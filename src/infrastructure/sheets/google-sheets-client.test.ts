import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type sheets_v4 } from 'googleapis';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { Value } from '@sinclair/typebox/value';
import {
  GoogleSheetsClient,
  formatScopedRange,
  columnIndexToLetter,
  gridRangeToA1,
  cellValueToCellData,
  valuesToRowData,
  buildColumnIndexMap,
} from './google-sheets-client';
import {
  GoogleSheetsApiError,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsDuplicateKeyError,
  GoogleSheetsExtentAnchorNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
} from './errors';
import {
  InsertGroupedRowResultSchema,
  ReadPositiveTableRequestSchema,
  PositiveTableRowSchema,
  type CellValue,
  type PositiveTableTarget,
  type SheetsConfigProvider,
} from './types';

describe('GoogleSheetsClient', () => {
  let mockSheetsApi: {
    spreadsheets: {
      get: ReturnType<typeof vi.fn>;
      batchUpdate: ReturnType<typeof vi.fn>;
      values: {
        get: ReturnType<typeof vi.fn>;
        batchGet: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
      };
    };
  };

  const defaultSpreadsheetMetadata: sheets_v4.Schema$Spreadsheet = {
    spreadsheetId: 'sheet-abc-123',
    sheets: [
      { properties: { sheetId: 0, title: 'Sheet1' } },
      { properties: { sheetId: 101, title: 'DataLog' } },
      { properties: { sheetId: 202, title: "John's Log" } },
    ],
    namedRanges: [
      {
        namedRangeId: 'nr-1',
        name: 'Headers',
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 },
      },
      {
        namedRangeId: 'nr-2',
        name: 'Data',
        range: { sheetId: 0, startRowIndex: 1, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 5 },
      },
      {
        namedRangeId: 'nr-3',
        name: 'DataLog!LogEntries',
        range: { sheetId: 101, startRowIndex: 5, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 4 },
      },
      {
        namedRangeId: 'nr-4',
        name: 'TopHeader',
        range: { sheetId: 101, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 },
      },
      {
        namedRangeId: 'nr-5',
        name: 'WorkbookScopedArch',
        range: { startRowIndex: 2, endRowIndex: 25, startColumnIndex: 0, endColumnIndex: 10 },
      },
      {
        namedRangeId: 'nr-6',
        name: 'QuotedRange',
        range: { sheetId: 202, startRowIndex: 2, endRowIndex: 15, startColumnIndex: 0, endColumnIndex: 10 },
      },
    ],
  };

  beforeEach(() => {
    mockSheetsApi = {
      spreadsheets: {
        get: vi.fn().mockResolvedValue({ data: defaultSpreadsheetMetadata }),
        batchUpdate: vi.fn().mockResolvedValue({ data: {} }),
        values: {
          get: vi.fn().mockResolvedValue({
            data: {
              values: [
                ['ID', 'Name', 'Score', 'Active'],
                ['1', 'Alice', 95.5, true],
              ],
            },
          }),
          batchGet: vi.fn().mockResolvedValue({
            data: {
              valueRanges: [],
            },
          }),
          update: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    };
  });

  interface SimCell {
    kind: 'empty' | 'string' | 'number' | 'boolean' | 'formula';
    value: CellValue;
    formattedValue?: CellValue;
  }

  interface SimRow {
    style: string;
    cells: SimCell[];
  }

  interface SimSheetState {
    sheetId: number;
    title: string;
    grid: SimRow[];
    namedRange: {
      name: string;
      startRowIndex: number;
      endRowIndex: number;
      startColumnIndex: number;
      endColumnIndex: number;
    };
  }

  function toSimCell(val: CellValue): SimCell {
    if (val === null || val === undefined || val === '') {
      return { kind: 'empty', value: val ?? '' };
    }
    if (typeof val === 'boolean') return { kind: 'boolean', value: val };
    if (typeof val === 'number') return { kind: 'number', value: val };
    if (typeof val === 'string' && val.startsWith('=')) {
      return { kind: 'formula', value: val };
    }
    return { kind: 'string', value: val };
  }

  function fromCellData(cellData: sheets_v4.Schema$CellData): SimCell {
    const ue = cellData.userEnteredValue;
    if (!ue) return { kind: 'empty', value: '' };
    if (ue.formulaValue !== undefined && ue.formulaValue !== null) {
      return { kind: 'formula', value: ue.formulaValue };
    }
    if (ue.stringValue !== undefined && ue.stringValue !== null) {
      return { kind: 'string', value: ue.stringValue };
    }
    if (ue.numberValue !== undefined && ue.numberValue !== null) {
      return { kind: 'number', value: ue.numberValue };
    }
    if (ue.boolValue !== undefined && ue.boolValue !== null) {
      return { kind: 'boolean', value: ue.boolValue };
    }
    return { kind: 'empty', value: '' };
  }

  function applyBatchUpdate(
    state: SimSheetState,
    requests: sheets_v4.Schema$Request[]
  ): void {
    for (const req of requests) {
      if (req.insertDimension) {
        const range = req.insertDimension.range!;
        expect(range.sheetId).toBe(state.sheetId);
        expect(range.dimension).toBe('ROWS');
        const start = range.startIndex!;
        const end = range.endIndex!;
        const count = end - start;
        expect(count).toBeGreaterThan(0);

        const inheritedStyle = req.insertDimension.inheritFromBefore
          ? state.grid[start - 1]?.style ?? 'default'
          : state.grid[start]?.style ?? 'default';

        const insertedRows: SimRow[] = Array.from({ length: count }, () => ({
          style: inheritedStyle,
          cells: [],
        }));
        state.grid.splice(start, 0, ...insertedRows);

        if (
          start > state.namedRange.startRowIndex &&
          start < state.namedRange.endRowIndex
        ) {
          state.namedRange.endRowIndex += count;
        }
      } else if (req.deleteDimension) {
        const range = req.deleteDimension.range!;
        expect(range.sheetId).toBe(state.sheetId);
        expect(range.dimension).toBe('ROWS');
        const start = range.startIndex!;
        const end = range.endIndex!;
        const count = end - start;
        expect(count).toBeGreaterThan(0);
        expect(end).toBeLessThanOrEqual(state.grid.length);

        state.grid.splice(start, count);

        if (
          start >= state.namedRange.startRowIndex &&
          start < state.namedRange.endRowIndex
        ) {
          state.namedRange.endRowIndex -= count;
        }
      } else if (req.updateCells) {
        const uc = req.updateCells;
        const range = uc.range!;
        expect(range.sheetId).toBe(state.sheetId);
        expect(uc.fields).toBe('userEnteredValue');
        const startRow = range.startRowIndex!;
        const endRow = range.endRowIndex!;
        const startCol = range.startColumnIndex!;
        const endCol = range.endColumnIndex!;
        const rows = uc.rows ?? [];
        expect(endRow - startRow).toBe(rows.length);

        for (let r = 0; r < rows.length; r++) {
          const targetRow = state.grid[startRow + r];
          expect(targetRow).toBeDefined();
          const rowValues = rows[r].values ?? [];
          expect(rowValues.length).toBe(endCol - startCol);
          for (let c = 0; c < rowValues.length; c++) {
            const absCol = startCol + c;
            while (targetRow.cells.length <= absCol) {
              targetRow.cells.push({ kind: 'empty', value: '' });
            }
            targetRow.cells[absCol] = fromCellData(rowValues[c]);
          }
        }
      } else {
        throw new Error(`Unsupported batchUpdate request in simulator: ${JSON.stringify(req)}`);
      }
    }
  }

  function parseSimA1Range(
    a1Range: string,
    defaultEndRowIndex: number,
    defaultEndColumnIndex: number
  ): {
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  } {
    const bangIdx = a1Range.lastIndexOf('!');
    const cellRange = (bangIdx >= 0 ? a1Range.slice(bangIdx + 1) : a1Range).trim();
    const colLettersToIdx = (letters: string): number => {
      let idx = 0;
      for (let i = 0; i < letters.length; i++) {
        idx = idx * 26 + (letters.charCodeAt(i) - 64);
      }
      return idx - 1;
    };
    const boxMatch = /^([A-Z]+)(\d+):([A-Z]+)(\d*)$/i.exec(cellRange);
    if (boxMatch) {
      return {
        startRowIndex: Number(boxMatch[2]) - 1,
        endRowIndex: boxMatch[4] ? Number(boxMatch[4]) : defaultEndRowIndex,
        startColumnIndex: colLettersToIdx(boxMatch[1].toUpperCase()),
        endColumnIndex: colLettersToIdx(boxMatch[3].toUpperCase()) + 1,
      };
    }
    const rowOnlyMatch = /^(\d+):(\d+)$/.exec(cellRange);
    if (rowOnlyMatch) {
      return {
        startRowIndex: Number(rowOnlyMatch[1]) - 1,
        endRowIndex: Number(rowOnlyMatch[2]),
        startColumnIndex: 0,
        endColumnIndex: defaultEndColumnIndex,
      };
    }
    return {
      startRowIndex: 0,
      endRowIndex: defaultEndRowIndex,
      startColumnIndex: 0,
      endColumnIndex: defaultEndColumnIndex,
    };
  }

  function wireSimulator(state: SimSheetState, spreadsheetId = 'sim-sheet-id') {
    mockSheetsApi.spreadsheets.get.mockImplementation(async () => ({
      data: {
        spreadsheetId,
        sheets: [{ properties: { sheetId: state.sheetId, title: state.title } }],
        namedRanges: [
          {
            namedRangeId: 'nr-sim',
            name: state.namedRange.name,
            range: {
              sheetId: state.sheetId,
              startRowIndex: state.namedRange.startRowIndex,
              endRowIndex: state.namedRange.endRowIndex,
              startColumnIndex: state.namedRange.startColumnIndex,
              endColumnIndex: state.namedRange.endColumnIndex,
            },
          },
        ],
      },
    }));

    const sliceSimValues = (range: string | undefined, valueRenderOption: string | undefined): CellValue[][] => {
      const nr = state.namedRange;
      const bounds = range
        ? parseSimA1Range(range, nr.endRowIndex, nr.endColumnIndex)
        : {
            startRowIndex: nr.startRowIndex,
            endRowIndex: nr.endRowIndex,
            startColumnIndex: nr.startColumnIndex,
            endColumnIndex: nr.endColumnIndex,
          };
      const slice: CellValue[][] = [];
      const rowLimit = Math.min(bounds.endRowIndex, state.grid.length);
      for (let r = bounds.startRowIndex; r < rowLimit; r++) {
        const row = state.grid[r];
        if (!row) {
          slice.push([]);
          continue;
        }
        const vals: CellValue[] = [];
        for (let c = bounds.startColumnIndex; c < bounds.endColumnIndex; c++) {
          const cell = row.cells[c];
          if (!cell) {
            vals.push('');
          } else if (valueRenderOption === 'FORMULA') {
            vals.push(cell.value);
          } else {
            vals.push(cell.formattedValue ?? cell.value);
          }
        }
        while (vals.length > 0 && vals[vals.length - 1] === '') {
          vals.pop();
        }
        slice.push(vals);
      }
      return slice;
    };

    mockSheetsApi.spreadsheets.values.get.mockImplementation(
      async (params?: { range?: string; valueRenderOption?: string }) => ({
        data: { values: sliceSimValues(params?.range, params?.valueRenderOption) },
      })
    );

    mockSheetsApi.spreadsheets.values.batchGet.mockImplementation(
      async (params?: { ranges?: string[]; valueRenderOption?: string }) => ({
        data: {
          spreadsheetId,
          valueRanges: (params?.ranges ?? []).map((range) => ({
            range,
            values: sliceSimValues(range, params?.valueRenderOption),
          })),
        },
      })
    );

    mockSheetsApi.spreadsheets.batchUpdate.mockImplementation(
      async ({ requestBody }: { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest }) => {
        applyBatchUpdate(state, requestBody.requests ?? []);
        return { data: {} };
      }
    );
  }

  describe('formatScopedRange, columnIndexToLetter, and gridRangeToA1', () => {
    it('wraps and escapes sheet names properly', () => {
      expect(formatScopedRange('Sheet1', 'A1:E1')).toBe("'Sheet1'!A1:E1");
      expect(formatScopedRange('Submittal Arch', 'A3:J25')).toBe("'Submittal Arch'!A3:J25");
      expect(formatScopedRange("John's Sheet", 'A3:J25')).toBe("'John''s Sheet'!A3:J25");
    });

    it('converts 0-based column indices to A1 column letters including multi-letter columns', () => {
      expect(columnIndexToLetter(0)).toBe('A');
      expect(columnIndexToLetter(9)).toBe('J');
      expect(columnIndexToLetter(25)).toBe('Z');
      expect(columnIndexToLetter(26)).toBe('AA');
      expect(columnIndexToLetter(27)).toBe('AB');
      expect(columnIndexToLetter(701)).toBe('ZZ');
      expect(columnIndexToLetter(702)).toBe('AAA');
    });

    it('converts bounded and unbounded GridRanges to explicit A1 notation', () => {
      expect(
        gridRangeToA1('Submittal Arch', {
          sheetId: 0,
          startRowIndex: 2,
          endRowIndex: 25,
          startColumnIndex: 0,
          endColumnIndex: 10,
        })
      ).toBe("'Submittal Arch'!A3:J25");

      expect(
        gridRangeToA1('Sheet1', {
          endRowIndex: 5,
          endColumnIndex: 3,
        })
      ).toBe("'Sheet1'!A1:C5");

      expect(
        gridRangeToA1("John's Log", {
          startRowIndex: 2,
          startColumnIndex: 26,
          endColumnIndex: 28,
        })
      ).toBe("'John''s Log'!AA3:AB");

      expect(
        gridRangeToA1('Sheet1', {
          startRowIndex: 2,
          endRowIndex: 10,
        })
      ).toBe("'Sheet1'!3:10");

      expect(gridRangeToA1('Sheet1', {})).toBe("'Sheet1'");
    });
  });

  describe('buildColumnIndexMap', () => {
    it('maps column headers to indices and ignores empty/null headers', () => {
      const map = buildColumnIndexMap(['ID', null, 'Name', '', 'Score', 'ID']);
      expect(map.get('ID')).toBe(0);
      expect(map.get('Name')).toBe(2);
      expect(map.get('Score')).toBe(4);
      expect(map.has('')).toBe(false);
      expect(map.size).toBe(3);
    });
  });

  describe('cellValueToCellData & valuesToRowData (SheetCellInput safety)', () => {
    it('maps null and undefined to empty object', () => {
      expect(cellValueToCellData(null)).toEqual({});
      expect(cellValueToCellData(undefined)).toEqual({});
    });

    it('maps boolean values to boolValue', () => {
      expect(cellValueToCellData(true)).toEqual({ userEnteredValue: { boolValue: true } });
      expect(cellValueToCellData(false)).toEqual({ userEnteredValue: { boolValue: false } });
    });

    it('maps numeric values to numberValue', () => {
      expect(cellValueToCellData(42)).toEqual({ userEnteredValue: { numberValue: 42 } });
      expect(cellValueToCellData(0)).toEqual({ userEnteredValue: { numberValue: 0 } });
      expect(cellValueToCellData(-3.14)).toEqual({ userEnteredValue: { numberValue: -3.14 } });
    });

    it('always maps plain strings (including leading =, +, -, @) to literal stringValue', () => {
      expect(cellValueToCellData('hello world')).toEqual({
        userEnteredValue: { stringValue: 'hello world' },
      });
      expect(cellValueToCellData('=1+1')).toEqual({
        userEnteredValue: { stringValue: '=1+1' },
      });
      expect(cellValueToCellData('=SUM(A1:A10)')).toEqual({
        userEnteredValue: { stringValue: '=SUM(A1:A10)' },
      });
      expect(cellValueToCellData('+CMD')).toEqual({
        userEnteredValue: { stringValue: '+CMD' },
      });
      expect(cellValueToCellData('-100')).toEqual({
        userEnteredValue: { stringValue: '-100' },
      });
      expect(cellValueToCellData('@foo')).toEqual({
        userEnteredValue: { stringValue: '@foo' },
      });
    });

    it('maps explicit SheetFormulaCell { formula } to formulaValue', () => {
      expect(
        cellValueToCellData({ formula: '=HYPERLINK("https://example.com", "Link")' })
      ).toEqual({
        userEnteredValue: { formulaValue: '=HYPERLINK("https://example.com", "Link")' },
      });
    });

    it('converts 2D array of SheetCellInputs to Schema$RowData array', () => {
      const rows = valuesToRowData([
        ['Name', 10, true],
        [null, '=A1', { formula: '=HYPERLINK("https://example.com", "Link")' }],
      ]);
      expect(rows).toEqual([
        {
          values: [
            { userEnteredValue: { stringValue: 'Name' } },
            { userEnteredValue: { numberValue: 10 } },
            { userEnteredValue: { boolValue: true } },
          ],
        },
        {
          values: [
            {},
            { userEnteredValue: { stringValue: '=A1' } },
            { userEnteredValue: { formulaValue: '=HYPERLINK("https://example.com", "Link")' } },
          ],
        },
      ]);
    });
  });

  describe('Constructor & Client Options', () => {
    it('accepts direct sheets_v4.Sheets instance', () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      expect(client).toBeInstanceOf(GoogleSheetsClient);
    });

    it('accepts GoogleSheetsClientOptions with sheets instance', () => {
      const client = new GoogleSheetsClient({
        sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
      });
      expect(client).toBeInstanceOf(GoogleSheetsClient);
    });

    it('accepts auth credential string option', () => {
      const client = new GoogleSheetsClient({ auth: 'ya29.sample-oauth-cred' });
      expect(client).toBeInstanceOf(GoogleSheetsClient);
    });

    it('accepts OAuth2Client option', () => {
      const oauth = new OAuth2Client();
      const client = new GoogleSheetsClient({ auth: oauth });
      expect(client).toBeInstanceOf(GoogleSheetsClient);
    });

    it('accepts GoogleAuth option without making network calls', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('Unexpected network call during GoogleSheetsClient construction');
      });
      try {
        const googleAuth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const client = new GoogleSheetsClient({ auth: googleAuth });
        expect(client).toBeInstanceOf(GoogleSheetsClient);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });

  describe('readNamedRange', () => {
    it('resolves GridRange to explicit A1 bounds and reads with UNFORMATTED_VALUE', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      const result = await client.readNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Headers',
      });

      expect(result).toEqual([
        ['ID', 'Name', 'Score', 'Active'],
        ['1', 'Alice', 95.5, true],
      ]);

      expect(mockSheetsApi.spreadsheets.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        fields: 'sheets(properties(sheetId,title)),namedRanges',
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'Sheet1'!A1:E1",
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
    });

    it('resolves workbook-scoped named ranges and escaped sheet names to explicit A1 bounds', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.readNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'WorkbookScopedArch',
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'Sheet1'!A3:J25",
        valueRenderOption: 'UNFORMATTED_VALUE',
      });

      await client.readNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: "John's Log",
        rangeName: 'QuotedRange',
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'John''s Log'!A3:J15",
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
    });

    it('returns empty array when sheet range has no values', async () => {
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: { values: undefined },
      });
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      const result = await client.readNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Data',
      });

      expect(result).toEqual([]);
    });

    it('resolves sheet-scoped named range formatted as Sheet!Range to explicit A1', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.readNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'DataLog',
        rangeName: 'LogEntries',
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'DataLog'!A6:D20",
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
    });

    it('throws GoogleSheetsNamedRangeNotFoundError when named range does not exist in spreadsheet', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'NonExistentRange',
        })
      ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
    });

    it('throws GoogleSheetsApiError when target sheet is not found in spreadsheet', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'MissingSheet',
          rangeName: 'Headers',
        })
      ).rejects.toThrow(/Sheet "MissingSheet" not found in spreadsheet/);
    });

    it('translates 400 Unable to parse range error to GoogleSheetsNamedRangeNotFoundError', async () => {
      mockSheetsApi.spreadsheets.values.get.mockRejectedValueOnce({
        code: 400,
        message: 'Unable to parse range: Sheet1!A1:E1',
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        })
      ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
    });
  });

  describe('writeNamedRange', () => {
    it('overwrites named range using explicit A1 bounds on values.update when insertRows is false or omitted', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.writeNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Headers',
        values: [['ID', 'Full Name', 'Status']],
        insertRows: false,
      });

      expect(mockSheetsApi.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'Sheet1'!A1:E1",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['ID', 'Full Name', 'Status']],
        },
      });
      expect(mockSheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();

      await client.writeNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'WorkbookScopedArch',
        values: [['ID', 'Full Name']],
      });

      expect(mockSheetsApi.spreadsheets.values.update).toHaveBeenLastCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'Sheet1'!A3:J25",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['ID', 'Full Name']],
        },
      });
    });

    it('executes atomic batchUpdate with insertDimension and updateCells when insertRows is true', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.writeNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Data',
        values: [
          ['101', 'First Row', 10, true],
          ['102', 'Second Row', 20, false],
        ],
        insertRows: true,
      });

      expect(mockSheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 1,
                  endIndex: 3,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 1,
                  endRowIndex: 3,
                  startColumnIndex: 0,
                  endColumnIndex: 5,
                },
                rows: valuesToRowData([
                  ['101', 'First Row', 10, true],
                  ['102', 'Second Row', 20, false],
                ]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('sets inheritFromBefore: false when startRowIndex is 0', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.writeNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'DataLog',
        rangeName: 'TopHeader',
        values: [['LogHeader']],
        insertRows: true,
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            requests: expect.arrayContaining([
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  inheritFromBefore: false,
                }),
              }),
            ]),
          }),
        })
      );
    });

    it('returns without API mutation if insertRows is true and values array is empty', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.writeNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Data',
        values: [],
        insertRows: true,
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
    });

    it('throws GoogleSheetsNamedRangeNotFoundError when writing to a non-existent named range', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.writeNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'MissingRange',
          values: [['val']],
        })
      ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
    });
  });

  describe('Rate Limiting & Exponential Backoff Retry', () => {
    it('retries on HTTP 429 errors with exponential backoff and succeeds', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      try {
        mockSheetsApi.spreadsheets.values.get
          .mockRejectedValueOnce({ statusCode: 429, message: 'Rate limit exceeded' })
          .mockRejectedValueOnce({ code: '429', message: 'Quota exceeded' })
          .mockResolvedValueOnce({
            data: { values: [['Success']] },
          });

        const client = new GoogleSheetsClient({
          sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
          retryOptions: {
            maxRetries: 3,
            initialDelayMs: 100,
            backoffFactor: 2,
            sleep: sleepMock,
          },
        });

        const result = await client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        });

        expect(result).toEqual([['Success']]);
        expect(sleepMock).toHaveBeenCalledTimes(2);
        expect(sleepMock).toHaveBeenNthCalledWith(1, 100);
        expect(sleepMock).toHaveBeenNthCalledWith(2, 200);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('fails when maxRetries is exceeded on persistent 429 errors', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      mockSheetsApi.spreadsheets.values.get.mockRejectedValue({
        statusCode: 429,
        message: 'Rate limit exceeded',
      });

      const client = new GoogleSheetsClient({
        sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 50,
          backoffFactor: 2,
          sleep: sleepMock,
        },
      });

      await expect(
        client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        })
      ).rejects.toThrow(/Rate limit exceeded/);

      expect(sleepMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry on non-429 errors (e.g. 500)', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      mockSheetsApi.spreadsheets.values.get.mockRejectedValueOnce({
        statusCode: 500,
        message: 'Internal Server Error',
      });

      const client = new GoogleSheetsClient({
        sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
        retryOptions: {
          maxRetries: 3,
          sleep: sleepMock,
        },
      });

      await expect(
        client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        })
      ).rejects.toThrow(GoogleSheetsApiError);

      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('uses dynamic retry options from configProvider when provided', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const mockConfigProvider: SheetsConfigProvider = {
        getSheetsConfig: vi.fn().mockResolvedValue({
          maxRetries: 4,
          initialDelayMs: 250,
          backoffFactor: 3,
        }),
      };

      try {
        mockSheetsApi.spreadsheets.values.get
          .mockRejectedValueOnce({ statusCode: 429, message: 'Too Many Requests' })
          .mockResolvedValueOnce({
            data: { values: [['Done']] },
          });

        const client = new GoogleSheetsClient({
          sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
          retryOptions: { sleep: sleepMock },
          configProvider: mockConfigProvider,
        });

        const result = await client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        });

        expect(result).toEqual([['Done']]);
        expect(mockConfigProvider.getSheetsConfig).toHaveBeenCalled();
        expect(sleepMock).toHaveBeenCalledTimes(1);
        expect(sleepMock).toHaveBeenCalledWith(250);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('retries HTTP 403 quota-reason payloads before wrapApiError wraps them', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      try {
        mockSheetsApi.spreadsheets.values.get
          .mockRejectedValueOnce({
            status: 403,
            errors: [{ reason: 'userRateLimitExceeded' }],
            message: 'Request failed',
          })
          .mockRejectedValueOnce({
            response: {
              status: 403,
              data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
            },
            message: 'Forbidden',
          })
          .mockResolvedValueOnce({
            data: { values: [['QuotaRecovered']] },
          });

        const client = new GoogleSheetsClient({
          sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
          retryOptions: {
            maxRetries: 3,
            initialDelayMs: 100,
            backoffFactor: 2,
            sleep: sleepMock,
          },
        });

        const result = await client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        });

        expect(result).toEqual([['QuotaRecovered']]);
        expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledTimes(3);
        expect(sleepMock).toHaveBeenCalledTimes(2);
        expect(sleepMock).toHaveBeenNthCalledWith(1, 100);
        expect(sleepMock).toHaveBeenNthCalledWith(2, 200);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('does not retry non-quota HTTP 403 and wraps into GoogleSheetsApiError with statusCode 403', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      mockSheetsApi.spreadsheets.values.get.mockRejectedValueOnce({
        status: 403,
        errors: [{ reason: 'forbidden' }],
        message: 'The caller does not have permission',
      });

      const client = new GoogleSheetsClient({
        sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 50,
          sleep: sleepMock,
        },
      });

      const err = await client
        .readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        })
        .catch((e) => e);

      expect(err).toBeInstanceOf(GoogleSheetsApiError);
      expect((err as GoogleSheetsApiError).statusCode).toBe(403);
      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('applies ±25% jitter bounds to exponential backoff delays', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const randomSpy = vi
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0) // 0.75x
        .mockReturnValueOnce(0.999999); // ~1.25x

      try {
        mockSheetsApi.spreadsheets.values.get
          .mockRejectedValueOnce({ statusCode: 429, message: 'Rate limit' })
          .mockRejectedValueOnce({ statusCode: 429, message: 'Rate limit' })
          .mockResolvedValueOnce({ data: { values: [['Jittered']] } });

        const client = new GoogleSheetsClient({
          sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
          retryOptions: {
            maxRetries: 3,
            initialDelayMs: 100,
            backoffFactor: 2,
            sleep: sleepMock,
          },
        });

        const result = await client.readNamedRange({
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          rangeName: 'Headers',
        });

        expect(result).toEqual([['Jittered']]);
        expect(sleepMock).toHaveBeenCalledTimes(2);
        expect(sleepMock.mock.calls[0]?.[0]).toBe(75);
        expect(sleepMock.mock.calls[1]?.[0]).toBe(250);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('preserves the private executeWithRetry prototype spy seam', async () => {
      const spy = vi
        .spyOn(
          GoogleSheetsClient.prototype as unknown as { executeWithRetry: () => unknown },
          'executeWithRetry'
        )
        .mockRejectedValueOnce(new Error('Blocked by prototype spy'));

      try {
        const client = new GoogleSheetsClient({
          sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
        });

        await expect(
          client.readNamedRange({
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            rangeName: 'Headers',
          })
        ).rejects.toThrow('Blocked by prototype spy');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(mockSheetsApi.spreadsheets.get).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('honors retryOptions.signal to abort active retry backoff immediately', async () => {
      const controller = new AbortController();
      mockSheetsApi.spreadsheets.values.get
        .mockRejectedValueOnce({ statusCode: 429, message: 'Too Many Requests' })
        .mockResolvedValueOnce({ data: { values: [['ShouldNotRun']] } });

      const client = new GoogleSheetsClient({
        sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 60_000,
          signal: controller.signal,
        },
      });

      const promise = client.readNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Headers',
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();

      await expect(promise).rejects.toThrow(/abort/i);
      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('readTable', () => {
    const createArchMetadata = (): sheets_v4.Schema$Spreadsheet => ({
      spreadsheetId: 'log-sheet-1',
      sheets: [{ properties: { sheetId: 10, title: 'Submittal Arch' } }],
      namedRanges: [
        {
          namedRangeId: 'nr-arch',
          name: 'Log_Submittal_Arch',
          range: {
            sheetId: 10,
            startRowIndex: 2, // Row 3 (1-based)
            endRowIndex: 14,
            startColumnIndex: 0,
            endColumnIndex: 10,
          },
        },
      ],
    });

    it('reads positive-terminated table with FORMATTED_VALUE preserving leading zeros and exact 1-based rowNumbers', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'], // Row 3 (rel 0)
            ['Formula Row', '', '', '', '', '', '', '', '', ''], // Row 4 (rel 1)
            ['<--->'], // Row 5 (rel 2 = topAnchor)
            ['Closed', '033000', '001', '0', 'Concrete Mix', '260115', 'MB', 'Received', 'Podium slab', 'Link'], // Row 6 (rel 3)
            ['---'], // Row 7 (rel 4 = divider)
            [], // Row 8 (rel 5 = blank)
            ['Open', '071200', '001', '0', 'Waterproofing', '260204', 'ARC', 'Referred', 'See --- note'], // Row 9 (rel 6, trailing null Calc Link + '---' in Notes)
            ['<--->'], // Row 10 (rel 7 = bottomAnchor)
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'Submittal Arch'!A4:J4",
              values: [['Formula Row', '', '', '', '', '', '', '', '', '']],
            },
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'log-sheet-1',
        range: "'Submittal Arch'!A3:J14",
        valueRenderOption: 'FORMATTED_VALUE',
      });

      expect(result.headers).toEqual([
        'Status',
        'Section',
        'Number',
        'Revision',
        'Title',
        'Date',
        'Contact',
        'Action',
        'Notes',
        'Calc Link',
      ]);
      expect(result.formulaColumns).toEqual([]);
      expect(result.rows).toEqual([
        {
          rowNumber: 6,
          values: {
            Status: 'Closed',
            Section: '033000',
            Number: '001',
            Revision: '0',
            Title: 'Concrete Mix',
            Date: '260115',
            Contact: 'MB',
            Action: 'Received',
            Notes: 'Podium slab',
            'Calc Link': 'Link',
          },
        },
        {
          rowNumber: 9,
          values: {
            Status: 'Open',
            Section: '071200',
            Number: '001',
            Revision: '0',
            Title: 'Waterproofing',
            Date: '260204',
            Contact: 'ARC',
            Action: 'Referred',
            Notes: 'See --- note',
            'Calc Link': null,
          },
        },
      ]);
    });

    it('resolves reordered headers dynamically and skips dividers in reordered Status column', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Notes', 'Status', '', 'Section', 'Number'], // Reordered + unnamed column
            ['', '<--->'], // topAnchor in Status column
            ['First row', 'Open', 'ignored-cell', '071200', '002'],
            ['Divider by status', '---', '', '', ''],
            ['Divider by col 0' /* Wait: col 0 is --- */, 'Open', '', '087100', '001'],
            ['---', 'IgnoredDivider', '', '', ''],
            ['', '<--->'], // bottomAnchor in Status column
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });

      expect(result.headers).toEqual(['Notes', 'Status', 'Section', 'Number']);
      expect(result.rows).toEqual([
        {
          rowNumber: 5,
          values: {
            Notes: 'First row',
            Status: 'Open',
            Section: '071200',
            Number: '002',
          },
        },
        {
          rowNumber: 7,
          values: {
            Notes: 'Divider by col 0',
            Status: 'Open',
            Section: '087100',
            Number: '001',
          },
        },
      ]);
    });

    it('returns empty rows array when cleared template has only placeholder blank row(s) between anchors', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section', 'Number'],
            ['Formula Row'],
            ['<--->'],
            ['', '', ''],
            ['<--->'],
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'Submittal Arch'!A4:J4",
              values: [['Formula Row']],
            },
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });

      expect(result.headers).toEqual(['Status', 'Section', 'Number']);
      expect(result.rows).toEqual([]);
    });

    it('throws GoogleSheetsExtentAnchorNotFoundError when anchors are missing or collapsed onto the same row', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const target = {
        spreadsheetId: 'log-sheet-1',
        sheetName: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        extentMarker: '<--->',
        groupDividerMarker: '---',
      };

      // Case 1: Empty sheet / no values
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({ data: { values: [] } });
      await expect(client.readTable({ target })).rejects.toThrow(
        GoogleSheetsExtentAnchorNotFoundError
      );

      // Case 2: Zero anchors
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section'],
            ['Open', '071200'],
          ],
        },
      });
      await expect(client.readTable({ target })).rejects.toThrow(
        GoogleSheetsExtentAnchorNotFoundError
      );

      // Case 3: Only one anchor (topAnchor === bottomAnchor)
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section'],
            ['<--->'],
            ['Open', '071200'],
          ],
        },
      });
      await expect(client.readTable({ target })).rejects.toThrow(
        GoogleSheetsExtentAnchorNotFoundError
      );
    });

    it('inspects pre-<---> rows with valueRenderOption FORMULA when topAnchor > 1 and returns detected formulaColumns', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({
        data: {
          spreadsheetId: 'log-sheet-ffe',
          sheets: [{ properties: { sheetId: 22, title: 'Submittal FF&E' } }],
          namedRanges: [
            {
              namedRangeId: 'nr-ffe',
              name: 'Log_Submittal_FFE',
              range: {
                sheetId: 22,
                startRowIndex: 2, // Row 3
                endRowIndex: 12,
                startColumnIndex: 0,
                endColumnIndex: 6,
              },
            },
          ],
        },
      });

      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Spec Tag', 'Spec Title', 'Helper', 'Custom Formula', 'Notes'], // Row 3 (rel 0)
            ['Note row', '', '', '', '', ''], // Row 4 (rel 1)
            ['Formula Row', '', 'BED - KING', '', 'calc-1', ''], // Row 5 (rel 2) — formatted preview
            ['<--->'], // Row 6 (rel 3 = topAnchor)
            ['Open', 'CG104', 'BED - KING', 'user', 'calc-1', 'Sample note'], // Row 7 (rel 4)
            ['<--->'], // Row 8 (rel 5 = bottomAnchor)
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'Submittal FF&E'!A4:F5",
              values: [
                ['Note row', '', '', '', '', ''], // Row 4
                [
                  'Formula Row',
                  '',
                  '=ARRAYFORMULA(IF(B7:B="","",VLOOKUP(B7:B,Options_Specs,2,FALSE)))',
                  'non-formula-label',
                  '  =ARRAYFORMULA(IF(B7:B="","",B7:B&"-X"))',
                  '',
                ], // Row 5
              ],
            },
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-ffe',
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'log-sheet-ffe',
        range: "'Submittal FF&E'!A3:F12",
        valueRenderOption: 'FORMATTED_VALUE',
      });
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledWith({
        spreadsheetId: 'log-sheet-ffe',
        ranges: ["'Submittal FF&E'!A4:F5"],
        valueRenderOption: 'FORMULA',
      });
      expect(result.formulaColumns).toEqual(['Spec Title', 'Custom Formula']);
    });

    it('skips pre-<---> FORMULA read when topAnchor === 1 and returns empty formulaColumns', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section'],
            ['<--->'],
            ['Open', '071200'],
            ['<--->'],
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).not.toHaveBeenCalled();
      expect(result.formulaColumns).toEqual([]);
      expect('links' in result.rows[0]).toBe(false);
    });

    it('omits row.links when linkColumns is empty array and skips FORMULA batchGet when topAnchor === 1', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section', 'Calc Link'],
            ['<--->'],
            ['Open', '071200', 'Link'],
            ['<--->'],
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        linkColumns: [],
      });

      expect(mockSheetsApi.spreadsheets.values.batchGet).not.toHaveBeenCalled();
      expect(result.rows).toHaveLength(1);
      expect('links' in result.rows[0]).toBe(false);
    });

    it('fetches pre-<---> Formula Row and deduplicated linkColumns in one batchGet FORMULA call, skipping missing headers and handling truncated/missing valueRanges', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({
        data: {
          spreadsheetId: 'log-sheet-ffe',
          sheets: [{ properties: { sheetId: 22, title: 'Submittal FF&E' } }],
          namedRanges: [
            {
              namedRangeId: 'nr-ffe',
              name: 'Log_Submittal_FFE',
              range: {
                sheetId: 22,
                startRowIndex: 2, // Row 3
                endRowIndex: 14,
                startColumnIndex: 2, // Col C (offset Named Range!)
                endColumnIndex: 8, // Col H
              },
            },
          ],
        },
      });

      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Spec Tag', 'Spec Title', 'Calc Link', 'Secondary Link'], // Row 3 (rel 0)
            ['Formula Row', '', 'BED - KING', '', ''], // Row 4 (rel 1)
            ['<--->'], // Row 5 (rel 2 = topAnchor)
            ['Open', 'CG104', 'BED - KING', 'Link', 'Alt'], // Row 6 (rel 3) -> slice offset 0
            ['---'], // Row 7 (rel 4 = divider) -> slice offset 1
            [], // Row 8 (rel 5 = blank) -> slice offset 2
            ['Closed', 'FB127', 'FABRIC', 'Link', ''], // Row 9 (rel 6) -> slice offset 3
            ['Open', 'LT108', 'LAMP', '', ''], // Row 10 (rel 7) -> slice offset 4 (truncated in response!)
            ['<--->'], // Row 11 (rel 8 = bottomAnchor)
          ],
        },
      });

      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'Submittal FF&E'!C4:H4",
              values: [['Formula Row', '', '=ARRAYFORMULA(D6:D)', '', '']],
            },
            {
              // Calc Link (col C + 3 = F, rows 6..10): truncated at row 9 (omitting trailing row 10!)
              range: "'Submittal FF&E'!F6:F10",
              values: [
                ['=HYPERLINK("https://drive.google.com/file/d/cg104/view", "Link")'],
                [''],
                [],
                ['https://drive.google.com/file/d/fb127/view'],
              ],
            },
            {
              // Secondary Link (col C + 4 = G, rows 6..10): Google omitted values property altogether
              range: "'Submittal FF&E'!G6:G10",
            },
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-ffe',
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        linkColumns: ['Calc Link', 'Missing Header', 'Calc Link', 'Secondary Link'],
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledWith({
        spreadsheetId: 'log-sheet-ffe',
        ranges: [
          "'Submittal FF&E'!C4:H4",
          "'Submittal FF&E'!F6:F10",
          "'Submittal FF&E'!G6:G10",
        ],
        valueRenderOption: 'FORMULA',
      });

      expect(result.formulaColumns).toEqual(['Spec Title']);
      expect(result.rows).toEqual([
        {
          rowNumber: 6,
          values: {
            Status: 'Open',
            'Spec Tag': 'CG104',
            'Spec Title': 'BED - KING',
            'Calc Link': 'Link',
            'Secondary Link': 'Alt',
          },
          links: {
            'Calc Link': 'https://drive.google.com/file/d/cg104/view',
            'Secondary Link': null,
          },
        },
        {
          rowNumber: 9,
          values: {
            Status: 'Closed',
            'Spec Tag': 'FB127',
            'Spec Title': 'FABRIC',
            'Calc Link': 'Link',
            'Secondary Link': '',
          },
          links: {
            'Calc Link': 'https://drive.google.com/file/d/fb127/view',
            'Secondary Link': null,
          },
        },
        {
          rowNumber: 10,
          values: {
            Status: 'Open',
            'Spec Tag': 'LT108',
            'Spec Title': 'LAMP',
            'Calc Link': '',
            'Secondary Link': '',
          },
          links: {
            'Calc Link': null,
            'Secondary Link': null,
          },
        },
      ]);
    });

    it('guards against Invalid GridRange when anchors are adjacent or table has zero data rows with linkColumns', async () => {
      const target: PositiveTableTarget = {
        spreadsheetId: 'log-sheet-1',
        sheetName: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        extentMarker: '<--->',
        groupDividerMarker: '---',
      };
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // Case A: topAnchor === 1, adjacent <---> markers at rows 4 and 5
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section', 'Calc Link'], // Row 3 (rel 0)
            ['<--->'], // Row 4 (rel 1 = topAnchor)
            ['<--->'], // Row 5 (rel 2 = bottomAnchor)
          ],
        },
      });

      const caseAResult = await client.readTable({ target, linkColumns: ['Calc Link'] });
      expect(mockSheetsApi.spreadsheets.values.batchGet).not.toHaveBeenCalled();
      expect(caseAResult.headers).toEqual(['Status', 'Section', 'Calc Link']);
      expect(caseAResult.formulaColumns).toEqual([]);
      expect(caseAResult.rows).toEqual([]);

      // Case B1: topAnchor > 1 with Formula Row + adjacent <---> markers
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section', 'Calc Link'], // Row 3 (rel 0)
            ['Formula Row', '', ''], // Row 4 (rel 1)
            ['<--->'], // Row 5 (rel 2 = topAnchor)
            ['<--->'], // Row 6 (rel 3 = bottomAnchor)
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'Submittal Arch'!A4:J4",
              values: [['Formula Row', '', '']],
            },
          ],
        },
      });

      const caseB1Result = await client.readTable({ target, linkColumns: ['Calc Link'] });
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledWith({
        spreadsheetId: 'log-sheet-1',
        ranges: ["'Submittal Arch'!A4:J4"],
        valueRenderOption: 'FORMULA',
      });
      expect(caseB1Result.rows).toEqual([]);

      // Case B2: topAnchor > 1 with Formula Row + only blank/divider rows between anchors
      mockSheetsApi.spreadsheets.values.batchGet.mockClear();
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section', 'Calc Link'], // Row 3 (rel 0)
            ['Formula Row', '', ''], // Row 4 (rel 1)
            ['<--->'], // Row 5 (rel 2 = topAnchor)
            ['---'], // Row 6 (rel 3 = divider)
            ['', '', ''], // Row 7 (rel 4 = blank)
            ['<--->'], // Row 8 (rel 5 = bottomAnchor)
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'Submittal Arch'!A4:J4",
              values: [['Formula Row', '', '']],
            },
          ],
        },
      });

      const caseB2Result = await client.readTable({ target, linkColumns: ['Calc Link'] });
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledWith({
        spreadsheetId: 'log-sheet-1',
        ranges: ["'Submittal Arch'!A4:J4"],
        valueRenderOption: 'FORMULA',
      });
      expect(caseB2Result.rows).toEqual([]);
    });

    it('skips batchGet when all requested linkColumns are missing from headers (topAnchor === 1) and returns empty links object on data rows', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Section', 'Title'], // Row 3 (rel 0)
            ['<--->'], // Row 4 (rel 1 = topAnchor)
            ['Open', '071200', 'Waterproofing'], // Row 5 (rel 2)
            ['Closed', '033000', 'Concrete'], // Row 6 (rel 3)
            ['<--->'], // Row 7 (rel 4 = bottomAnchor)
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        linkColumns: ['MissingCol'],
      });

      expect(mockSheetsApi.spreadsheets.values.batchGet).not.toHaveBeenCalled();
      expect(result.rows).toEqual([
        {
          rowNumber: 5,
          values: { Status: 'Open', Section: '071200', Title: 'Waterproofing' },
          links: {},
        },
        {
          rowNumber: 6,
          values: { Status: 'Closed', Section: '033000', Title: 'Concrete' },
          links: {},
        },
      ]);
    });

    it('validates ReadPositiveTableRequestSchema and PositiveTableRowSchema under ExactOptionalPropertyTypes = true', async () => {
      const target: PositiveTableTarget = {
        spreadsheetId: 'log-sheet-1',
        sheetName: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        extentMarker: '<--->',
        groupDividerMarker: '---',
      };
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // Read 1: links omitted
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Calc Link'],
            ['<--->'],
            ['Open', 'Link'],
            ['<--->'],
          ],
        },
      });
      const omittedResult = await client.readTable({ target });

      // Read 2: links populated (both string and null values)
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Calc Link'],
            ['<--->'],
            ['Open', 'Link'],
            ['Closed', ''],
            ['<--->'],
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'Submittal Arch'!B5:B6",
              values: [['=HYPERLINK("https://example.com/doc", "Link")'], ['']],
            },
          ],
        },
      });
      const populatedResult = await client.readTable({ target, linkColumns: ['Calc Link'] });

      const prevPolicy = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(Value.Check(ReadPositiveTableRequestSchema, { target })).toBe(true);
        expect(Value.Check(ReadPositiveTableRequestSchema, { target, linkColumns: undefined })).toBe(
          true
        );
        expect(
          Value.Check(ReadPositiveTableRequestSchema, { target, linkColumns: ['Calc Link'] })
        ).toBe(true);

        expect(omittedResult.rows).toHaveLength(1);
        expect('links' in omittedResult.rows[0]!).toBe(false);
        expect(Value.Check(PositiveTableRowSchema, omittedResult.rows[0])).toBe(true);

        expect(populatedResult.rows).toHaveLength(2);
        expect(populatedResult.rows[0]!.links).toEqual({
          'Calc Link': 'https://example.com/doc',
        });
        expect(populatedResult.rows[1]!.links).toEqual({ 'Calc Link': null });
        for (const row of populatedResult.rows) {
          expect(Value.Check(PositiveTableRowSchema, row)).toBe(true);
        }
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prevPolicy;
      }
    });

    it('retries HTTP 429 with exponential backoff on values.batchGet during readTable', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const initialDelayMs = 75;

      try {
        mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
        mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
          data: {
            values: [
              ['Status', 'Calc Link'], // Row 3
              ['<--->'], // Row 4
              ['Open', 'Link'], // Row 5
              ['<--->'], // Row 6
            ],
          },
        });
        mockSheetsApi.spreadsheets.values.batchGet
          .mockRejectedValueOnce({ statusCode: 429, message: 'Rate limit' })
          .mockResolvedValueOnce({
            data: {
              valueRanges: [
                {
                  range: "'Submittal Arch'!B5:B5",
                  values: [['=HYPERLINK("https://drive.google.com/file/d/retry/view", "Link")']],
                },
              ],
            },
          });

        const client = new GoogleSheetsClient({
          sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
          retryOptions: {
            maxRetries: 3,
            initialDelayMs,
            backoffFactor: 2,
            sleep: sleepMock,
          },
        });

        const result = await client.readTable({
          target: {
            spreadsheetId: 'log-sheet-1',
            sheetName: 'Submittal Arch',
            rangeName: 'Log_Submittal_Arch',
            extentMarker: '<--->',
            groupDividerMarker: '---',
          },
          linkColumns: ['Calc Link'],
        });

        expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledTimes(2);
        expect(sleepMock).toHaveBeenCalledTimes(1);
        expect(sleepMock).toHaveBeenCalledWith(initialDelayMs);
        expect(result.rows).toEqual([
          {
            rowNumber: 5,
            values: { Status: 'Open', 'Calc Link': 'Link' },
            links: { 'Calc Link': 'https://drive.google.com/file/d/retry/view' },
          },
        ]);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('extracts and validates all =HYPERLINK(...) and raw URL edge cases via readTable', async () => {
      const cases: Array<{ label: string; cell: CellValue; expected: string | null }> = [
        {
          label: 'standard HYPERLINK formula',
          cell: '=HYPERLINK("https://drive.google.com/file/d/abc/view", "Link")',
          expected: 'https://drive.google.com/file/d/abc/view',
        },
        {
          label: 'lowercase hyperlink function name',
          cell: '=hyperlink("https://example.com/a", "A")',
          expected: 'https://example.com/a',
        },
        {
          label: 'mixed-case HyPeRlInK function name',
          cell: '=HyPeRlInK("http://example.com/b", "B")',
          expected: 'http://example.com/b',
        },
        {
          label: 'escaped double quotes inside URL',
          cell: '=HYPERLINK("https://example.com/q=""hello""", "Link")',
          expected: 'https://example.com/q="hello"',
        },
        {
          label: 'semicolon argument separator',
          cell: '=HYPERLINK("https://example.com/semi"; "Link")',
          expected: 'https://example.com/semi',
        },
        {
          label: 'URI containing semicolon and comma inside quotes',
          cell: '=HYPERLINK("https://example.com/a;b,c", "Link")',
          expected: 'https://example.com/a;b,c',
        },
        {
          label: 'single-argument HYPERLINK',
          cell: '=HYPERLINK("https://example.com/single")',
          expected: 'https://example.com/single',
        },
        {
          label: 'cell-reference 2nd argument',
          cell: '=HYPERLINK("https://example.com/cellref", B6)',
          expected: 'https://example.com/cellref',
        },
        {
          label: 'cross-sheet cell-reference 2nd argument',
          cell: '=HYPERLINK("https://example.com/sheetref", \'Submittal Arch\'!B6)',
          expected: 'https://example.com/sheetref',
        },
        {
          label: 'nested formula 2nd argument',
          cell: '=HYPERLINK("https://example.com/nested", IF(A6="", "Empty", A6))',
          expected: 'https://example.com/nested',
        },
        {
          label: 'non-literal 1st argument (cell reference)',
          cell: '=HYPERLINK(Z6, "Link")',
          expected: null,
        },
        {
          label: 'non-literal 1st argument (string concatenation)',
          cell: '=HYPERLINK("https://example.com/" & Z6, "Link")',
          expected: null,
        },
        {
          label: 'raw https URL with surrounding whitespace',
          cell: '  https://example.com/raw  ',
          expected: 'https://example.com/raw',
        },
        {
          label: 'raw http URL',
          cell: 'http://example.com/plain',
          expected: 'http://example.com/plain',
        },
        {
          label: 'HYPERLINK containing LF newline',
          cell: '=HYPERLINK("https://example.com/a\nb", "NL")',
          expected: null,
        },
        {
          label: 'HYPERLINK containing CR',
          cell: '=HYPERLINK("https://example.com/a\rb", "CR")',
          expected: null,
        },
        {
          label: 'raw URL containing LF newline',
          cell: 'https://example.com/a\nb',
          expected: null,
        },
        {
          label: 'raw URL with trailing LF newline',
          cell: 'https://example.com/trailing\n',
          expected: null,
        },
        {
          label: 'HYPERLINK with trailing CR inside URI',
          cell: '=HYPERLINK("https://example.com/trailing\r", "CR")',
          expected: null,
        },
        {
          label: 'sheet-quoted 2nd arg with unbalanced paren inside sheet title',
          cell: '=HYPERLINK("https://example.com/sheetparen", \'Sheet )1\'!B6)',
          expected: 'https://example.com/sheetparen',
        },
        {
          label: 'HYPERLINK javascript protocol',
          cell: '=HYPERLINK("javascript:alert(1)", "XSS")',
          expected: null,
        },
        {
          label: 'HYPERLINK ftp protocol',
          cell: '=HYPERLINK("ftp://example.com/a.pdf", "FTP")',
          expected: null,
        },
        {
          label: 'HYPERLINK file protocol',
          cell: '=HYPERLINK("file:///etc/passwd", "File")',
          expected: null,
        },
        {
          label: 'HYPERLINK data protocol',
          cell: '=HYPERLINK("data:text/html,hi", "Data")',
          expected: null,
        },
        {
          label: 'raw javascript protocol',
          cell: 'javascript:alert(1)',
          expected: null,
        },
        {
          label: 'raw mailto protocol',
          cell: 'mailto:a@b.com',
          expected: null,
        },
        {
          label: 'non-HYPERLINK formula cell reference',
          cell: '=A6',
          expected: null,
        },
        {
          label: 'non-HYPERLINK string literal formula',
          cell: '="https://example.com"',
          expected: null,
        },
        {
          label: 'HYPERLINK with trailing concatenation token',
          cell: '=HYPERLINK("https://a.com", "b") & "c"',
          expected: null,
        },
        {
          label: 'HYPERLINK with empty 2nd argument',
          cell: '=HYPERLINK("https://a.com", )',
          expected: null,
        },
        {
          label: 'plain display text',
          cell: 'Link',
          expected: null,
        },
        {
          label: 'empty string',
          cell: '',
          expected: null,
        },
        {
          label: 'null value',
          cell: null,
          expected: null,
        },
        {
          label: 'number value',
          cell: 42,
          expected: null,
        },
        {
          label: 'boolean value',
          cell: true,
          expected: null,
        },
      ];

      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({ data: createArchMetadata() });
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: {
          values: [
            ['Status', 'Calc Link'], // Row 3 (rel 0)
            ['<--->'], // Row 4 (rel 1 = topAnchor)
            ...cases.map((c, idx) => [
              `Row ${idx + 1}`,
              typeof c.cell === 'string' ? 'Link' : c.cell,
            ]),
            ['<--->'], // bottomAnchor
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: `'Submittal Arch'!B5:B${4 + cases.length}`,
              values: cases.map((c) => [c.cell]),
            },
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.readTable({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        linkColumns: ['Calc Link'],
      });

      expect(result.rows).toHaveLength(cases.length);
      for (const [idx, testCase] of cases.entries()) {
        expect(result.rows[idx]?.links, testCase.label).toEqual({
          'Calc Link': testCase.expected,
        });
      }
    });
  });

  describe('insertIntoGroupedList (positive-termination foundation)', () => {
    const createFfeClearedTemplateState = (betweenRows: SimRow[]): SimSheetState => {
      const headers = [
        'Status',
        'Spec Tag',
        'Related Tag',
        'Revision',
        'Spec Title',
        'Vendor',
        'Date',
        'Contact',
        'Action',
        'Notes',
        'Calc Link',
      ];
      const formulaRow = [
        'Formula Row',
        '',
        '',
        '',
        '=ARRAYFORMULA(IF(B6:B="","",VLOOKUP(B6:B,Options_Specs,2,FALSE)))',
      ];
      const grid: SimRow[] = [
        { style: 'title', cells: [toSimCell('Project Log')] }, // Row 1 (idx 0)
        { style: 'spacer', cells: [] }, // Row 2 (idx 1)
        { style: 'header', cells: headers.map(toSimCell) }, // Row 3 (idx 2)
        { style: 'formula', cells: formulaRow.map(toSimCell) }, // Row 4 (idx 3)
        { style: 'anchor', cells: [toSimCell('<--->')] }, // Row 5 (idx 4)
        ...betweenRows,
        { style: 'anchor', cells: [toSimCell('<--->')] }, // bottomAnchor
      ];
      return {
        sheetId: 22,
        title: 'Submittal FF&E',
        grid,
        namedRange: {
          name: 'Log_Submittal_FFE',
          startRowIndex: 2,
          endRowIndex: grid.length,
          startColumnIndex: 0,
          endColumnIndex: headers.length,
        },
      };
    };

    const ffeTarget: PositiveTableTarget = {
      spreadsheetId: 'sim-sheet-id',
      sheetName: 'Submittal FF&E',
      rangeName: 'Log_Submittal_FFE',
      extentMarker: '<--->',
      groupDividerMarker: '---',
    };

    it('reuses single clean formatted placeholder row in empty cleared template and preserves readOnly/formula columns', async () => {
      const state = createFfeClearedTemplateState([
        { style: 'clean-data-row', cells: [] }, // Row 6 (idx 5)
      ]);
      // Pre-seed untouched formula cell on placeholder row (E6) that displays blank until populated,
      // verifying updateCells skips Spec Title and leaves underlying cell intact
      state.grid[5].cells[4] = { kind: 'formula', value: '=SPILL_VALUE', formattedValue: '' };
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target: ffeTarget,
        rowData: {
          Status: 'Open',
          'Spec Tag': 'CG104',
          'Related Tag': 'FB127',
          Revision: '0',
          'Spec Title': 'SHOULD_NOT_WRITE',
          Vendor: 'Keystone Casegoods',
          Date: '260120',
          Contact: 'HPG',
          Action: 'Received',
          Notes: 'Headboard sample',
          'Calc Link': { formula: '=HYPERLINK("https://drive.google.com/file/d/cg104/view", "Link")' },
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(result).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 22 });

      const batchCalls = mockSheetsApi.spreadsheets.batchUpdate.mock.calls;
      expect(batchCalls).toHaveLength(1);
      const requests = batchCalls[0][0].requestBody.requests as sheets_v4.Schema$Request[];
      expect(requests.some((r) => r.insertDimension)).toBe(false);
      expect(requests.some((r) => r.deleteDimension)).toBe(false);

      const updateReqs = requests.filter((r) => r.updateCells);
      expect(updateReqs).toHaveLength(2); // Cols 0..3 and Cols 5..10 (skipping Col 4 Spec Title)
      expect(updateReqs[0].updateCells?.range).toEqual({
        sheetId: 22,
        startRowIndex: 5,
        endRowIndex: 6,
        startColumnIndex: 0,
        endColumnIndex: 4,
      });
      expect(updateReqs[1].updateCells?.range).toEqual({
        sheetId: 22,
        startRowIndex: 5,
        endRowIndex: 6,
        startColumnIndex: 5,
        endColumnIndex: 11,
      });

      expect(state.grid[5].style).toBe('clean-data-row');
      expect(state.grid[5].cells[4]).toEqual({
        kind: 'formula',
        value: '=SPILL_VALUE',
        formattedValue: '',
      });
      expect(state.grid[5].cells[10]).toEqual({
        kind: 'formula',
        value: '=HYPERLINK("https://drive.google.com/file/d/cg104/view", "Link")',
      });
      expect(state.grid[6].cells[0].value).toBe('<--->');

      const table = await client.readTable({ target: ffeTarget });
      expect(table.rows).toHaveLength(1);
      expect(table.rows[0].rowNumber).toBe(6);
      expect(table.rows[0].values['Spec Tag']).toBe('CG104');
      expect(table.rows[0].values.Date).toBe('260120');
    });

    it('deletes excess blank/divider rows when writing to empty log with multiple placeholder/divider rows', async () => {
      const state = createFfeClearedTemplateState([
        { style: 'divider', cells: [toSimCell('---')] }, // Row 6 (idx 5)
        { style: 'clean-data-row', cells: [] }, // Row 7 (idx 6)
        { style: 'blank', cells: [] }, // Row 8 (idx 7)
        { style: 'divider', cells: [toSimCell('---')] }, // Row 9 (idx 8)
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target: ffeTarget,
        rowData: {
          Status: 'Open',
          'Spec Tag': 'FB127',
          Revision: '0',
          Vendor: 'Atlas Textiles',
          Date: '260118',
          Contact: 'HPG',
          Action: 'Received',
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(result).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 22 });
      expect(state.grid).toHaveLength(7); // rows 0..4 + 1 data row (idx 5) + bottomAnchor (idx 6)
      expect(state.grid[5].style).toBe('clean-data-row');
      expect(state.grid[6].cells[0].value).toBe('<--->');

      const table = await client.readTable({ target: ffeTarget });
      expect(table.rows).toHaveLength(1);
      expect(table.rows[0].rowNumber).toBe(6);
      expect(table.rows[0].values['Spec Tag']).toBe('FB127');
    });

    it('clears stray groupDividerMarker when overwriting a divider-only empty log without Status in rowData', async () => {
      const state = createFfeClearedTemplateState([
        { style: 'divider', cells: [toSimCell('---')] }, // Row 6 (idx 5)
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target: ffeTarget,
        rowData: {
          'Spec Tag': 'LT108',
          Revision: '0',
          Vendor: 'Crestline Lighting',
        },
      });

      expect(result).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 22 });
      const table = await client.readTable({ target: ffeTarget });
      expect(table.rows).toHaveLength(1);
      expect(table.rows[0].values.Status).toBe('');
      expect(table.rows[0].values['Spec Tag']).toBe('LT108');
    });

    it('recovers cleanly when 0 rows exist between anchors by inserting at bottomAnchor with inheritFromBefore: false', async () => {
      const state = createFfeClearedTemplateState([]); // topAnchor idx 4, bottomAnchor idx 5
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target: ffeTarget,
        rowData: {
          Status: 'Open',
          'Spec Tag': 'AC102',
          Revision: '0',
          Vendor: 'Northstar Furnishings',
          Date: '260112',
          Contact: 'HPG',
          Action: 'Received',
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(result).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 22 });

      const requests = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      expect(requests[0]).toEqual({
        insertDimension: {
          range: {
            sheetId: 22,
            dimension: 'ROWS',
            startIndex: 5,
            endIndex: 6,
          },
          inheritFromBefore: false,
        },
      });

      expect(state.grid[5].style).toBe('anchor'); // inherited from bottomAnchor (idx 5), NOT topAnchor!
      expect(state.grid[6].cells[0].value).toBe('<--->');
      expect(state.namedRange.endRowIndex).toBe(7);

      const table = await client.readTable({ target: ffeTarget });
      expect(table.rows).toHaveLength(1);
      expect(table.rows[0].rowNumber).toBe(6);
      expect(table.rows[0].values['Spec Tag']).toBe('AC102');
    });

    it('appends row strictly inside (topAnchor, bottomAnchor] on non-empty log with inheritFromBefore: true', async () => {
      const state = createFfeClearedTemplateState([
        {
          style: 'clean-data-row',
          cells: [
            toSimCell('Closed'),
            toSimCell('033000'),
            toSimCell(''),
            toSimCell('0'),
            { kind: 'formula', value: '=ARRAY_1' },
            toSimCell('Keystone Casegoods'),
            toSimCell('260115'),
            toSimCell('MB'),
            toSimCell('Received'),
            toSimCell('First entry'),
            toSimCell('Link'),
          ],
        },
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target: ffeTarget,
        rowData: {
          Status: 'Open',
          'Spec Tag': 'CG104',
          Revision: '0',
          Vendor: 'Keystone Casegoods',
          Date: '260120',
          Contact: 'HPG',
          Action: 'Received',
          Notes: 'Second entry',
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(result).toEqual({ rowNumber: 7, action: 'inserted', sheetId: 22 });

      const requests = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      expect(requests[0]).toEqual({
        insertDimension: {
          range: {
            sheetId: 22,
            dimension: 'ROWS',
            startIndex: 6,
            endIndex: 7,
          },
          inheritFromBefore: true,
        },
      });

      expect(state.grid[6].style).toBe('clean-data-row');
      expect(state.grid[7].cells[0].value).toBe('<--->');
      expect(state.namedRange.endRowIndex).toBe(8);

      const table = await client.readTable({ target: ffeTarget });
      expect(table.rows.map((r) => r.rowNumber)).toEqual([6, 7]);
      expect(table.rows[1].values['Spec Tag']).toBe('CG104');
    });

    it('handles offset Named Range columns, reordered headers, and leaves unrecognized helper columns untouched', async () => {
      const state: SimSheetState = {
        sheetId: 33,
        title: 'Custom Sheet',
        grid: [
          { style: 'top', cells: [] }, // Row 1 (idx 0)
          {
            style: 'header',
            cells: [
              toSimCell('OutsideA'),
              toSimCell('OutsideB'),
              toSimCell('Notes'),
              toSimCell('UserHelper'),
              toSimCell('Status'),
              toSimCell('Spec Title'),
              toSimCell('Section'),
            ],
          }, // Row 2 (idx 1)
          { style: 'anchor', cells: [toSimCell(''), toSimCell(''), toSimCell('<--->')] }, // Row 3 (idx 2)
          {
            style: 'clean-data-row',
            cells: [
              toSimCell('keepA'),
              toSimCell('keepB'),
              toSimCell(''),
              { kind: 'formula', value: '=USER_HELPER()', formattedValue: '' },
              toSimCell(''),
              { kind: 'formula', value: '=AUTO_TITLE()', formattedValue: '' },
              toSimCell(''),
            ],
          }, // Row 4 (idx 3)
          { style: 'anchor', cells: [toSimCell(''), toSimCell(''), toSimCell('<--->')] }, // Row 5 (idx 4)
        ],
        namedRange: {
          name: 'OffsetTable',
          startRowIndex: 1,
          endRowIndex: 5,
          startColumnIndex: 2, // Column C!
          endColumnIndex: 7, // Column G!
        },
      };
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sim-sheet-id',
          sheetName: 'Custom Sheet',
          rangeName: 'OffsetTable',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        rowData: {
          Status: 'Open',
          Section: '071200',
          Notes: 'Offset test',
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(result).toEqual({ rowNumber: 4, action: 'inserted', sheetId: 33 });
      expect(state.grid[3].cells[0].value).toBe('keepA');
      expect(state.grid[3].cells[3].value).toBe('=USER_HELPER()');
      expect(state.grid[3].cells[5].value).toBe('=AUTO_TITLE()');
      expect(state.grid[3].cells[2].value).toBe('Offset test');
      expect(state.grid[3].cells[4].value).toBe('Open');
      expect(state.grid[3].cells[6].value).toBe('071200');
    });

    it('prevents spreadsheet formula injection by writing user strings (leading =, +, -, @) strictly as stringValue', async () => {
      const state = createFfeClearedTemplateState([{ style: 'clean-data-row', cells: [] }]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      await client.insertIntoGroupedList({
        target: ffeTarget,
        rowData: {
          Status: '=1+1',
          'Spec Tag': '+CMD',
          Revision: '-100',
          Notes: '@foo',
          'Calc Link': { formula: '=HYPERLINK("https://example.com/a.pdf", "Link")' },
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(state.grid[5].cells[0]).toEqual({ kind: 'string', value: '=1+1' });
      expect(state.grid[5].cells[1]).toEqual({ kind: 'string', value: '+CMD' });
      expect(state.grid[5].cells[3]).toEqual({ kind: 'string', value: '-100' });
      expect(state.grid[5].cells[9]).toEqual({ kind: 'string', value: '@foo' });
      expect(state.grid[5].cells[10]).toEqual({
        kind: 'formula',
        value: '=HYPERLINK("https://example.com/a.pdf", "Link")',
      });
    });

    it('fails fast with GoogleSheetsColumnNotFoundError when a writable key in rowData is missing from Header Row while tolerating missing readOnlyColumns', async () => {
      const state = createFfeClearedTemplateState([{ style: 'clean-data-row', cells: [] }]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: ffeTarget,
          rowData: {
            Status: 'Open',
            MissingHeader: 'value',
          },
        })
      ).rejects.toThrow(GoogleSheetsColumnNotFoundError);
      expect(mockSheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();

      // Missing readOnly column is tolerated cleanly
      const result = await client.insertIntoGroupedList({
        target: ffeTarget,
        rowData: {
          Status: 'Open',
          DeletedFormulaCol: 'ignored',
        },
        readOnlyColumns: ['DeletedFormulaCol'],
      });
      expect(result).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 22 });
    });

    it('serializes concurrent writes to the same spreadsheetId via KeyedAsyncLock and allows parallel writes to different spreadsheets', async () => {
      const callLog: string[] = [];
      mockSheetsApi.spreadsheets.get.mockImplementation(async ({ spreadsheetId }: { spreadsheetId: string }) => ({
        data: {
          spreadsheetId,
          sheets: [{ properties: { sheetId: 1, title: 'Submittal Arch' } }],
          namedRanges: [
            {
              namedRangeId: 'nr-1',
              name: 'Log_Submittal_Arch',
              range: { sheetId: 1, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 2 },
            },
          ],
        },
      }));
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ spreadsheetId }: { spreadsheetId: string }) => {
        callLog.push(`read:${spreadsheetId}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          data: {
            values: [
              ['Status', 'Section'],
              ['<--->'],
              ['Open', '071200'],
              ['<--->'],
            ],
          },
        };
      });
      mockSheetsApi.spreadsheets.batchUpdate.mockImplementation(async ({ spreadsheetId }: { spreadsheetId: string }) => {
        callLog.push(`write:${spreadsheetId}`);
        return { data: {} };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const targetA: PositiveTableTarget = {
        spreadsheetId: 'sheet-A',
        sheetName: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        extentMarker: '<--->',
        groupDividerMarker: '---',
      };
      const targetB: PositiveTableTarget = {
        ...targetA,
        spreadsheetId: 'sheet-B',
      };

      const [res1, res2, resB] = await Promise.all([
        client.insertIntoGroupedList({ target: targetA, rowData: { Status: 'Open', Section: '033000' } }),
        client.insertIntoGroupedList({ target: targetA, rowData: { Status: 'Closed', Section: '071200' } }),
        client.insertIntoGroupedList({ target: targetB, rowData: { Status: 'Open', Section: '087100' } }),
      ]);

      expect(res1).toEqual({ rowNumber: 4, action: 'inserted', sheetId: 1 });
      expect(res2).toEqual({ rowNumber: 4, action: 'inserted', sheetId: 1 });
      expect(resB).toEqual({ rowNumber: 4, action: 'inserted', sheetId: 1 });

      const aEvents = callLog.filter((e) => e.endsWith(':sheet-A'));
      expect(aEvents).toEqual(['read:sheet-A', 'write:sheet-A', 'read:sheet-A', 'write:sheet-A']);
    });

    it('retries HTTP 429 during insertIntoGroupedList batchUpdate with exponential backoff', async () => {
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      try {
        const state = createFfeClearedTemplateState([{ style: 'clean-data-row', cells: [] }]);
        wireSimulator(state);

        const originalBatchUpdate = mockSheetsApi.spreadsheets.batchUpdate.getMockImplementation()!;
        mockSheetsApi.spreadsheets.batchUpdate
          .mockRejectedValueOnce({ statusCode: 429, message: 'Quota exceeded' })
          .mockImplementationOnce(originalBatchUpdate);

        const client = new GoogleSheetsClient({
          sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
          retryOptions: {
            maxRetries: 2,
            initialDelayMs: 50,
            backoffFactor: 2,
            sleep: sleepMock,
          },
        });

        const result = await client.insertIntoGroupedList({
          target: ffeTarget,
          rowData: { Status: 'Open', 'Spec Tag': 'CG104' },
          readOnlyColumns: ['Spec Title'],
        });

        expect(result).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 22 });
        expect(sleepMock).toHaveBeenCalledTimes(1);
        expect(sleepMock).toHaveBeenCalledWith(50);
      } finally {
        randomSpy.mockRestore();
      }
    });
  });

  describe('insertIntoGroupedList (grouped/sorted placement, dividers & duplicatePolicy)', () => {
    const target: PositiveTableTarget = {
      spreadsheetId: 'sim-grouped-id',
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      extentMarker: '<--->',
      groupDividerMarker: '---',
    };

    const headers = ['Status', 'Group', 'SortKey', 'Spec Title', 'Helper', 'Notes'];

    const makeDataRow = (
      status: string,
      group: string,
      sortKey: string,
      notes: string
    ): SimRow => ({
      style: 'clean-data-row',
      cells: [
        toSimCell(status),
        toSimCell(group),
        toSimCell(sortKey),
        { kind: 'formula', value: '=ARRAY_TITLE()', formattedValue: 'Auto Title' },
        toSimCell('user-helper'),
        toSimCell(notes),
      ],
    });

    const makeDividerSimRow = (): SimRow => ({
      style: 'divider',
      cells: [toSimCell('---')],
    });

    const makeBlankSimRow = (): SimRow => ({
      style: 'blank',
      cells: [],
    });

    const createSeededState = (betweenRows: SimRow[]): SimSheetState => {
      const grid: SimRow[] = [
        { style: 'title', cells: [toSimCell('Document Log')] }, // idx 0 (Row 1)
        { style: 'spacer', cells: [] }, // idx 1 (Row 2)
        { style: 'header', cells: headers.map(toSimCell) }, // idx 2 (Row 3)
        { style: 'formula', cells: [toSimCell('Formula Row'), toSimCell(''), toSimCell(''), toSimCell('=ARRAYFORMULA(...)')] }, // idx 3 (Row 4)
        { style: 'anchor', cells: [toSimCell('<--->')] }, // idx 4 (Row 5)
        ...betweenRows,
        { style: 'anchor', cells: [toSimCell('<--->')] }, // bottomAnchor
      ];
      return {
        sheetId: 10,
        title: 'Submittal Arch',
        grid,
        namedRange: {
          name: 'Log_Submittal_Arch',
          startRowIndex: 2,
          endRowIndex: grid.length,
          startColumnIndex: 0,
          endColumnIndex: headers.length,
        },
      };
    };

    const rowKeyExtractor = (row: Record<string, CellValue>) => {
      const group = typeof row.Group === 'string' ? row.Group.trim() : '';
      if (!group) return null;
      const sort = typeof row.SortKey === 'string' ? row.SortKey : '';
      return { groupKey: group, sortKey: sort };
    };

    it('inserts a top new group immediately below topAnchor with inheritFromBefore: false and a Column-0-only "---" divider below', async () => {
      const state = createSeededState([
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'Concrete'),
        makeDividerSimRow(),
        makeDataRow('Open', '071200-001', '071200-001-0-260204-1', 'Waterproofing'),
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '013300-001',
          SortKey: '013300-001-0-260110-1',
          'Spec Title': 'IGNORED',
          Notes: 'Baseline',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '013300-001', sortKey: '013300-001-0-260110-1' },
        readOnlyColumns: ['Spec Title'],
      });

      expect(result).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 10 });

      const requests = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      const insertReq = requests[0].insertDimension!;
      expect(insertReq.range?.startIndex).toBe(5);
      expect(insertReq.range?.endIndex).toBe(7);
      expect(insertReq.inheritFromBefore).toBe(false);

      // Divider updateCells writes ONLY to Column 0
      const dividerUpdate = requests.find(
        (r) => r.updateCells?.range?.startRowIndex === 6
      )?.updateCells;
      expect(dividerUpdate?.range).toEqual({
        sheetId: 10,
        startRowIndex: 6,
        endRowIndex: 7,
        startColumnIndex: 0,
        endColumnIndex: 1,
      });
      expect(dividerUpdate?.rows?.[0]?.values).toEqual([{ userEnteredValue: { stringValue: '---' } }]);

      expect(state.grid[5].style).toBe('clean-data-row');
      expect(state.grid[5].cells[1].value).toBe('013300-001');
      expect(state.grid[6].cells[0].value).toBe('---');
      expect(state.grid[6].cells.length).toBe(1);
      expect(state.grid[7].cells[1].value).toBe('033000-001');
      expect(state.grid[4].cells[0].value).toBe('<--->');
      expect(state.grid[10].cells[0].value).toBe('<--->');
      expect(state.namedRange.endRowIndex).toBe(11);
    });

    it('inserts a middle new group reusing an existing "---" divider and adds missing dividers when absent', async () => {
      // Case A: Existing divider between 033000-001 and 087100-001
      const stateWithDivider = createSeededState([
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'Concrete'),
        makeDividerSimRow(),
        makeDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'Hardware'),
      ]);
      wireSimulator(stateWithDivider);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const resA = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '075100-001',
          SortKey: '075100-001-0-260220-1',
          Notes: 'Roofing',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '075100-001', sortKey: '075100-001-0-260220-1' },
      });

      expect(resA).toEqual({ rowNumber: 8, action: 'inserted', sheetId: 10 });
      const reqsA = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      expect(reqsA[0].insertDimension?.inheritFromBefore).toBe(true);
      expect(stateWithDivider.grid[5].cells[1].value).toBe('033000-001');
      expect(stateWithDivider.grid[6].cells[0].value).toBe('---');
      expect(stateWithDivider.grid[7].style).toBe('clean-data-row');
      expect(stateWithDivider.grid[7].cells[1].value).toBe('075100-001');
      expect(stateWithDivider.grid[8].cells[0].value).toBe('---');
      expect(stateWithDivider.grid[9].cells[1].value).toBe('087100-001');
      expect(stateWithDivider.grid[10].cells[0].value).toBe('<--->');

      // Case B: No divider previously existed between 033000-001 and 087100-001
      const stateNoDivider = createSeededState([
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'Concrete'),
        makeDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'Hardware'),
      ]);
      wireSimulator(stateNoDivider);

      const resB = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '075100-001',
          SortKey: '075100-001-0-260220-1',
          Notes: 'Roofing',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '075100-001', sortKey: '075100-001-0-260220-1' },
      });

      expect(resB).toEqual({ rowNumber: 8, action: 'inserted', sheetId: 10 });
      expect(stateNoDivider.grid[5].cells[1].value).toBe('033000-001');
      expect(stateNoDivider.grid[6].cells[0].value).toBe('---');
      expect(stateNoDivider.grid[7].cells[1].value).toBe('075100-001');
      expect(stateNoDivider.grid[8].cells[0].value).toBe('---');
      expect(stateNoDivider.grid[9].cells[1].value).toBe('087100-001');
      expect(stateNoDivider.grid[10].cells[0].value).toBe('<--->');
    });

    it('inserts a bottom new group inside (topAnchor, bottomAnchor] with leading "---" divider and zero dividers adjacent to bottomAnchor', async () => {
      const state = createSeededState([
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'Concrete'),
        makeDividerSimRow(),
        makeDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'Hardware'),
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const result = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '096500-001',
          SortKey: '096500-001-0-260314-1',
          Notes: 'Flooring',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '096500-001', sortKey: '096500-001-0-260314-1' },
      });

      expect(result).toEqual({ rowNumber: 10, action: 'inserted', sheetId: 10 });
      expect(state.grid[7].cells[1].value).toBe('087100-001');
      expect(state.grid[8].cells[0].value).toBe('---');
      expect(state.grid[9].style).toBe('clean-data-row');
      expect(state.grid[9].cells[1].value).toBe('096500-001');
      expect(state.grid[10].cells[0].value).toBe('<--->');
      expect(state.namedRange.endRowIndex).toBe(11);
    });

    it('supports groupSortOrder: desc and rowSortOrder: desc', async () => {
      const state = createSeededState([
        makeDataRow('Manager', '087100-001', '087100-001-0-260305-3', 'Later'),
        makeDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'Earlier'),
        makeDividerSimRow(),
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'Concrete'),
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // Middle group 071200-001 sorts between 087100-001 and 033000-001 in desc order
      const midRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260204-1',
          Notes: 'Middle desc',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260204-1' },
        groupSortOrder: 'desc',
        rowSortOrder: 'desc',
      });
      expect(midRes).toEqual({ rowNumber: 9, action: 'inserted', sheetId: 10 });

      // Row inside 087100-001 with sortKey 260304-2 sorts between 260305-3 and 260303-1 in desc order
      const rowRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Manager',
          Group: '087100-001',
          SortKey: '087100-001-0-260304-2',
          Notes: 'Mid row desc',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '087100-001', sortKey: '087100-001-0-260304-2' },
        groupSortOrder: 'desc',
        rowSortOrder: 'desc',
      });
      expect(rowRes).toEqual({ rowNumber: 7, action: 'inserted', sheetId: 10 });

      const table = await client.readTable({ target });
      expect(table.rows.map((r) => r.values.SortKey)).toEqual([
        '087100-001-0-260305-3',
        '087100-001-0-260304-2',
        '087100-001-0-260303-1',
        '071200-001-0-260204-1',
        '033000-001-0-260115-1',
      ]);
    });

    it('uses inheritFromBefore: false when inserting before first row of first existing group and appends duplicatePolicy: insert after equal sortKeys', async () => {
      const state = createSeededState([
        makeDataRow('Open', '071200-001', '071200-001-0-260205-2', 'First referral PST'),
        makeDataRow('Open', '071200-001', '071200-001-0-260205-2', 'Second referral SME'),
        makeDataRow('Open', '071200-001', '071200-001-0-260212-5', 'RR'),
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // 1. Insert earlier than first row -> absInsertIndex === topAnchor + 1 -> inheritFromBefore: false
      const firstRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260204-1',
          Notes: 'REC before referrals',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260204-1' },
      });
      expect(firstRes).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 10 });
      const firstReq = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      expect(firstReq[0].insertDimension?.inheritFromBefore).toBe(false);
      expect(state.grid[5].style).toBe('clean-data-row');

      // 2. Insert duplicate sortKey with duplicatePolicy: insert -> placed AFTER both 260205-2 referrals
      const dupRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260205-2',
          Notes: 'Third referral LMD',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260205-2' },
        duplicatePolicy: 'insert',
      });
      expect(dupRes).toEqual({ rowNumber: 9, action: 'inserted', sheetId: 10 });

      const table = await client.readTable({ target });
      expect(table.rows.map((r) => r.values.Notes)).toEqual([
        'REC before referrals',
        'First referral PST',
        'Second referral SME',
        'Third referral LMD',
        'RR',
      ]);
    });

    it('enforces duplicatePolicy: upsert (in-place update preserving protected/helper columns) and reject (throws before mutation)', async () => {
      const state = createSeededState([
        makeDataRow('Open', '071200-001', '071200-001-0-260204-1', 'Original note'),
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // reject throws GoogleSheetsDuplicateKeyError with zero batchUpdate calls
      await expect(
        client.insertIntoGroupedList({
          target,
          rowData: {
            Status: 'Closed',
            Group: '071200-001',
            SortKey: '071200-001-0-260204-1',
            Notes: 'Should not write',
          },
          rowKeyExtractor,
          targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260204-1' },
          duplicatePolicy: 'reject',
        })
      ).rejects.toThrow(GoogleSheetsDuplicateKeyError);
      expect(mockSheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();

      // upsert updates writable cells in place without inserting rows and preserves Spec Title & Helper
      const upsertRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Closed',
          Group: '071200-001',
          SortKey: '071200-001-0-260204-1',
          'Spec Title': 'DO_NOT_OVERWRITE',
          Notes: null,
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260204-1' },
        duplicatePolicy: 'upsert',
        readOnlyColumns: ['Spec Title'],
      });

      expect(upsertRes).toEqual({ rowNumber: 6, action: 'updated', sheetId: 10 });
      const upsertReqs = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      expect(upsertReqs.some((r) => r.insertDimension)).toBe(false);
      expect(upsertReqs.some((r) => r.deleteDimension)).toBe(false);

      expect(state.grid[5].cells[0].value).toBe('Closed');
      expect(state.grid[5].cells[3]).toEqual({
        kind: 'formula',
        value: '=ARRAY_TITLE()',
        formattedValue: 'Auto Title',
      });
      expect(state.grid[5].cells[4].value).toBe('user-helper');
      expect(state.grid[5].cells[5]).toEqual({ kind: 'empty', value: '' });
      expect(state.grid).toHaveLength(7); // no rows added
    });

    it('preserves existing rows where rowKeyExtractor returns null safely without crashing', async () => {
      const state = createSeededState([
        makeDataRow('Open', '', '', 'Unkeyable malformed row'),
        makeDataRow('Open', '071200-001', '071200-001-0-260204-1', 'Valid row'),
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const res = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260212-5',
          Notes: 'New valid row',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260212-5' },
      });

      expect(res).toEqual({ rowNumber: 8, action: 'inserted', sheetId: 10 });
      expect(state.grid[5].cells[5].value).toBe('Unkeyable malformed row');
      expect(state.grid[6].cells[5].value).toBe('Valid row');
      expect(state.grid[7].cells[5].value).toBe('New valid row');

      // Also when ALL existing data rows return null
      const allNullState = createSeededState([
        makeDataRow('Open', '', '', 'Only malformed row'),
      ]);
      wireSimulator(allNullState);
      const allNullRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260204-1',
          Notes: 'Appended safely',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260204-1' },
      });
      expect(allNullRes).toEqual({ rowNumber: 7, action: 'inserted', sheetId: 10 });
      expect(allNullState.grid[5].cells[5].value).toBe('Only malformed row');
      expect(allNullState.grid[6].cells[5].value).toBe('Appended safely');
    });

    it('automatically protects pre-<---> formulaColumns without readOnlyColumns on insert and upsert across reordered headers and custom user columns', async () => {
      const customHeaders = [
        'Notes',
        'CustomHelper',
        'Status',
        'Spec Title',
        'CustomFormula',
        'Group',
        'SortKey',
      ];
      const state: SimSheetState = {
        sheetId: 44,
        title: 'Submittal FF&E',
        grid: [
          { style: 'title', cells: [toSimCell('Project Log')] }, // Row 1 (idx 0)
          { style: 'spacer', cells: [] }, // Row 2 (idx 1)
          { style: 'header', cells: customHeaders.map(toSimCell) }, // Row 3 (idx 2)
          {
            style: 'formula',
            cells: [
              toSimCell('Formula Row'),
              toSimCell(''),
              toSimCell(''),
              toSimCell('=ARRAYFORMULA(IF(F6:F="","",VLOOKUP(F6:F,Options_Specs,2,FALSE)))'),
              toSimCell('=ARRAYFORMULA(IF(F6:F="","",F6:F&"-CALC"))'),
            ],
          }, // Row 4 (idx 3)
          { style: 'anchor', cells: [toSimCell(''), toSimCell(''), toSimCell('<--->')] }, // Row 5 (idx 4)
          {
            style: 'clean-data-row',
            cells: [
              toSimCell('Initial note'),
              toSimCell('keep-helper-1'),
              toSimCell('Open'),
              { kind: 'formula', value: '=SPILL_TITLE_1', formattedValue: 'BED - KING' },
              { kind: 'formula', value: '=SPILL_CALC_1', formattedValue: 'CG104-CALC' },
              toSimCell('CG104'),
              toSimCell('CG104-0-260120-1'),
            ],
          }, // Row 6 (idx 5)
          { style: 'anchor', cells: [toSimCell(''), toSimCell(''), toSimCell('<--->')] }, // Row 7 (idx 6)
        ],
        namedRange: {
          name: 'Log_Submittal_FFE',
          startRowIndex: 2,
          endRowIndex: 7,
          startColumnIndex: 0,
          endColumnIndex: customHeaders.length,
        },
      };
      wireSimulator(state, 'sim-auto-protect-id');

      const ffeCustomTarget: PositiveTableTarget = {
        spreadsheetId: 'sim-auto-protect-id',
        sheetName: 'Submittal FF&E',
        rangeName: 'Log_Submittal_FFE',
        extentMarker: '<--->',
        groupDividerMarker: '---',
      };

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // 1. Insert WITHOUT passing readOnlyColumns even when rowData carries Spec Title & CustomFormula keys
      const insertRes = await client.insertIntoGroupedList({
        target: ffeCustomTarget,
        rowData: {
          Status: 'Open',
          Group: 'CG104',
          SortKey: 'CG104-1-260205-1',
          'Spec Title': 'SHOULD_NOT_WRITE_TITLE',
          CustomFormula: 'SHOULD_NOT_WRITE_FORMULA',
          Notes: 'Inserted note',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: 'CG104', sortKey: 'CG104-1-260205-1' },
      });

      expect(insertRes).toEqual({ rowNumber: 7, action: 'inserted', sheetId: 44 });
      const insertReqs = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      const insertUpdates = insertReqs.filter((r) => r.updateCells);
      // Minimal contiguous writable runs: [0] (Notes), [2] (Status), [5..6] (Group, SortKey)
      expect(insertUpdates.map((r) => r.updateCells?.range)).toEqual([
        { sheetId: 44, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 1 },
        { sheetId: 44, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 2, endColumnIndex: 3 },
        { sheetId: 44, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 5, endColumnIndex: 7 },
      ]);
      expect(state.grid[6].cells[0].value).toBe('Inserted note');
      expect(state.grid[6].cells[1]).toEqual({ kind: 'empty', value: '' }); // CustomHelper untouched
      expect(state.grid[6].cells[2].value).toBe('Open');
      expect(state.grid[6].cells[3]).toEqual({ kind: 'empty', value: '' }); // Spec Title untouched
      expect(state.grid[6].cells[4]).toEqual({ kind: 'empty', value: '' }); // CustomFormula untouched
      expect(state.grid[6].cells[5].value).toBe('CG104');
      expect(state.grid[6].cells[6].value).toBe('CG104-1-260205-1');

      // 2. Upsert WITHOUT passing readOnlyColumns on Row 6 -> protects Spec Title, CustomFormula, CustomHelper
      const upsertRes = await client.insertIntoGroupedList({
        target: ffeCustomTarget,
        rowData: {
          Status: 'Closed',
          Group: 'CG104',
          SortKey: 'CG104-0-260120-1',
          'Spec Title': 'OVERWRITE_BLOCKED',
          CustomFormula: 'OVERWRITE_BLOCKED_2',
          Notes: 'Updated note',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: 'CG104', sortKey: 'CG104-0-260120-1' },
        duplicatePolicy: 'upsert',
      });

      expect(upsertRes).toEqual({ rowNumber: 6, action: 'updated', sheetId: 44 });
      const upsertReqs = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[1][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      expect(upsertReqs.map((r) => r.updateCells?.range)).toEqual([
        { sheetId: 44, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 1 },
        { sheetId: 44, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 2, endColumnIndex: 3 },
        { sheetId: 44, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 5, endColumnIndex: 7 },
      ]);
      expect(state.grid[5].cells[0].value).toBe('Updated note');
      expect(state.grid[5].cells[1].value).toBe('keep-helper-1');
      expect(state.grid[5].cells[2].value).toBe('Closed');
      expect(state.grid[5].cells[3]).toEqual({
        kind: 'formula',
        value: '=SPILL_TITLE_1',
        formattedValue: 'BED - KING',
      });
      expect(state.grid[5].cells[4]).toEqual({
        kind: 'formula',
        value: '=SPILL_CALC_1',
        formattedValue: 'CG104-CALC',
      });
    });

    it('heals trapped blanks/dividers and immediate boundaries when inserting into an existing group without touching unrelated messy gaps or null-keyed rows', async () => {
      const state = createSeededState([
        makeDividerSimRow(), // idx 5: unrelated top stray divider
        makeDataRow('Closed', '013300-001', '013300-001-0-260110-1', 'G0 row'), // idx 6
        makeDividerSimRow(), // idx 7: unrelated gap messy divider 1
        makeDividerSimRow(), // idx 8: unrelated gap messy divider 2
        makeBlankSimRow(), // idx 9: unrelated gap messy blank
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'G1 row'), // idx 10
        makeBlankSimRow(), // idx 11: G1..G2 blank (no divider -> heal to 1 ---)
        makeDataRow('Open', '071200-001', '071200-001-0-260204-1', 'G2 row 1'), // idx 12
        makeBlankSimRow(), // idx 13: trapped blank inside G2
        makeDividerSimRow(), // idx 14: trapped divider inside G2
        makeDataRow('Open', '', '', 'Malformed inside G2'), // idx 15: null-keyed row inside G2 (preserve!)
        makeDataRow('Open', '071200-001', '071200-001-1-260224-6', 'G2 row 2'), // idx 16
        makeBlankSimRow(), // idx 17: G2..G3 blank (heal out)
        makeDividerSimRow(), // idx 18: G2..G3 divider 1 (keep)
        makeDividerSimRow(), // idx 19: G2..G3 divider 2 (heal out)
        makeDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'G3 row'), // idx 20
        makeDividerSimRow(), // idx 21: unrelated bottom stray divider
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const res = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260212-5',
          'Spec Title': 'IGNORED',
          Notes: 'G2 new mid',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260212-5' },
        readOnlyColumns: ['Spec Title'],
      });

      expect(res).toEqual({ rowNumber: 15, action: 'inserted', sheetId: 10 });
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledTimes(1);

      // Verify exact final grid structure
      expect(state.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')).toEqual([
        '<--->',
        '---', // untouched top stray divider
        'G0 row',
        '---', // untouched unrelated messy gap
        '---', // untouched unrelated messy gap
        '', // untouched unrelated messy gap
        'G1 row',
        '---', // healed missing G1..G2 divider (Col 0 only)
        'G2 row 1',
        'Malformed inside G2', // preserved null-keyed row inside G2
        'G2 new mid', // idx 14 -> rowNumber 15
        'G2 row 2',
        '---', // healed single G2..G3 divider
        'G3 row',
        '---', // untouched bottom stray divider
        '<--->',
      ]);
      expect(state.grid[11].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(state.grid[16].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(state.grid[14].style).toBe('clean-data-row');
      expect(state.namedRange.endRowIndex).toBe(20);
    });

    it('heals edge stray blanks/dividers at <---> when inserting before first row of targetGroupIdx === 0 (inheritFromBefore: false) and into targetGroupIdx === groups.length - 1', async () => {
      // 1. targetGroupIdx === 0 with stray blank + divider above it, inserting BEFORE its first row
      const topState = createSeededState([
        makeBlankSimRow(), // idx 5: stray blank at top <--->
        makeDividerSimRow(), // idx 6: stray divider at top <--->
        makeDataRow('Open', '033000-001', '033000-001-0-260120-1', 'G0 existing'), // idx 7
        makeDividerSimRow(), // idx 8
        makeDataRow('Open', '071200-001', '071200-001-0-260204-1', 'G1 existing'), // idx 9
      ]);
      wireSimulator(topState);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const topRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '033000-001',
          SortKey: '033000-001-0-260115-1',
          Notes: 'G0 before',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '033000-001', sortKey: '033000-001-0-260115-1' },
      });

      expect(topRes).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 10 });
      const topRequests = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      const topInsertReq = topRequests.find((r) => r.insertDimension)?.insertDimension;
      expect(topInsertReq?.inheritFromBefore).toBe(false);
      expect(topState.grid[5].style).toBe('clean-data-row');
      expect(topState.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')).toEqual([
        '<--->',
        'G0 before',
        'G0 existing',
        '---',
        'G1 existing',
        '<--->',
      ]);
      const topTable = await client.readTable({ target });
      expect(topTable.rows.map((r) => ({ rowNumber: r.rowNumber, notes: r.values.Notes }))).toEqual([
        { rowNumber: 6, notes: 'G0 before' },
        { rowNumber: 7, notes: 'G0 existing' },
        { rowNumber: 9, notes: 'G1 existing' },
      ]);

      // 2. targetGroupIdx === groups.length - 1 with stray divider + blank below it at bottom <--->
      const bottomState = createSeededState([
        makeDividerSimRow(), // idx 5: unrelated top stray divider
        makeDataRow('Closed', '013300-001', '013300-001-0-260110-1', 'G0 row'), // idx 6
        makeBlankSimRow(), // idx 7: unrelated upper messy gap blank
        makeDividerSimRow(), // idx 8: unrelated upper messy gap divider 1
        makeDividerSimRow(), // idx 9: unrelated upper messy gap divider 2
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'G1 row'), // idx 10
        makeDividerSimRow(), // idx 11: G1..G2 divider
        makeDataRow('Open', '087100-001', '087100-001-0-260303-1', 'G2 existing'), // idx 12
        makeDividerSimRow(), // idx 13: stray divider at bottom <--->
        makeBlankSimRow(), // idx 14: stray blank at bottom <--->
      ]);
      wireSimulator(bottomState);

      const bottomRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '087100-001',
          SortKey: '087100-001-0-260305-2',
          Notes: 'G2 appended',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '087100-001', sortKey: '087100-001-0-260305-2' },
      });

      expect(bottomRes).toEqual({ rowNumber: 14, action: 'inserted', sheetId: 10 });
      expect(bottomState.grid[13].style).toBe('clean-data-row');
      expect(bottomState.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')).toEqual([
        '<--->',
        '---', // untouched top stray divider
        'G0 row',
        '', // untouched unrelated upper gap
        '---', // untouched unrelated upper gap
        '---', // untouched unrelated upper gap
        'G1 row',
        '---', // G1..G2 divider
        'G2 existing',
        'G2 appended', // idx 13 -> Row 14
        '<--->',
      ]);
      const bottomTable = await client.readTable({ target });
      expect(bottomTable.rows.map((r) => ({ rowNumber: r.rowNumber, notes: r.values.Notes }))).toEqual([
        { rowNumber: 7, notes: 'G0 row' },
        { rowNumber: 11, notes: 'G1 row' },
        { rowNumber: 13, notes: 'G2 existing' },
        { rowNumber: 14, notes: 'G2 appended' },
      ]);
    });

    it('heals trapped blanks/dividers and immediate boundaries during duplicatePolicy: upsert while preserving null-keyed rows, formula/helper columns, and unrelated gaps', async () => {
      const state = createSeededState([
        makeDividerSimRow(), // idx 5: unrelated top stray divider
        makeDataRow('Closed', '013300-001', '013300-001-0-260110-1', 'G0 row'), // idx 6
        makeBlankSimRow(), // idx 7: unrelated messy gap G0..G1
        makeDividerSimRow(), // idx 8: unrelated messy gap G0..G1
        makeDividerSimRow(), // idx 9: unrelated messy gap G0..G1
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'G1 row'), // idx 10
        makeBlankSimRow(), // idx 11: missing G1..G2 divider (blank only -> heal to 1 ---)
        makeDataRow('Open', '071200-001', '071200-001-0-260204-1', 'G2 first'), // idx 12
        makeBlankSimRow(), // idx 13: trapped blank inside G2
        makeDividerSimRow(), // idx 14: trapped divider inside G2
        makeDataRow('Open', '', '', 'Malformed inside G2'), // idx 15: null-keyed row inside G2
        makeDataRow('Open', '071200-001', '071200-001-0-260212-5', 'Original G2 note'), // idx 16: upsert target
        makeBlankSimRow(), // idx 17: G2..G3 excess blank
        makeDividerSimRow(), // idx 18: G2..G3 divider 1 (keep)
        makeDividerSimRow(), // idx 19: G2..G3 divider 2 (heal out)
        makeDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'G3 row'), // idx 20
        makeDividerSimRow(), // idx 21: unrelated bottom stray divider
      ]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const res = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Closed',
          Group: '071200-001',
          SortKey: '071200-001-0-260212-5',
          'Spec Title': 'DO_NOT_OVERWRITE',
          Notes: 'Upserted G2 note',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260212-5' },
        duplicatePolicy: 'upsert',
        readOnlyColumns: ['Spec Title'],
      });

      expect(res).toEqual({ rowNumber: 15, action: 'updated', sheetId: 10 });
      expect(state.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')).toEqual([
        '<--->',
        '---', // untouched top stray
        'G0 row',
        '', // untouched G0..G1
        '---', // untouched G0..G1
        '---', // untouched G0..G1
        'G1 row',
        '---', // healed G1..G2 Col-0 divider
        'G2 first',
        'Malformed inside G2', // preserved null-keyed row
        'Upserted G2 note', // idx 14 -> Row 15
        '---', // healed G2..G3 Col-0 divider
        'G3 row',
        '---', // untouched bottom stray
        '<--->',
      ]);
      expect(state.grid[11].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(state.grid[15].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(state.grid[14].cells[0].value).toBe('Closed');
      expect(state.grid[14].cells[3]).toEqual({
        kind: 'formula',
        value: '=ARRAY_TITLE()',
        formattedValue: 'Auto Title',
      });
      expect(state.grid[14].cells[4].value).toBe('user-helper');

      const table = await client.readTable({ target });
      expect(table.rows.map((r) => ({ rowNumber: r.rowNumber, status: r.values.Status, title: r.values['Spec Title'], helper: r.values.Helper, notes: r.values.Notes }))).toEqual([
        { rowNumber: 7, status: 'Closed', title: 'Auto Title', helper: 'user-helper', notes: 'G0 row' },
        { rowNumber: 11, status: 'Closed', title: 'Auto Title', helper: 'user-helper', notes: 'G1 row' },
        { rowNumber: 13, status: 'Open', title: 'Auto Title', helper: 'user-helper', notes: 'G2 first' },
        { rowNumber: 14, status: 'Open', title: 'Auto Title', helper: 'user-helper', notes: 'Malformed inside G2' },
        { rowNumber: 15, status: 'Closed', title: 'Auto Title', helper: 'user-helper', notes: 'Upserted G2 note' },
        { rowNumber: 17, status: 'Manager', title: 'Auto Title', helper: 'user-helper', notes: 'G3 row' },
      ]);
    });

    it('inserts new groups at TOP, MIDDLE, BOTTOM, and groups.length === 0 of messy sheets while healing touched gaps/dividers, preserving null-keyed rows, and leaving unrelated gaps untouched', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // 1. TOP (nextGroupIdx === 0) with stray blanks/dividers & null-keyed malformed row at top edge
      const topState = createSeededState([
        makeBlankSimRow(), // idx 5: top stray blank
        makeDividerSimRow(), // idx 6: top stray divider
        makeDataRow('Open', '', '', 'Top edge malformed'), // idx 7: null-keyed row at top edge
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'G1 row'), // idx 8
        makeBlankSimRow(), // idx 9: unrelated messy gap
        makeDividerSimRow(), // idx 10: unrelated messy gap
        makeDividerSimRow(), // idx 11: unrelated messy gap
        makeDataRow('Open', '071200-001', '071200-001-0-260204-1', 'G2 row'), // idx 12
        makeDividerSimRow(), // idx 13: unrelated bottom stray divider
      ]);
      wireSimulator(topState);

      const topRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '013300-001',
          SortKey: '013300-001-0-260110-1',
          Notes: 'New top group',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '013300-001', sortKey: '013300-001-0-260110-1' },
      });

      expect(topRes).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 10 });
      expect(topState.grid[5].style).toBe('clean-data-row');
      expect(topState.grid[6].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(topState.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')).toEqual([
        '<--->',
        'New top group',
        '---',
        'Top edge malformed',
        'G1 row',
        '',
        '---',
        '---',
        'G2 row',
        '---',
        '<--->',
      ]);
      const topTable = await client.readTable({ target });
      expect(topTable.rows.map((r) => ({ rowNumber: r.rowNumber, notes: r.values.Notes }))).toEqual([
        { rowNumber: 6, notes: 'New top group' },
        { rowNumber: 8, notes: 'Top edge malformed' },
        { rowNumber: 9, notes: 'G1 row' },
        { rowNumber: 13, notes: 'G2 row' },
      ]);

      // 2. MIDDLE (nextGroupIdx > 0) with duplicate dividers [blank, '---', '---', blank] + null-keyed row in middle gap
      const midDupState = createSeededState([
        makeDividerSimRow(), // idx 5: unrelated top stray divider
        makeDataRow('Closed', '013300-001', '013300-001-0-260110-1', 'G0 row'), // idx 6
        makeDividerSimRow(), // idx 7: unrelated G0..G1 divider
        makeBlankSimRow(), // idx 8: unrelated G0..G1 blank
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'G1 row'), // idx 9
        makeBlankSimRow(), // idx 10: middle gap blank
        makeDividerSimRow(), // idx 11: middle gap clean divider 1 (reused!)
        makeDividerSimRow(), // idx 12: middle gap duplicate divider 2 (deleted)
        makeDataRow('Open', '', '', 'Middle gap malformed'), // idx 13: null-keyed row in middle gap
        makeBlankSimRow(), // idx 14: middle gap trailing blank
        makeDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'G2 row'), // idx 15
        makeDividerSimRow(), // idx 16: unrelated bottom stray divider
      ]);
      wireSimulator(midDupState);

      const midDupRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '075100-001',
          SortKey: '075100-001-0-260220-1',
          Notes: 'New mid group',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '075100-001', sortKey: '075100-001-0-260220-1' },
      });

      expect(midDupRes).toEqual({ rowNumber: 12, action: 'inserted', sheetId: 10 });
      expect(midDupState.grid[11].style).toBe('clean-data-row');
      expect(midDupState.grid[10].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(midDupState.grid[12].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(midDupState.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')).toEqual([
        '<--->',
        '---', // untouched top stray
        'G0 row',
        '---', // untouched G0..G1
        '', // untouched G0..G1
        'G1 row',
        '---', // new Col-0 divider
        'New mid group', // idx 11 -> Row 12
        '---', // reused clean divider (no duplicates)
        'Middle gap malformed', // preserved null-keyed row
        'G2 row',
        '---', // untouched bottom stray
        '<--->',
      ]);
      const midDupTable = await client.readTable({ target });
      expect(midDupTable.rows.map((r) => ({ rowNumber: r.rowNumber, notes: r.values.Notes }))).toEqual([
        { rowNumber: 7, notes: 'G0 row' },
        { rowNumber: 10, notes: 'G1 row' },
        { rowNumber: 12, notes: 'New mid group' },
        { rowNumber: 14, notes: 'Middle gap malformed' },
        { rowNumber: 15, notes: 'G2 row' },
      ]);

      // 3. MIDDLE (nextGroupIdx > 0) with dirty non-Col-0 divider ['', '---'] replaced by clean Col-0-only '---'
      const shiftedHeaders = ['Marker', ...headers];
      const makeShiftedDataRow = (
        status: string,
        group: string,
        sortKey: string,
        notes: string
      ): SimRow => ({
        style: 'clean-data-row',
        cells: [
          toSimCell(''),
          toSimCell(status),
          toSimCell(group),
          toSimCell(sortKey),
          { kind: 'formula', value: '=ARRAY_TITLE()', formattedValue: 'Auto Title' },
          toSimCell('user-helper'),
          toSimCell(notes),
        ],
      });
      const dirtyDividerState: SimSheetState = {
        sheetId: 11,
        title: 'Submittal Arch',
        grid: [
          { style: 'title', cells: [toSimCell('Document Log')] },
          { style: 'spacer', cells: [] },
          { style: 'header', cells: shiftedHeaders.map(toSimCell) },
          { style: 'formula', cells: [toSimCell('Formula Row')] },
          { style: 'anchor', cells: [toSimCell('<--->')] },
          makeShiftedDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'G0 shifted'),
          { style: 'divider', cells: [toSimCell(''), toSimCell('---')] }, // dirty non-Col-0 divider
          makeShiftedDataRow('Manager', '087100-001', '087100-001-0-260303-1', 'G1 shifted'),
          { style: 'anchor', cells: [toSimCell('<--->')] },
        ],
        namedRange: {
          name: 'Log_Submittal_Arch',
          startRowIndex: 2,
          endRowIndex: 9,
          startColumnIndex: 0,
          endColumnIndex: shiftedHeaders.length,
        },
      };
      wireSimulator(dirtyDividerState);

      const dirtyMidRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '075100-001',
          SortKey: '075100-001-0-260220-1',
          Notes: 'New mid clean',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '075100-001', sortKey: '075100-001-0-260220-1' },
      });

      expect(dirtyMidRes).toEqual({ rowNumber: 8, action: 'inserted', sheetId: 11 });
      expect(dirtyDividerState.grid[6].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(dirtyDividerState.grid[7].style).toBe('clean-data-row');
      expect(dirtyDividerState.grid[8].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(
        dirtyDividerState.grid.slice(4).map((row) => row.cells[6]?.value ?? row.cells[0]?.value ?? '')
      ).toEqual(['<--->', 'G0 shifted', '---', 'New mid clean', '---', 'G1 shifted', '<--->']);
      const dirtyTable = await client.readTable({ target });
      expect(dirtyTable.rows.map((r) => ({ rowNumber: r.rowNumber, notes: r.values.Notes }))).toEqual([
        { rowNumber: 6, notes: 'G0 shifted' },
        { rowNumber: 8, notes: 'New mid clean' },
        { rowNumber: 10, notes: 'G1 shifted' },
      ]);

      // 4. BOTTOM (nextGroupIdx === -1) with null-keyed row & stray divider/blank at bottom <--->
      const bottomState = createSeededState([
        makeDividerSimRow(), // idx 5: unrelated top stray divider
        makeDataRow('Closed', '013300-001', '013300-001-0-260110-1', 'G0 row'), // idx 6
        makeBlankSimRow(), // idx 7: unrelated messy gap
        makeDividerSimRow(), // idx 8: unrelated messy gap
        makeDividerSimRow(), // idx 9: unrelated messy gap
        makeDataRow('Closed', '033000-001', '033000-001-0-260115-1', 'G1 row'), // idx 10
        makeDataRow('Open', '', '', 'Bottom edge malformed'), // idx 11: null-keyed row at bottom edge
        makeDividerSimRow(), // idx 12: bottom stray divider
        makeBlankSimRow(), // idx 13: bottom stray blank
      ]);
      wireSimulator(bottomState);

      const bottomRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '096500-001',
          SortKey: '096500-001-0-260314-1',
          Notes: 'New bottom group',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '096500-001', sortKey: '096500-001-0-260314-1' },
      });

      expect(bottomRes).toEqual({ rowNumber: 14, action: 'inserted', sheetId: 10 });
      expect(bottomState.grid[12].cells).toEqual([{ kind: 'string', value: '---' }]);
      expect(bottomState.grid[13].style).toBe('clean-data-row');
      expect(bottomState.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')).toEqual([
        '<--->',
        '---', // untouched top stray
        'G0 row',
        '', // untouched G0..G1
        '---', // untouched G0..G1
        '---', // untouched G0..G1
        'G1 row',
        'Bottom edge malformed', // preserved null-keyed row
        '---', // new Col-0 divider
        'New bottom group', // idx 13 -> Row 14
        '<--->',
      ]);
      const bottomTable = await client.readTable({ target });
      expect(bottomTable.rows.map((r) => ({ rowNumber: r.rowNumber, notes: r.values.Notes }))).toEqual([
        { rowNumber: 7, notes: 'G0 row' },
        { rowNumber: 11, notes: 'G1 row' },
        { rowNumber: 12, notes: 'Bottom edge malformed' },
        { rowNumber: 14, notes: 'New bottom group' },
      ]);

      // 5. groups.length === 0 with only null-keyed rows + bottom stray divider/blank
      const emptyGroupsState = createSeededState([
        makeDataRow('Open', '', '', 'Only null-keyed 1'), // idx 5
        makeDataRow('Open', '', '', 'Only null-keyed 2'), // idx 6
        makeDividerSimRow(), // idx 7: bottom stray divider
        makeBlankSimRow(), // idx 8: bottom stray blank
      ]);
      wireSimulator(emptyGroupsState);

      const emptyGroupsRes = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260204-1',
          Notes: 'First real group',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '071200-001', sortKey: '071200-001-0-260204-1' },
      });

      expect(emptyGroupsRes).toEqual({ rowNumber: 8, action: 'inserted', sheetId: 10 });
      expect(emptyGroupsState.grid[7].style).toBe('clean-data-row');
      expect(
        emptyGroupsState.grid.slice(4).map((row) => row.cells[5]?.value ?? row.cells[0]?.value ?? '')
      ).toEqual([
        '<--->',
        'Only null-keyed 1',
        'Only null-keyed 2',
        'First real group',
        '<--->',
      ]);
      const emptyGroupsTable = await client.readTable({ target });
      expect(emptyGroupsTable.rows.map((r) => ({ rowNumber: r.rowNumber, notes: r.values.Notes }))).toEqual([
        { rowNumber: 6, notes: 'Only null-keyed 1' },
        { rowNumber: 7, notes: 'Only null-keyed 2' },
        { rowNumber: 8, notes: 'First real group' },
      ]);
    });

    it('returns sheetId (including sheetId === 0) on InsertGroupedRowResult and satisfies ExactOptionalPropertyTypes', async () => {
      const zeroSheetState = createSeededState([
        { style: 'clean-data-row', cells: [] },
      ]);
      zeroSheetState.sheetId = 0;
      wireSimulator(zeroSheetState);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const zeroResult = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260204-1',
          Notes: 'Zero sheetId row',
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(zeroResult).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 0 });

      const nonZeroState = createSeededState([
        { style: 'clean-data-row', cells: [] },
      ]);
      nonZeroState.sheetId = 404;
      wireSimulator(nonZeroState);

      const nonZeroResult = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: 'Open',
          Group: '071200-001',
          SortKey: '071200-001-0-260204-1',
          Notes: 'Non-zero sheetId row',
        },
        readOnlyColumns: ['Spec Title'],
      });

      expect(nonZeroResult).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 404 });

      const prevPolicy = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(Value.Check(InsertGroupedRowResultSchema, zeroResult)).toBe(true);
        expect(Value.Check(InsertGroupedRowResultSchema, nonZeroResult)).toBe(true);
        expect(
          Value.Check(InsertGroupedRowResultSchema, { rowNumber: 6, action: 'inserted' })
        ).toBe(true);
        expect(
          Value.Check(InsertGroupedRowResultSchema, {
            rowNumber: 6,
            action: 'inserted',
            sheetId: undefined,
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prevPolicy;
      }
    });

    it('writes literal =text strings strictly as stringValue (never formulaValue) across insertIntoGroupedList insert and upsert while preserving explicit { formula } cells', async () => {
      const state = createSeededState([makeBlankSimRow()]);
      wireSimulator(state);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);
      const insertResult = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: '=STATUS_INJECT',
          Group: '099000-001',
          SortKey: '099000-001-0-260325-1',
          Helper: { formula: '=HYPERLINK("https://drive.google.com/file/d/safe/view", "Link")' },
          Notes: '=SUM(1,2)',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '099000-001', sortKey: '099000-001-0-260325-1' },
        readOnlyColumns: ['Spec Title'],
      });
      expect(insertResult).toEqual({ rowNumber: 6, action: 'inserted', sheetId: 10 });

      const insertRequests = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[0][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      const insertCellUpdates = insertRequests.filter((req) => req.updateCells);
      const insertedCells = insertCellUpdates.flatMap((req) => req.updateCells?.rows?.[0]?.values ?? []);
      expect(insertedCells).toEqual(
        expect.arrayContaining([
          { userEnteredValue: { stringValue: '=STATUS_INJECT' } },
          { userEnteredValue: { formulaValue: '=HYPERLINK("https://drive.google.com/file/d/safe/view", "Link")' } },
          { userEnteredValue: { stringValue: '=SUM(1,2)' } },
        ])
      );
      expect(state.grid[5].cells[0]).toEqual({ kind: 'string', value: '=STATUS_INJECT' });
      expect(state.grid[5].cells[4]).toEqual({
        kind: 'formula',
        value: '=HYPERLINK("https://drive.google.com/file/d/safe/view", "Link")',
      });
      expect(state.grid[5].cells[5]).toEqual({ kind: 'string', value: '=SUM(1,2)' });

      // Upsert with another literal =text payload also uses stringValue (never formulaValue)
      const upsertResult = await client.insertIntoGroupedList({
        target,
        rowData: {
          Status: '=1+1',
          Group: '099000-001',
          SortKey: '099000-001-0-260325-1',
          Notes: '=HYPERLINK("https://evil.example", "Phish")',
        },
        rowKeyExtractor,
        targetKeys: { groupKey: '099000-001', sortKey: '099000-001-0-260325-1' },
        duplicatePolicy: 'upsert',
        readOnlyColumns: ['Spec Title'],
      });
      expect(upsertResult).toEqual({ rowNumber: 6, action: 'updated', sheetId: 10 });

      const upsertRequests = mockSheetsApi.spreadsheets.batchUpdate.mock.calls[1][0].requestBody
        .requests as sheets_v4.Schema$Request[];
      const upsertCells = upsertRequests
        .filter((req) => req.updateCells)
        .flatMap((req) => req.updateCells?.rows?.[0]?.values ?? []);
      expect(upsertCells).toEqual(
        expect.arrayContaining([
          { userEnteredValue: { stringValue: '=1+1' } },
          {
            userEnteredValue: {
              stringValue: '=HYPERLINK("https://evil.example", "Phish")',
            },
          },
        ])
      );
      expect(
        upsertCells.some(
          (c) =>
            c.userEnteredValue?.formulaValue === '=1+1' ||
            c.userEnteredValue?.formulaValue === '=HYPERLINK("https://evil.example", "Phish")'
        )
      ).toBe(false);

      const table = await client.readTable({ target, linkColumns: ['Helper'] });
      expect(table.rows).toHaveLength(1);
      expect(table.rows[0].values).toMatchObject({
        Status: '=1+1',
        Group: '099000-001',
        Notes: '=HYPERLINK("https://evil.example", "Phish")',
      });
      expect(table.rows[0].links).toEqual({
        Helper: 'https://drive.google.com/file/d/safe/view',
      });
    });
  });

  describe('readNamedRangesBatch', () => {
    it('reads multiple Named Ranges in 1 spreadsheets.get + 1 values.batchGet (FORMATTED_VALUE) and reports missing ranges per key', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({
        data: {
          spreadsheetId: 'sheet-config-1',
          sheets: [
            { properties: { sheetId: 301, title: '_Config Submittal Arch' } },
          ],
          namedRanges: [
            {
              namedRangeId: 'nr-status',
              name: 'Options_Submittal_Arch_Statuses',
              range: { sheetId: 301, startRowIndex: 2, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 1 },
            },
            {
              namedRangeId: 'nr-action',
              name: '_Config Submittal Arch!Options_Submittal_Arch_Actions',
              range: { sheetId: 301, startRowIndex: 2, endRowIndex: 12, startColumnIndex: 2, endColumnIndex: 6 },
            },
          ],
        },
      });
      mockSheetsApi.spreadsheets.values.batchGet.mockResolvedValueOnce({
        data: {
          valueRanges: [
            {
              range: "'_Config Submittal Arch'!A3:A10",
              values: [['Status'], ['Open'], ['Closed'], ['---']],
            },
            {
              range: "'_Config Submittal Arch'!C3:F12",
              values: [
                ['Action', 'Name', 'Suffix', 'Order'],
                ['REC', 'Received', '', '1'],
                ['---'],
              ],
            },
          ],
        },
      });

      const client = new GoogleSheetsClient({ sheets: mockSheetsApi as unknown as sheets_v4.Sheets });
      const result = await client.readNamedRangesBatch({
        spreadsheetId: 'sheet-config-1',
        targets: [
          { key: 'statuses', sheetName: '_Config Submittal Arch', rangeName: 'Options_Submittal_Arch_Statuses' },
          { key: 'actions', sheetName: '_Config Submittal Arch', rangeName: 'Options_Submittal_Arch_Actions' },
          { key: 'missingNr', sheetName: '_Config Submittal Arch', rangeName: 'Options_Missing' },
          { key: 'missingSheet', sheetName: '_MissingTab', rangeName: 'Options_Any' },
        ],
      });

      expect(mockSheetsApi.spreadsheets.get).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-config-1',
        ranges: ["'_Config Submittal Arch'!A3:A10", "'_Config Submittal Arch'!C3:F12"],
        valueRenderOption: 'FORMATTED_VALUE',
      });
      expect(result.statuses).toEqual({
        status: 'found',
        values: [['Status'], ['Open'], ['Closed'], ['---']],
      });
      expect(result.actions).toEqual({
        status: 'found',
        values: [
          ['Action', 'Name', 'Suffix', 'Order'],
          ['REC', 'Received', '', '1'],
          ['---'],
        ],
      });
      expect(result.missingNr.status).toBe('missing_range');
      expect(result.missingSheet.status).toBe('missing_range');
    });

    it('skips batchGet when all targets are missing and skips all API calls when targets are empty', async () => {
      const client = new GoogleSheetsClient({ sheets: mockSheetsApi as unknown as sheets_v4.Sheets });

      expect(await client.readNamedRangesBatch({ spreadsheetId: 's1', targets: [] })).toEqual({});
      expect(mockSheetsApi.spreadsheets.get).not.toHaveBeenCalled();

      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({
        data: {
          spreadsheetId: 's1',
          sheets: [{ properties: { sheetId: 301, title: '_Config Submittal Arch' } }],
          namedRanges: [],
        },
      });
      const res = await client.readNamedRangesBatch({
        spreadsheetId: 's1',
        targets: [{ key: 'statuses', sheetName: '_Config Submittal Arch', rangeName: 'Options_Missing' }],
      });
      expect(mockSheetsApi.spreadsheets.get).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).not.toHaveBeenCalled();
      expect(res.statuses.status).toBe('missing_range');
    });

    it('aborts active 429 retry backoff immediately when per-call SheetsOperationOptions.signal aborts', async () => {
      const controller = new AbortController();
      mockSheetsApi.spreadsheets.get
        .mockRejectedValueOnce({ statusCode: 429, message: 'Too Many Requests' })
        .mockResolvedValueOnce({
          data: {
            spreadsheetId: 's1',
            sheets: [{ properties: { sheetId: 301, title: '_Config Submittal Arch' } }],
            namedRanges: [],
          },
        });

      const retryClient = new GoogleSheetsClient({
        sheets: mockSheetsApi as unknown as sheets_v4.Sheets,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 60_000,
        },
      });

      const promise = retryClient.readNamedRangesBatch(
        {
          spreadsheetId: 's1',
          targets: [{ key: 'statuses', sheetName: '_Config Submittal Arch', rangeName: 'Options_Statuses' }],
        },
        { signal: controller.signal }
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();

      await expect(promise).rejects.toThrow(/abort/i);
      expect(mockSheetsApi.spreadsheets.get).toHaveBeenCalledTimes(1);
      expect(mockSheetsApi.spreadsheets.values.batchGet).not.toHaveBeenCalled();
    });
  });

  describe('Atomic option write-back & process-shared KeyedAsyncLock (Ticket #361)', () => {
    interface MultiSheetSimCell {
      value: CellValue;
      userEnteredFormat?: sheets_v4.Schema$CellFormat | undefined;
    }

    interface MultiSheetSim {
      spreadsheetId: string;
      sheets: Array<{
        sheetId: number;
        title: string;
        grid: MultiSheetSimCell[][];
      }>;
      namedRanges: Array<{
        namedRangeId: string;
        name: string;
        range: {
          sheetId: number;
          startRowIndex: number;
          endRowIndex: number;
          startColumnIndex: number;
          endColumnIndex: number;
        };
      }>;
      batchUpdatePayloads: Array<{ spreadsheetId: string; requests: sheets_v4.Schema$Request[] }>;
    }

    function cloneSimCell(cell: MultiSheetSimCell | undefined): MultiSheetSimCell {
      return cell ? { value: cell.value, ...(cell.userEnteredFormat ? { userEnteredFormat: structuredClone(cell.userEnteredFormat) } : {}) } : { value: '' };
    }

    function createMultiSheetApi(
      sim: MultiSheetSim,
      templateSim?: MultiSheetSim
    ): sheets_v4.Sheets {
      const findSimSheet = (targetSim: MultiSheetSim, sheetId: number) => {
        const sheet = targetSim.sheets.find((s) => s.sheetId === sheetId);
        if (!sheet) throw new Error(`Unknown sheetId ${sheetId}`);
        return sheet;
      };

      const readSimRange = (targetSim: MultiSheetSim, a1Range: string, valueRenderOption?: string): CellValue[][] => {
        const bangIdx = a1Range.lastIndexOf('!');
        const rawSheet = bangIdx >= 0 ? a1Range.slice(0, bangIdx) : targetSim.sheets[0].title;
        const sheetTitle = rawSheet.replace(/^'|'$/g, '').replace(/''/g, "'");
        const sheet = targetSim.sheets.find((s) => s.title.toLowerCase() === sheetTitle.toLowerCase());
        if (!sheet) throw new Error(`Unknown sheet "${sheetTitle}"`);
        const bounds = parseSimA1Range(
          a1Range,
          sheet.grid.length,
          Math.max(...sheet.grid.map((r) => r.length), 1)
        );
        return sheet.grid.slice(bounds.startRowIndex, bounds.endRowIndex).map((row) => {
          const out: CellValue[] = [];
          for (let c = bounds.startColumnIndex; c < bounds.endColumnIndex; c++) {
            const val = row[c]?.value ?? '';
            if (typeof val === 'string' && val.startsWith('=') && valueRenderOption !== 'FORMULA') {
              out.push('');
            } else {
              out.push(val);
            }
          }
          while (out.length > 0 && (out[out.length - 1] === '' || out[out.length - 1] === null)) {
            out.pop();
          }
          return out;
        });
      };

      return {
        spreadsheets: {
          get: vi.fn().mockImplementation(async (params: { spreadsheetId: string; includeGridData?: boolean }) => {
            const targetSim =
              templateSim && params.spreadsheetId === templateSim.spreadsheetId ? templateSim : sim;
            return {
              data: {
                spreadsheetId: targetSim.spreadsheetId,
                sheets: targetSim.sheets.map((s) => ({
                  properties: { sheetId: s.sheetId, title: s.title },
                  ...(params.includeGridData
                    ? {
                        data: [
                          {
                            startRow: 0,
                            startColumn: 0,
                            rowData: s.grid.map((row) => ({
                              values: row.map((cell) => ({
                                formattedValue: cell.value === null ? '' : String(cell.value),
                                ...(cell.userEnteredFormat ? { userEnteredFormat: structuredClone(cell.userEnteredFormat) } : {}),
                              })),
                            })),
                          },
                        ],
                      }
                    : {}),
                })),
                namedRanges: targetSim.namedRanges.map((nr) => ({
                  namedRangeId: nr.namedRangeId,
                  name: nr.name,
                  range: { ...nr.range },
                })),
              },
            };
          }),
          values: {
            get: vi.fn().mockImplementation(async (params: { range: string; valueRenderOption?: string }) => ({
              data: { values: readSimRange(sim, params.range, params.valueRenderOption) },
            })),
            batchGet: vi.fn().mockImplementation(async (params: { ranges: string[]; valueRenderOption?: string }) => ({
              data: {
                valueRanges: params.ranges.map((range) => ({
                  range,
                  values: readSimRange(sim, range, params.valueRenderOption),
                })),
              },
            })),
            update: vi.fn().mockResolvedValue({ data: {} }),
          },
          batchUpdate: vi.fn().mockImplementation(async (params: { spreadsheetId: string; requestBody: { requests: sheets_v4.Schema$Request[] } }) => {
            const requests = params.requestBody.requests;
            sim.batchUpdatePayloads.push({ spreadsheetId: params.spreadsheetId, requests });
            for (const req of requests) {
              if (req.insertDimension) {
                const { sheetId, startIndex, endIndex } = req.insertDimension.range!;
                const sheet = findSimSheet(sim, sheetId!);
                const count = endIndex! - startIndex!;
                const templateRow = req.insertDimension.inheritFromBefore
                  ? sheet.grid[startIndex! - 1]
                  : sheet.grid[startIndex!];
                const newRows = Array.from({ length: count }, () =>
                  (templateRow ?? []).map((c) => ({ value: '', ...(c.userEnteredFormat ? { userEnteredFormat: structuredClone(c.userEnteredFormat) } : {}) }))
                );
                sheet.grid.splice(startIndex!, 0, ...newRows);
                for (const nr of sim.namedRanges) {
                  if (nr.range.sheetId === sheetId && startIndex! > nr.range.startRowIndex && startIndex! < nr.range.endRowIndex) {
                    nr.range.endRowIndex += count;
                  }
                }
              } else if (req.insertRange) {
                const { range, shiftDimension } = req.insertRange;
                expect(shiftDimension).toBe('ROWS');
                const sheet = findSimSheet(sim, range!.sheetId!);
                const startRow = range!.startRowIndex!;
                const endRow = range!.endRowIndex!;
                const startCol = range!.startColumnIndex!;
                const endCol = range!.endColumnIndex!;
                const count = endRow - startRow;
                // Ensure enough rows exist at bottom for shifted cells
                const prevBottom = sheet.grid.length;
                for (let i = 0; i < count; i++) {
                  sheet.grid.push([]);
                }
                for (let r = prevBottom - 1; r >= startRow; r--) {
                  const srcRow = sheet.grid[r] ?? [];
                  const dstRow = sheet.grid[r + count]!;
                  for (let c = startCol; c < endCol; c++) {
                    dstRow[c] = cloneSimCell(srcRow[c]);
                  }
                }
                const refRow = sheet.grid[startRow - 1] ?? [];
                for (let r = startRow; r < endRow; r++) {
                  const targetRow = sheet.grid[r]!;
                  for (let c = startCol; c < endCol; c++) {
                    targetRow[c] = {
                      value: '',
                      ...(refRow[c]?.userEnteredFormat ? { userEnteredFormat: structuredClone(refRow[c].userEnteredFormat) } : {}),
                    };
                  }
                }
                for (const nr of sim.namedRanges) {
                  if (
                    nr.range.sheetId === range!.sheetId &&
                    nr.range.startColumnIndex >= startCol &&
                    nr.range.endColumnIndex <= endCol &&
                    startRow > nr.range.startRowIndex &&
                    startRow < nr.range.endRowIndex
                  ) {
                    nr.range.endRowIndex += count;
                  }
                }
              } else if (req.updateCells) {
                const uc = req.updateCells;
                const range = uc.range!;
                const sheet = findSimSheet(sim, range.sheetId!);
                const fields = new Set((uc.fields ?? '').split(',').map((f) => f.trim()));
                for (let r = 0; r < (uc.rows?.length ?? 0); r++) {
                  const absRow = range.startRowIndex! + r;
                  while (sheet.grid.length <= absRow) sheet.grid.push([]);
                  const targetRow = sheet.grid[absRow]!;
                  const rowCells = uc.rows![r].values ?? [];
                  for (let c = 0; c < rowCells.length; c++) {
                    const absCol = range.startColumnIndex! + c;
                    while (targetRow.length <= absCol) targetRow.push({ value: '' });
                    const existing = targetRow[absCol]!;
                    const incoming = rowCells[c];
                    const nextCell: MultiSheetSimCell = { ...existing };
                    if (fields.has('userEnteredValue')) {
                      const ue = incoming.userEnteredValue;
                      if (!ue) {
                        nextCell.value = '';
                      } else if (ue.stringValue !== undefined) {
                        nextCell.value = ue.stringValue;
                      } else if (ue.numberValue !== undefined) {
                        nextCell.value = ue.numberValue;
                      } else if (ue.boolValue !== undefined) {
                        nextCell.value = ue.boolValue;
                      } else if (ue.formulaValue !== undefined) {
                        nextCell.value = ue.formulaValue;
                      }
                    }
                    if (fields.has('userEnteredFormat')) {
                      nextCell.userEnteredFormat = incoming.userEnteredFormat
                        ? structuredClone(incoming.userEnteredFormat)
                        : undefined;
                    }
                    targetRow[absCol] = nextCell;
                  }
                }
              } else if (req.updateNamedRange) {
                const updated = req.updateNamedRange.namedRange!;
                const existing = sim.namedRanges.find(
                  (nr) => nr.namedRangeId === updated.namedRangeId || nr.name === updated.name
                );
                if (existing && updated.range) {
                  existing.range = {
                    sheetId: updated.range.sheetId ?? existing.range.sheetId,
                    startRowIndex: updated.range.startRowIndex ?? existing.range.startRowIndex,
                    endRowIndex: updated.range.endRowIndex ?? existing.range.endRowIndex,
                    startColumnIndex: updated.range.startColumnIndex ?? existing.range.startColumnIndex,
                    endColumnIndex: updated.range.endColumnIndex ?? existing.range.endColumnIndex,
                  };
                }
              }
            }
            return { data: {} };
          }),
        },
      } as unknown as sheets_v4.Sheets;
    }

    function createBaseMultiRangeSim(): MultiSheetSim {
      return {
        spreadsheetId: 'sheet-multi-361',
        sheets: [
          {
            sheetId: 101,
            title: 'Submittal Arch',
            grid: [
              [],
              [],
              [{ value: 'Status' }, { value: 'Section' }, { value: 'Number' }, { value: 'Contact' }],
              [{ value: 'Formula Row' }, { value: '' }, { value: '' }, { value: '' }],
              [{ value: '<--->' }],
              [{ value: '' }],
              [{ value: '<--->' }],
            ],
          },
          {
            sheetId: 103,
            title: '_Config Submittal Arch',
            grid: [
              // Row 0: Headers for Statuses (A), Contacts (C:E), Actions (G:J)
              [
                { value: 'Status' },
                { value: '' },
                { value: 'Contact' },
                { value: 'Name' },
                { value: 'Contact Type' },
                { value: '' },
                { value: 'Action' },
                { value: 'Name' },
                { value: 'Suffix' },
                { value: 'Order' },
              ],
              // Row 1
              [
                { value: 'Open' },
                { value: '' },
                { value: 'INC' },
                { value: 'INC Architecture and Design' },
                { value: 'INC' },
                { value: '' },
                { value: 'REC' },
                { value: 'Received' },
                { value: '' },
                { value: '1' },
              ],
              // Row 2
              [
                { value: 'Closed' },
                { value: '' },
                { value: 'ACME' },
                { value: '' },
                { value: '' },
                { value: '' },
                { value: '---' },
                { value: '' },
                { value: '' },
                { value: '' },
              ],
              // Row 3
              [
                { value: '---' },
                { value: '' },
                { value: '---' },
                { value: '' },
                { value: '' },
                { value: '' },
                { value: '' },
              ],
            ],
          },
        ],
        namedRanges: [
          {
            namedRangeId: 'nr-log',
            name: 'Log_Submittal_Arch',
            range: { sheetId: 101, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 4 },
          },
          {
            namedRangeId: 'nr-statuses',
            name: 'Options_Submittal_Arch_Statuses',
            range: { sheetId: 103, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 },
          },
          {
            namedRangeId: 'nr-val-statuses',
            name: 'Validation_Submittal_Arch_Statuses',
            range: { sheetId: 103, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
          },
          {
            namedRangeId: 'nr-contacts',
            name: 'Options_Submittal_Arch_Contacts',
            range: { sheetId: 103, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 2, endColumnIndex: 5 },
          },
          {
            namedRangeId: 'nr-val-contacts',
            name: 'Validation_Submittal_Arch_Contacts',
            range: { sheetId: 103, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 3 },
          },
          {
            namedRangeId: 'nr-actions',
            name: 'Options_Submittal_Arch_Actions',
            range: { sheetId: 103, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 6, endColumnIndex: 10 },
          },
        ],
        batchUpdatePayloads: [],
      };
    }

    it('shares process-wide KeyedAsyncLock across separate GoogleSheetsClient instances for same spreadsheetId while running different spreadsheetIds concurrently', async () => {
      const simA = createBaseMultiRangeSim();
      simA.spreadsheetId = 'shared-lock-sheet-A';
      const simB = createBaseMultiRangeSim();
      simB.spreadsheetId = 'shared-lock-sheet-B';

      const baseApiA = createMultiSheetApi(simA);
      const baseApiB = createMultiSheetApi(simB);

      const events: string[] = [];
      let releaseFirstBatch!: () => void;
      const firstBatchGate = new Promise<void>((resolve) => {
        releaseFirstBatch = resolve;
      });
      let firstBatchEntered!: () => void;
      const firstBatchEnteredPromise = new Promise<void>((resolve) => {
        firstBatchEntered = resolve;
      });

      type MockAsyncFn = (params: unknown) => Promise<unknown>;
      const origBatchUpdateA = (
        baseApiA.spreadsheets.batchUpdate as ReturnType<typeof vi.fn<MockAsyncFn>>
      ).getMockImplementation()!;
      let aCallCount = 0;
      (baseApiA.spreadsheets.batchUpdate as ReturnType<typeof vi.fn<MockAsyncFn>>).mockImplementation(
        async (params) => {
          aCallCount++;
          events.push(`A${aCallCount}:batchStart`);
          if (aCallCount === 1) {
            firstBatchEntered();
            await firstBatchGate;
          }
          const res = await origBatchUpdateA(params);
          events.push(`A${aCallCount}:batchEnd`);
          return res;
        }
      );

      const origGetA = (
        baseApiA.spreadsheets.get as ReturnType<typeof vi.fn<MockAsyncFn>>
      ).getMockImplementation()!;
      let getCountA = 0;
      (baseApiA.spreadsheets.get as ReturnType<typeof vi.fn<MockAsyncFn>>).mockImplementation(
        async (params) => {
          getCountA++;
          events.push(`A${getCountA}:get`);
          return origGetA(params);
        }
      );

      const origBatchUpdateB = (
        baseApiB.spreadsheets.batchUpdate as ReturnType<typeof vi.fn<MockAsyncFn>>
      ).getMockImplementation()!;
      (baseApiB.spreadsheets.batchUpdate as ReturnType<typeof vi.fn<MockAsyncFn>>).mockImplementation(
        async (params) => {
          events.push('B:batch');
          return origBatchUpdateB(params);
        }
      );

      // Two separate GoogleSheetsClient instances (like per-request OAuth clients)
      const client1 = new GoogleSheetsClient({ sheets: baseApiA });
      const client2 = new GoogleSheetsClient({ sheets: baseApiA });
      const clientB = new GoogleSheetsClient({ sheets: baseApiB });

      const targetA: PositiveTableTarget = {
        spreadsheetId: 'shared-lock-sheet-A',
        sheetName: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        extentMarker: '<--->',
        groupDividerMarker: '---',
      };
      const targetB: PositiveTableTarget = {
        ...targetA,
        spreadsheetId: 'shared-lock-sheet-B',
      };

      const p1 = client1.insertIntoGroupedList({
        target: targetA,
        rowData: { Status: 'Open', Section: '071200', Number: '001', Contact: 'First' },
      });

      await firstBatchEnteredPromise;

      const p2 = client2.insertIntoGroupedList({
        target: targetA,
        rowData: { Status: 'Open', Section: '071200', Number: '002', Contact: 'Second' },
      });
      const pB = clientB.insertIntoGroupedList({
        target: targetB,
        rowData: { Status: 'Open', Section: '071200', Number: '003', Contact: 'Other' },
      });

      // Different spreadsheetId (B) must finish without waiting for A1
      await pB;
      expect(events).toContain('B:batch');
      expect(events).not.toContain('A2:get');

      releaseFirstBatch();
      await Promise.all([p1, p2]);

      const idxA1End = events.indexOf('A1:batchEnd');
      const idxA2Get = events.indexOf('A2:get');
      expect(idxA1End).toBeGreaterThan(-1);
      expect(idxA2Get).toBeGreaterThan(idxA1End);
    });

    it('inserts new literal stringValue rows above "---" via column-scoped insertRange, extends Validation_*, leaves neighboring tables & unmapped columns untouched, and executes in 1 atomic batchUpdate (+0 extra HTTP calls)', async () => {
      const sim = createBaseMultiRangeSim();
      const api = createMultiSheetApi(sim);
      const client = new GoogleSheetsClient({ sheets: api });

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: sim.spreadsheetId,
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        rowData: {
          Status: 'Open',
          Section: '071200',
          Number: '001',
          Contact: '=HYPER(1)',
        },
        optionWrites: [
          {
            sheetName: '_Config Submittal Arch',
            rangeName: 'Options_Submittal_Arch_Contacts',
            validationRangeName: 'Validation_Submittal_Arch_Contacts',
            endMarker: '---',
            columns: { Contact: 'key', Name: 'name' },
            items: [
              // Formula-like text must be written strictly as stringValue literal
              { key: '=HYPER(1)', values: { key: '=HYPER(1)', name: '=HYPER(1)' } },
              // Same display name as another key must NOT be deduplicated (key-only match)
              { key: 'NEWKEY', values: { key: 'NEWKEY', name: 'INC Architecture and Design' } },
            ],
          },
        ],
      });

      // +0 extra HTTP calls: 1 spreadsheets.get, 1 values.batchGet (FORMATTED_VALUE replacing values.get),
      // 1 values.batchGet (FORMULA for Log_* Formula Row), 1 batchUpdate
      expect(api.spreadsheets.get).toHaveBeenCalledTimes(1);
      expect(api.spreadsheets.values.get).not.toHaveBeenCalled();
      expect(api.spreadsheets.values.batchGet).toHaveBeenCalledTimes(2);
      expect(api.spreadsheets.values.batchGet).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ valueRenderOption: 'FORMATTED_VALUE' })
      );
      expect(api.spreadsheets.values.batchGet).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ valueRenderOption: 'FORMULA' })
      );
      expect(api.spreadsheets.batchUpdate).toHaveBeenCalledTimes(1);

      const batchRequests = sim.batchUpdatePayloads[0].requests;
      const insertRangeReq = batchRequests.find((r) => r.insertRange !== undefined);
      expect(insertRangeReq).toEqual({
        insertRange: {
          range: {
            sheetId: 103,
            startRowIndex: 3,
            endRowIndex: 5,
            startColumnIndex: 2,
            endColumnIndex: 5,
          },
          shiftDimension: 'ROWS',
        },
      });

      const updateValRangeReq = batchRequests.find((r) => r.updateNamedRange !== undefined);
      expect(updateValRangeReq?.updateNamedRange?.namedRange?.range).toMatchObject({
        sheetId: 103,
        startRowIndex: 1,
        endRowIndex: 5,
        startColumnIndex: 2,
        endColumnIndex: 3,
      });

      // Verify Contact Type column (col 4) left blank and literal stringValues written
      const configGrid = sim.sheets[1].grid;
      expect(configGrid[3].slice(2, 5).map((c) => c.value)).toEqual(['=HYPER(1)', '=HYPER(1)', '']);
      expect(configGrid[4].slice(2, 5).map((c) => c.value)).toEqual([
        'NEWKEY',
        'INC Architecture and Design',
        '',
      ]);
      expect(configGrid[5][2].value).toBe('---');

      // Verify neighboring Statuses (col 0) and Actions (col 6..9) did NOT shift!
      expect(configGrid[3][0].value).toBe('---');
      expect(configGrid[2][6].value).toBe('---');
      expect(configGrid[1][6].value).toBe('REC');

      // Verify stringValue used (never formulaValue) for option cells
      const optionUpdateCells = batchRequests.find(
        (r) => r.updateCells?.range?.sheetId === 103
      )?.updateCells;
      expect(optionUpdateCells?.rows?.[0]?.values?.[0]?.userEnteredValue).toEqual({
        stringValue: '=HYPER(1)',
      });
    });

    it('matches duplicates by trimmed case-insensitive key only, backfilling blank sibling cells without overwriting non-blank cells', async () => {
      const sim = createBaseMultiRangeSim();
      const api = createMultiSheetApi(sim);
      const client = new GoogleSheetsClient({ sheets: api });

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: sim.spreadsheetId,
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        rowData: { Status: 'Open', Section: '071200', Number: '001', Contact: 'ACME' },
        optionWrites: [
          {
            sheetName: '_Config Submittal Arch',
            rangeName: 'Options_Submittal_Arch_Contacts',
            validationRangeName: 'Validation_Submittal_Arch_Contacts',
            endMarker: '---',
            columns: { Contact: 'key', Name: 'name' },
            items: [
              // '  inc  ' matches 'INC': Name is already 'INC Architecture and Design', must NOT overwrite!
              { key: '  inc  ', values: { key: 'inc', name: 'Attempted Overwrite' } },
              // ' acme ' matches 'ACME': Name cell is blank, MUST backfill ONLY Name cell!
              { key: ' acme ', values: { key: 'acme', name: 'Acme Builders' } },
            ],
          },
        ],
      });

      const batchRequests = sim.batchUpdatePayloads[0].requests;
      // No new rows inserted -> no insertRange and no updateNamedRange
      expect(batchRequests.some((r) => r.insertRange !== undefined)).toBe(false);
      expect(batchRequests.some((r) => r.updateNamedRange !== undefined)).toBe(false);

      const configGrid = sim.sheets[1].grid;
      // INC untouched
      expect(configGrid[1].slice(2, 5).map((c) => c.value)).toEqual([
        'INC',
        'INC Architecture and Design',
        'INC',
      ]);
      // ACME key casing preserved, Name backfilled, Contact Type left blank
      expect(configGrid[2].slice(2, 5).map((c) => c.value)).toEqual(['ACME', 'Acme Builders', '']);
    });

    it('fails fast with config_error before batchUpdate if any target option table lacks "---"', async () => {
      const sim = createBaseMultiRangeSim();
      // Remove '---' from Contacts table
      sim.sheets[1].grid[3][2] = { value: '' };
      const api = createMultiSheetApi(sim);
      const client = new GoogleSheetsClient({ sheets: api });

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: sim.spreadsheetId,
            sheetName: 'Submittal Arch',
            rangeName: 'Log_Submittal_Arch',
            extentMarker: '<--->',
            groupDividerMarker: '---',
          },
          rowData: { Status: 'Open', Section: '071200', Number: '001', Contact: 'NewCo' },
          optionWrites: [
            {
              sheetName: '_Config Submittal Arch',
              rangeName: 'Options_Submittal_Arch_Contacts',
              endMarker: '---',
              columns: { Contact: 'key', Name: 'name' },
              items: [{ key: 'NewCo', values: { key: 'NewCo', name: 'NewCo' } }],
            },
          ],
        })
      ).rejects.toThrow(/config_error.*---/i);

      expect(api.spreadsheets.batchUpdate).not.toHaveBeenCalled();
    });

    it('copies data-row cell formatting from templateSpreadsheetId when inserting into an empty option table (no data row above "---")', async () => {
      const sim = createBaseMultiRangeSim();
      // Make Contacts table empty: Row 0 = headers, Row 1 = '---'
      sim.sheets[1].grid[1][2] = { value: '---' };
      sim.sheets[1].grid[1][3] = { value: '' };
      sim.sheets[1].grid[1][4] = { value: '' };
      sim.sheets[1].grid[2][2] = { value: '' };
      sim.sheets[1].grid[2][3] = { value: '' };
      sim.sheets[1].grid[2][4] = { value: '' };
      sim.sheets[1].grid[3][2] = { value: '' };
      const contactsNr = sim.namedRanges.find((nr) => nr.name === 'Options_Submittal_Arch_Contacts')!;
      contactsNr.range.endRowIndex = 2;
      const valContactsNr = sim.namedRanges.find((nr) => nr.name === 'Validation_Submittal_Arch_Contacts')!;
      valContactsNr.range = { sheetId: 103, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex: 3 };

      const templateFormat0: sheets_v4.Schema$CellFormat = {
        backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 },
        textFormat: { fontFamily: 'Roboto', fontSize: 9, bold: false },
      };
      const templateFormat1: sheets_v4.Schema$CellFormat = {
        backgroundColor: { red: 1, green: 1, blue: 1 },
        textFormat: { fontFamily: 'Roboto', fontSize: 9, italic: true },
      };
      const templateFormat2: sheets_v4.Schema$CellFormat = {
        backgroundColor: { red: 0.98, green: 0.98, blue: 0.98 },
        textFormat: { fontFamily: 'Roboto', fontSize: 9 },
      };

      const templateSim: MultiSheetSim = {
        spreadsheetId: 'tmpl-361',
        sheets: [
          {
            sheetId: 903,
            title: '_Config Submittal Arch',
            grid: [
              [{ value: 'Contact' }, { value: 'Name' }, { value: 'Contact Type' }],
              [
                { value: 'INC', userEnteredFormat: templateFormat0 },
                { value: 'INC Architecture and Design', userEnteredFormat: templateFormat1 },
                { value: 'INC', userEnteredFormat: templateFormat2 },
              ],
              [{ value: '---' }, { value: '' }, { value: '' }],
            ],
          },
        ],
        namedRanges: [
          {
            namedRangeId: 'tmpl-nr-contacts',
            name: 'Options_Submittal_Arch_Contacts',
            range: { sheetId: 903, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 },
          },
        ],
        batchUpdatePayloads: [],
      };

      const api = createMultiSheetApi(sim, templateSim);
      const client = new GoogleSheetsClient({ sheets: api });

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: sim.spreadsheetId,
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        rowData: { Status: 'Open', Section: '071200', Number: '001', Contact: 'Solo' },
        templateSpreadsheetId: 'tmpl-361',
        optionWrites: [
          {
            sheetName: '_Config Submittal Arch',
            rangeName: 'Options_Submittal_Arch_Contacts',
            validationRangeName: 'Validation_Submittal_Arch_Contacts',
            endMarker: '---',
            columns: { Contact: 'key', Name: 'name' },
            items: [{ key: 'Solo', values: { key: 'Solo', name: 'Solo' } }],
          },
        ],
      });

      expect(api.spreadsheets.get).toHaveBeenCalledWith(
        expect.objectContaining({ spreadsheetId: 'tmpl-361', includeGridData: true })
      );

      const batchRequests = sim.batchUpdatePayloads[0].requests;
      const optionUpdate = batchRequests.find((r) => r.updateCells?.range?.sheetId === 103)?.updateCells;
      expect(optionUpdate?.fields).toBe('userEnteredValue,userEnteredFormat');
      expect(optionUpdate?.rows?.[0]?.values?.[0]).toEqual({
        userEnteredValue: { stringValue: 'Solo' },
        userEnteredFormat: templateFormat0,
      });
      expect(optionUpdate?.rows?.[0]?.values?.[1]).toEqual({
        userEnteredValue: { stringValue: 'Solo' },
        userEnteredFormat: templateFormat1,
      });
      // Unmapped Contact Type cell gets template formatting without writing a value
      expect(optionUpdate?.rows?.[0]?.values?.[2]).toEqual({
        userEnteredFormat: templateFormat2,
      });

      const configGrid = sim.sheets[1].grid;
      expect(configGrid[1].slice(2, 5).map((c) => c.value)).toEqual(['Solo', 'Solo', '']);
      expect(configGrid[2][2].value).toBe('---');
      expect(valContactsNr.range).toMatchObject({ startRowIndex: 1, endRowIndex: 2 });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
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
import type { CellValue, PositiveTableTarget, SheetsConfigProvider } from './types';

describe('GoogleSheetsClient', () => {
  let mockSheetsApi: {
    spreadsheets: {
      get: ReturnType<typeof vi.fn>;
      batchUpdate: ReturnType<typeof vi.fn>;
      values: {
        get: ReturnType<typeof vi.fn>;
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

    mockSheetsApi.spreadsheets.values.get.mockImplementation(async () => {
      const nr = state.namedRange;
      const slice: CellValue[][] = [];
      for (let r = nr.startRowIndex; r < nr.endRowIndex; r++) {
        const row = state.grid[r];
        if (!row) {
          slice.push([]);
          continue;
        }
        const vals: CellValue[] = [];
        for (let c = nr.startColumnIndex; c < nr.endColumnIndex; c++) {
          const cell = row.cells[c];
          vals.push(cell ? (cell.formattedValue ?? cell.value) : '');
        }
        while (vals.length > 0 && vals[vals.length - 1] === '') {
          vals.pop();
        }
        slice.push(vals);
      }
      return { data: { values: slice } };
    });

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
      const sleepMock = vi.fn().mockResolvedValue(undefined);

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
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const mockConfigProvider: SheetsConfigProvider = {
        getSheetsConfig: vi.fn().mockResolvedValue({
          maxRetries: 4,
          initialDelayMs: 250,
          backoffFactor: 3,
        }),
      };

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

      expect(result).toEqual({ rowNumber: 6, action: 'inserted' });

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

      expect(result).toEqual({ rowNumber: 6, action: 'inserted' });
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

      expect(result).toEqual({ rowNumber: 6, action: 'inserted' });
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

      expect(result).toEqual({ rowNumber: 6, action: 'inserted' });

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

      expect(result).toEqual({ rowNumber: 7, action: 'inserted' });

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

      expect(result).toEqual({ rowNumber: 4, action: 'inserted' });
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
      expect(result).toEqual({ rowNumber: 6, action: 'inserted' });
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

      expect(res1).toEqual({ rowNumber: 4, action: 'inserted' });
      expect(res2).toEqual({ rowNumber: 4, action: 'inserted' });
      expect(resB).toEqual({ rowNumber: 4, action: 'inserted' });

      const aEvents = callLog.filter((e) => e.endsWith(':sheet-A'));
      expect(aEvents).toEqual(['read:sheet-A', 'write:sheet-A', 'read:sheet-A', 'write:sheet-A']);
    });

    it('retries HTTP 429 during insertIntoGroupedList batchUpdate with exponential backoff', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
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

      expect(result).toEqual({ rowNumber: 6, action: 'inserted' });
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(50);
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

      expect(result).toEqual({ rowNumber: 6, action: 'inserted' });

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

      expect(resA).toEqual({ rowNumber: 8, action: 'inserted' });
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

      expect(resB).toEqual({ rowNumber: 8, action: 'inserted' });
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

      expect(result).toEqual({ rowNumber: 10, action: 'inserted' });
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
      expect(midRes).toEqual({ rowNumber: 9, action: 'inserted' });

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
      expect(rowRes).toEqual({ rowNumber: 7, action: 'inserted' });

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
      expect(firstRes).toEqual({ rowNumber: 6, action: 'inserted' });
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
      expect(dupRes).toEqual({ rowNumber: 9, action: 'inserted' });

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

      expect(upsertRes).toEqual({ rowNumber: 6, action: 'updated' });
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

      expect(res).toEqual({ rowNumber: 8, action: 'inserted' });
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
      expect(allNullRes).toEqual({ rowNumber: 7, action: 'inserted' });
      expect(allNullState.grid[5].cells[5].value).toBe('Only malformed row');
      expect(allNullState.grid[6].cells[5].value).toBe('Appended safely');
    });
  });
});

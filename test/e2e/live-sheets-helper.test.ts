import { describe, it, expect, vi } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import type { PositiveTableTarget } from '../../src/infrastructure/sheets';
import {
  SHEET_ERROR_TOKENS,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSheetErrorTokens,
  inspectPositiveTableLayout,
} from './utils/live-sheets-helper';

function createMockSheetsApi(params: {
  sheetId?: number;
  sheetTitle?: string;
  rangeName?: string;
  gridRange?: sheets_v4.Schema$GridRange;
  formattedValues: unknown[][];
  formulaValues?: unknown[][];
  preAnchorFormulaValues?: unknown[][];
  valuesGetImpl?: (req: { range?: string; valueRenderOption?: string }) => Promise<unknown>;
}) {
  const sheetId = params.sheetId ?? 101;
  const sheetTitle = params.sheetTitle ?? 'Submittal Arch';
  const rangeName = params.rangeName ?? 'Log_Submittal_Arch';
  const gridRange: sheets_v4.Schema$GridRange = params.gridRange ?? {
    sheetId,
    startRowIndex: 2,
    endRowIndex: 2 + params.formattedValues.length,
    startColumnIndex: 0,
    endColumnIndex: 10,
  };

  const getSpreadsheet = vi.fn().mockResolvedValue({
    data: {
      sheets: [{ properties: { sheetId, title: sheetTitle } }],
      namedRanges: [{ name: rangeName, range: gridRange }],
    },
  });

  const valuesGet = vi.fn().mockImplementation(
    params.valuesGetImpl ??
      (async (req: { range?: string; valueRenderOption?: string }) => {
        if (req.valueRenderOption === 'FORMULA') {
          if (
            params.preAnchorFormulaValues &&
            req.range &&
            !req.range.endsWith(`:${gridRange.endRowIndex}`)
          ) {
            return { data: { values: params.preAnchorFormulaValues } };
          }
          return { data: { values: params.formulaValues ?? params.formattedValues } };
        }
        return { data: { values: params.formattedValues } };
      })
  );

  const batchUpdate = vi.fn().mockResolvedValue({ data: {} });

  const sheetsApi = {
    spreadsheets: {
      get: getSpreadsheet,
      values: {
        get: valuesGet,
      },
      batchUpdate,
    },
  } as unknown as sheets_v4.Sheets;

  return { sheetsApi, getSpreadsheet, valuesGet, batchUpdate };
}

describe('live-sheets-helper', () => {
  const archTarget: PositiveTableTarget = {
    spreadsheetId: 'sheet-123',
    sheetName: 'Submittal Arch',
    rangeName: 'Log_Submittal_Arch',
    extentMarker: '<--->',
    groupDividerMarker: '---',
  };

  const ffeTarget: PositiveTableTarget = {
    spreadsheetId: 'sheet-123',
    sheetName: 'Submittal FF&E',
    rangeName: 'Log_Submittal_FFE',
    extentMarker: '<--->',
    groupDividerMarker: '---',
  };

  describe('ensureClearedPositiveTable', () => {
    it('performs zero batchUpdate mutations when exactly 1 blank row exists between anchors', async () => {
      const { sheetsApi, valuesGet, batchUpdate } = createMockSheetsApi({
        formattedValues: [
          ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
          [],
          ['<--->'],
          [],
          ['<--->'],
        ],
      });

      await ensureClearedPositiveTable(sheetsApi, archTarget);

      expect(valuesGet).toHaveBeenCalledTimes(1);
      expect(valuesGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal Arch'!A3:J7",
        valueRenderOption: 'FORMATTED_VALUE',
      });
      expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('deletes excess rows [absTopAnchor + 2, absBottomAnchor) and clears writable cells on absTopAnchor + 1 while skipping formula-owned columns', async () => {
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
      const { sheetsApi, valuesGet, batchUpdate } = createMockSheetsApi({
        sheetId: 202,
        sheetTitle: 'Submittal FF&E',
        rangeName: 'Log_Submittal_FFE',
        gridRange: {
          sheetId: 202,
          startRowIndex: 2,
          endRowIndex: 10,
          startColumnIndex: 0,
          endColumnIndex: 11,
        },
        formattedValues: [
          headers,
          ['', '', '', '', ''], // Row 4 (rel 1, abs 3): formula row
          ['<--->'], // Row 5 (rel 2, abs 4): topAnchor
          ['Open', 'CG104', 'FB127', '0', 'BED - KING', 'Keystone', '260120', 'HPG', 'Received', 'Note', 'Link'], // Row 6 (abs 5)
          ['---'], // Row 7 (abs 6)
          ['Closed', 'FB127', '', '0', 'FABRIC - LEATHER', 'Atlas', '260118', 'HPG', 'Received', '', 'Link'], // Row 8 (abs 7)
          ['<--->'], // Row 9 (rel 6, abs 8): bottomAnchor
        ],
        preAnchorFormulaValues: [
          ['', '', '', '', '=ARRAYFORMULA(IF(B4:B="","",VLOOKUP(B4:B,Specs!A:B,2,FALSE)))'],
        ],
      });

      await ensureClearedPositiveTable(sheetsApi, ffeTarget);

      expect(valuesGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal FF&E'!A4:K4",
        valueRenderOption: 'FORMULA',
      });
      expect(batchUpdate).toHaveBeenCalledTimes(1);
      const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
      expect(requests).toEqual([
        {
          deleteDimension: {
            range: {
              sheetId: 202,
              dimension: 'ROWS',
              startIndex: 6,
              endIndex: 8,
            },
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 0,
              endColumnIndex: 4,
            },
            rows: [{ values: [{}, {}, {}, {}] }],
            fields: 'userEnteredValue',
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 5,
              endColumnIndex: 11,
            },
            rows: [{ values: [{}, {}, {}, {}, {}, {}] }],
            fields: 'userEnteredValue',
          },
        },
      ]);
    });

    it('inserts 1 row with inheritFromBefore: false when 0 rows exist between anchors and clears writable cells', async () => {
      const { sheetsApi, batchUpdate } = createMockSheetsApi({
        sheetId: 101,
        sheetTitle: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        gridRange: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: 6,
          startColumnIndex: 0,
          endColumnIndex: 10,
        },
        formattedValues: [
          ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
          [],
          ['<--->'],
          ['<--->'],
        ],
        preAnchorFormulaValues: [[]],
      });

      await ensureClearedPositiveTable(sheetsApi, archTarget);

      expect(batchUpdate).toHaveBeenCalledTimes(1);
      const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
      expect(requests).toEqual([
        {
          insertDimension: {
            range: {
              sheetId: 101,
              dimension: 'ROWS',
              startIndex: 5,
              endIndex: 6,
            },
            inheritFromBefore: false,
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 101,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 0,
              endColumnIndex: 10,
            },
            rows: [{ values: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}] }],
            fields: 'userEnteredValue',
          },
        },
      ]);
    });

    it('sets explicit endColumnIndex on preAnchorA1Range when endColumnIndex is omitted and respects non-zero startColumnIndex', async () => {
      const { sheetsApi: unboundedApi, valuesGet: unboundedGet, batchUpdate: unboundedBatch } =
        createMockSheetsApi({
          sheetId: 303,
          sheetTitle: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          gridRange: {
            sheetId: 303,
            startRowIndex: 2,
            endRowIndex: 7,
            startColumnIndex: 0,
          },
          formattedValues: [
            ['Status', 'Section', 'Title'],
            ['', '', ''],
            ['<--->'],
            ['Open', '033000', 'Concrete'],
            ['<--->'],
          ],
          preAnchorFormulaValues: [['', '', '=UPPER(C4)']],
        });

      await ensureClearedPositiveTable(unboundedApi, archTarget);

      expect(unboundedGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal Arch'!A4:C4",
        valueRenderOption: 'FORMULA',
      });
      expect(unboundedBatch.mock.calls[0][0].requestBody.requests).toEqual([
        {
          updateCells: {
            range: {
              sheetId: 303,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 0,
              endColumnIndex: 2,
            },
            rows: [{ values: [{}, {}] }],
            fields: 'userEnteredValue',
          },
        },
      ]);

      const { sheetsApi: offsetApi, valuesGet: offsetGet, batchUpdate: offsetBatch } =
        createMockSheetsApi({
          sheetId: 304,
          sheetTitle: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          gridRange: {
            sheetId: 304,
            startRowIndex: 2,
            endRowIndex: 7,
            startColumnIndex: 1,
            endColumnIndex: 4,
          },
          formattedValues: [
            ['Status', 'Section', 'Title'],
            ['', '', ''],
            ['<--->'],
            ['Open', '033000', 'Concrete'],
            ['<--->'],
          ],
          preAnchorFormulaValues: [['', '', '=UPPER(D4)']],
        });

      await ensureClearedPositiveTable(offsetApi, archTarget);

      expect(offsetGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal Arch'!B4:D4",
        valueRenderOption: 'FORMULA',
      });
      expect(offsetBatch.mock.calls[0][0].requestBody.requests).toEqual([
        {
          updateCells: {
            range: {
              sheetId: 304,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 1,
              endColumnIndex: 3,
            },
            rows: [{ values: [{}, {}] }],
            fields: 'userEnteredValue',
          },
        },
      ]);
    });

    it('retries HTTP 429 rate-limit errors with exponential backoff in ensureClearedPositiveTable', async () => {
      let attempt = 0;
      const { sheetsApi, valuesGet } = createMockSheetsApi({
        formattedValues: [
          ['Status', 'Section'],
          [],
          ['<--->'],
          [],
          ['<--->'],
        ],
        valuesGetImpl: async () => {
          attempt++;
          if (attempt < 3) {
            throw { statusCode: 429, message: 'Quota exceeded' };
          }
          return {
            data: {
              values: [['Status', 'Section'], [], ['<--->'], [], ['<--->']],
            },
          };
        },
      });

      await ensureClearedPositiveTable(sheetsApi, archTarget, {
        maxRetries: 3,
        initialDelayMs: 1,
        backoffFactor: 2,
      });

      expect(valuesGet).toHaveBeenCalledTimes(3);
    });
  });

  describe('inspectPositiveTableLayout', () => {
    it('reads both FORMATTED_VALUE and FORMULA and reports divider Column-0 purity and formulaRowsByHeader', async () => {
      const headers = ['Status', 'Section', 'Title', 'Calc Link'];
      const formattedValues = [
        headers,
        [],
        ['<--->'],
        ['Open', '033000', '=SUM(1,2)', 'Link'],
        ['---'],
        ['Open', '071200', 'Waterproofing', ''],
        ['---', '', 'stale'],
        [],
        ['<--->'],
      ];
      const formulaValues = [
        headers,
        [],
        ['<--->'],
        ['Open', '033000', '=SUM(1,2)', '=HYPERLINK("https://drive.google.com/file/d/1/view", "Link")'],
        ['---'],
        ['Open', '071200', 'Waterproofing'],
        ['---', '', 'stale'],
        [],
        ['<--->'],
      ];

      const { sheetsApi, valuesGet } = createMockSheetsApi({
        gridRange: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: 11,
          startColumnIndex: 0,
          endColumnIndex: 4,
        },
        formattedValues,
        formulaValues,
      });

      const layout = await inspectPositiveTableLayout(sheetsApi, archTarget);

      expect(valuesGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal Arch'!A3:D11",
        valueRenderOption: 'FORMATTED_VALUE',
      });
      expect(valuesGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal Arch'!A3:D11",
        valueRenderOption: 'FORMULA',
      });

      expect(layout.headers).toEqual(headers);
      expect(layout.topAnchorRowIndex).toBe(4);
      expect(layout.bottomAnchorRowIndex).toBe(10);
      expect(layout.dividerRowIndices).toEqual([6, 8]);

      const dividers = layout.betweenRows.filter((row) => row.kind === 'divider');
      expect(dividers).toHaveLength(2);
      expect(dividers[0]).toMatchObject({
        rowIndex: 6,
        rowNumber: 7,
        kind: 'divider',
        isColumnZeroOnlyDivider: true,
        nonEmptyColumnsAfterZero: [],
      });
      expect(dividers[1]).toMatchObject({
        rowIndex: 8,
        rowNumber: 9,
        kind: 'divider',
        isColumnZeroOnlyDivider: false,
        nonEmptyColumnsAfterZero: [2],
      });

      expect(layout.formulaRowsByHeader).toEqual({
        Status: ['Open', 'Open'],
        Section: ['033000', '071200'],
        Title: ['=SUM(1,2)', 'Waterproofing'],
        'Calc Link': ['=HYPERLINK("https://drive.google.com/file/d/1/view", "Link")', ''],
      });
    });

    it('retries HTTP 429 rate-limit errors in inspectPositiveTableLayout', async () => {
      let getAttempts = 0;
      const { sheetsApi, getSpreadsheet } = createMockSheetsApi({
        gridRange: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: 7,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
        formattedValues: [['Status', 'Section'], [], ['<--->'], ['Open', '033000'], ['<--->']],
      });
      getSpreadsheet.mockImplementation(async () => {
        getAttempts++;
        if (getAttempts === 1) {
          throw { response: { status: 429 }, message: 'Rate limited' };
        }
        return {
          data: {
            sheets: [{ properties: { sheetId: 101, title: 'Submittal Arch' } }],
            namedRanges: [
              {
                name: 'Log_Submittal_Arch',
                range: {
                  sheetId: 101,
                  startRowIndex: 2,
                  endRowIndex: 7,
                  startColumnIndex: 0,
                  endColumnIndex: 2,
                },
              },
            ],
          },
        };
      });

      const layout = await inspectPositiveTableLayout(sheetsApi, archTarget, {
        maxRetries: 2,
        initialDelayMs: 1,
        backoffFactor: 2,
      });

      expect(getSpreadsheet).toHaveBeenCalledTimes(2);
      expect(layout.formulaRowsByHeader.Section).toEqual(['033000']);
    });
  });

  describe('findSheetErrorTokens and findCleanDividerViolations', () => {
    it('detects Google Sheets error tokens in row records', () => {
      expect(SHEET_ERROR_TOKENS).toEqual(['#REF!', '#ERROR!', '#N/A', '#VALUE!']);
      expect(
        findSheetErrorTokens({
          Status: 'Open',
          'Spec Title': 'BED - KING',
          Count: 1,
          Empty: null,
        })
      ).toEqual([]);

      expect(
        findSheetErrorTokens({
          'Spec Title': 'Lookup failed: #N/A',
          Notes: 'Broken ref #REF!',
        })
      ).toEqual(['#N/A', '#REF!']);
    });

    it('reports zero violations for clean Column-0-only dividers and flags adjacent, consecutive, or polluted dividers', () => {
      expect(
        findCleanDividerViolations({
          dividerRowIndices: [6, 9],
          topAnchorRowIndex: 4,
          bottomAnchorRowIndex: 11,
          betweenRows: [
            { kind: 'divider', rowNumber: 7, isColumnZeroOnlyDivider: true, nonEmptyColumnsAfterZero: [] },
            { kind: 'divider', rowNumber: 10, isColumnZeroOnlyDivider: true, nonEmptyColumnsAfterZero: [] },
          ],
          expectedDividerCount: 2,
        })
      ).toEqual([]);

      const violations = findCleanDividerViolations({
        dividerRowIndices: [5, 6, 10],
        topAnchorRowIndex: 4,
        bottomAnchorRowIndex: 11,
        betweenRows: [
          { kind: 'divider', rowNumber: 6, isColumnZeroOnlyDivider: true, nonEmptyColumnsAfterZero: [] },
          { kind: 'divider', rowNumber: 7, isColumnZeroOnlyDivider: false, nonEmptyColumnsAfterZero: [2] },
          { kind: 'divider', rowNumber: 11, isColumnZeroOnlyDivider: true, nonEmptyColumnsAfterZero: [] },
        ],
        expectedDividerCount: 2,
      });

      expect(violations.length).toBeGreaterThanOrEqual(4);
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import type { PositiveTableTarget } from '../../src/infrastructure/sheets';
import {
  SHEET_ERROR_TOKENS,
  appendRawPositiveTableRows,
  batchUpdateSpreadsheetValues,
  clearOptionTableToEmpty,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSheetErrorTokens,
  findSpreadsheetErrorTokens,
  findSideBySideTableShiftViolations,
  inspectPositiveTableLayout,
  partialHydrationRowToCellInputs,
  readNamedRangesFormattedValues,
  readOptionTableGridFormats,
  readSheetsGridLayout,
  readSpreadsheetMetadata,
  readSpreadsheetValues,
  snapshotNamedRanges,
  withLiveSheetsRetry,
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

  describe('findSheetErrorTokens, findSpreadsheetErrorTokens, and findCleanDividerViolations', () => {
    it('detects Google Sheets error tokens including #NAME? and #DIV/0! in row records', () => {
      expect(SHEET_ERROR_TOKENS).toEqual([
        '#REF!',
        '#ERROR!',
        '#N/A',
        '#VALUE!',
        '#NAME?',
        '#DIV/0!',
      ]);
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
          Formula1: '#NAME?',
          Formula2: '#DIV/0!',
        })
      ).toEqual(['#N/A', '#REF!', '#NAME?', '#DIV/0!']);
    });

    it('scans all sheets via values.batchGet and reports any formula error tokens with coordinates', async () => {
      const sheetsApi = {
        spreadsheets: {
          get: vi.fn().mockResolvedValue({
            data: {
              sheets: [
                { properties: { title: 'Submittal Arch' } },
                { properties: { title: '_Config Submittal Arch' } },
              ],
            },
          }),
          values: {
            batchGet: vi.fn().mockResolvedValue({
              data: {
                valueRanges: [
                  { values: [['Header'], ['Clean row']] },
                  { values: [['Settings'], ['Bad formula', '#NAME?'], ['Zero div', '#DIV/0!']] },
                ],
              },
            }),
          },
        },
      } as unknown as sheets_v4.Sheets;

      const findings = await findSpreadsheetErrorTokens(sheetsApi, 'sheet-123');
      expect(findings).toEqual([
        {
          sheetTitle: '_Config Submittal Arch',
          rowNumber: 2,
          columnIndex: 1,
          value: '#NAME?',
          tokens: ['#NAME?'],
        },
        {
          sheetTitle: '_Config Submittal Arch',
          rowNumber: 3,
          columnIndex: 1,
          value: '#DIV/0!',
          tokens: ['#DIV/0!'],
        },
      ]);
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

  describe('partialHydrationRowToCellInputs', () => {
    it('converts =HYPERLINK(...) linkFormula into formula input, preserves leading-zero strings, and maps empty strings to null', () => {
      const inputs = partialHydrationRowToCellInputs({
        scenario: 'leadingZeroAndFormula',
        description: 'Partial row with leading-zero strings, empty cells, and HYPERLINK formula.',
        rowCells: {
          Status: 'Waiting',
          Section: '071200',
          Number: '001',
          Revision: '0',
          Title: 'Fluid-Applied Waterproofing Membrane',
          Date: '260225',
          Contact: 'MB',
          Action: 'Referred',
          Notes: '',
          'Calc Link': 'Link',
        },
        linkFormula: '=HYPERLINK("https://drive.google.com/file/d/fixture-arch-partial-sec/view", "Link")',
        expectedIssues: ['section'],
      });

      expect(inputs).toEqual({
        Status: 'Waiting',
        Section: '071200',
        Number: '001',
        Revision: '0',
        Title: 'Fluid-Applied Waterproofing Membrane',
        Date: '260225',
        Contact: 'MB',
        Action: 'Referred',
        Notes: null,
        'Calc Link': {
          formula: '=HYPERLINK("https://drive.google.com/file/d/fixture-arch-partial-sec/view", "Link")',
        },
      });
    });

    it('converts raw https:// linkFormula to a plain string and blank/whitespace linkFormula to null', () => {
      const rawUrlInputs = partialHydrationRowToCellInputs({
        scenario: 'rawUrlLink',
        description: 'Partial row with a raw URL string in Calc Link.',
        rowCells: {
          Status: 'Open',
          Section: '071200',
          Number: '001',
          Revision: '1',
          Title: 'Fluid-Applied Waterproofing Membrane',
          Date: '260226',
          Contact: 'ARC',
          Action: 'Approved',
          Notes: 'Legacy human label',
          'Calc Link': 'https://drive.google.com/file/d/fixture-arch-raw-url/view',
        },
        linkFormula: 'https://drive.google.com/file/d/fixture-arch-raw-url/view',
        expectedIssues: ['action'],
      });

      expect(rawUrlInputs['Calc Link']).toBe(
        'https://drive.google.com/file/d/fixture-arch-raw-url/view'
      );

      const blankInputs = partialHydrationRowToCellInputs({
        scenario: 'blankLink',
        description: 'Partial row with blank Calc Link.',
        rowCells: {
          Status: 'Waiting',
          Section: '071200',
          Number: '001',
          Revision: '1',
          Title: 'Fluid-Applied Waterproofing Membrane',
          Date: '',
          Contact: 'PST',
          Action: 'Referred',
          Notes: 'Awaiting date confirmation',
          'Calc Link': '',
        },
        linkFormula: '   ',
        expectedIssues: ['date'],
      });

      expect(blankInputs['Calc Link']).toBeNull();
      expect(blankInputs.Date).toBeNull();
    });
  });

  describe('appendRawPositiveTableRows', () => {
    it('returns [] and performs zero spreadsheets.get, values.get, or batchUpdate calls when rows is empty', async () => {
      const { sheetsApi, getSpreadsheet, valuesGet, batchUpdate } = createMockSheetsApi({
        formattedValues: [
          ['Status', 'Section'],
          [],
          ['<--->'],
          [],
          ['<--->'],
        ],
      });

      const insertedRowNumbers = await appendRawPositiveTableRows(sheetsApi, archTarget, []);

      expect(insertedRowNumbers).toEqual([]);
      expect(getSpreadsheet).not.toHaveBeenCalled();
      expect(valuesGet).not.toHaveBeenCalled();
      expect(batchUpdate).not.toHaveBeenCalled();
    });

    it('appends multiple raw rows before the bottom anchor with inheritFromBefore: true, skips formula-owned and absent columns, and returns 1-based row numbers', async () => {
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
          endRowIndex: 8,
          startColumnIndex: 0,
          endColumnIndex: 11,
        },
        formattedValues: [
          headers,
          ['', '', '', '', ''], // Row 4 (abs 3): formula row
          ['<--->'], // Row 5 (abs 4): topAnchor
          ['Open', 'CG104', 'FB127', '0', 'BED - KING', 'Keystone', '260120', 'HPG', 'Received', 'Note', 'Link'], // Row 6 (abs 5)
          ['---'], // Row 7 (abs 6)
          ['<--->'], // Row 8 (abs 7): bottomAnchor
        ],
        preAnchorFormulaValues: [
          ['', '', '', '', '=ARRAYFORMULA(IF(B4:B="","",VLOOKUP(B4:B,Specs!A:B,2,FALSE)))'],
        ],
      });

      const insertedRowNumbers = await appendRawPositiveTableRows(sheetsApi, ffeTarget, [
        {
          Status: 'In Review',
          'Spec Tag': '001',
          // 'Related Tag' intentionally absent
          Revision: '0',
          'Spec Title': 'SHOULD BE SKIPPED',
          Vendor: '',
          Date: '260216',
          Contact: 'HPG',
          Action: 'Received',
          Notes: null,
          'Calc Link': {
            formula: '=HYPERLINK("https://drive.google.com/file/d/1/view", "Link")',
          },
        },
        {
          Status: 'Open',
          'Spec Tag': 'CG104',
          'Related Tag': 'FB127',
          Revision: '',
          Vendor: 'Keystone Casegoods',
          Date: '260211',
          Contact: 'ARC',
          Action: 'Referred',
          // 'Notes' intentionally absent
          'Calc Link': 'https://drive.google.com/file/d/raw-url/view',
        },
      ]);

      expect(insertedRowNumbers).toEqual([8, 9]);
      expect(valuesGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal FF&E'!A4:K4",
        valueRenderOption: 'FORMULA',
      });
      expect(batchUpdate).toHaveBeenCalledTimes(1);

      const requests = batchUpdate.mock.calls[0][0].requestBody.requests;
      expect(requests).toEqual([
        {
          insertDimension: {
            range: {
              sheetId: 202,
              dimension: 'ROWS',
              startIndex: 7,
              endIndex: 9,
            },
            inheritFromBefore: true,
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 7,
              endRowIndex: 8,
              startColumnIndex: 0,
              endColumnIndex: 2,
            },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: 'In Review' } },
                  { userEnteredValue: { stringValue: '001' } },
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 7,
              endRowIndex: 8,
              startColumnIndex: 3,
              endColumnIndex: 4,
            },
            rows: [{ values: [{ userEnteredValue: { stringValue: '0' } }] }],
            fields: 'userEnteredValue',
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 7,
              endRowIndex: 8,
              startColumnIndex: 5,
              endColumnIndex: 11,
            },
            rows: [
              {
                values: [
                  {},
                  { userEnteredValue: { stringValue: '260216' } },
                  { userEnteredValue: { stringValue: 'HPG' } },
                  { userEnteredValue: { stringValue: 'Received' } },
                  {},
                  {
                    userEnteredValue: {
                      formulaValue: '=HYPERLINK("https://drive.google.com/file/d/1/view", "Link")',
                    },
                  },
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 8,
              endRowIndex: 9,
              startColumnIndex: 0,
              endColumnIndex: 4,
            },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: 'Open' } },
                  { userEnteredValue: { stringValue: 'CG104' } },
                  { userEnteredValue: { stringValue: 'FB127' } },
                  {},
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 8,
              endRowIndex: 9,
              startColumnIndex: 5,
              endColumnIndex: 9,
            },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: 'Keystone Casegoods' } },
                  { userEnteredValue: { stringValue: '260211' } },
                  { userEnteredValue: { stringValue: 'ARC' } },
                  { userEnteredValue: { stringValue: 'Referred' } },
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
        {
          updateCells: {
            range: {
              sheetId: 202,
              startRowIndex: 8,
              endRowIndex: 9,
              startColumnIndex: 10,
              endColumnIndex: 11,
            },
            rows: [
              {
                values: [
                  {
                    userEnteredValue: {
                      stringValue: 'https://drive.google.com/file/d/raw-url/view',
                    },
                  },
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
      ]);
    });

    it('uses inheritFromBefore: false for empty positive tables (absBottomAnchor === absTopAnchor + 1) and respects a non-zero startColumnIndex and omitted endColumnIndex', async () => {
      const {
        sheetsApi: unboundedApi,
        valuesGet: unboundedGet,
        batchUpdate: unboundedBatch,
      } = createMockSheetsApi({
        sheetId: 303,
        sheetTitle: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        gridRange: {
          sheetId: 303,
          startRowIndex: 2,
          endRowIndex: 6,
          startColumnIndex: 0,
        },
        formattedValues: [
          ['Status', 'Section', 'Title'],
          ['', '', ''],
          ['<--->'],
          ['<--->'],
        ],
        preAnchorFormulaValues: [['', '', '=UPPER(C4)']],
      });

      const unboundedRows = await appendRawPositiveTableRows(unboundedApi, archTarget, [
        {
          Status: 'Open',
          Section: '033000',
          Title: 'Ignored Formula Col',
        },
      ]);

      expect(unboundedRows).toEqual([6]);
      expect(unboundedGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal Arch'!A4:C4",
        valueRenderOption: 'FORMULA',
      });
      expect(unboundedBatch.mock.calls[0][0].requestBody.requests).toEqual([
        {
          insertDimension: {
            range: {
              sheetId: 303,
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
              sheetId: 303,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 0,
              endColumnIndex: 2,
            },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: 'Open' } },
                  { userEnteredValue: { stringValue: '033000' } },
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
      ]);

      const {
        sheetsApi: offsetApi,
        valuesGet: offsetGet,
        batchUpdate: offsetBatch,
      } = createMockSheetsApi({
        sheetId: 304,
        sheetTitle: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        gridRange: {
          sheetId: 304,
          startRowIndex: 2,
          endRowIndex: 6,
          startColumnIndex: 1,
          endColumnIndex: 4,
        },
        formattedValues: [
          ['Status', 'Section', 'Title'],
          ['', '', ''],
          ['<--->'],
          ['<--->'],
        ],
        preAnchorFormulaValues: [['', '', '=UPPER(D4)']],
      });

      const offsetRows = await appendRawPositiveTableRows(offsetApi, archTarget, [
        {
          Status: 'Open',
          Section: '071200',
          Title: 'Ignored Formula Col',
        },
      ]);

      expect(offsetRows).toEqual([6]);
      expect(offsetGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-123',
        range: "'Submittal Arch'!B4:D4",
        valueRenderOption: 'FORMULA',
      });
      expect(offsetBatch).toHaveBeenCalledTimes(1);
      expect(offsetBatch.mock.calls[0][0].requestBody.requests).toEqual([
        {
          insertDimension: {
            range: {
              sheetId: 304,
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
              sheetId: 304,
              startRowIndex: 5,
              endRowIndex: 6,
              startColumnIndex: 1,
              endColumnIndex: 3,
            },
            rows: [
              {
                values: [
                  { userEnteredValue: { stringValue: 'Open' } },
                  { userEnteredValue: { stringValue: '071200' } },
                ],
              },
            ],
            fields: 'userEnteredValue',
          },
        },
      ]);
    });

    it('retries HTTP 429 rate-limit errors with exponential backoff in appendRawPositiveTableRows', async () => {
      let batchAttempts = 0;
      const { sheetsApi, batchUpdate } = createMockSheetsApi({
        gridRange: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: 7,
          startColumnIndex: 0,
          endColumnIndex: 2,
        },
        formattedValues: [
          ['Status', 'Section'],
          [],
          ['<--->'],
          ['Open', '033000'],
          ['<--->'],
        ],
      });
      batchUpdate.mockImplementation(async () => {
        batchAttempts++;
        if (batchAttempts < 3) {
          throw { statusCode: 429, message: 'Quota exceeded' };
        }
        return { data: {} };
      });

      const insertedRowNumbers = await appendRawPositiveTableRows(
        sheetsApi,
        archTarget,
        [{ Status: 'Open', Section: '071200' }],
        {
          maxRetries: 3,
          initialDelayMs: 1,
          backoffFactor: 2,
        }
      );

      expect(batchUpdate).toHaveBeenCalledTimes(3);
      expect(insertedRowNumbers).toEqual([7]);
    });
  });

  describe('option-table helpers for Ticket #363', () => {
    it('snapshots requested NamedRanges and batches FORMATTED_VALUE reads', async () => {
      const batchGet = vi.fn().mockResolvedValue({
        data: {
          valueRanges: [
            { range: "'_Config Submittal Arch'!A1:A6", values: [['Status'], ['Open'], ['---']] },
            { range: "'_Config Submittal Arch'!H1:J4", values: [['Contact', 'Name'], ['INC', 'INC'], ['---']] },
          ],
        },
      });
      const getSpreadsheet = vi.fn().mockResolvedValue({
        data: {
          sheets: [{ properties: { sheetId: 401, title: '_Config Submittal Arch' } }],
          namedRanges: [
            {
              namedRangeId: 'nr-statuses',
              name: 'Options_Submittal_Arch_Statuses',
              range: { sheetId: 401, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 1 },
            },
            {
              namedRangeId: 'nr-contacts',
              name: 'Options_Submittal_Arch_Contacts',
              range: { sheetId: 401, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 7, endColumnIndex: 10 },
            },
          ],
        },
      });
      const sheetsApi = {
        spreadsheets: {
          get: getSpreadsheet,
          values: { batchGet },
        },
      } as unknown as sheets_v4.Sheets;

      const snapshots = await snapshotNamedRanges(sheetsApi, 'sheet-cfg-1', [
        'Options_Submittal_Arch_Statuses',
        'Options_Submittal_Arch_Contacts',
      ]);

      expect(snapshots.Options_Submittal_Arch_Statuses).toEqual({
        name: 'Options_Submittal_Arch_Statuses',
        namedRangeId: 'nr-statuses',
        sheetId: 401,
        sheetTitle: '_Config Submittal Arch',
        a1Range: "'_Config Submittal Arch'!A1:A6",
        gridRange: {
          sheetId: 401,
          startRowIndex: 0,
          endRowIndex: 6,
          startColumnIndex: 0,
          endColumnIndex: 1,
        },
      });

      const values = await readNamedRangesFormattedValues(sheetsApi, 'sheet-cfg-1', snapshots);
      expect(batchGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-cfg-1',
        ranges: ["'_Config Submittal Arch'!A1:A6", "'_Config Submittal Arch'!H1:J4"],
        valueRenderOption: 'FORMATTED_VALUE',
      });
      expect(values.Options_Submittal_Arch_Statuses).toEqual([['Status'], ['Open'], ['---']]);
      expect(values.Options_Submittal_Arch_Contacts).toEqual([['Contact', 'Name'], ['INC', 'INC'], ['---']]);
    });

    it('resolves optional extraRanges alongside named-range snapshots in a single batchGet call', async () => {
      const batchGet = vi.fn().mockResolvedValue({
        data: {
          valueRanges: [
            { range: "'_Config Submittal Arch'!A1:A6", values: [['Status'], ['Open'], ['---']] },
            {
              range: "'_Config Submittal Arch'!A1:K2",
              values: [
                ['Architecture Submittal Log Settings'],
                ['Statuses', '', '', 'Specification Divisions'],
              ],
            },
          ],
        },
      });
      const sheetsApi = {
        spreadsheets: {
          values: { batchGet },
        },
      } as unknown as sheets_v4.Sheets;

      const snapshots = {
        Options_Submittal_Arch_Statuses: {
          name: 'Options_Submittal_Arch_Statuses',
          sheetId: 401,
          sheetTitle: '_Config Submittal Arch',
          a1Range: "'_Config Submittal Arch'!A1:A6",
          gridRange: { sheetId: 401, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 1 },
        },
      };

      const values = await readNamedRangesFormattedValues(
        sheetsApi,
        'sheet-cfg-1',
        snapshots,
        undefined,
        { archHeaderBanner: "'_Config Submittal Arch'!A1:K2" }
      );

      expect(batchGet).toHaveBeenCalledTimes(1);
      expect(batchGet).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-cfg-1',
        ranges: ["'_Config Submittal Arch'!A1:A6", "'_Config Submittal Arch'!A1:K2"],
        valueRenderOption: 'FORMATTED_VALUE',
      });
      expect(values.Options_Submittal_Arch_Statuses).toEqual([['Status'], ['Open'], ['---']]);
      expect(values.archHeaderBanner).toEqual([
        ['Architecture Submittal Log Settings'],
        ['Statuses', '', '', 'Specification Divisions'],
      ]);
    });

    it('detects side-by-side _Config table range shifts or value mutations', () => {
      const baseSnap = {
        Options_Submittal_Arch_Statuses: {
          name: 'Options_Submittal_Arch_Statuses',
          namedRangeId: 'nr-1',
          sheetId: 401,
          sheetTitle: '_Config Submittal Arch',
          a1Range: "'_Config Submittal Arch'!A1:A4",
          gridRange: { sheetId: 401, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 },
        },
      };
      const baseVals = {
        Options_Submittal_Arch_Statuses: [['Status'], ['Open'], ['Closed'], ['---']],
      };

      expect(
        findSideBySideTableShiftViolations({
          beforeSnapshots: baseSnap,
          afterSnapshots: structuredClone(baseSnap),
          beforeValues: baseVals,
          afterValues: structuredClone(baseVals),
          rangeNames: ['Options_Submittal_Arch_Statuses'],
        })
      ).toEqual([]);

      const shiftedSnap = structuredClone(baseSnap);
      shiftedSnap.Options_Submittal_Arch_Statuses.gridRange.endRowIndex = 5;
      const mutatedVals = {
        Options_Submittal_Arch_Statuses: [['Status'], ['Open'], ['---']],
      };

      const violations = findSideBySideTableShiftViolations({
        beforeSnapshots: baseSnap,
        afterSnapshots: shiftedSnap,
        beforeValues: baseVals,
        afterValues: mutatedVals,
        rangeNames: ['Options_Submittal_Arch_Statuses'],
      });
      expect(violations).toHaveLength(2);
      expect(violations[0]).toContain('Options_Submittal_Arch_Statuses');
    });

    it('clears an option table to 1 unformatted blank row + "---" using range-scoped deleteRange without shifting side-by-side tables', async () => {
      const getSpreadsheet = vi.fn().mockResolvedValue({
        data: {
          sheets: [{ properties: { sheetId: 401, title: '_Config Submittal Arch' } }],
          namedRanges: [
            {
              namedRangeId: 'nr-contacts',
              name: 'Options_Submittal_Arch_Contacts',
              range: { sheetId: 401, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 7, endColumnIndex: 10 },
            },
            {
              namedRangeId: 'nr-val-contacts',
              name: 'Validation_Submittal_Arch_Contacts',
              range: { sheetId: 401, startRowIndex: 1, endRowIndex: 4, startColumnIndex: 7, endColumnIndex: 8 },
            },
          ],
        },
      });
      const valuesGet = vi.fn().mockResolvedValue({
        data: {
          values: [
            ['Contact', 'Name', 'Contact Type'],
            ['INC', 'INC Architecture', 'INC'],
            ['PMG', 'Project Management', 'Consultant'],
            ['FXC', 'FXCollaborative', 'Architect'],
            ['---'],
          ],
        },
      });
      const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
      const sheetsApi = {
        spreadsheets: {
          get: getSpreadsheet,
          values: { get: valuesGet },
          batchUpdate,
        },
      } as unknown as sheets_v4.Sheets;

      const result = await clearOptionTableToEmpty(sheetsApi, {
        spreadsheetId: 'sheet-cfg-1',
        sheetName: '_Config Submittal Arch',
        rangeName: 'Options_Submittal_Arch_Contacts',
        validationRangeName: 'Validation_Submittal_Arch_Contacts',
        endMarker: '---',
      });

      expect(result).toEqual({
        cleared: true,
        blankRowIndex: 1,
        absTerminatorRowIndex: 2,
      });
      expect(batchUpdate).toHaveBeenCalledTimes(1);
      expect(batchUpdate.mock.calls[0][0].requestBody.requests).toEqual([
        {
          updateCells: {
            range: {
              sheetId: 401,
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 7,
              endColumnIndex: 10,
            },
            rows: [{ values: [{}, {}, {}] }],
            fields: 'userEnteredValue,userEnteredFormat',
          },
        },
        {
          deleteRange: {
            range: {
              sheetId: 401,
              startRowIndex: 2,
              endRowIndex: 4,
              startColumnIndex: 7,
              endColumnIndex: 10,
            },
            shiftDimension: 'ROWS',
          },
        },
        {
          updateNamedRange: {
            namedRange: {
              namedRangeId: 'nr-val-contacts',
              name: 'Validation_Submittal_Arch_Contacts',
              range: {
                sheetId: 401,
                startRowIndex: 1,
                endRowIndex: 2,
                startColumnIndex: 7,
                endColumnIndex: 8,
              },
            },
            fields: 'range',
          },
        },
      ]);
    });

    it('reads option-table grid cell formats between header and endMarker', async () => {
      const tmplFmt = { textFormat: { fontFamily: 'Inter', fontSize: 10 } };
      const getSpreadsheet = vi.fn().mockImplementation(async (req: { includeGridData?: boolean }) => {
        if (!req.includeGridData) {
          return {
            data: {
              sheets: [{ properties: { sheetId: 401, title: '_Config Submittal Arch' } }],
              namedRanges: [
                {
                  namedRangeId: 'nr-contacts',
                  name: 'Options_Submittal_Arch_Contacts',
                  range: { sheetId: 401, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 7, endColumnIndex: 10 },
                },
              ],
            },
          };
        }
        return {
          data: {
            sheets: [
              {
                properties: { sheetId: 401, title: '_Config Submittal Arch' },
                data: [
                  {
                    startRow: 0,
                    startColumn: 7,
                    rowData: [
                      { values: [{ formattedValue: 'Contact' }, { formattedValue: 'Name' }, { formattedValue: 'Contact Type' }] },
                      { values: [{ formattedValue: '' }, { formattedValue: '' }, { formattedValue: '' }] },
                      {
                        values: [
                          { formattedValue: 'T363C', userEnteredFormat: tmplFmt },
                          { formattedValue: 'T363C', userEnteredFormat: tmplFmt },
                          { formattedValue: '', userEnteredFormat: tmplFmt },
                        ],
                      },
                      { values: [{ formattedValue: '---' }] },
                    ],
                  },
                ],
              },
            ],
          },
        };
      });
      const sheetsApi = {
        spreadsheets: {
          get: getSpreadsheet,
        },
      } as unknown as sheets_v4.Sheets;

      const gridInfo = await readOptionTableGridFormats(sheetsApi, {
        spreadsheetId: 'sheet-cfg-1',
        sheetName: '_Config Submittal Arch',
        rangeName: 'Options_Submittal_Arch_Contacts',
        endMarker: '---',
      });

      expect(gridInfo.headerRow).toEqual(['Contact', 'Name', 'Contact Type']);
      expect(gridInfo.dataRows).toHaveLength(2);
      expect(gridInfo.dataRows[0].absRowIndex).toBe(1);
      expect(gridInfo.dataRows[0].cells[0].userEnteredFormat).toBeUndefined();
      expect(gridInfo.dataRows[1].absRowIndex).toBe(2);
      expect(gridInfo.dataRows[1].cells).toEqual([
        { formattedValue: 'T363C', userEnteredFormat: tmplFmt },
        { formattedValue: 'T363C', userEnteredFormat: tmplFmt },
        { formattedValue: '', userEnteredFormat: tmplFmt },
      ]);
    });

    it('reads headerNotes and sheetMerges in readOptionTableGridFormats without changing API call count', async () => {
      const sheetMerges: sheets_v4.Schema$GridRange[] = [
        { sheetId: 401, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 5, endColumnIndex: 9 },
      ];
      const getSpreadsheet = vi.fn().mockImplementation(async (req: { includeGridData?: boolean; fields?: string }) => {
        if (!req.includeGridData) {
          return {
            data: {
              sheets: [
                {
                  properties: { sheetId: 401, title: '_Config Submittal Arch' },
                  merges: sheetMerges,
                },
              ],
              namedRanges: [
                {
                  namedRangeId: 'nr-contacts',
                  name: 'Options_Submittal_Arch_Contacts',
                  range: { sheetId: 401, startRowIndex: 2, endRowIndex: 6, startColumnIndex: 5, endColumnIndex: 9 },
                },
              ],
            },
          };
        }
        return {
          data: {
            sheets: [
              {
                properties: { sheetId: 401, title: '_Config Submittal Arch' },
                data: [
                  {
                    startRow: 2,
                    startColumn: 5,
                    rowData: [
                      {
                        values: [
                          { formattedValue: 'Type' },
                          { formattedValue: 'Key' },
                          { formattedValue: 'Name' },
                          {
                            formattedValue: 'Aliases',
                            note: 'Comma-separated aliases; wrap ""quotes"" and note case-sensitive matching.',
                          },
                        ],
                      },
                      { values: [{ formattedValue: 'Consultant' }, { formattedValue: 'PMG' }, { formattedValue: 'Pavarini' }, { formattedValue: '' }] },
                      { values: [{ formattedValue: '---' }] },
                    ],
                  },
                ],
              },
            ],
          },
        };
      });
      const sheetsApi = {
        spreadsheets: {
          get: getSpreadsheet,
        },
      } as unknown as sheets_v4.Sheets;

      const gridInfo = await readOptionTableGridFormats(sheetsApi, {
        spreadsheetId: 'sheet-cfg-1',
        sheetName: '_Config Submittal Arch',
        rangeName: 'Options_Submittal_Arch_Contacts',
        endMarker: '---',
      });

      expect(getSpreadsheet).toHaveBeenCalledTimes(2);
      expect(getSpreadsheet).toHaveBeenNthCalledWith(1, {
        spreadsheetId: 'sheet-cfg-1',
        fields: 'sheets(properties(sheetId,title),merges),namedRanges',
      });
      expect(getSpreadsheet).toHaveBeenNthCalledWith(2, {
        spreadsheetId: 'sheet-cfg-1',
        ranges: ["'_Config Submittal Arch'!F3:I6"],
        includeGridData: true,
        fields: 'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(formattedValue,userEnteredFormat,note))))',
      });
      expect(gridInfo.headerNotes).toEqual([
        '',
        '',
        '',
        'Comma-separated aliases; wrap ""quotes"" and note case-sensitive matching.',
      ]);
      expect(gridInfo.sheetMerges).toEqual(sheetMerges);
    });

    it('handles single-row and already-empty tables and rejects missing endMarker in clearOptionTableToEmpty', async () => {
      const makeApi = (values: string[][]) => {
        const batchUpdate = vi.fn().mockResolvedValue({ data: {} });
        const sheetsApi = {
          spreadsheets: {
            get: vi.fn().mockResolvedValue({
              data: {
                sheets: [{ properties: { sheetId: 401, title: '_Config Submittal Arch' } }],
                namedRanges: [
                  {
                    namedRangeId: 'nr-contacts',
                    name: 'Options_Submittal_Arch_Contacts',
                    range: {
                      sheetId: 401,
                      startRowIndex: 0,
                      endRowIndex: values.length,
                      startColumnIndex: 7,
                      endColumnIndex: 10,
                    },
                  },
                ],
              },
            }),
            values: {
              get: vi.fn().mockResolvedValue({ data: { values } }),
            },
            batchUpdate,
          },
        } as unknown as sheets_v4.Sheets;
        return { sheetsApi, batchUpdate };
      };

      const singleRow = makeApi([
        ['Contact', 'Name', 'Contact Type'],
        ['INC', 'INC Architecture', 'INC'],
        ['---'],
      ]);
      const singleRes = await clearOptionTableToEmpty(singleRow.sheetsApi, {
        spreadsheetId: 'sheet-cfg-1',
        sheetName: '_Config Submittal Arch',
        rangeName: 'Options_Submittal_Arch_Contacts',
        endMarker: '---',
      });
      expect(singleRes).toEqual({
        cleared: true,
        blankRowIndex: 1,
        absTerminatorRowIndex: 2,
      });
      expect(singleRow.batchUpdate).toHaveBeenCalledTimes(1);
      expect(singleRow.batchUpdate.mock.calls[0][0].requestBody.requests).toHaveLength(1);

      const alreadyEmpty = makeApi([
        ['Contact', 'Name', 'Contact Type'],
        ['---'],
      ]);
      const emptyRes = await clearOptionTableToEmpty(alreadyEmpty.sheetsApi, {
        spreadsheetId: 'sheet-cfg-1',
        sheetName: '_Config Submittal Arch',
        rangeName: 'Options_Submittal_Arch_Contacts',
        endMarker: '---',
      });
      expect(emptyRes).toEqual({
        cleared: false,
        blankRowIndex: 1,
        absTerminatorRowIndex: 1,
      });
      expect(alreadyEmpty.batchUpdate).not.toHaveBeenCalled();

      const missingMarker = makeApi([
        ['Contact', 'Name', 'Contact Type'],
        ['INC', 'INC Architecture', 'INC'],
      ]);
      await expect(
        clearOptionTableToEmpty(missingMarker.sheetsApi, {
          spreadsheetId: 'sheet-cfg-1',
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Contacts',
          endMarker: '---',
        })
      ).rejects.toThrow(/missing endMarker "---"/);
    });
  });

  describe('shared rate-limit retry delegation', () => {
    it('retries HTTP 403 quota-reason errors with ±25% jitter while ignoring non-quota 403', async () => {
      const randomSpy = vi
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0) // 0.75x
        .mockReturnValueOnce(0.999999); // ~1.25x
      const sleepMock = vi.fn().mockResolvedValue(undefined);

      try {
        let getAttempts = 0;
        const { sheetsApi, getSpreadsheet } = createMockSheetsApi({
          formattedValues: [['Status', 'Section'], [], ['<--->'], [], ['<--->']],
        });

        getSpreadsheet.mockImplementation(async () => {
          getAttempts++;
          if (getAttempts === 1) {
            throw { status: 403, errors: [{ reason: 'userRateLimitExceeded' }], message: 'Quota' };
          }
          if (getAttempts === 2) {
            throw {
              response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
              message: 'Rate limit',
            };
          }
          return {
            data: {
              sheets: [{ properties: { sheetId: 101, title: 'Submittal Arch' } }],
              namedRanges: [
                {
                  name: 'Log_Submittal_Arch',
                  range: { sheetId: 101, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 2 },
                },
              ],
            },
          };
        });

        await ensureClearedPositiveTable(sheetsApi, archTarget, {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffFactor: 2,
          sleep: sleepMock,
        });

        expect(getSpreadsheet).toHaveBeenCalledTimes(3);
        expect(sleepMock).toHaveBeenCalledTimes(2);
        expect(sleepMock.mock.calls[0]?.[0]).toBe(75);
        expect(sleepMock.mock.calls[1]?.[0]).toBe(250);

        sleepMock.mockClear();
        getSpreadsheet.mockRejectedValueOnce({
          status: 403,
          errors: [{ reason: 'forbidden' }],
          message: 'Insufficient Permission',
        });

        await expect(
          ensureClearedPositiveTable(sheetsApi, archTarget, {
            maxRetries: 3,
            initialDelayMs: 100,
            sleep: sleepMock,
          })
        ).rejects.toMatchObject({ status: 403 });
        expect(sleepMock).not.toHaveBeenCalled();
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('honors AbortSignal to terminate active retry backoff immediately', async () => {
      const controller = new AbortController();
      const { sheetsApi, getSpreadsheet } = createMockSheetsApi({
        formattedValues: [['Status', 'Section'], [], ['<--->'], [], ['<--->']],
      });
      getSpreadsheet.mockRejectedValue({ statusCode: 429, message: 'Too Many Requests' });

      const promise = ensureClearedPositiveTable(sheetsApi, archTarget, {
        maxRetries: 3,
        initialDelayMs: 60_000,
        signal: controller.signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(getSpreadsheet).toHaveBeenCalledTimes(1);
    });

    it('wraps readSpreadsheetMetadata, readSpreadsheetValues, batchUpdateSpreadsheetValues, and readSheetsGridLayout with rate-limit retry', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const retryOpts = { maxRetries: 2, initialDelayMs: 10, backoffFactor: 2, sleep: sleepMock };

      let metaAttempt = 0;
      let valuesGetAttempt = 0;
      let valuesBatchUpdateAttempt = 0;
      let gridAttempt = 0;

      const getSpreadsheet = vi.fn().mockImplementation(async (req: { includeGridData?: boolean }) => {
        if (req.includeGridData) {
          gridAttempt++;
          if (gridAttempt === 1) {
            throw { status: 429, message: 'Rate limited' };
          }
          return { data: { sheets: [], namedRanges: [] } };
        }
        metaAttempt++;
        if (metaAttempt === 1) {
          throw { status: 429, message: 'Rate limited' };
        }
        return { data: { sheets: [{ properties: { sheetId: 7, title: 'Submittal Arch' } }] } };
      });

      const valuesGet = vi.fn().mockImplementation(async () => {
        valuesGetAttempt++;
        if (valuesGetAttempt === 1) {
          throw { status: 403, errors: [{ reason: 'userRateLimitExceeded' }], message: 'Quota' };
        }
        return { data: { values: [['CalcValue']] } };
      });

      const valuesBatchUpdate = vi.fn().mockImplementation(async () => {
        valuesBatchUpdateAttempt++;
        if (valuesBatchUpdateAttempt === 1) {
          throw { statusCode: 429, message: 'Rate limited' };
        }
        return { data: { totalUpdatedCells: 1 } };
      });

      const sheetsApi = {
        spreadsheets: {
          get: getSpreadsheet,
          values: {
            get: valuesGet,
            batchUpdate: valuesBatchUpdate,
          },
        },
      } as unknown as sheets_v4.Sheets;

      const meta = await readSpreadsheetMetadata(sheetsApi, 'sheet-123', undefined, retryOpts);
      expect(meta.sheets?.[0]?.properties?.sheetId).toBe(7);

      const values = await readSpreadsheetValues(
        sheetsApi,
        'sheet-123',
        "'Submittal FF&E'!L6",
        'FORMATTED_VALUE',
        retryOpts
      );
      expect(values).toEqual([['CalcValue']]);

      await batchUpdateSpreadsheetValues(
        sheetsApi,
        'sheet-123',
        [{ range: "'_Config Submittal Arch'!I5", values: [['alias']] }],
        'RAW',
        retryOpts
      );

      const grid = await readSheetsGridLayout(
        sheetsApi,
        'sheet-123',
        ["'_Config Submittal Arch'!A1:K4"],
        retryOpts
      );
      expect(grid).toEqual({ sheets: [], namedRanges: [] });

      let directAttempts = 0;
      const directResult = await withLiveSheetsRetry(async () => {
        directAttempts++;
        if (directAttempts === 1) {
          throw { status: 429, message: 'Retry me' };
        }
        return 'ok';
      }, retryOpts);
      expect(directResult).toBe('ok');
      expect(directAttempts).toBe(2);
      expect(sleepMock).toHaveBeenCalledTimes(5);
    });
  });
});

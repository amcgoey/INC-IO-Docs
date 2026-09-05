import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import {
  GoogleSheetsClient,
  formatScopedRange,
  cellValueToCellData,
  valuesToRowData,
} from './google-sheets-client';
import {
  GoogleSheetsApiError,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
} from './errors';
import type { SheetsConfigProvider } from './types';

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
      {
        properties: {
          sheetId: 0,
          title: 'Sheet1',
        },
      },
      {
        properties: {
          sheetId: 101,
          title: 'DataLog',
        },
      },
    ],
    namedRanges: [
      {
        namedRangeId: 'nr-1',
        name: 'Headers',
        range: {
          sheetId: 0,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 5,
        },
      },
      {
        namedRangeId: 'nr-2',
        name: 'Data',
        range: {
          sheetId: 0,
          startRowIndex: 1,
          endRowIndex: 10,
          startColumnIndex: 0,
          endColumnIndex: 5,
        },
      },
      {
        namedRangeId: 'nr-3',
        name: 'DataLog!LogEntries',
        range: {
          sheetId: 101,
          startRowIndex: 5,
          endRowIndex: 20,
          startColumnIndex: 1,
          endColumnIndex: 6,
        },
      },
      {
        namedRangeId: 'nr-4',
        name: 'TopHeader',
        range: {
          sheetId: 101,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: 4,
        },
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

  describe('formatScopedRange', () => {
    it('wraps sheet name in single quotes and appends range name', () => {
      expect(formatScopedRange('Sheet1', 'Headers')).toBe("'Sheet1'!Headers");
    });

    it('handles sheet names containing spaces', () => {
      expect(formatScopedRange('Monthly Report 2026', 'Data')).toBe("'Monthly Report 2026'!Data");
    });

    it('escapes existing single quotes in sheet name by doubling them', () => {
      expect(formatScopedRange("John's Sheet", 'RangeA')).toBe("'John''s Sheet'!RangeA");
    });
  });

  describe('cellValueToCellData & valuesToRowData', () => {
    it('maps null and undefined to empty object', () => {
      expect(cellValueToCellData(null)).toEqual({});
      // @ts-expect-error test undefined input
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

    it('maps formulas to formulaValue', () => {
      expect(cellValueToCellData('=SUM(A1:A10)')).toEqual({
        userEnteredValue: { formulaValue: '=SUM(A1:A10)' },
      });
    });

    it('maps normal strings to stringValue', () => {
      expect(cellValueToCellData('hello world')).toEqual({
        userEnteredValue: { stringValue: 'hello world' },
      });
    });

    it('converts 2D array of CellValues to Schema$RowData array', () => {
      const rows = valuesToRowData([
        ['Name', 10, true],
        [null, '=A1', false],
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
            { userEnteredValue: { formulaValue: '=A1' } },
            { userEnteredValue: { boolValue: false } },
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

    it('accepts auth token string option', () => {
      const client = new GoogleSheetsClient({ auth: 'ya29.sample-token' });
      expect(client).toBeInstanceOf(GoogleSheetsClient);
    });

    it('accepts OAuth2Client option', () => {
      const oauth = new OAuth2Client();
      const client = new GoogleSheetsClient({ auth: oauth });
      expect(client).toBeInstanceOf(GoogleSheetsClient);
    });
  });

  describe('readNamedRange', () => {
    it('reads named range using UNFORMATTED_VALUE and scoped range', async () => {
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
        range: "'Sheet1'!Headers",
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

    it('resolves sheet-scoped named range formatted as Sheet!Range', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.readNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'DataLog',
        rangeName: 'LogEntries',
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'DataLog'!LogEntries",
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
        message: 'Unable to parse range: Sheet1!Headers',
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
    it('overwrites named range using values.update when insertRows is false', async () => {
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
        range: "'Sheet1'!Headers",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['ID', 'Full Name', 'Status']],
        },
      });
      expect(mockSheetsApi.spreadsheets.batchUpdate).not.toHaveBeenCalled();
    });

    it('overwrites named range when insertRows is omitted', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.writeNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Headers',
        values: [['ID', 'Full Name']],
      });

      expect(mockSheetsApi.spreadsheets.values.update).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'Sheet1'!Headers",
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['ID', 'Full Name']],
        },
      });
    });

    it('executes atomic batchUpdate with InsertDimensionRequest and UpdateCellsRequest when insertRows is true', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.writeNamedRange({
        spreadsheetId: 'sheet-abc-123',
        sheetName: 'Sheet1',
        rangeName: 'Data', // startRowIndex: 1, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 5
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
                  endIndex: 3, // 1 + 2 rows
                },
                inheritFromBefore: true, // startRowIndex > 0
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
        rangeName: 'TopHeader', // startRowIndex: 0
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

    it('does not retry on non-429 errors (e.g. 500 or 404)', async () => {
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

  describe('Downstream Stubs', () => {
    it('insertIntoGroupedList throws descriptive error indicating blocked by #99', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          rowData: { ID: '10' },
          groupConfig: { columnName: 'ID', value: '10' },
          sortConfig: { columnName: 'ID', value: '10' },
        })
      ).rejects.toThrow(/Method insertIntoGroupedList not yet implemented\. Blocked by Issue #99\./);
    });

  describe('findRowsByValue', () => {
    it('fetches headers and data, filters matching rows, and returns converted RowRecords', async () => {
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
        if (range.includes('Headers')) {
          return {
            data: {
              values: [['ID', 'Name', 'Score', 'Active']],
            },
          };
        }
        if (range.includes('Data')) {
          return {
            data: {
              values: [
                ['1', 'Alice', 95.5, true],
                ['2', 'Bob', 82.0, false],
                ['3', 'Alice', 99.0, false],
              ],
            },
          };
        }
        return { data: { values: [] } };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      const results = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'Name',
        value: 'Alice',
      });

      expect(results).toEqual([
        { ID: '1', Name: 'Alice', Score: 95.5, Active: true },
        { ID: '3', Name: 'Alice', Score: 99.0, Active: false },
      ]);

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'Sheet1'!Headers",
        valueRenderOption: 'UNFORMATTED_VALUE',
      });

      expect(mockSheetsApi.spreadsheets.values.get).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        range: "'Sheet1'!Data",
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
    });

    it('isolates caller from physical column order and maps missing/trailing cells to null', async () => {
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
        if (range.includes('Headers')) {
          return {
            data: {
              values: [['Active', 'ID', 'Role', 'Name']],
            },
          };
        }
        if (range.includes('Data')) {
          return {
            data: {
              values: [
                [true, '10'], // Role and Name are omitted/short row
              ],
            },
          };
        }
        return { data: { values: [] } };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      const results = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'ID',
        value: '10',
      });

      expect(results).toEqual([
        { Active: true, ID: '10', Role: null, Name: null },
      ]);
    });

    it('returns empty array when no rows match the search value', async () => {
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
        if (range.includes('Headers')) {
          return {
            data: {
              values: [['ID', 'Name']],
            },
          };
        }
        if (range.includes('Data')) {
          return {
            data: {
              values: [
                ['1', 'Alice'],
                ['2', 'Bob'],
              ],
            },
          };
        }
        return { data: { values: [] } };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      const results = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'Name',
        value: 'Charlie',
      });

      expect(results).toEqual([]);
    });

    it('returns empty array when data range is empty', async () => {
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
        if (range.includes('Headers')) {
          return {
            data: {
              values: [['ID', 'Name']],
            },
          };
        }
        return { data: { values: undefined } };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      const results = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'Name',
        value: 'Alice',
      });

      expect(results).toEqual([]);
    });

    it('handles numeric, boolean, and null search values accurately', async () => {
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
        if (range.includes('Headers')) {
          return {
            data: {
              values: [['ID', 'Score', 'Active', 'Notes']],
            },
          };
        }
        if (range.includes('Data')) {
          return {
            data: {
              values: [
                ['1', 95.5, true, 'Great'],
                ['2', 80, false, null],
                ['3', 0, false], // Notes omitted
              ],
            },
          };
        }
        return { data: { values: [] } };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // Search by numeric
      const scoreResults = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'Score',
        value: 95.5,
      });
      expect(scoreResults).toEqual([
        { ID: '1', Score: 95.5, Active: true, Notes: 'Great' },
      ]);

      // Search by boolean
      const activeResults = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'Active',
        value: false,
      });
      expect(activeResults).toEqual([
        { ID: '2', Score: 80, Active: false, Notes: null },
        { ID: '3', Score: 0, Active: false, Notes: null },
      ]);

      // Search by null
      const nullResults = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'Notes',
        value: null,
      });
      expect(nullResults).toEqual([
        { ID: '2', Score: 80, Active: false, Notes: null },
        { ID: '3', Score: 0, Active: false, Notes: null },
      ]);
    });

    it('requires exact column name match and throws if casing differs', async () => {
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
        if (range.includes('Headers')) {
          return {
            data: {
              values: [['UserID', 'EmailAddress']],
            },
          };
        }
        if (range.includes('Data')) {
          return {
            data: {
              values: [['u-1', 'test@example.com']],
            },
          };
        }
        return { data: { values: [] } };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // Exact match succeeds
      const results = await client.findRowsByValue({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        columnName: 'EmailAddress',
        value: 'test@example.com',
      });

      expect(results).toEqual([
        { UserID: 'u-1', EmailAddress: 'test@example.com' },
      ]);

      // Casing mismatch fails with GoogleSheetsColumnNotFoundError
      await expect(
        client.findRowsByValue({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          columnName: 'emailaddress',
          value: 'test@example.com',
        })
      ).rejects.toThrow(GoogleSheetsColumnNotFoundError);
    });

    it('throws GoogleSheetsColumnNotFoundError with descriptive error when column name is not found in headers', async () => {
      mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
        if (range.includes('Headers')) {
          return {
            data: {
              values: [['ID', 'Name', 'Score']],
            },
          };
        }
        return { data: { values: [] } };
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.findRowsByValue({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          columnName: 'NonExistentColumn',
          value: 'test',
        })
      ).rejects.toThrow(GoogleSheetsColumnNotFoundError);

      await expect(
        client.findRowsByValue({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          columnName: 'NonExistentColumn',
          value: 'test',
        })
      ).rejects.toThrow(/Column "NonExistentColumn" not found/);
    });

    it('throws GoogleSheetsNamedRangeNotFoundError when headers or data range is not found', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.findRowsByValue({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'MissingHeaderRange',
            dataRangeName: 'Data',
          },
          columnName: 'ID',
          value: '1',
        })
      ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
    });
  });
  });
});

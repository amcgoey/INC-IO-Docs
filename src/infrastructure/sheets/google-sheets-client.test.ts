import { describe, it, expect, vi, beforeEach } from 'vitest';
import { type sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import {
  GoogleSheetsClient,
  formatScopedRange,
  cellValueToCellData,
  valuesToRowData,
  compareCellValues,
} from './google-sheets-client';
import {
  GoogleSheetsApiError,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
} from './errors';
import type { CellValue, SheetsConfigProvider } from './types';

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

  const mockHeadersAndData = (headers: CellValue[][], data: CellValue[][] = []) => {
    mockSheetsApi.spreadsheets.values.get.mockImplementation(async ({ range }: { range: string }) => {
      if (range.includes('Headers') || range.includes('Header')) {
        return { data: { values: headers } };
      }
      if (range.includes('Data') || range.includes('Entries')) {
        return { data: { values: data } };
      }
      return { data: { values: [] } };
    });
  };

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

  describe('compareCellValues', () => {
    it('sorts numbers in numerical order', () => {
      expect(compareCellValues(100, 20)).toBeGreaterThan(0);
      expect(compareCellValues(20, 100)).toBeLessThan(0);
      expect(compareCellValues(42, 42)).toBe(0);
      expect(compareCellValues(-10, 5)).toBeLessThan(0);
      expect(compareCellValues(0, -1)).toBeGreaterThan(0);
    });

    it('sorts numbers before strings', () => {
      expect(compareCellValues(10, 'apple')).toBeGreaterThan(0);
      expect(compareCellValues('apple', 10)).toBeLessThan(0);
      expect(compareCellValues(0, '0')).toBeGreaterThan(0);
      expect(compareCellValues(-99, 'zebra')).toBeGreaterThan(0);
    });

    it('sorts strings case-insensitively', () => {
      expect(compareCellValues('Alpha', 'alpha')).toBe(0);
      expect(compareCellValues('zebra', 'Apple')).toBeGreaterThan(0);
      expect(compareCellValues('Apple', 'zebra')).toBeLessThan(0);
      expect(compareCellValues('beta', 'beta')).toBe(0);
    });

    it('sorts nulls and empty strings to bottom', () => {
      expect(compareCellValues('test', null)).toBeGreaterThan(0);
      expect(compareCellValues(10, null)).toBeGreaterThan(0);
      expect(compareCellValues('test', '')).toBeGreaterThan(0);
      expect(compareCellValues(10, '')).toBeGreaterThan(0);
      expect(compareCellValues(null, 'test')).toBeLessThan(0);
      expect(compareCellValues('', 10)).toBeLessThan(0);
      expect(compareCellValues(null, null)).toBe(0);
      expect(compareCellValues('', '')).toBe(0);
      expect(compareCellValues(null, '')).toBe(0);
      expect(compareCellValues('', null)).toBe(0);
      expect(compareCellValues(undefined, null)).toBe(0);
    });

    it('sorts an array descending matching all rules combined', () => {
      const input: CellValue[] = [null, 'banana', 10, '', 'Apple', 100, 2, 'zebra', null];
      const sorted = [...input].sort((a, b) => compareCellValues(b, a));
      expect(sorted).toEqual([100, 10, 2, 'zebra', 'banana', 'Apple', null, '', null]);
    });
  });

  describe('insertIntoGroupedList', () => {
    it('throws GoogleSheetsColumnNotFoundError if groupConfig.columnName is not in headers', async () => {
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: { values: [['ID', 'Score', 'Status']] },
      });
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          rowData: { ID: '1', Score: 100 },
          groupConfig: { columnName: 'NonExistentGroup', value: 'GrpA' },
          sortConfig: { columnName: 'Score', value: 100 },
        })
      ).rejects.toThrow(GoogleSheetsColumnNotFoundError);
    });

    it('throws GoogleSheetsColumnNotFoundError if sortConfig.columnName is not in headers', async () => {
      mockSheetsApi.spreadsheets.values.get.mockResolvedValueOnce({
        data: { values: [['ID', 'Group', 'Status']] },
      });
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          rowData: { ID: '1', Group: 'GrpA' },
          groupConfig: { columnName: 'Group', value: 'GrpA' },
          sortConfig: { columnName: 'MissingSortColumn', value: 100 },
        })
      ).rejects.toThrow(GoogleSheetsColumnNotFoundError);
    });

    it('throws GoogleSheetsNamedRangeNotFoundError if headerRangeName does not exist', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'UnknownHeaders',
            dataRangeName: 'Data',
          },
          rowData: { ID: '1' },
          groupConfig: { columnName: 'ID', value: '1' },
          sortConfig: { columnName: 'ID', value: '1' },
        })
      ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
    });

    it('throws GoogleSheetsNamedRangeNotFoundError if dataRangeName does not exist', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'UnknownData',
          },
          rowData: { ID: '1' },
          groupConfig: { columnName: 'ID', value: '1' },
          sortConfig: { columnName: 'ID', value: '1' },
        })
      ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
    });

    it('throws GoogleSheetsApiError if sheet is not found', async () => {
      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'MissingSheet',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          rowData: { ID: '1' },
          groupConfig: { columnName: 'ID', value: '1' },
          sortConfig: { columnName: 'ID', value: '1' },
        })
      ).rejects.toThrow(GoogleSheetsApiError);
    });

    it('throws GoogleSheetsNamedRangeNotFoundError if a named range is on a different sheet than target sheet', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({
        data: {
          ...defaultSpreadsheetMetadata,
          namedRanges: [
            {
              namedRangeId: 'nr-1',
              name: 'Headers',
              range: {
                sheetId: 0,
                startRowIndex: 0,
                endRowIndex: 1,
              },
            },
            {
              namedRangeId: 'nr-2',
              name: 'Sheet1!Data', // Name matches scoped pattern, but physical cells reside on sheetId 101
              range: {
                sheetId: 101,
                startRowIndex: 1,
                endRowIndex: 10,
              },
            },
          ],
        },
      });

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await expect(
        client.insertIntoGroupedList({
          target: {
            spreadsheetId: 'sheet-abc-123',
            sheetName: 'Sheet1',
            headerRangeName: 'Headers',
            dataRangeName: 'Data',
          },
          rowData: { ID: '1' },
          groupConfig: { columnName: 'ID', value: '1' },
          sortConfig: { columnName: 'ID', value: '1' },
        })
      ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
    });

    it('resolves the correct sheet-scoped named range when multiple sheets have the same range name', async () => {
      mockSheetsApi.spreadsheets.get.mockResolvedValueOnce({
        data: {
          ...defaultSpreadsheetMetadata,
          namedRanges: [
            {
              namedRangeId: 'nr-headers-datalog',
              name: 'Headers',
              range: { sheetId: 101, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
            },
            {
              namedRangeId: 'nr-headers-sheet1',
              name: 'Headers',
              range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 },
            },
            {
              namedRangeId: 'nr-data-datalog',
              name: 'Data',
              range: { sheetId: 101, startRowIndex: 1, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 2 },
            },
            {
              namedRangeId: 'nr-data-sheet1',
              name: 'Data',
              range: { sheetId: 0, startRowIndex: 1, endRowIndex: 20, startColumnIndex: 0, endColumnIndex: 2 },
            },
          ],
        },
      });

      mockHeadersAndData([['Group', 'Score']], []);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1', // Targets sheetId 0
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'G1', Score: 100 },
        groupConfig: { columnName: 'Group', value: 'G1' },
        sortConfig: { columnName: 'Score', value: 100 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: expect.arrayContaining([
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    sheetId: 0, // Must resolve to Sheet1 (0), not DataLog (101)
                  }),
                }),
              }),
            ]),
          },
        })
      );
    });

    it('handles internal blank rows within an existing group without fragmenting the group', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['A', 100, 'Top'],
          [null, null, null], // Accidental internal blank row
          ['A', 50, 'Bottom'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // Score 70 should insert before row index 2 ('A', 50)
      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 70, Name: 'Middle' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 70 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: expect.arrayContaining([
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    startIndex: 3, // 1 + 2 (before the 3rd row in data)
                    endIndex: 4,
                  }),
                }),
              }),
            ]),
          },
        })
      );
    });

    it('inserts into an existing group in descending sort order (at top of group)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['A', 80, 'Alice'],
          ['A', 50, 'Bob'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data', // Data startRowIndex is 1
        },
        rowData: { Group: 'A', Score: 95, Name: 'Charlie' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 95 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 1, // data startRowIndex (1) + relative index (0)
                  endIndex: 2,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 1,
                  endRowIndex: 2,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['A', 95, 'Charlie']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
      expect(mockSheetsApi.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it('inserts into an existing group in middle of group', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['A', 100, 'Top'],
          ['A', 50, 'Bottom'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 75, Name: 'Middle' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 75 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: [
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    startIndex: 2, // data startRowIndex (1) + relative index (1)
                    endIndex: 3,
                  }),
                }),
              }),
              expect.objectContaining({
                updateCells: expect.objectContaining({
                  range: expect.objectContaining({
                    startRowIndex: 2,
                    endRowIndex: 3,
                  }),
                  rows: valuesToRowData([['A', 75, 'Middle']]),
                }),
              }),
            ],
          },
        })
      );
    });

    it('inserts at bottom of existing group when sort value is lowest or equal', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['A', 100, 'Top'],
          ['A', 50, 'Bottom'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 50, Name: 'EqualBottom' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 50 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: [
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    startIndex: 3, // data startRowIndex (1) + relative index (2)
                    endIndex: 4,
                  }),
                }),
              }),
              expect.objectContaining({
                updateCells: expect.objectContaining({
                  range: expect.objectContaining({
                    startRowIndex: 3,
                    endRowIndex: 4,
                  }),
                  rows: valuesToRowData([['A', 50, 'EqualBottom']]),
                }),
              }),
            ],
          },
        })
      );
    });

    it('determines position in descending order when group does not exist (before first group)', async () => {
      mockHeadersAndData([['Group', 'Score', 'Name']], [['B', 100, 'ExistingGroupB']]);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // 'C' > 'B' in descending order, so group 'C' must be inserted before group 'B'
      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'C', Score: 50, Name: 'GroupC_Row' },
        groupConfig: { columnName: 'Group', value: 'C' },
        sortConfig: { columnName: 'Score', value: 50 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: [
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    startIndex: 1, // data startRowIndex (1) + relative index (0)
                    endIndex: 3, // inserts 2 rows: data row C + 1 blank row separating C from B
                  }),
                }),
              }),
              expect.objectContaining({
                updateCells: expect.objectContaining({
                  range: expect.objectContaining({
                    startRowIndex: 1,
                    endRowIndex: 2,
                  }),
                  rows: valuesToRowData([['C', 50, 'GroupC_Row']]),
                }),
              }),
            ],
          },
        })
      );
    });

    it('determines position in descending order when group does not exist (between existing groups)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['Z', 90, 'FirstGroup2'],
          [null, null, null], // Blank row separator
          ['A', 80, 'SecondGroup'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // 'M' is between 'Z' and 'A' (Z > M > A). Should insert at start of group 'A' (relative index 3).
      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'M', Score: 60, Name: 'MiddleGroupRow' },
        groupConfig: { columnName: 'Group', value: 'M' },
        sortConfig: { columnName: 'Score', value: 60 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: [
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    startIndex: 4, // data startRowIndex (1) + relative index (3)
                    endIndex: 6, // inserts 2 rows: data row M + 1 blank row separating M from A
                  }),
                }),
              }),
              expect.objectContaining({
                updateCells: expect.objectContaining({
                  range: expect.objectContaining({
                    startRowIndex: 4,
                    endRowIndex: 5,
                  }),
                  rows: valuesToRowData([['M', 60, 'MiddleGroupRow']]),
                }),
              }),
            ],
          },
        })
      );
    });

    it('determines position in descending order when group does not exist (after last group)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['M', 50, 'SecondGroup'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // 'A' is smaller than 'Z' and 'M'. Should insert after 'M' (relative index 2).
      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 10, Name: 'LastGroupRow' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 10 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: [
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    startIndex: 3, // 1 + 2
                    endIndex: 5, // inserts 2 rows: 1 blank row separating from M + data row A
                  }),
                }),
              }),
              expect.objectContaining({
                updateCells: expect.objectContaining({
                  range: expect.objectContaining({
                    startRowIndex: 4,
                    endRowIndex: 5,
                  }),
                  rows: valuesToRowData([['A', 10, 'LastGroupRow']]),
                }),
              }),
            ],
          },
        })
      );
    });

    it('inserts at index 0 when data range is empty', async () => {
      mockHeadersAndData([['Group', 'Score']], []);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'First', Score: 100 },
        groupConfig: { columnName: 'Group', value: 'First' },
        sortConfig: { columnName: 'Score', value: 100 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: expect.arrayContaining([
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    startIndex: 1, // startRowIndex 1 + 0
                    endIndex: 2,
                  }),
                }),
              }),
            ]),
          },
        })
      );
    });

    it('correctly maps RowRecord: ignores extra keys and fills missing headers with null', async () => {
      mockHeadersAndData([['ID', 'Name', 'Notes', 'Active', 'Score']], []);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: {
          ID: '123',
          Name: 'Bob',
          UnmappedExtraField1: 'ignored',
          UnmappedExtraField2: 999,
          // Notes and Active omitted
          Score: 0,
        },
        groupConfig: { columnName: 'ID', value: '123' },
        sortConfig: { columnName: 'Score', value: 0 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: expect.arrayContaining([
              expect.objectContaining({
                updateCells: expect.objectContaining({
                  rows: valuesToRowData([['123', 'Bob', null, null, 0]]),
                }),
              }),
            ]),
          },
        })
      );
    });

    it('sets inheritFromBefore: false when inserting at sheet row 0', async () => {
      mockHeadersAndData([['Group', 'Val']], []);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // TopHeader starts at row 0. 'Z_New' sorts before existing row 'Group', placing it at row 0
      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'DataLog',
          headerRangeName: 'TopHeader',
          dataRangeName: 'TopHeader',
        },
        rowData: { Group: 'Z_New', Val: 10 },
        groupConfig: { columnName: 'Group', value: 'Z_New' },
        sortConfig: { columnName: 'Val', value: 10 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: expect.arrayContaining([
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  inheritFromBefore: false,
                }),
              }),
            ]),
          },
        })
      );
    });

    it('resolves sheet-scoped named range (e.g. DataLog!LogEntries)', async () => {
      mockHeadersAndData([['Group', 'Score']], []);

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'DataLog',
          headerRangeName: 'TopHeader',
          dataRangeName: 'LogEntries', // nr-3: DataLog!LogEntries, startRowIndex: 5
        },
        rowData: { Group: 'G1', Score: 10 },
        groupConfig: { columnName: 'Group', value: 'G1' },
        sortConfig: { columnName: 'Score', value: 10 },
      });

      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            requests: expect.arrayContaining([
              expect.objectContaining({
                insertDimension: expect.objectContaining({
                  range: expect.objectContaining({
                    sheetId: 101,
                    startIndex: 5,
                    endIndex: 6,
                  }),
                }),
              }),
            ]),
          },
        })
      );
    });
  });

  describe('findRowsByValue', () => {
    it('fetches headers and data, filters matching rows, and returns converted RowRecords', async () => {
      mockHeadersAndData(
        [['ID', 'Name', 'Score', 'Active']],
        [
          ['1', 'Alice', 95.5, true],
          ['2', 'Bob', 82.0, false],
          ['3', 'Alice', 99.0, false],
        ]
      );

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
      mockHeadersAndData([['Active', 'ID', 'Role', 'Name']], [[true, '10']]);

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
      mockHeadersAndData([['ID', 'Name']], [['1', 'Alice'], ['2', 'Bob']]);

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
      mockHeadersAndData([['ID', 'Name']], []);

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
      mockHeadersAndData(
        [['ID', 'Score', 'Active', 'Notes']],
        [
          ['1', 95.5, true, 'Great'],
          ['2', 80, false, null],
          ['3', 0, false], // Notes omitted
        ]
      );

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
      mockHeadersAndData([['UserID', 'EmailAddress']], [['u-1', 'test@example.com']]);

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
      mockHeadersAndData([['ID', 'Name', 'Score']], []);

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

  describe('insertIntoGroupedList - Blank Row Padding & Healing (Issue 100)', () => {
    it('heals under-padding when inserting a new group between groups with 0 blank rows (inserts 3 rows: blank, data, blank)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['Z', 90, 'FirstGroup2'],
          ['A', 80, 'SecondGroup'], // 0 blank rows between Z and A
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data', // startRowIndex: 1
        },
        rowData: { Group: 'M', Score: 60, Name: 'MiddleGroupRow' },
        groupConfig: { columnName: 'Group', value: 'M' },
        sortConfig: { columnName: 'Score', value: 60 },
      });

      // At nextGroup.startIndex (2), inserts 3 rows [blank, data, blank] at absolute index 3 (1 + 2)
      // data row is written at absolute index 4 (1 + 2 + 1)
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 3,
                  endIndex: 6,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['M', 60, 'MiddleGroupRow']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('maintains padding when inserting a new group between groups with 1 blank row (inserts 2 rows: data, blank)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['Z', 90, 'FirstGroup2'],
          [null, null, null], // 1 blank row
          ['A', 80, 'SecondGroup'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'M', Score: 60, Name: 'MiddleGroupRow' },
        groupConfig: { columnName: 'Group', value: 'M' },
        sortConfig: { columnName: 'Score', value: 60 },
      });

      // At nextGroup.startIndex (3), inserts 2 rows [data, blank] at absolute index 4 (1 + 3)
      // data row is written at absolute index 4
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 6,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['M', 60, 'MiddleGroupRow']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('maintains padding when inserting a new group between groups with 2 blank rows (inserts 1 row between blanks)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['Z', 90, 'FirstGroup2'],
          [null, null, null], // blank 1
          [null, null, null], // blank 2
          ['A', 80, 'SecondGroup'],
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'M', Score: 60, Name: 'MiddleGroupRow' },
        groupConfig: { columnName: 'Group', value: 'M' },
        sortConfig: { columnName: 'Score', value: 60 },
      });

      // 2 blanks already exist at rel 2 and 3. Inserts 1 row at rel 3 (abs 4) between them.
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 5,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['M', 60, 'MiddleGroupRow']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('heals over-padding when inserting a new group between groups with multiple (3+) blank rows (deletes excess blank rows)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['Z', 90, 'FirstGroup2'],
          [null, null, null], // blank 1 (rel 2)
          [null, null, null], // blank 2 (rel 3)
          [null, null, null], // blank 3 (rel 4, excess 1)
          [null, null, null], // blank 4 (rel 5, excess 2)
          ['A', 80, 'SecondGroup'], // rel 6
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'M', Score: 60, Name: 'MiddleGroupRow' },
        groupConfig: { columnName: 'Group', value: 'M' },
        sortConfig: { columnName: 'Score', value: 60 },
      });

      // 4 blanks exist. Deletes 2 excess blanks from rel 4 (abs 5) to rel 6 (abs 7).
      // Then inserts 1 data row at rel 3 (abs 4) between the remaining 2 blanks.
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 5,
                  endIndex: 7,
                },
              },
            },
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 5,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['M', 60, 'MiddleGroupRow']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('heals over-padding when inserting a new group before first group with multiple blank rows (deletes excess blank rows)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          [null, null, null], // rel 0
          [null, null, null], // rel 1 (excess 1)
          [null, null, null], // rel 2 (excess 2)
          ['B', 100, 'ExistingGroupB'], // rel 3
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'C', Score: 50, Name: 'GroupC_Row' },
        groupConfig: { columnName: 'Group', value: 'C' },
        sortConfig: { columnName: 'Score', value: 50 },
      });

      // 3 blanks before B. Deletes 2 excess blanks from rel 1 (abs 2) to rel 3 (abs 4).
      // Then inserts 1 row at rel 0 (abs 1) before the remaining blank row.
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 2,
                  endIndex: 4,
                },
              },
            },
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 1,
                  endIndex: 2,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 1,
                  endRowIndex: 2,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['C', 50, 'GroupC_Row']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('maintains padding when inserting a new group before first group with exactly 1 blank row (inserts 1 row)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          [null, null, null], // rel 0 (1 blank row)
          ['B', 100, 'ExistingGroupB'], // rel 1
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'C', Score: 50, Name: 'GroupC_Row' },
        groupConfig: { columnName: 'Group', value: 'C' },
        sortConfig: { columnName: 'Score', value: 50 },
      });

      // 1 blank row exists at rel 0. Inserts 1 row at rel 0 (abs 1) before the blank row.
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
                  endIndex: 2,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 1,
                  endRowIndex: 2,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['C', 50, 'GroupC_Row']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('maintains padding when inserting a new group after last group with exactly 1 blank row (inserts 1 row)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['M', 50, 'SecondGroup'], // rel 1
          [null, null, null], // rel 2 (1 blank row)
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 10, Name: 'LastGroupRow' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 10 },
      });

      // 1 blank row exists after M at rel 2. Inserts 1 row at rel 3 (abs 4) after the blank row.
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 5,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['A', 10, 'LastGroupRow']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('heals over-padding when inserting a new group after last group with multiple blank rows (deletes excess blank rows)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'FirstGroup'],
          ['M', 50, 'SecondGroup'], // rel 1
          [null, null, null], // rel 2
          [null, null, null], // rel 3 (excess 1)
          [null, null, null], // rel 4 (excess 2)
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 10, Name: 'LastGroupRow' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 10 },
      });

      // 3 blanks after M. Deletes 2 excess blanks from rel 3 (abs 4) to rel 5 (abs 6).
      // Then inserts 1 row at rel 3 (abs 4).
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 6,
                },
              },
            },
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 5,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['A', 10, 'LastGroupRow']]),
                fields: 'userEnteredValue',
              },
            },
          ],
        },
      });
    });

    it('heals under-padding around an existing group (inserts blank rows above and below)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'GroupZ_1'], // rel 0
          ['A', 80, 'GroupA_Top'], // rel 1 (0 blanks from Z)
          ['A', 50, 'GroupA_Bottom'], // rel 2
          ['B', 70, 'GroupB_1'], // rel 3 (0 blanks from A)
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      // Insert score 65 into Group A (between Top and Bottom at rel 2)
      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 65, Name: 'GroupA_Middle' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 65 },
      });

      // 1. Above: 0 blanks -> inserts 1 blank at Group A start (rel 1, abs 2)
      // 2. Data row: rel 2 inside A + 1 indexShift = rel 3 (abs 4) -> inserts data row at abs 4
      // 3. Write data row at abs 4
      // 4. Below: 0 blanks -> inserts 1 blank below Group A at effectiveEndIndex + 1 (2 + 1 + 1 + 1 = 5, abs 6)
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 2,
                  endIndex: 3,
                },
                inheritFromBefore: true,
              },
            },
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 5,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['A', 65, 'GroupA_Middle']]),
                fields: 'userEnteredValue',
              },
            },
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 6,
                  endIndex: 7,
                },
                inheritFromBefore: true,
              },
            },
          ],
        },
      });
    });

    it('heals over-padding around an existing group (deletes excess blank rows above and below)', async () => {
      mockHeadersAndData(
        [['Group', 'Score', 'Name']],
        [
          ['Z', 100, 'GroupZ_1'], // rel 0
          [null, null, null], // rel 1
          [null, null, null], // rel 2 (excess above 1)
          [null, null, null], // rel 3 (excess above 2)
          ['A', 80, 'GroupA_1'], // rel 4
          [null, null, null], // rel 5
          [null, null, null], // rel 6 (excess below 1)
          ['B', 70, 'GroupB_1'], // rel 7
        ]
      );

      const client = new GoogleSheetsClient(mockSheetsApi as unknown as sheets_v4.Sheets);

      await client.insertIntoGroupedList({
        target: {
          spreadsheetId: 'sheet-abc-123',
          sheetName: 'Sheet1',
          headerRangeName: 'Headers',
          dataRangeName: 'Data',
        },
        rowData: { Group: 'A', Score: 50, Name: 'GroupA_2' },
        groupConfig: { columnName: 'Group', value: 'A' },
        sortConfig: { columnName: 'Score', value: 50 },
      });

      // 1. Above: 3 blanks -> deletes 2 excess blanks from rel 2 (abs 3) to rel 4 (abs 5)
      // 2. Data row: rel 5 inside A - 2 indexShift = rel 3 (abs 4) -> inserts data row at abs 4
      // 3. Write data row at abs 4
      // 4. Below: 2 blanks -> deletes 1 excess blank below Group A
      expect(mockSheetsApi.spreadsheets.batchUpdate).toHaveBeenCalledWith({
        spreadsheetId: 'sheet-abc-123',
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 3,
                  endIndex: 5,
                },
              },
            },
            {
              insertDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 4,
                  endIndex: 5,
                },
                inheritFromBefore: true,
              },
            },
            {
              updateCells: {
                range: {
                  sheetId: 0,
                  startRowIndex: 4,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 3,
                },
                rows: valuesToRowData([['A', 50, 'GroupA_2']]),
                fields: 'userEnteredValue',
              },
            },
            {
              deleteDimension: {
                range: {
                  sheetId: 0,
                  dimension: 'ROWS',
                  startIndex: 6,
                  endIndex: 7,
                },
              },
            },
          ],
        },
      });
    });
  });
});

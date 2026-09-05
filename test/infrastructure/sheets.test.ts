import { describe, it, expect, beforeAll } from 'vitest';
import {
  GoogleSheetsClient,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
} from '../../src/infrastructure/sheets';

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_TEST_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_TEST_SHEET_NAME ?? 'Sheet1';
const TEST_RANGE_NAME = process.env.GOOGLE_SHEETS_TEST_RANGE_NAME ?? 'Data';
const TEST_HEADER_RANGE_NAME = process.env.GOOGLE_SHEETS_TEST_HEADER_RANGE_NAME ?? 'Headers';

describe.skipIf(!SPREADSHEET_ID)('Live Google Sheets Integration Tests', () => {
  let client: GoogleSheetsClient;

  beforeAll(() => {
    // GoogleSheetsClient defaults to google.sheets({ version: 'v4' }) using ambient Google ADC
    client = new GoogleSheetsClient();
  });

  it('reads a configured named range from a live spreadsheet', async () => {
    const data = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
    });

    expect(Array.isArray(data)).toBe(true);
  });

  it('throws GoogleSheetsNamedRangeNotFoundError for non-existent range on live sheet', async () => {
    await expect(
      client.readNamedRange({
        spreadsheetId: SPREADSHEET_ID!,
        sheetName: SHEET_NAME,
        rangeName: 'NonExistentNamedRange_XYZ_123',
      })
    ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);
  });

  it('writes and updates cell values in a named range without inserting rows', async () => {
    const timestamp = Date.now();
    const testData = [[`TestEntry_${timestamp}`, 42, true]];

    await client.writeNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
      values: testData,
      insertRows: false,
    });

    const updated = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
    });

    expect(updated.length).toBeGreaterThanOrEqual(1);
    expect(updated[0][0]).toBe(`TestEntry_${timestamp}`);
    expect(updated[0][1]).toBe(42);
    expect(updated[0][2]).toBe(true);
  });

  it('executes atomic batchUpdate with InsertDimensionRequest when insertRows is true', async () => {
    const timestamp = Date.now();
    const insertedRow = [[`InsertedEntry_${timestamp}`, 99, false]];

    const before = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
    });

    await client.writeNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
      values: insertedRow,
      insertRows: true,
    });

    const after = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
    });

    expect(after.length).toBe(before.length + 1);
    expect(after[0][0]).toBe(`InsertedEntry_${timestamp}`);
    expect(after[0][1]).toBe(99);
    expect(after[0][2]).toBe(false);
  });

  it('searches rows by column value in a live spreadsheet', async () => {
    const timestamp = Date.now();
    const entryValue = `SearchEntry_${timestamp}`;
    const newRow = [[entryValue, 123, true]];

    await client.writeNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
      values: newRow,
      insertRows: true,
    });

    const headers = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_HEADER_RANGE_NAME,
    });

    const firstColumnHeader = String(headers[0]?.[0] ?? 'ID');

    const matchingRows = await client.findRowsByValue({
      target: {
        spreadsheetId: SPREADSHEET_ID!,
        sheetName: SHEET_NAME,
        headerRangeName: TEST_HEADER_RANGE_NAME,
        dataRangeName: TEST_RANGE_NAME,
      },
      columnName: firstColumnHeader,
      value: entryValue,
    });

    expect(matchingRows.length).toBeGreaterThanOrEqual(1);
    expect(matchingRows[0][firstColumnHeader]).toBe(entryValue);
  });

  it('throws GoogleSheetsColumnNotFoundError for non-existent column name on live sheet', async () => {
    await expect(
      client.findRowsByValue({
        target: {
          spreadsheetId: SPREADSHEET_ID!,
          sheetName: SHEET_NAME,
          headerRangeName: TEST_HEADER_RANGE_NAME,
          dataRangeName: TEST_RANGE_NAME,
        },
        columnName: 'NonExistentColumn_XYZ_123',
        value: 'anything',
      })
    ).rejects.toThrow(GoogleSheetsColumnNotFoundError);
  });
});

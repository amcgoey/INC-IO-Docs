import { describe, it, expect, beforeAll } from 'vitest';
import {
  GoogleSheetsClient,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
  type PositiveTableTarget,
  type SheetCellInput,
} from '../../src/infrastructure/sheets';

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_TEST_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_TEST_SHEET_NAME ?? 'Sheet1';
const TEST_RANGE_NAME = process.env.GOOGLE_SHEETS_TEST_RANGE_NAME ?? 'Log_Submittal_Arch';
const EXTENT_MARKER = process.env.GOOGLE_SHEETS_TEST_EXTENT_MARKER ?? '<--->';
const GROUP_DIVIDER_MARKER = process.env.GOOGLE_SHEETS_TEST_GROUP_DIVIDER_MARKER ?? '---';

describe.skipIf(!SPREADSHEET_ID)('Live Google Sheets Integration Tests', () => {
  let client: GoogleSheetsClient;

  const buildTarget = (): PositiveTableTarget => ({
    spreadsheetId: SPREADSHEET_ID!,
    sheetName: SHEET_NAME,
    rangeName: TEST_RANGE_NAME,
    extentMarker: EXTENT_MARKER,
    groupDividerMarker: GROUP_DIVIDER_MARKER,
  });

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

  it('reads headers and rows from a positive-terminated table via readTable', async () => {
    const result = await client.readTable({
      target: buildTarget(),
    });

    expect(Array.isArray(result.headers)).toBe(true);
    expect(result.headers.length).toBeGreaterThan(0);
    expect(Array.isArray(result.rows)).toBe(true);
    for (const row of result.rows) {
      expect(typeof row.rowNumber).toBe('number');
      expect(row.rowNumber).toBeGreaterThan(0);
      expect(typeof row.values).toBe('object');
    }
  });

  it('throws GoogleSheetsColumnNotFoundError for a non-existent writable column in rowData', async () => {
    await expect(
      client.insertIntoGroupedList({
        target: buildTarget(),
        rowData: {
          NonExistentColumn_XYZ_123: 'anything',
        },
      })
    ).rejects.toThrow(GoogleSheetsColumnNotFoundError);
  });

  it('inserts a row into a positive-terminated table and makes it observable via readTable', async () => {
    const target = buildTarget();
    const before = await client.readTable({ target });
    expect(before.headers.length).toBeGreaterThan(0);

    const firstCol = before.headers[0];
    const secondCol = before.headers[1];
    const timestamp = Date.now();
    const uniqueValue = `TestEntry_${timestamp}`;

    const rowData: Record<string, SheetCellInput> = {
      [firstCol]: uniqueValue,
    };
    if (secondCol) {
      rowData[secondCol] = `Note_${timestamp}`;
    }

    const insertResult = await client.insertIntoGroupedList({
      target,
      rowData,
    });

    expect(insertResult).toEqual({
      rowNumber: expect.any(Number),
      action: 'inserted',
    });
    expect(insertResult.rowNumber).toBeGreaterThan(0);

    const after = await client.readTable({ target });
    const insertedRow = after.rows.find(
      (row) => row.rowNumber === insertResult.rowNumber && row.values[firstCol] === uniqueValue
    );

    expect(insertedRow).toBeDefined();
    expect(insertedRow?.values[firstCol]).toBe(uniqueValue);
    if (secondCol) {
      expect(insertedRow?.values[secondCol]).toBe(`Note_${timestamp}`);
    }
  });
});

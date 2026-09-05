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

  it('inserts a row into a grouped list in a live spreadsheet', async () => {
    const headers = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_HEADER_RANGE_NAME,
    });

    const headerRow = headers[0] ?? [];
    const firstCol = String(headerRow[0] ?? 'ID');
    const secondCol = String(headerRow[1] ?? headerRow[0] ?? 'Score');

    const timestamp = Date.now();
    const groupVal = `Group_${timestamp}`;
    const sortVal = timestamp;

    await client.insertIntoGroupedList({
      target: {
        spreadsheetId: SPREADSHEET_ID!,
        sheetName: SHEET_NAME,
        headerRangeName: TEST_HEADER_RANGE_NAME,
        dataRangeName: TEST_RANGE_NAME,
      },
      rowData: {
        [firstCol]: groupVal,
        [secondCol]: sortVal,
      },
      groupConfig: {
        columnName: firstCol,
        value: groupVal,
      },
      sortConfig: {
        columnName: secondCol,
        value: sortVal,
      },
    });

    const rows = await client.findRowsByValue({
      target: {
        spreadsheetId: SPREADSHEET_ID!,
        sheetName: SHEET_NAME,
        headerRangeName: TEST_HEADER_RANGE_NAME,
        dataRangeName: TEST_RANGE_NAME,
      },
      columnName: firstCol,
      value: groupVal,
    });

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0][firstCol]).toBe(groupVal);
  });

  it('maintains exact 1-row blank padding separating distinct groups in a live spreadsheet', async () => {
    const headers = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_HEADER_RANGE_NAME,
    });

    const headerRow = headers[0] ?? [];
    const firstCol = String(headerRow[0] ?? 'ID');
    const secondCol = String(headerRow[1] ?? headerRow[0] ?? 'Score');

    const timestamp = Date.now();
    const group1 = `GroupZ_${timestamp}`;
    const group2 = `GroupA_${timestamp}`;

    // Insert into Group 1 (descending higher)
    await client.insertIntoGroupedList({
      target: {
        spreadsheetId: SPREADSHEET_ID!,
        sheetName: SHEET_NAME,
        headerRangeName: TEST_HEADER_RANGE_NAME,
        dataRangeName: TEST_RANGE_NAME,
      },
      rowData: {
        [firstCol]: group1,
        [secondCol]: 100,
      },
      groupConfig: {
        columnName: firstCol,
        value: group1,
      },
      sortConfig: {
        columnName: secondCol,
        value: 100,
      },
    });

    // Insert into Group 2 (descending lower)
    await client.insertIntoGroupedList({
      target: {
        spreadsheetId: SPREADSHEET_ID!,
        sheetName: SHEET_NAME,
        headerRangeName: TEST_HEADER_RANGE_NAME,
        dataRangeName: TEST_RANGE_NAME,
      },
      rowData: {
        [firstCol]: group2,
        [secondCol]: 50,
      },
      groupConfig: {
        columnName: firstCol,
        value: group2,
      },
      sortConfig: {
        columnName: secondCol,
        value: 50,
      },
    });

    const dataRows = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
    });

    // Locate the rows for group1 and group2
    const group1Indices: number[] = [];
    const group2Indices: number[] = [];
    dataRows.forEach((row, idx) => {
      const val = row[0];
      if (val === group1) group1Indices.push(idx);
      if (val === group2) group2Indices.push(idx);
    });

    expect(group1Indices.length).toBeGreaterThanOrEqual(1);
    expect(group2Indices.length).toBeGreaterThanOrEqual(1);

    const group1LastRow = Math.max(...group1Indices);
    const group2FirstRow = Math.min(...group2Indices);

    // Group 1 precedes Group 2 with descending order
    expect(group2FirstRow).toBeGreaterThan(group1LastRow);

    // Exactly 1 blank row must separate group1 and group2
    const rowsBetween = group2FirstRow - group1LastRow - 1;
    expect(rowsBetween).toBe(1);

    const separatorRow = dataRows[group1LastRow + 1];
    expect(separatorRow[0] === null || separatorRow[0] === undefined || separatorRow[0] === '').toBe(true);
  });

  it('heals manual formatting mistakes in a live spreadsheet by removing excess blank rows and enforcing 1-row padding', async () => {
    const headers = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_HEADER_RANGE_NAME,
    });

    const headerRow = headers[0] ?? [];
    const firstCol = String(headerRow[0] ?? 'ID');
    const secondCol = String(headerRow[1] ?? headerRow[0] ?? 'Score');

    const timestamp = Date.now();
    const groupA = `HealA_${timestamp}`;
    const groupB = `HealB_${timestamp}`;

    // Step 1: Write raw rows with manual formatting mistakes:
    // groupA row, followed by 3 blank rows (over-padded), followed by groupB row
    const messyRows = [
      [groupA, 100],
      ['', ''],
      ['', ''],
      ['', ''],
      [groupB, 20],
    ];

    await client.writeNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
      values: messyRows,
      insertRows: true,
    });

    // Step 2: Insert into groupB, which should trigger healing of the padding above it
    await client.insertIntoGroupedList({
      target: {
        spreadsheetId: SPREADSHEET_ID!,
        sheetName: SHEET_NAME,
        headerRangeName: TEST_HEADER_RANGE_NAME,
        dataRangeName: TEST_RANGE_NAME,
      },
      rowData: {
        [firstCol]: groupB,
        [secondCol]: 25,
      },
      groupConfig: {
        columnName: firstCol,
        value: groupB,
      },
      sortConfig: {
        columnName: secondCol,
        value: 25,
      },
    });

    // Step 3: Verify the sheet now has exactly 1 blank row separating groupA and groupB
    const dataRows = await client.readNamedRange({
      spreadsheetId: SPREADSHEET_ID!,
      sheetName: SHEET_NAME,
      rangeName: TEST_RANGE_NAME,
    });

    const groupAIndices: number[] = [];
    const groupBIndices: number[] = [];
    dataRows.forEach((row, idx) => {
      const val = row[0];
      if (val === groupA) groupAIndices.push(idx);
      if (val === groupB) groupBIndices.push(idx);
    });

    expect(groupAIndices.length).toBe(1);
    expect(groupBIndices.length).toBe(2);

    const groupALast = groupAIndices[0];
    const groupBFirst = Math.min(...groupBIndices);

    // After healing, exactly 1 blank row should separate groupA and groupB
    expect(groupBFirst - groupALast - 1).toBe(1);
    const blankRow = dataRows[groupALast + 1];
    expect(blankRow[0] === null || blankRow[0] === undefined || blankRow[0] === '').toBe(true);
  });
});


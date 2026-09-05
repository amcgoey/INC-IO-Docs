import type { OAuth2Client } from 'google-auth-library';
import type { sheets_v4 } from 'googleapis';

export type CellValue = string | number | boolean | null;
export type RowRecord = Record<string, CellValue>;

export interface SheetTargetConfig {
  spreadsheetId: string;
  sheetName: string;       // Scopes the named ranges to a specific tab
  headerRangeName: string; // The range containing column headers
  dataRangeName: string;   // The range containing the actual data (must start/end with blank rows)
}

export interface InsertGroupedRowRequest {
  target: SheetTargetConfig;
  rowData: RowRecord;

  groupConfig: {
    columnName: string; // The header name identifying the group
    value: CellValue;   // The group identifier
  };

  sortConfig: {
    columnName: string; // The header name identifying the sort order
    value: CellValue;   // The sort identifier
  };
}

export interface FindRowsRequest {
  target: SheetTargetConfig;
  columnName: string;
  value: CellValue;
}

export interface ReadNamedRangeRequest {
  spreadsheetId: string;
  sheetName: string;
  rangeName: string;
}

export interface WriteNamedRangeRequest {
  spreadsheetId: string;
  sheetName: string;
  rangeName: string;
  values: CellValue[][]; // 2D array for direct grid writes
  insertRows?: boolean;  // If true, inserts physical rows instead of just overwriting
}

export interface SheetsRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SheetsConfigProvider {
  getSheetsConfig(): Promise<{
    maxRetries?: number | undefined;
    initialDelayMs?: number | undefined;
    backoffFactor?: number | undefined;
  } | undefined>;
}

export interface GoogleSheetsClientOptions {
  auth?: OAuth2Client | string | undefined;
  sheets?: sheets_v4.Sheets | undefined;
  retryOptions?: SheetsRetryOptions | undefined;
  configProvider?: SheetsConfigProvider | undefined;
}

export interface SheetsClient {
  insertIntoGroupedList(request: InsertGroupedRowRequest): Promise<void>;
  findRowsByValue(request: FindRowsRequest): Promise<RowRecord[]>;
  readNamedRange(request: ReadNamedRangeRequest): Promise<CellValue[][]>;
  writeNamedRange(request: WriteNamedRangeRequest): Promise<void>;
}

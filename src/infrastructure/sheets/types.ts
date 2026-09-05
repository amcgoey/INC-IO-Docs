import type { OAuth2Client } from 'google-auth-library';
import type { sheets_v4 } from 'googleapis';
import { Type, type Static } from '@sinclair/typebox';

export const CellValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
export type CellValue = Static<typeof CellValueSchema>;

export const RowRecordSchema = Type.Record(Type.String(), CellValueSchema);
export type RowRecord = Static<typeof RowRecordSchema>;

export const NamedRangeTargetSchema = Type.Object({
  spreadsheetId: Type.String({ minLength: 1 }),
  sheetName: Type.String({ minLength: 1 }),
  rangeName: Type.String({ minLength: 1 }),
});
export type NamedRangeTarget = Static<typeof NamedRangeTargetSchema>;

export const SheetTargetConfigSchema = Type.Object({
  spreadsheetId: Type.String({ minLength: 1 }),
  sheetName: Type.String({ minLength: 1 }),
  headerRangeName: Type.String({ minLength: 1 }),
  dataRangeName: Type.String({ minLength: 1 }),
});
export type SheetTargetConfig = Static<typeof SheetTargetConfigSchema>;

export const InsertGroupedRowRequestSchema = Type.Object({
  target: SheetTargetConfigSchema,
  rowData: RowRecordSchema,
  groupConfig: Type.Object({
    columnName: Type.String({ minLength: 1 }),
    value: CellValueSchema,
  }),
  sortConfig: Type.Object({
    columnName: Type.String({ minLength: 1 }),
    value: CellValueSchema,
  }),
});
export type InsertGroupedRowRequest = Static<typeof InsertGroupedRowRequestSchema>;

export const FindRowsRequestSchema = Type.Object({
  target: SheetTargetConfigSchema,
  columnName: Type.String({ minLength: 1 }),
  value: CellValueSchema,
});
export type FindRowsRequest = Static<typeof FindRowsRequestSchema>;

export const ReadNamedRangeRequestSchema = NamedRangeTargetSchema;
export type ReadNamedRangeRequest = Static<typeof ReadNamedRangeRequestSchema>;

export const WriteNamedRangeRequestSchema = Type.Intersect([
  NamedRangeTargetSchema,
  Type.Object({
    values: Type.Array(Type.Array(CellValueSchema)),
    insertRows: Type.Optional(Type.Boolean()),
  }),
]);
export type WriteNamedRangeRequest = Static<typeof WriteNamedRangeRequestSchema>;

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

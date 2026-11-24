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

export const SheetFormulaCellSchema = Type.Object({
  formula: Type.String(),
});
export type SheetFormulaCell = Static<typeof SheetFormulaCellSchema>;

export const SheetCellInputSchema = Type.Union([
  CellValueSchema,
  SheetFormulaCellSchema,
]);
export type SheetCellInput = Static<typeof SheetCellInputSchema>;

export const RowRecordSchema = Type.Record(Type.String(), CellValueSchema);
export type RowRecord = Static<typeof RowRecordSchema>;

export const NamedRangeTargetSchema = Type.Object({
  spreadsheetId: Type.String({ minLength: 1 }),
  sheetName: Type.String({ minLength: 1 }),
  rangeName: Type.String({ minLength: 1 }),
});
export type NamedRangeTarget = Static<typeof NamedRangeTargetSchema>;

export const PositiveTableTargetSchema = Type.Object({
  spreadsheetId: Type.String({ minLength: 1 }),
  sheetName: Type.String({ minLength: 1 }),
  rangeName: Type.String({ minLength: 1 }),
  extentMarker: Type.String({ minLength: 1 }),
  groupDividerMarker: Type.String({ minLength: 1 }),
});
export type PositiveTableTarget = Static<typeof PositiveTableTargetSchema>;

export const ReadPositiveTableRequestSchema = Type.Object({
  target: PositiveTableTargetSchema,
});
export type ReadPositiveTableRequest = Static<typeof ReadPositiveTableRequestSchema>;

export const PositiveTableRowSchema = Type.Object({
  rowNumber: Type.Number(),
  values: RowRecordSchema,
});
export type PositiveTableRow = Static<typeof PositiveTableRowSchema>;

export const PositiveTableReadResultSchema = Type.Object({
  headers: Type.Array(Type.String()),
  formulaColumns: Type.Array(Type.String()),
  rows: Type.Array(PositiveTableRowSchema),
});
export type PositiveTableReadResult = Static<typeof PositiveTableReadResultSchema>;

export const RowKeySchema = Type.Object({
  groupKey: Type.String(),
  sortKey: Type.String(),
});
export type RowKey = Static<typeof RowKeySchema>;

export const InsertGroupedRowResultSchema = Type.Object({
  rowNumber: Type.Number(),
  action: Type.Union([Type.Literal('inserted'), Type.Literal('updated')]),
});
export type InsertGroupedRowResult = Static<typeof InsertGroupedRowResultSchema>;

export interface InsertPositiveGroupedRowRequest {
  target: PositiveTableTarget;
  rowData: Record<string, SheetCellInput>;
  rowKeyExtractor?: ((row: RowRecord) => RowKey | null) | undefined;
  targetKeys?: RowKey | undefined;
  groupSortOrder?: 'asc' | 'desc' | undefined;
  rowSortOrder?: 'asc' | 'desc' | undefined;
  duplicatePolicy?: 'insert' | 'upsert' | 'reject' | undefined;
  readOnlyColumns?: string[] | undefined;
}

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
  readTable(request: ReadPositiveTableRequest): Promise<PositiveTableReadResult>;
  insertIntoGroupedList(request: InsertPositiveGroupedRowRequest): Promise<InsertGroupedRowResult>;
  readNamedRange(request: ReadNamedRangeRequest): Promise<CellValue[][]>;
  writeNamedRange(request: WriteNamedRangeRequest): Promise<void>;
}

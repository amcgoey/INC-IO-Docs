import { google, type sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type {
  CellValue,
  GoogleSheetsClientOptions,
  InsertGroupedRowResult,
  InsertPositiveGroupedRowRequest,
  NamedRangeTarget,
  PositiveTableReadResult,
  PositiveTableRow,
  PositiveTableTarget,
  ReadNamedRangeRequest,
  ReadPositiveTableRequest,
  RowRecord,
  SheetCellInput,
  SheetFormulaCell,
  SheetsClient,
  SheetsConfigProvider,
  SheetsRetryOptions,
  WriteNamedRangeRequest,
} from './types';
import {
  GoogleSheetsApiError,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsExtentAnchorNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
} from './errors';
import { KeyedAsyncLock } from './keyed-lock';

function extractHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as { statusCode?: unknown; status?: unknown; code?: unknown; response?: { status?: unknown } };
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  if (typeof err.code === 'number') return err.code;
  return undefined;
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = extractHttpStatusCode(error);
  if (status === 429) return true;
  const err = error as Record<string, unknown>;
  return err.code === '429' || err.code === 429;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

function quoteSheetName(sheetName: string): string {
  const unquoted = sheetName.replace(/^'|'$/g, '');
  const escaped = unquoted.replace(/'/g, "''");
  return `'${escaped}'`;
}

/**
 * Formats a sheet-qualified range reference with proper single-quote escaping.
 */
export function formatScopedRange(sheetName: string, rangeName: string): string {
  return `${quoteSheetName(sheetName)}!${rangeName}`;
}

/**
 * Converts a 0-based column index to its A1 column letters (e.g. 0 -> "A", 26 -> "AA").
 */
export function columnIndexToLetter(columnIndex: number): string {
  if (!Number.isInteger(columnIndex) || columnIndex < 0) {
    throw new GoogleSheetsApiError(`Invalid column index: ${columnIndex}`);
  }
  let index = columnIndex;
  let result = '';
  while (index >= 0) {
    result = String.fromCharCode((index % 26) + 65) + result;
    index = Math.floor(index / 26) - 1;
  }
  return result;
}

/**
 * Converts a Sheets GridRange into explicit sheet-qualified A1 bounds (e.g. `'Submittal Arch'!A3:J25`)
 * so workbook-scoped Named Ranges do not trigger `400 Unable to parse range` on values APIs.
 */
export function gridRangeToA1(sheetName: string, gridRange: sheets_v4.Schema$GridRange): string {
  const startRowIndex = gridRange.startRowIndex ?? 0;
  const endRowIndex = gridRange.endRowIndex;
  const startColumnIndex = gridRange.startColumnIndex ?? 0;
  const endColumnIndex = gridRange.endColumnIndex;

  if (endColumnIndex !== undefined && endColumnIndex !== null) {
    if (endColumnIndex <= startColumnIndex) {
      throw new GoogleSheetsApiError(
        `Invalid GridRange: endColumnIndex (${endColumnIndex}) must be greater than startColumnIndex (${startColumnIndex}).`
      );
    }
    if (endRowIndex !== undefined && endRowIndex !== null && endRowIndex <= startRowIndex) {
      throw new GoogleSheetsApiError(
        `Invalid GridRange: endRowIndex (${endRowIndex}) must be greater than startRowIndex (${startRowIndex}).`
      );
    }
    const startCol = columnIndexToLetter(startColumnIndex);
    const endCol = columnIndexToLetter(endColumnIndex - 1);
    const startRow = startRowIndex + 1;
    const endRowPart = endRowIndex !== undefined && endRowIndex !== null ? String(endRowIndex) : '';
    return formatScopedRange(sheetName, `${startCol}${startRow}:${endCol}${endRowPart}`);
  }

  if (startColumnIndex > 0) {
    throw new GoogleSheetsApiError(
      `Invalid GridRange: unbounded endColumnIndex with non-zero startColumnIndex (${startColumnIndex}) cannot be converted to A1 notation.`
    );
  }

  if (endRowIndex !== undefined && endRowIndex !== null) {
    if (endRowIndex <= startRowIndex) {
      throw new GoogleSheetsApiError(
        `Invalid GridRange: endRowIndex (${endRowIndex}) must be greater than startRowIndex (${startRowIndex}).`
      );
    }
    return formatScopedRange(sheetName, `${startRowIndex + 1}:${endRowIndex}`);
  }

  if (startRowIndex === 0) {
    return quoteSheetName(sheetName);
  }

  throw new GoogleSheetsApiError(
    `Invalid GridRange: unbounded endRowIndex and endColumnIndex past row 0 cannot be converted to A1 notation.`
  );
}

/**
 * Type guard identifying explicit `{ formula }` cell inputs.
 */
export function isSheetFormulaCell(value: unknown): value is SheetFormulaCell {
  return (
    typeof value === 'object' &&
    value !== null &&
    'formula' in value &&
    typeof (value as { formula: unknown }).formula === 'string'
  );
}

/**
 * Maps a `SheetCellInput` to Google Sheets `CellData`.
 * Plain strings always map to `stringValue` (never `formulaValue`) to prevent spreadsheet formula injection.
 */
export function cellValueToCellData(value: SheetCellInput | undefined): sheets_v4.Schema$CellData {
  if (value === null || value === undefined) {
    return {};
  }
  if (isSheetFormulaCell(value)) {
    return { userEnteredValue: { formulaValue: value.formula } };
  }
  if (typeof value === 'boolean') {
    return { userEnteredValue: { boolValue: value } };
  }
  if (typeof value === 'number') {
    return { userEnteredValue: { numberValue: value } };
  }
  if (typeof value === 'string') {
    return { userEnteredValue: { stringValue: value } };
  }
  return { userEnteredValue: { stringValue: String(value) } };
}

export function valuesToRowData(values: SheetCellInput[][]): sheets_v4.Schema$RowData[] {
  return values.map((row) => ({
    values: row.map(cellValueToCellData),
  }));
}

export function isCellEmpty(value: CellValue | undefined): boolean {
  return value === null || value === undefined || value === '';
}

export function buildColumnIndexMap(headerRow: CellValue[]): Map<string, number> {
  const columnIndexMap = new Map<string, number>();
  headerRow.forEach((header, index) => {
    if (header !== null && header !== undefined) {
      const colName = String(header);
      if (colName && !columnIndexMap.has(colName)) {
        columnIndexMap.set(colName, index);
      }
    }
  });
  return columnIndexMap;
}

type PositiveRowKind = 'data' | 'blank' | 'divider';

interface ParsedPositiveRow {
  relIndex: number;
  rowNumber: number;
  kind: PositiveRowKind;
  rawRow: CellValue[];
  values: RowRecord;
}

interface ParsedPositiveTable {
  headers: string[];
  columnIndexMap: Map<string, number>;
  topAnchorIndex: number;
  bottomAnchorIndex: number;
  betweenRows: ParsedPositiveRow[];
}

function matchesMarkerInAnchorOrStatus(
  row: CellValue[],
  marker: string,
  statusColIndex: number | undefined
): boolean {
  if (row[0] === marker) {
    return true;
  }
  if (statusColIndex !== undefined && row[statusColIndex] === marker) {
    return true;
  }
  return false;
}

function isBlankRow(row: CellValue[]): boolean {
  return row.length === 0 || row.every((cell) => isCellEmpty(cell));
}

function buildRowRecord(row: CellValue[], columnIndexMap: Map<string, number>): RowRecord {
  const record: RowRecord = {};
  for (const [colName, idx] of columnIndexMap.entries()) {
    const val = idx < row.length ? row[idx] : undefined;
    record[colName] = val !== undefined ? val : null;
  }
  return record;
}

function parsePositiveTable(
  values: CellValue[][],
  target: PositiveTableTarget,
  rangeStartRowIndex: number
): ParsedPositiveTable {
  if (values.length === 0) {
    throw new GoogleSheetsExtentAnchorNotFoundError(
      `Positive extent anchors "${target.extentMarker}" not found in empty range "${target.rangeName}" on sheet "${target.sheetName}".`
    );
  }

  const headerRow = values[0] ?? [];
  const columnIndexMap = buildColumnIndexMap(headerRow);
  const headers = Array.from(columnIndexMap.keys());
  const statusColIndex = columnIndexMap.get('Status');

  let topAnchorIndex = -1;
  let bottomAnchorIndex = -1;

  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (matchesMarkerInAnchorOrStatus(row, target.extentMarker, statusColIndex)) {
      if (topAnchorIndex === -1) {
        topAnchorIndex = i;
      }
      bottomAnchorIndex = i;
    }
  }

  if (topAnchorIndex === -1 || bottomAnchorIndex === -1 || topAnchorIndex >= bottomAnchorIndex) {
    throw new GoogleSheetsExtentAnchorNotFoundError(
      `Valid start and end extent anchors "${target.extentMarker}" not found in range "${target.rangeName}" on sheet "${target.sheetName}".`
    );
  }

  const betweenRows: ParsedPositiveRow[] = [];
  for (let i = topAnchorIndex + 1; i < bottomAnchorIndex; i++) {
    const rawRow = values[i] ?? [];
    const rowNumber = rangeStartRowIndex + i + 1;
    let kind: PositiveRowKind;
    let rowValues: RowRecord = {};

    if (matchesMarkerInAnchorOrStatus(rawRow, target.groupDividerMarker, statusColIndex)) {
      kind = 'divider';
    } else if (isBlankRow(rawRow)) {
      kind = 'blank';
    } else {
      kind = 'data';
      rowValues = buildRowRecord(rawRow, columnIndexMap);
    }

    betweenRows.push({
      relIndex: i,
      rowNumber,
      kind,
      rawRow,
      values: rowValues,
    });
  }

  return {
    headers,
    columnIndexMap,
    topAnchorIndex,
    bottomAnchorIndex,
    betweenRows,
  };
}

interface WritableColumnRun {
  startColumnIndex: number;
  endColumnIndex: number;
  cells: sheets_v4.Schema$CellData[];
}

function makeInsertRowRequest(
  sheetId: number,
  startIndex: number,
  count: number,
  inheritFromBefore: boolean
): sheets_v4.Schema$Request {
  return {
    insertDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex,
        endIndex: startIndex + count,
      },
      inheritFromBefore,
    },
  };
}

function makeDeleteRowsRequest(
  sheetId: number,
  startIndex: number,
  count: number
): sheets_v4.Schema$Request {
  return {
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex,
        endIndex: startIndex + count,
      },
    },
  };
}

function buildWritableRuns(params: {
  rowData: Record<string, SheetCellInput>;
  columnIndexMap: Map<string, number>;
  protectedColumns: ReadonlySet<string>;
  rangeStartColumnIndex: number;
  target: PositiveTableTarget;
  extraClearRelCols?: number[];
}): WritableColumnRun[] {
  const {
    rowData,
    columnIndexMap,
    protectedColumns,
    rangeStartColumnIndex,
    target,
    extraClearRelCols = [],
  } = params;

  const entryByRelCol = new Map<number, sheets_v4.Schema$CellData>();

  for (const colName of Object.keys(rowData)) {
    if (protectedColumns.has(colName)) {
      continue;
    }
    const relCol = columnIndexMap.get(colName);
    if (relCol === undefined) {
      const available = Array.from(columnIndexMap.keys());
      const availableMsg = available.length > 0 ? available.join(', ') : 'none';
      throw new GoogleSheetsColumnNotFoundError(
        `Column "${colName}" not found in range "${target.rangeName}" on sheet "${target.sheetName}". Available headers: ${availableMsg}`
      );
    }
    entryByRelCol.set(relCol, cellValueToCellData(rowData[colName]));
  }

  const protectedRelCols = new Set<number>();
  for (const colName of protectedColumns) {
    const idx = columnIndexMap.get(colName);
    if (idx !== undefined) {
      protectedRelCols.add(idx);
    }
  }

  for (const relCol of extraClearRelCols) {
    if (!entryByRelCol.has(relCol) && !protectedRelCols.has(relCol)) {
      entryByRelCol.set(relCol, {});
    }
  }

  const sortedRelCols = Array.from(entryByRelCol.keys()).sort((a, b) => a - b);
  const runs: WritableColumnRun[] = [];

  for (const relCol of sortedRelCols) {
    const cellData = entryByRelCol.get(relCol)!;
    const absCol = rangeStartColumnIndex + relCol;
    const prevRun = runs[runs.length - 1];
    if (prevRun && prevRun.endColumnIndex === absCol) {
      prevRun.endColumnIndex = absCol + 1;
      prevRun.cells.push(cellData);
    } else {
      runs.push({
        startColumnIndex: absCol,
        endColumnIndex: absCol + 1,
        cells: [cellData],
      });
    }
  }

  return runs;
}

function makeUpdateCellsForRuns(
  sheetId: number,
  absRowIndex: number,
  runs: WritableColumnRun[]
): sheets_v4.Schema$Request[] {
  return runs.map((run) => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: absRowIndex,
        endRowIndex: absRowIndex + 1,
        startColumnIndex: run.startColumnIndex,
        endColumnIndex: run.endColumnIndex,
      },
      rows: [{ values: run.cells }],
      fields: 'userEnteredValue',
    },
  }));
}

function planEmptyLogMutation(params: {
  sheetId: number;
  parsed: ParsedPositiveTable;
  rangeStartRowIndex: number;
  target: PositiveTableTarget;
}): {
  structuralRequests: sheets_v4.Schema$Request[];
  targetAbsRowIndex: number;
  extraClearRelCols: number[];
} {
  const { sheetId, parsed, rangeStartRowIndex, target } = params;
  const absTopAnchor = rangeStartRowIndex + parsed.topAnchorIndex;
  const absBottomAnchor = rangeStartRowIndex + parsed.bottomAnchorIndex;
  const structuralRequests: sheets_v4.Schema$Request[] = [];
  const extraClearRelCols: number[] = [];

  if (parsed.betweenRows.length === 0) {
    // Inherit from bottomAnchor (false) rather than topAnchor to avoid copying strict anchor styling/validation.
    structuralRequests.push(makeInsertRowRequest(sheetId, absBottomAnchor, 1, false));
    return { structuralRequests, targetAbsRowIndex: absBottomAnchor, extraClearRelCols };
  }

  const firstBlank = parsed.betweenRows.find((r) => r.kind === 'blank');
  const keepRow = firstBlank ?? parsed.betweenRows[0];

  // Delete trailing excess rows first so earlier row indices remain stable for any leading deletion.
  if (keepRow.relIndex < parsed.bottomAnchorIndex - 1) {
    const absDeleteStart = rangeStartRowIndex + keepRow.relIndex + 1;
    const deleteCount = absBottomAnchor - absDeleteStart;
    structuralRequests.push(makeDeleteRowsRequest(sheetId, absDeleteStart, deleteCount));
  }

  if (keepRow.relIndex > parsed.topAnchorIndex + 1) {
    const absDeleteStart = absTopAnchor + 1;
    const deleteCount = rangeStartRowIndex + keepRow.relIndex - absDeleteStart;
    structuralRequests.push(makeDeleteRowsRequest(sheetId, absDeleteStart, deleteCount));
  }

  if (keepRow.kind === 'divider') {
    if (keepRow.rawRow[0] === target.groupDividerMarker) {
      extraClearRelCols.push(0);
    }
    const statusColIndex = parsed.columnIndexMap.get('Status');
    if (
      statusColIndex !== undefined &&
      keepRow.rawRow[statusColIndex] === target.groupDividerMarker
    ) {
      extraClearRelCols.push(statusColIndex);
    }
  }

  return {
    structuralRequests,
    targetAbsRowIndex: absTopAnchor + 1,
    extraClearRelCols,
  };
}

export class GoogleSheetsClient implements SheetsClient {
  private readonly sheetsApi: sheets_v4.Sheets;
  private readonly retryOptions: SheetsRetryOptions;
  private readonly configProvider?: SheetsConfigProvider | undefined;
  private readonly lock = new KeyedAsyncLock();

  constructor(optionsOrSheets: GoogleSheetsClientOptions | sheets_v4.Sheets = {}) {
    if ('spreadsheets' in optionsOrSheets) {
      this.sheetsApi = optionsOrSheets;
      this.retryOptions = {};
      this.configProvider = undefined;
    } else {
      const options = optionsOrSheets;
      this.retryOptions = options.retryOptions ?? {};
      this.configProvider = options.configProvider;

      if (options.sheets) {
        this.sheetsApi = options.sheets;
      } else if (typeof options.auth === 'string') {
        const oauth2Client = new OAuth2Client();
        oauth2Client.setCredentials({ access_token: options.auth });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.sheetsApi = google.sheets({ version: 'v4', auth: oauth2Client as any });
      } else if (options.auth) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.sheetsApi = google.sheets({ version: 'v4', auth: options.auth as any });
      } else {
        this.sheetsApi = google.sheets({ version: 'v4' });
      }
    }
  }

  private wrapApiError(error: unknown): never {
    if (error instanceof GoogleSheetsApiError) {
      throw error;
    }
    const statusCode = extractHttpStatusCode(error);
    const message = formatErrorMessage(error);
    if (
      statusCode === 400 &&
      (message.includes('Unable to parse range') || message.includes('not found'))
    ) {
      throw new GoogleSheetsNamedRangeNotFoundError(
        `Google Sheets API error: ${message}`,
        { cause: error, statusCode }
      );
    }
    throw new GoogleSheetsApiError(
      `Google Sheets API error: ${message}`,
      { cause: error, statusCode }
    );
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let dynamicConfig;
    if (this.configProvider) {
      try {
        dynamicConfig = await this.configProvider.getSheetsConfig();
      } catch {
        dynamicConfig = undefined;
      }
    }
    const maxRetries = dynamicConfig?.maxRetries ?? this.retryOptions.maxRetries ?? 3;
    const initialDelayMs = dynamicConfig?.initialDelayMs ?? this.retryOptions.initialDelayMs ?? 1000;
    const backoffFactor = dynamicConfig?.backoffFactor ?? this.retryOptions.backoffFactor ?? 2;
    const sleep =
      this.retryOptions.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (isRateLimitError(error) && attempt < maxRetries) {
          const delay = initialDelayMs * Math.pow(backoffFactor, attempt);
          attempt++;
          await sleep(delay);
          continue;
        }
        this.wrapApiError(error);
      }
    }
  }

  private async getSpreadsheetMetadata(spreadsheetId: string): Promise<sheets_v4.Schema$Spreadsheet> {
    return await this.executeWithRetry(async () => {
      const response = await this.sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,title)),namedRanges',
      });
      return response.data;
    });
  }

  private findNamedRange(
    spreadsheet: sheets_v4.Schema$Spreadsheet,
    target: NamedRangeTarget
  ): {
    sheetId: number;
    sheetTitle: string;
    namedRange: sheets_v4.Schema$NamedRange;
    gridRange: sheets_v4.Schema$GridRange;
  } {
    const targetSheet = (spreadsheet.sheets ?? []).find(
      (sheet) => sheet.properties?.title?.toLowerCase() === target.sheetName.toLowerCase()
    );

    if (!targetSheet || targetSheet.properties?.sheetId === undefined || targetSheet.properties.sheetId === null) {
      throw new GoogleSheetsApiError(
        `Sheet "${target.sheetName}" not found in spreadsheet "${target.spreadsheetId}".`
      );
    }

    const targetSheetId = targetSheet.properties.sheetId;
    const sheetTitle = targetSheet.properties.title ?? target.sheetName;
    const targetRangeLower = target.rangeName.toLowerCase();
    const scopedRangeNameLower = `${target.sheetName}!${target.rangeName}`.toLowerCase();

    const namedRanges = spreadsheet.namedRanges ?? [];
    let matchedNamedRange: sheets_v4.Schema$NamedRange | undefined;
    let fallbackWorkbookRange: sheets_v4.Schema$NamedRange | undefined;

    for (const nr of namedRanges) {
      const name = (nr.name ?? '').toLowerCase();
      if (name === targetRangeLower || name === scopedRangeNameLower) {
        const sheetId = nr.range?.sheetId;
        if (sheetId === targetSheetId) {
          matchedNamedRange = nr;
          break;
        }
        if ((sheetId === undefined || sheetId === null) && !fallbackWorkbookRange) {
          fallbackWorkbookRange = nr;
        }
      }
    }

    const resolvedRange = matchedNamedRange ?? fallbackWorkbookRange;

    if (!resolvedRange || !resolvedRange.range) {
      throw new GoogleSheetsNamedRangeNotFoundError(
        `Named range "${target.rangeName}" not found on sheet "${target.sheetName}" in spreadsheet "${target.spreadsheetId}".`
      );
    }

    return {
      sheetId: targetSheetId,
      sheetTitle,
      namedRange: resolvedRange,
      gridRange: {
        ...resolvedRange.range,
        sheetId: targetSheetId,
      },
    };
  }

  private async resolveNamedRange(target: NamedRangeTarget): Promise<{
    sheetId: number;
    sheetTitle: string;
    namedRange: sheets_v4.Schema$NamedRange;
    gridRange: sheets_v4.Schema$GridRange;
  }> {
    const spreadsheet = await this.getSpreadsheetMetadata(target.spreadsheetId);
    return this.findNamedRange(spreadsheet, target);
  }

  private async readValues(
    spreadsheetId: string,
    a1Range: string,
    valueRenderOption: 'UNFORMATTED_VALUE' | 'FORMATTED_VALUE'
  ): Promise<CellValue[][]> {
    const response = await this.executeWithRetry(() =>
      this.sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: a1Range,
        valueRenderOption,
      })
    );

    return (response.data.values as CellValue[][]) ?? [];
  }

  async readNamedRange(request: ReadNamedRangeRequest): Promise<CellValue[][]> {
    const { sheetTitle, gridRange } = await this.resolveNamedRange(request);
    const a1Range = gridRangeToA1(sheetTitle, gridRange);
    return this.readValues(request.spreadsheetId, a1Range, 'UNFORMATTED_VALUE');
  }

  async writeNamedRange(request: WriteNamedRangeRequest): Promise<void> {
    return await this.lock.acquire(request.spreadsheetId, async () => {
      const { sheetId, sheetTitle, gridRange } = await this.resolveNamedRange(request);

      if (request.insertRows) {
        const rowCount = request.values.length;
        if (rowCount === 0) {
          return;
        }

        const startRowIndex = gridRange.startRowIndex ?? 0;
        const startColumnIndex = gridRange.startColumnIndex ?? 0;
        const maxColumns = Math.max(...request.values.map((r) => r.length), 1);
        const endColumnIndex = gridRange.endColumnIndex ?? startColumnIndex + maxColumns;

        await this.executeWithRetry(() =>
          this.sheetsApi.spreadsheets.batchUpdate({
            spreadsheetId: request.spreadsheetId,
            requestBody: {
              requests: [
                {
                  insertDimension: {
                    range: {
                      sheetId,
                      dimension: 'ROWS',
                      startIndex: startRowIndex,
                      endIndex: startRowIndex + rowCount,
                    },
                    inheritFromBefore: startRowIndex > 0,
                  },
                },
                {
                  updateCells: {
                    range: {
                      sheetId,
                      startRowIndex,
                      endRowIndex: startRowIndex + rowCount,
                      startColumnIndex,
                      endColumnIndex,
                    },
                    rows: valuesToRowData(request.values),
                    fields: 'userEnteredValue',
                  },
                },
              ],
            },
          })
        );
      } else {
        const a1Range = gridRangeToA1(sheetTitle, gridRange);
        await this.executeWithRetry(() =>
          this.sheetsApi.spreadsheets.values.update({
            spreadsheetId: request.spreadsheetId,
            range: a1Range,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
              values: request.values,
            },
          })
        );
      }
    });
  }

  private async loadParsedPositiveTable(target: PositiveTableTarget): Promise<{
    sheetId: number;
    rangeStartRowIndex: number;
    rangeStartColumnIndex: number;
    parsed: ParsedPositiveTable;
  }> {
    const { sheetId, sheetTitle, gridRange } = await this.resolveNamedRange(target);
    const a1Range = gridRangeToA1(sheetTitle, gridRange);
    const values = await this.readValues(target.spreadsheetId, a1Range, 'FORMATTED_VALUE');
    const rangeStartRowIndex = gridRange.startRowIndex ?? 0;
    const rangeStartColumnIndex = gridRange.startColumnIndex ?? 0;
    const parsed = parsePositiveTable(values, target, rangeStartRowIndex);

    return {
      sheetId,
      rangeStartRowIndex,
      rangeStartColumnIndex,
      parsed,
    };
  }

  /**
   * Reads a positive-terminated table bounded by `extentMarker` anchors using `FORMATTED_VALUE`.
   */
  async readTable(request: ReadPositiveTableRequest): Promise<PositiveTableReadResult> {
    const { parsed } = await this.loadParsedPositiveTable(request.target);

    const rows: PositiveTableRow[] = parsed.betweenRows
      .filter((row) => row.kind === 'data')
      .map((row) => ({
        rowNumber: row.rowNumber,
        values: row.values,
      }));

    return {
      headers: parsed.headers,
      formulaColumns: [],
      rows,
    };
  }

  /**
   * Inserts a row atomically inside a positive-terminated table under per-spreadsheet lock.
   */
  async insertIntoGroupedList(
    request: InsertPositiveGroupedRowRequest
  ): Promise<InsertGroupedRowResult> {
    return await this.lock.acquire(request.target.spreadsheetId, async () => {
      const { sheetId, rangeStartRowIndex, rangeStartColumnIndex, parsed } =
        await this.loadParsedPositiveTable(request.target);

      const protectedColumns = new Set(request.readOnlyColumns ?? []);
      const dataRows = parsed.betweenRows.filter((row) => row.kind === 'data');

      let structuralRequests: sheets_v4.Schema$Request[];
      let targetAbsRowIndex: number;
      let extraClearRelCols: number[] = [];

      if (dataRows.length === 0) {
        const emptyPlan = planEmptyLogMutation({
          sheetId,
          parsed,
          rangeStartRowIndex,
          target: request.target,
        });
        structuralRequests = emptyPlan.structuralRequests;
        targetAbsRowIndex = emptyPlan.targetAbsRowIndex;
        extraClearRelCols = emptyPlan.extraClearRelCols;
      } else {
        const absBottomAnchor = rangeStartRowIndex + parsed.bottomAnchorIndex;
        structuralRequests = [makeInsertRowRequest(sheetId, absBottomAnchor, 1, true)];
        targetAbsRowIndex = absBottomAnchor;
      }

      const writableRuns = buildWritableRuns({
        rowData: request.rowData,
        columnIndexMap: parsed.columnIndexMap,
        protectedColumns,
        rangeStartColumnIndex,
        target: request.target,
        extraClearRelCols,
      });

      const requests = [
        ...structuralRequests,
        ...makeUpdateCellsForRuns(sheetId, targetAbsRowIndex, writableRuns),
      ];

      if (requests.length > 0) {
        await this.executeWithRetry(() =>
          this.sheetsApi.spreadsheets.batchUpdate({
            spreadsheetId: request.target.spreadsheetId,
            requestBody: { requests },
          })
        );
      }

      return {
        rowNumber: targetAbsRowIndex + 1,
        action: 'inserted',
      };
    });
  }
}

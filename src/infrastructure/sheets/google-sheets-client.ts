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
  ReadNamedRangeBatchEntry,
  ReadNamedRangeRequest,
  ReadNamedRangesBatchRequest,
  ReadPositiveTableRequest,
  RowKey,
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
  GoogleSheetsDuplicateKeyError,
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

function collectFormulaColumns(
  formulaRows: readonly CellValue[][],
  parsed: ParsedPositiveTable
): string[] {
  const formulaColSet = new Set<string>();
  for (const row of formulaRows) {
    for (const [colName, colIdx] of parsed.columnIndexMap.entries()) {
      const cell = colIdx < row.length ? row[colIdx] : undefined;
      if (typeof cell === 'string' && cell.trim().startsWith('=')) {
        formulaColSet.add(colName);
      }
    }
  }
  return parsed.headers.filter((header) => formulaColSet.has(header));
}

function validateHttpUrl(candidate: string): string | null {
  if (/[\r\n]/.test(candidate)) {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function extractHyperlinkFirstArg(formula: string): string | null {
  const openMatch = /^=\s*HYPERLINK\s*\(/i.exec(formula);
  if (!openMatch) {
    return null;
  }

  let idx = openMatch[0].length;
  while (idx < formula.length && /\s/.test(formula[idx]!)) {
    idx++;
  }
  if (idx >= formula.length || formula[idx] !== '"') {
    return null;
  }

  idx++;
  let uri = '';
  let closed = false;
  while (idx < formula.length) {
    const ch = formula[idx]!;
    if (ch === '"') {
      if (formula[idx + 1] === '"') {
        uri += '"';
        idx += 2;
        continue;
      }
      idx++;
      closed = true;
      break;
    }
    uri += ch;
    idx++;
  }
  if (!closed) {
    return null;
  }

  while (idx < formula.length && /\s/.test(formula[idx]!)) {
    idx++;
  }
  if (idx >= formula.length) {
    return null;
  }

  const separator = formula[idx]!;
  if (separator === ')') {
    return idx === formula.length - 1 ? uri : null;
  }
  if (separator !== ',' && separator !== ';') {
    return null;
  }

  idx++;
  let parenDepth = 1;
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let hasSecondArgToken = false;

  while (idx < formula.length) {
    const ch = formula[idx]!;
    if (inDoubleQuote) {
      if (ch === '"') {
        if (formula[idx + 1] === '"') {
          idx += 2;
          continue;
        }
        inDoubleQuote = false;
      }
      hasSecondArgToken = true;
    } else if (inSingleQuote) {
      if (ch === "'") {
        if (formula[idx + 1] === "'") {
          idx += 2;
          continue;
        }
        inSingleQuote = false;
      }
      hasSecondArgToken = true;
    } else if (ch === '"') {
      inDoubleQuote = true;
      hasSecondArgToken = true;
    } else if (ch === "'") {
      inSingleQuote = true;
      hasSecondArgToken = true;
    } else if (ch === '(') {
      parenDepth++;
      hasSecondArgToken = true;
    } else if (ch === ')') {
      parenDepth--;
      if (parenDepth === 0) {
        return hasSecondArgToken && idx === formula.length - 1 ? uri : null;
      }
      hasSecondArgToken = true;
    } else if (parenDepth === 1 && (ch === ',' || ch === ';')) {
      return null;
    } else if (!/\s/.test(ch)) {
      hasSecondArgToken = true;
    }
    idx++;
  }

  return null;
}

function extractLinkTarget(cellValue: CellValue | undefined): string | null {
  if (typeof cellValue !== 'string') {
    return null;
  }
  const trimmed = cellValue.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('=')) {
    const formulaUri = extractHyperlinkFirstArg(trimmed);
    return formulaUri !== null ? validateHttpUrl(formulaUri) : null;
  }
  return validateHttpUrl(cellValue);
}

function resolveRequestedLinkColumns(
  linkColumns: readonly string[] | undefined,
  columnIndexMap: ReadonlyMap<string, number>
): Array<{ colName: string; colRelIdx: number }> {
  if (!linkColumns || linkColumns.length === 0) {
    return [];
  }
  const resolved: Array<{ colName: string; colRelIdx: number }> = [];
  const seen = new Set<string>();
  for (const colName of linkColumns) {
    if (seen.has(colName)) {
      continue;
    }
    seen.add(colName);
    const colRelIdx = columnIndexMap.get(colName);
    if (colRelIdx !== undefined) {
      resolved.push({ colName, colRelIdx });
    }
  }
  return resolved;
}

function extractLinksByRowNumber(
  parsed: ParsedPositiveTable,
  dataRows: readonly ParsedPositiveRow[],
  linkRangeSlices: ReadonlyArray<{ colName: string; rangeIndex: number }>,
  valueRanges: readonly sheets_v4.Schema$ValueRange[]
): Map<number, Record<string, string | null>> {
  const linksByRow = new Map<number, Record<string, string | null>>();
  for (const row of dataRows) {
    const rowLinks: Record<string, string | null> = {};
    const sliceRowOffset = row.relIndex - (parsed.topAnchorIndex + 1);
    for (const { colName, rangeIndex } of linkRangeSlices) {
      const colValues = (valueRanges[rangeIndex]?.values as CellValue[][] | undefined) ?? [];
      const rawCell =
        sliceRowOffset >= 0 && sliceRowOffset < colValues.length
          ? colValues[sliceRowOffset]?.[0]
          : undefined;
      rowLinks[colName] = extractLinkTarget(rawCell);
    }
    linksByRow.set(row.rowNumber, rowLinks);
  }
  return linksByRow;
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

function compareSortKeys(a: string, b: string, order: 'asc' | 'desc'): number {
  if (a === b) return 0;
  const cmp = a < b ? -1 : 1;
  return order === 'desc' ? -cmp : cmp;
}

function makeDividerUpdateRequest(
  sheetId: number,
  absRowIndex: number,
  rangeStartColumnIndex: number,
  groupDividerMarker: string
): sheets_v4.Schema$Request {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: absRowIndex,
        endRowIndex: absRowIndex + 1,
        startColumnIndex: rangeStartColumnIndex,
        endColumnIndex: rangeStartColumnIndex + 1,
      },
      rows: [{ values: [cellValueToCellData(groupDividerMarker)] }],
      fields: 'userEnteredValue',
    },
  };
}

interface KeyedDataRow {
  relIndex: number;
  absRowIndex: number;
  rowNumber: number;
  keys: RowKey;
}

interface PartitionedGroup {
  groupKey: string;
  rows: KeyedDataRow[];
  firstDataRelIndex: number;
  lastDataRelIndex: number;
  firstDataAbsIndex: number;
  lastDataAbsIndex: number;
}

function partitionKeyedGroups(
  betweenRows: readonly ParsedPositiveRow[],
  rangeStartRowIndex: number,
  rowKeyExtractor: (row: RowRecord) => RowKey | null
): {
  groups: PartitionedGroup[];
  groupMap: Map<string, PartitionedGroup>;
} {
  const groups: PartitionedGroup[] = [];
  const groupMap = new Map<string, PartitionedGroup>();

  for (const row of betweenRows) {
    if (row.kind !== 'data') {
      continue;
    }
    const keys = rowKeyExtractor(row.values);
    if (keys === null) {
      continue;
    }
    const absRowIndex = rangeStartRowIndex + row.relIndex;
    const entry: KeyedDataRow = {
      relIndex: row.relIndex,
      absRowIndex,
      rowNumber: row.rowNumber,
      keys,
    };

    let group = groupMap.get(keys.groupKey);
    if (!group) {
      group = {
        groupKey: keys.groupKey,
        rows: [entry],
        firstDataRelIndex: row.relIndex,
        lastDataRelIndex: row.relIndex,
        firstDataAbsIndex: absRowIndex,
        lastDataAbsIndex: absRowIndex,
      };
      groupMap.set(keys.groupKey, group);
      groups.push(group);
    } else {
      group.rows.push(entry);
      group.lastDataRelIndex = row.relIndex;
      group.lastDataAbsIndex = absRowIndex;
    }
  }

  return { groups, groupMap };
}

function isCleanColumnZeroDivider(row: ParsedPositiveRow, groupDividerMarker: string): boolean {
  return (
    row.kind === 'divider' &&
    row.rawRow[0] === groupDividerMarker &&
    row.rawRow.slice(1).every((cell) => isCellEmpty(cell))
  );
}

function collectBlankAndDividerAbsIndices(
  betweenRows: readonly ParsedPositiveRow[],
  rangeStartRowIndex: number,
  startRelExclusive: number,
  endRelExclusive: number
): number[] {
  if (startRelExclusive >= endRelExclusive) {
    return [];
  }
  const indices: number[] = [];
  for (const row of betweenRows) {
    if (row.relIndex <= startRelExclusive || row.relIndex >= endRelExclusive) {
      continue;
    }
    if (row.kind === 'blank' || row.kind === 'divider') {
      indices.push(rangeStartRowIndex + row.relIndex);
    }
  }
  return indices;
}

/**
 * Heals a group-to-group boundary gap strictly between `startRelExclusive` and `endRelExclusive`,
 * keeping at most one clean Column-0-only divider while preserving any null-keyed data rows.
 */
function planInterGroupGapHealing(params: {
  betweenRows: readonly ParsedPositiveRow[];
  rangeStartRowIndex: number;
  startRelExclusive: number;
  endRelExclusive: number;
  groupDividerMarker: string;
}): {
  deleteAbsIndices: number[];
  keptCleanDividerAbsIndex?: number | undefined;
} {
  const {
    betweenRows,
    rangeStartRowIndex,
    startRelExclusive,
    endRelExclusive,
    groupDividerMarker,
  } = params;

  if (startRelExclusive >= endRelExclusive) {
    return { deleteAbsIndices: [] };
  }

  const gapRows = betweenRows.filter(
    (r) => r.relIndex > startRelExclusive && r.relIndex < endRelExclusive
  );
  const keptDivider = gapRows.find((r) => isCleanColumnZeroDivider(r, groupDividerMarker));
  const deleteAbsIndices: number[] = [];

  for (const row of gapRows) {
    if (row.kind === 'blank') {
      deleteAbsIndices.push(rangeStartRowIndex + row.relIndex);
    } else if (row.kind === 'divider' && row !== keptDivider) {
      deleteAbsIndices.push(rangeStartRowIndex + row.relIndex);
    }
  }

  return {
    deleteAbsIndices,
    ...(keptDivider ? { keptCleanDividerAbsIndex: rangeStartRowIndex + keptDivider.relIndex } : {}),
  };
}

type PlannedInsertedRowKind = 'data' | 'divider';

interface PlannedInsertion {
  postDeleteAbsIndex: number;
  orderRank: number;
  inheritFromBefore: boolean;
  rows: PlannedInsertedRowKind[];
}

function buildPostDeleteMapper(deleteAbsIndices: readonly number[]): {
  sortedUniqueDeletesDesc: number[];
  postDeleteIndex: (origAbsIndex: number) => number;
} {
  const sortedUniqueDeletesDesc = Array.from(new Set(deleteAbsIndices)).sort((a, b) => b - a);
  const postDeleteIndex = (origAbsIndex: number): number => {
    let deletedBefore = 0;
    for (const delIdx of sortedUniqueDeletesDesc) {
      if (delIdx < origAbsIndex) {
        deletedBefore++;
      }
    }
    return origAbsIndex - deletedBefore;
  };
  return { sortedUniqueDeletesDesc, postDeleteIndex };
}

function makeCoalescedDeleteRequests(
  sheetId: number,
  sortedUniqueDeletesDesc: readonly number[]
): sheets_v4.Schema$Request[] {
  const requests: sheets_v4.Schema$Request[] = [];
  let i = 0;
  while (i < sortedUniqueDeletesDesc.length) {
    const endInclusive = sortedUniqueDeletesDesc[i];
    let startInclusive = endInclusive;
    while (
      i + 1 < sortedUniqueDeletesDesc.length &&
      sortedUniqueDeletesDesc[i + 1] === startInclusive - 1
    ) {
      i++;
      startInclusive = sortedUniqueDeletesDesc[i];
    }
    requests.push(makeDeleteRowsRequest(sheetId, startInclusive, endInclusive - startInclusive + 1));
    i++;
  }
  return requests;
}

function coalesceInsertions(insertions: readonly PlannedInsertion[]): PlannedInsertion[] {
  const sorted = [...insertions].sort(
    (a, b) => a.postDeleteAbsIndex - b.postDeleteAbsIndex || a.orderRank - b.orderRank
  );
  const coalesced: PlannedInsertion[] = [];
  for (const ins of sorted) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.postDeleteAbsIndex === ins.postDeleteAbsIndex) {
      prev.rows.push(...ins.rows);
      prev.inheritFromBefore = prev.inheritFromBefore && ins.inheritFromBefore;
    } else {
      coalesced.push({
        postDeleteAbsIndex: ins.postDeleteAbsIndex,
        orderRank: ins.orderRank,
        inheritFromBefore: ins.inheritFromBefore,
        rows: [...ins.rows],
      });
    }
  }
  return coalesced;
}

interface AtomicMutationDraft {
  sortedUniqueDeletesDesc: readonly number[];
  postDeleteIndex: (origAbsIndex: number) => number;
  insertions: readonly PlannedInsertion[];
  upsertOrigAbsIndex?: number | undefined;
}

/**
 * Compiles deletions (executed descending so upper indices stay stable), coalesced insertions
 * (executed ascending with running offset), and optional upsert updates into one atomic batchUpdate.
 */
function compileAtomicMutationPlan(params: {
  sheetId: number;
  rangeStartColumnIndex: number;
  groupDividerMarker: string;
  writableRuns: WritableColumnRun[];
  sortedUniqueDeletesDesc: readonly number[];
  postDeleteIndex: (origAbsIndex: number) => number;
  insertions: readonly PlannedInsertion[];
  upsertOrigAbsIndex?: number | undefined;
}): {
  requests: sheets_v4.Schema$Request[];
  rowNumber: number;
  action: 'inserted' | 'updated';
} {
  const {
    sheetId,
    rangeStartColumnIndex,
    groupDividerMarker,
    writableRuns,
    sortedUniqueDeletesDesc,
    postDeleteIndex,
    insertions,
    upsertOrigAbsIndex,
  } = params;

  const requests: sheets_v4.Schema$Request[] = makeCoalescedDeleteRequests(
    sheetId,
    sortedUniqueDeletesDesc
  );
  const coalescedInsertions = coalesceInsertions(insertions);

  let insertedOffset = 0;
  let insertedDataAbsRow: number | undefined;

  for (const ins of coalescedInsertions) {
    const insertAt = ins.postDeleteAbsIndex + insertedOffset;
    requests.push(makeInsertRowRequest(sheetId, insertAt, ins.rows.length, ins.inheritFromBefore));
    for (let offset = 0; offset < ins.rows.length; offset++) {
      const targetRow = insertAt + offset;
      if (ins.rows[offset] === 'divider') {
        requests.push(
          makeDividerUpdateRequest(sheetId, targetRow, rangeStartColumnIndex, groupDividerMarker)
        );
      } else {
        requests.push(...makeUpdateCellsForRuns(sheetId, targetRow, writableRuns));
        insertedDataAbsRow = targetRow;
      }
    }
    insertedOffset += ins.rows.length;
  }

  if (upsertOrigAbsIndex !== undefined) {
    const postDelUpsert = postDeleteIndex(upsertOrigAbsIndex);
    let priorInsertions = 0;
    for (const ins of coalescedInsertions) {
      if (ins.postDeleteAbsIndex <= postDelUpsert) {
        priorInsertions += ins.rows.length;
      }
    }
    const finalUpsertAbsRow = postDelUpsert + priorInsertions;
    requests.push(...makeUpdateCellsForRuns(sheetId, finalUpsertAbsRow, writableRuns));
    return {
      requests,
      rowNumber: finalUpsertAbsRow + 1,
      action: 'updated',
    };
  }

  if (insertedDataAbsRow === undefined) {
    throw new GoogleSheetsApiError('Internal planner error: missing inserted data row index.');
  }

  return {
    requests,
    rowNumber: insertedDataAbsRow + 1,
    action: 'inserted',
  };
}

/**
 * Plans an insert or upsert inside an existing group while cleaning trapped blanks/dividers
 * and healing only that group's immediate upper and lower boundaries.
 */
function planExistingGroupMutation(params: {
  parsed: ParsedPositiveTable;
  rangeStartRowIndex: number;
  groupDividerMarker: string;
  targetKeys: RowKey;
  groups: readonly PartitionedGroup[];
  existingGroup: PartitionedGroup;
  rowSortOrder: 'asc' | 'desc';
  duplicatePolicy: 'insert' | 'upsert' | 'reject';
}): AtomicMutationDraft {
  const {
    parsed,
    rangeStartRowIndex,
    groupDividerMarker,
    targetKeys,
    groups,
    existingGroup,
    rowSortOrder,
    duplicatePolicy,
  } = params;

  const absTopAnchor = rangeStartRowIndex + parsed.topAnchorIndex;
  const targetGroupIdx = groups.indexOf(existingGroup);
  const prevGroup = targetGroupIdx > 0 ? groups[targetGroupIdx - 1] : undefined;
  const nextGroup = targetGroupIdx < groups.length - 1 ? groups[targetGroupIdx + 1] : undefined;

  const deleteAbsIndices: number[] = [];

  // 1. Heal upper boundary strictly adjacent to existingGroup
  let needsUpperDivider = false;
  if (prevGroup) {
    const upperGap = planInterGroupGapHealing({
      betweenRows: parsed.betweenRows,
      rangeStartRowIndex,
      startRelExclusive: prevGroup.lastDataRelIndex,
      endRelExclusive: existingGroup.firstDataRelIndex,
      groupDividerMarker,
    });
    deleteAbsIndices.push(...upperGap.deleteAbsIndices);
    needsUpperDivider = upperGap.keptCleanDividerAbsIndex === undefined;
  } else {
    deleteAbsIndices.push(
      ...collectBlankAndDividerAbsIndices(
        parsed.betweenRows,
        rangeStartRowIndex,
        parsed.topAnchorIndex,
        existingGroup.firstDataRelIndex
      )
    );
  }

  // 2. Delete accidental blanks/dividers trapped inside existingGroup while preserving null-keyed rows
  deleteAbsIndices.push(
    ...collectBlankAndDividerAbsIndices(
      parsed.betweenRows,
      rangeStartRowIndex,
      existingGroup.firstDataRelIndex,
      existingGroup.lastDataRelIndex
    )
  );

  // 3. Heal lower boundary strictly adjacent to existingGroup
  let needsLowerDivider = false;
  if (nextGroup) {
    const lowerGap = planInterGroupGapHealing({
      betweenRows: parsed.betweenRows,
      rangeStartRowIndex,
      startRelExclusive: existingGroup.lastDataRelIndex,
      endRelExclusive: nextGroup.firstDataRelIndex,
      groupDividerMarker,
    });
    deleteAbsIndices.push(...lowerGap.deleteAbsIndices);
    needsLowerDivider = lowerGap.keptCleanDividerAbsIndex === undefined;
  } else {
    deleteAbsIndices.push(
      ...collectBlankAndDividerAbsIndices(
        parsed.betweenRows,
        rangeStartRowIndex,
        existingGroup.lastDataRelIndex,
        parsed.bottomAnchorIndex
      )
    );
  }

  const { sortedUniqueDeletesDesc, postDeleteIndex } = buildPostDeleteMapper(deleteAbsIndices);
  const insertions: PlannedInsertion[] = [];

  if (needsUpperDivider) {
    insertions.push({
      postDeleteAbsIndex: postDeleteIndex(existingGroup.firstDataAbsIndex),
      orderRank: 0,
      inheritFromBefore: true,
      rows: ['divider'],
    });
  }

  const matchingRow = existingGroup.rows.find((r) => r.keys.sortKey === targetKeys.sortKey);
  const isUpsert = duplicatePolicy === 'upsert' && matchingRow !== undefined;

  if (!isUpsert) {
    const nextRow = existingGroup.rows.find(
      (r) => compareSortKeys(r.keys.sortKey, targetKeys.sortKey, rowSortOrder) > 0
    );
    const postDeleteInsertIndex = nextRow
      ? postDeleteIndex(nextRow.absRowIndex)
      : postDeleteIndex(existingGroup.lastDataAbsIndex) + 1;

    insertions.push({
      postDeleteAbsIndex: postDeleteInsertIndex,
      orderRank: 1,
      inheritFromBefore: postDeleteInsertIndex !== absTopAnchor + 1,
      rows: ['data'],
    });
  }

  if (needsLowerDivider && nextGroup) {
    insertions.push({
      postDeleteAbsIndex: postDeleteIndex(nextGroup.firstDataAbsIndex),
      orderRank: 2,
      inheritFromBefore: true,
      rows: ['divider'],
    });
  }

  return {
    sortedUniqueDeletesDesc,
    postDeleteIndex,
    insertions,
    ...(isUpsert ? { upsertOrigAbsIndex: matchingRow.absRowIndex } : {}),
  };
}

/**
 * Plans insertion of a new group at the top, middle, or bottom while healing only
 * the affected insertion boundary and preserving any null-keyed rows.
 */
function planNewGroupMutation(params: {
  parsed: ParsedPositiveTable;
  rangeStartRowIndex: number;
  groupDividerMarker: string;
  targetKeys: RowKey;
  groups: readonly PartitionedGroup[];
  groupSortOrder: 'asc' | 'desc';
}): AtomicMutationDraft {
  const {
    parsed,
    rangeStartRowIndex,
    groupDividerMarker,
    targetKeys,
    groups,
    groupSortOrder,
  } = params;

  const absTopAnchor = rangeStartRowIndex + parsed.topAnchorIndex;
  const absBottomAnchor = rangeStartRowIndex + parsed.bottomAnchorIndex;
  const deleteAbsIndices: number[] = [];
  const insertions: PlannedInsertion[] = [];

  if (groups.length === 0) {
    let lastDataRelIndex = parsed.topAnchorIndex;
    for (const row of parsed.betweenRows) {
      if (row.kind === 'data') {
        lastDataRelIndex = row.relIndex;
      }
    }
    deleteAbsIndices.push(
      ...collectBlankAndDividerAbsIndices(
        parsed.betweenRows,
        rangeStartRowIndex,
        lastDataRelIndex,
        parsed.bottomAnchorIndex
      )
    );
    const { sortedUniqueDeletesDesc, postDeleteIndex } = buildPostDeleteMapper(deleteAbsIndices);
    const postDeleteInsertIndex = postDeleteIndex(absBottomAnchor);
    insertions.push({
      postDeleteAbsIndex: postDeleteInsertIndex,
      orderRank: 0,
      inheritFromBefore: postDeleteInsertIndex !== absTopAnchor + 1,
      rows: ['data'],
    });
    return { sortedUniqueDeletesDesc, postDeleteIndex, insertions };
  }

  const nextGroupIdx = groups.findIndex(
    (g) => compareSortKeys(g.groupKey, targetKeys.groupKey, groupSortOrder) > 0
  );

  if (nextGroupIdx === 0) {
    const nextGroup = groups[0];
    deleteAbsIndices.push(
      ...collectBlankAndDividerAbsIndices(
        parsed.betweenRows,
        rangeStartRowIndex,
        parsed.topAnchorIndex,
        nextGroup.firstDataRelIndex
      )
    );
    const { sortedUniqueDeletesDesc, postDeleteIndex } = buildPostDeleteMapper(deleteAbsIndices);
    insertions.push({
      postDeleteAbsIndex: absTopAnchor + 1,
      orderRank: 0,
      inheritFromBefore: false,
      rows: ['data', 'divider'],
    });
    return { sortedUniqueDeletesDesc, postDeleteIndex, insertions };
  }

  if (nextGroupIdx > 0) {
    const prevGroup = groups[nextGroupIdx - 1];
    const nextGroup = groups[nextGroupIdx];
    const middleGap = planInterGroupGapHealing({
      betweenRows: parsed.betweenRows,
      rangeStartRowIndex,
      startRelExclusive: prevGroup.lastDataRelIndex,
      endRelExclusive: nextGroup.firstDataRelIndex,
      groupDividerMarker,
    });
    deleteAbsIndices.push(...middleGap.deleteAbsIndices);
    const { sortedUniqueDeletesDesc, postDeleteIndex } = buildPostDeleteMapper(deleteAbsIndices);

    if (middleGap.keptCleanDividerAbsIndex !== undefined) {
      insertions.push({
        postDeleteAbsIndex: postDeleteIndex(middleGap.keptCleanDividerAbsIndex),
        orderRank: 0,
        inheritFromBefore: true,
        rows: ['divider', 'data'],
      });
    } else {
      insertions.push({
        postDeleteAbsIndex: postDeleteIndex(prevGroup.lastDataAbsIndex) + 1,
        orderRank: 0,
        inheritFromBefore: true,
        rows: ['divider', 'data', 'divider'],
      });
    }

    return { sortedUniqueDeletesDesc, postDeleteIndex, insertions };
  }

  const prevGroup = groups[groups.length - 1];
  deleteAbsIndices.push(
    ...collectBlankAndDividerAbsIndices(
      parsed.betweenRows,
      rangeStartRowIndex,
      prevGroup.lastDataRelIndex,
      parsed.bottomAnchorIndex
    )
  );
  const { sortedUniqueDeletesDesc, postDeleteIndex } = buildPostDeleteMapper(deleteAbsIndices);
  insertions.push({
    postDeleteAbsIndex: postDeleteIndex(absBottomAnchor),
    orderRank: 0,
    inheritFromBefore: true,
    rows: ['divider', 'data'],
  });

  return { sortedUniqueDeletesDesc, postDeleteIndex, insertions };
}

function planGroupedRowMutation(params: {
  sheetId: number;
  parsed: ParsedPositiveTable;
  rangeStartRowIndex: number;
  rangeStartColumnIndex: number;
  target: PositiveTableTarget;
  rowData: Record<string, SheetCellInput>;
  protectedColumns: ReadonlySet<string>;
  targetKeys: RowKey;
  rowKeyExtractor: (row: RowRecord) => RowKey | null;
  groupSortOrder: 'asc' | 'desc';
  rowSortOrder: 'asc' | 'desc';
  duplicatePolicy: 'insert' | 'upsert' | 'reject';
}): {
  requests: sheets_v4.Schema$Request[];
  rowNumber: number;
  action: 'inserted' | 'updated';
} {
  const {
    sheetId,
    parsed,
    rangeStartRowIndex,
    rangeStartColumnIndex,
    target,
    rowData,
    protectedColumns,
    targetKeys,
    rowKeyExtractor,
    groupSortOrder,
    rowSortOrder,
    duplicatePolicy,
  } = params;

  const { groups, groupMap } = partitionKeyedGroups(
    parsed.betweenRows,
    rangeStartRowIndex,
    rowKeyExtractor
  );

  const existingGroup = groupMap.get(targetKeys.groupKey);
  if (existingGroup) {
    const matchingRow = existingGroup.rows.find((r) => r.keys.sortKey === targetKeys.sortKey);
    if (duplicatePolicy === 'reject' && matchingRow) {
      throw new GoogleSheetsDuplicateKeyError(
        `Duplicate key "${targetKeys.sortKey}" in group "${targetKeys.groupKey}" on sheet "${target.sheetName}" (${target.rangeName}).`
      );
    }
  }

  const writableRuns = buildWritableRuns({
    rowData,
    columnIndexMap: parsed.columnIndexMap,
    protectedColumns,
    rangeStartColumnIndex,
    target,
  });

  const draft = existingGroup
    ? planExistingGroupMutation({
        parsed,
        rangeStartRowIndex,
        groupDividerMarker: target.groupDividerMarker,
        targetKeys,
        groups,
        existingGroup,
        rowSortOrder,
        duplicatePolicy,
      })
    : planNewGroupMutation({
        parsed,
        rangeStartRowIndex,
        groupDividerMarker: target.groupDividerMarker,
        targetKeys,
        groups,
        groupSortOrder,
      });

  return compileAtomicMutationPlan({
    sheetId,
    rangeStartColumnIndex,
    groupDividerMarker: target.groupDividerMarker,
    writableRuns,
    ...draft,
  });
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
    valueRenderOption: 'UNFORMATTED_VALUE' | 'FORMATTED_VALUE' | 'FORMULA'
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

  private async readBatchValues(
    spreadsheetId: string,
    ranges: string[],
    valueRenderOption: 'UNFORMATTED_VALUE' | 'FORMATTED_VALUE' | 'FORMULA'
  ): Promise<sheets_v4.Schema$ValueRange[]> {
    if (ranges.length === 0) {
      return [];
    }
    const response = await this.executeWithRetry(() =>
      this.sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
        valueRenderOption,
      })
    );

    return response.data.valueRanges ?? [];
  }

  async readNamedRange(request: ReadNamedRangeRequest): Promise<CellValue[][]> {
    const { sheetTitle, gridRange } = await this.resolveNamedRange(request);
    const a1Range = gridRangeToA1(sheetTitle, gridRange);
    return this.readValues(request.spreadsheetId, a1Range, 'UNFORMATTED_VALUE');
  }

  /**
   * Resolves and reads multiple Named Ranges in 1 `spreadsheets.get` + 1 `values.batchGet` (`FORMATTED_VALUE`),
   * surfacing missing sheet or Named Range errors per target key without failing valid sibling targets.
   */
  async readNamedRangesBatch(
    request: ReadNamedRangesBatchRequest
  ): Promise<Record<string, ReadNamedRangeBatchEntry>> {
    if (request.targets.length === 0) {
      return {};
    }

    const spreadsheet = await this.getSpreadsheetMetadata(request.spreadsheetId);
    const results: Record<string, ReadNamedRangeBatchEntry> = {};
    const resolvedTargets: Array<{ key: string; a1Range: string }> = [];

    for (const target of request.targets) {
      try {
        const { sheetTitle, gridRange } = this.findNamedRange(spreadsheet, {
          spreadsheetId: request.spreadsheetId,
          sheetName: target.sheetName,
          rangeName: target.rangeName,
        });
        resolvedTargets.push({
          key: target.key,
          a1Range: gridRangeToA1(sheetTitle, gridRange),
        });
      } catch (error) {
        if (error instanceof GoogleSheetsApiError) {
          results[target.key] = {
            status: 'missing_range',
            errorMessage: error.message,
          };
        } else {
          throw error;
        }
      }
    }

    if (resolvedTargets.length > 0) {
      const valueRanges = await this.readBatchValues(
        request.spreadsheetId,
        resolvedTargets.map((item) => item.a1Range),
        'FORMATTED_VALUE'
      );
      resolvedTargets.forEach((item, index) => {
        results[item.key] = {
          status: 'found',
          values: (valueRanges[index]?.values as CellValue[][] | undefined) ?? [],
        };
      });
    }

    return results;
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

  private async loadParsedPositiveTable(
    target: PositiveTableTarget,
    linkColumns?: readonly string[]
  ): Promise<{
    sheetId: number;
    rangeStartRowIndex: number;
    rangeStartColumnIndex: number;
    parsed: ParsedPositiveTable;
    formulaColumns: string[];
    linksByRowNumber?: Map<number, Record<string, string | null>>;
  }> {
    const { sheetId, sheetTitle, gridRange } = await this.resolveNamedRange(target);
    const a1Range = gridRangeToA1(sheetTitle, gridRange);
    const values = await this.readValues(target.spreadsheetId, a1Range, 'FORMATTED_VALUE');
    const rangeStartRowIndex = gridRange.startRowIndex ?? 0;
    const rangeStartColumnIndex = gridRange.startColumnIndex ?? 0;
    const parsed = parsePositiveTable(values, target, rangeStartRowIndex);

    const formulaRanges: string[] = [];
    let formulaZoneRangeIndex: number | undefined;
    if (parsed.topAnchorIndex > 1) {
      const formulaA1Range = gridRangeToA1(sheetTitle, {
        ...gridRange,
        startRowIndex: rangeStartRowIndex + 1,
        endRowIndex: rangeStartRowIndex + parsed.topAnchorIndex,
      });
      formulaZoneRangeIndex = formulaRanges.length;
      formulaRanges.push(formulaA1Range);
    }

    const hasRequestedLinkColumns = linkColumns !== undefined && linkColumns.length > 0;
    const dataRows = parsed.betweenRows.filter((row) => row.kind === 'data');
    const resolvedLinkColumns = resolveRequestedLinkColumns(linkColumns, parsed.columnIndexMap);
    const linkRangeSlices: Array<{ colName: string; rangeIndex: number }> = [];

    if (
      resolvedLinkColumns.length > 0 &&
      parsed.bottomAnchorIndex > parsed.topAnchorIndex + 1 &&
      dataRows.length > 0
    ) {
      const startRowIndex = rangeStartRowIndex + parsed.topAnchorIndex + 1;
      const endRowIndex = rangeStartRowIndex + parsed.bottomAnchorIndex;
      for (const { colName, colRelIdx } of resolvedLinkColumns) {
        const absColIdx = rangeStartColumnIndex + colRelIdx;
        const colA1Range = gridRangeToA1(sheetTitle, {
          sheetId,
          startRowIndex,
          endRowIndex,
          startColumnIndex: absColIdx,
          endColumnIndex: absColIdx + 1,
        });
        linkRangeSlices.push({ colName, rangeIndex: formulaRanges.length });
        formulaRanges.push(colA1Range);
      }
    }

    const valueRanges = await this.readBatchValues(target.spreadsheetId, formulaRanges, 'FORMULA');
    let formulaColumns: string[] = [];
    if (formulaZoneRangeIndex !== undefined) {
      const formulaRows = (valueRanges[formulaZoneRangeIndex]?.values as CellValue[][] | undefined) ?? [];
      formulaColumns = collectFormulaColumns(formulaRows, parsed);
    }

    const linksByRowNumber = hasRequestedLinkColumns
      ? extractLinksByRowNumber(parsed, dataRows, linkRangeSlices, valueRanges)
      : undefined;

    return {
      sheetId,
      rangeStartRowIndex,
      rangeStartColumnIndex,
      parsed,
      formulaColumns,
      ...(linksByRowNumber !== undefined ? { linksByRowNumber } : {}),
    };
  }

  /**
   * Reads a positive-terminated table bounded by `extentMarker` anchors using `FORMATTED_VALUE`,
   * optionally extracting `=HYPERLINK(...)` / raw URL targets for `linkColumns` in one `FORMULA` batchGet pass.
   */
  async readTable(request: ReadPositiveTableRequest): Promise<PositiveTableReadResult> {
    const { parsed, formulaColumns, linksByRowNumber } = await this.loadParsedPositiveTable(
      request.target,
      request.linkColumns
    );

    const rows: PositiveTableRow[] = parsed.betweenRows
      .filter((row) => row.kind === 'data')
      .map((row) => {
        const links = linksByRowNumber?.get(row.rowNumber);
        return {
          rowNumber: row.rowNumber,
          values: row.values,
          ...(links !== undefined ? { links } : {}),
        };
      });

    return {
      headers: parsed.headers,
      formulaColumns,
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
      const { sheetId, rangeStartRowIndex, rangeStartColumnIndex, parsed, formulaColumns } =
        await this.loadParsedPositiveTable(request.target);

      const protectedColumns = new Set([
        ...formulaColumns,
        ...(request.readOnlyColumns ?? []),
      ]);
      const dataRows = parsed.betweenRows.filter((row) => row.kind === 'data');

      let requests: sheets_v4.Schema$Request[];
      let rowNumber: number;
      let action: 'inserted' | 'updated';

      if (dataRows.length === 0) {
        const emptyPlan = planEmptyLogMutation({
          sheetId,
          parsed,
          rangeStartRowIndex,
          target: request.target,
        });
        const writableRuns = buildWritableRuns({
          rowData: request.rowData,
          columnIndexMap: parsed.columnIndexMap,
          protectedColumns,
          rangeStartColumnIndex,
          target: request.target,
          extraClearRelCols: emptyPlan.extraClearRelCols,
        });
        requests = [
          ...emptyPlan.structuralRequests,
          ...makeUpdateCellsForRuns(sheetId, emptyPlan.targetAbsRowIndex, writableRuns),
        ];
        rowNumber = emptyPlan.targetAbsRowIndex + 1;
        action = 'inserted';
      } else if (request.targetKeys && request.rowKeyExtractor) {
        const groupedPlan = planGroupedRowMutation({
          sheetId,
          parsed,
          rangeStartRowIndex,
          rangeStartColumnIndex,
          target: request.target,
          rowData: request.rowData,
          protectedColumns,
          targetKeys: request.targetKeys,
          rowKeyExtractor: request.rowKeyExtractor,
          groupSortOrder: request.groupSortOrder ?? 'asc',
          rowSortOrder: request.rowSortOrder ?? 'asc',
          duplicatePolicy: request.duplicatePolicy ?? 'insert',
        });
        requests = groupedPlan.requests;
        rowNumber = groupedPlan.rowNumber;
        action = groupedPlan.action;
      } else {
        const absBottomAnchor = rangeStartRowIndex + parsed.bottomAnchorIndex;
        const writableRuns = buildWritableRuns({
          rowData: request.rowData,
          columnIndexMap: parsed.columnIndexMap,
          protectedColumns,
          rangeStartColumnIndex,
          target: request.target,
        });
        requests = [
          makeInsertRowRequest(sheetId, absBottomAnchor, 1, true),
          ...makeUpdateCellsForRuns(sheetId, absBottomAnchor, writableRuns),
        ];
        rowNumber = absBottomAnchor + 1;
        action = 'inserted';
      }

      if (requests.length > 0) {
        await this.executeWithRetry(() =>
          this.sheetsApi.spreadsheets.batchUpdate({
            spreadsheetId: request.target.spreadsheetId,
            requestBody: { requests },
          })
        );
      }

      return {
        rowNumber,
        action,
      };
    });
  }
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GoogleAuth, OAuth2Client } from 'google-auth-library';
// nosemgrep: adapter-leakage-warning
import { google, type sheets_v4 } from 'googleapis';
import {
  buildColumnIndexMap,
  cellValueToCellData,
  gridRangeToA1,
  isCellEmpty,
  type CellValue,
  type PositiveTableTarget,
  type RowRecord,
  type SheetCellInput,
} from '../../../src/infrastructure/sheets';
import {
  executeWithRateLimitRetry,
  type GoogleApiRetryOptions,
} from '../../../src/infrastructure/google/retry';

export const DEFAULT_LIVE_RETRY_OPTIONS = {
  maxRetries: 5,
  initialDelayMs: 2000,
  backoffFactor: 2,
};

export const SHEET_ERROR_TOKENS = [
  '#REF!',
  '#ERROR!',
  '#N/A',
  '#VALUE!',
  '#NAME?',
  '#DIV/0!',
] as const;

export interface SpreadsheetErrorFinding {
  sheetTitle: string;
  rowNumber: number;
  columnIndex: number;
  value: string;
  tokens: string[];
}

export interface FixtureSubmittalEntry {
  documentData: Record<string, string>;
  actionName: string;
  fileUri: string | null;
  identity: { idGroup: string; idDocument: string; id: string };
}

export interface FixtureWriteScenario extends FixtureSubmittalEntry {
  scenario: string;
  description: string;
  fileUri: string;
}

export interface FixturePartialHydrationRow {
  scenario: string;
  description: string;
  rowCells: Record<string, string>;
  linkFormula: string;
  expectedIssues: string[];
}

export interface DocumentLogSampleFixture {
  metadata: { templateSpreadsheetId: string };
  submittalArch: {
    sheetName: string;
    rangeName: string;
    seedEntries: FixtureSubmittalEntry[];
    writeScenarios: FixtureWriteScenario[];
    partialHydrationRows: FixturePartialHydrationRow[];
  };
  submittalFfe: {
    sheetName: string;
    rangeName: string;
    seedEntries: FixtureSubmittalEntry[];
    writeScenarios: FixtureWriteScenario[];
    partialHydrationRows: FixturePartialHydrationRow[];
  };
}

export type LiveSheetsRetryOptions = GoogleApiRetryOptions;

type PositiveRowKind = 'data' | 'blank' | 'divider';

interface ResolvedNamedRange {
  sheetId: number;
  sheetTitle: string;
  gridRange: sheets_v4.Schema$GridRange;
  a1Range: string;
}

interface ParsedBetweenEntry {
  relIndex: number;
  rowIndex: number;
  rowNumber: number;
  kind: PositiveRowKind;
  formattedRow: CellValue[];
}

interface ParsedBounds {
  headers: string[];
  columnIndexMap: Map<string, number>;
  topAnchorIndex: number;
  bottomAnchorIndex: number;
  betweenRows: ParsedBetweenEntry[];
}

interface InspectedBetweenRow {
  rowIndex: number;
  rowNumber: number;
  kind: PositiveRowKind;
  formattedRow: CellValue[];
  formulaRow: CellValue[];
  isColumnZeroOnlyDivider: boolean;
  nonEmptyColumnsAfterZero: number[];
}

interface PositiveTableLayoutInspection {
  headers: string[];
  topAnchorRowIndex: number;
  bottomAnchorRowIndex: number;
  betweenRows: InspectedBetweenRow[];
  dividerRowIndices: number[];
  formulaRowsByHeader: Record<string, string[]>;
}

/**
 * Loads the anonymized Submittal Arch / FF&E fixture dataset for live tests.
 */
export function loadDocumentLogSampleFixture(fixturePath?: string): DocumentLogSampleFixture {
  const targetPath =
    fixturePath ?? path.resolve(__dirname, '../../fixtures/document-log-sample-data.json');
  return JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as DocumentLogSampleFixture;
}

/**
 * Converts a fixture partial-hydration row into raw `SheetCellInput` values keyed by header.
 */
export function partialHydrationRowToCellInputs(
  row: FixturePartialHydrationRow
): Record<string, SheetCellInput> {
  const inputs: Record<string, SheetCellInput> = {};

  for (const [header, value] of Object.entries(row.rowCells)) {
    if (header === 'Calc Link') {
      continue;
    }
    inputs[header] = value === '' ? null : value;
  }

  const trimmedLink = row.linkFormula.trim();
  if (trimmedLink === '') {
    inputs['Calc Link'] = null;
  } else if (trimmedLink.startsWith('=')) {
    inputs['Calc Link'] = { formula: trimmedLink };
  } else {
    inputs['Calc Link'] = trimmedLink;
  }

  return inputs;
}

/**
 * Creates an authenticated `sheets_v4.Sheets` client for live integration tests.
 */
export function createLiveSheetsApi(auth: OAuth2Client | GoogleAuth): sheets_v4.Sheets {
  return google.sheets({
    version: 'v4',
    auth: auth as NonNullable<Parameters<typeof google.sheets>[0]['auth']>,
  });
}

/**
 * Returns any Google Sheets formula/evaluation error tokens found in a row's string cells.
 */
export function findSheetErrorTokens(values: RowRecord): string[] {
  const found: string[] = [];
  for (const cellVal of Object.values(values)) {
    if (typeof cellVal !== 'string') {
      continue;
    }
    for (const token of SHEET_ERROR_TOKENS) {
      if (cellVal.includes(token)) {
        found.push(token);
      }
    }
  }
  return found;
}

/**
 * Scans every sheet tab in a spreadsheet for Google Sheets formula evaluation error tokens.
 */
export async function findSpreadsheetErrorTokens(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  retryOptions?: LiveSheetsRetryOptions
): Promise<SpreadsheetErrorFinding[]> {
  const metaResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(title))',
      }),
    retryOptions
  );

  const sheetTitles = (metaResponse.data.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter((title): title is string => typeof title === 'string' && title.length > 0);

  if (sheetTitles.length === 0) {
    return [];
  }

  const quotedRanges = sheetTitles.map((title) => gridRangeToA1(title, {}));
  const valuesResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: quotedRanges,
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    retryOptions
  );

  const findings: SpreadsheetErrorFinding[] = [];
  const valueRanges = valuesResponse.data.valueRanges ?? [];
  sheetTitles.forEach((sheetTitle, sheetIdx) => {
    const rows = (valueRanges[sheetIdx]?.values as CellValue[][] | undefined) ?? [];
    rows.forEach((row, rowIdx) => {
      row.forEach((cellVal, columnIndex) => {
        if (typeof cellVal !== 'string') {
          return;
        }
        const tokens = SHEET_ERROR_TOKENS.filter((token) => cellVal.includes(token));
        if (tokens.length > 0) {
          findings.push({
            sheetTitle,
            rowNumber: rowIdx + 1,
            columnIndex,
            value: cellVal,
            tokens,
          });
        }
      });
    });
  });

  return findings;
}

/**
 * Validates positive-table divider layout and returns descriptive violation messages (empty when clean).
 */
export function findCleanDividerViolations(params: {
  dividerRowIndices: number[];
  topAnchorRowIndex: number;
  bottomAnchorRowIndex: number;
  betweenRows: Array<{
    kind: string;
    rowNumber: number;
    isColumnZeroOnlyDivider: boolean;
    nonEmptyColumnsAfterZero: number[];
  }>;
  expectedDividerCount: number;
}): string[] {
  const {
    dividerRowIndices,
    topAnchorRowIndex,
    bottomAnchorRowIndex,
    betweenRows,
    expectedDividerCount,
  } = params;

  const violations: string[] = [];

  if (dividerRowIndices.length !== expectedDividerCount) {
    violations.push(
      `Expected ${expectedDividerCount} divider rows, found ${dividerRowIndices.length}.`
    );
  }

  if (dividerRowIndices.length > 0) {
    if (dividerRowIndices[0] <= topAnchorRowIndex + 1) {
      violations.push(
        `First divider row index ${dividerRowIndices[0]} is adjacent to or before top anchor ${topAnchorRowIndex}.`
      );
    }
    const lastDivider = dividerRowIndices[dividerRowIndices.length - 1];
    if (lastDivider >= bottomAnchorRowIndex - 1) {
      violations.push(
        `Last divider row index ${lastDivider} is adjacent to or after bottom anchor ${bottomAnchorRowIndex}.`
      );
    }
    for (let i = 1; i < dividerRowIndices.length; i++) {
      if (dividerRowIndices[i] - dividerRowIndices[i - 1] <= 1) {
        violations.push(
          `Consecutive divider rows found at indices ${dividerRowIndices[i - 1]} and ${dividerRowIndices[i]}.`
        );
      }
    }
  }

  const dividerEntries = betweenRows.filter((row) => row.kind === 'divider');
  if (dividerEntries.length !== expectedDividerCount) {
    violations.push(
      `Expected ${expectedDividerCount} divider entries in betweenRows, found ${dividerEntries.length}.`
    );
  }

  for (const divider of dividerEntries) {
    if (!divider.isColumnZeroOnlyDivider || divider.nonEmptyColumnsAfterZero.length > 0) {
      violations.push(
        `Divider at row ${divider.rowNumber} has non-empty trailing columns [${divider.nonEmptyColumnsAfterZero.join(', ')}].`
      );
    }
  }

  return violations;
}

/**
 * Wraps a raw Sheets SDK operation with unified rate-limit retry (`±25%` jitter, 429 & quota-403).
 */
export async function withLiveSheetsRetry<T>(
  operation: () => Promise<T>,
  retryOptions: LiveSheetsRetryOptions = DEFAULT_LIVE_RETRY_OPTIONS
): Promise<T> {
  return executeWithRateLimitRetry(operation, {
    ...retryOptions,
    maxRetries: retryOptions.maxRetries ?? DEFAULT_LIVE_RETRY_OPTIONS.maxRetries,
    initialDelayMs: retryOptions.initialDelayMs ?? DEFAULT_LIVE_RETRY_OPTIONS.initialDelayMs,
    backoffFactor: retryOptions.backoffFactor ?? DEFAULT_LIVE_RETRY_OPTIONS.backoffFactor,
  });
}

async function withSheetsRetry<T>(
  operation: () => Promise<T>,
  retryOptions: LiveSheetsRetryOptions = DEFAULT_LIVE_RETRY_OPTIONS
): Promise<T> {
  return withLiveSheetsRetry(operation, retryOptions);
}

/**
 * Reads spreadsheet metadata with unified rate-limit retry.
 */
export async function readSpreadsheetMetadata(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  fields = 'sheets(properties(sheetId,title))',
  retryOptions?: LiveSheetsRetryOptions
): Promise<sheets_v4.Schema$Spreadsheet> {
  const response = await withLiveSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields,
      }),
    retryOptions
  );
  return response.data;
}

/**
 * Reads A1 range values with unified rate-limit retry.
 */
export async function readSpreadsheetValues(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  range: string,
  valueRenderOption: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE',
  retryOptions?: LiveSheetsRetryOptions
): Promise<CellValue[][]> {
  const response = await withLiveSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range,
        valueRenderOption,
      }),
    retryOptions
  );
  return (response.data.values as CellValue[][] | undefined) ?? [];
}

/**
 * Writes raw or user-entered values via `values.batchUpdate` with unified rate-limit retry.
 */
export async function batchUpdateSpreadsheetValues(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  data: sheets_v4.Schema$ValueRange[],
  valueInputOption: 'RAW' | 'USER_ENTERED' = 'RAW',
  retryOptions?: LiveSheetsRetryOptions
): Promise<void> {
  await withLiveSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption,
          data,
        },
      }),
    retryOptions
  );
}

/**
 * Reads grid layout (`formattedValue`, `userEnteredValue`, `note`), sheet `merges`, and `namedRanges`
 * for one or more A1 ranges in a single retry-backed `spreadsheets.get` call.
 */
export async function readSheetsGridLayout(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  ranges: readonly string[],
  retryOptions?: LiveSheetsRetryOptions
): Promise<sheets_v4.Schema$Spreadsheet> {
  const response = await withLiveSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId,
        ranges: [...ranges],
        includeGridData: true,
        fields:
          'sheets(properties(sheetId,title),merges,data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue,note)))),namedRanges',
      }),
    retryOptions
  );
  return response.data;
}

async function resolvePositiveNamedRange(
  sheetsApi: sheets_v4.Sheets,
  target: PositiveTableTarget,
  retryOptions?: LiveSheetsRetryOptions
): Promise<ResolvedNamedRange> {
  const response = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId: target.spreadsheetId,
        fields: 'sheets(properties(sheetId,title)),namedRanges',
      }),
    retryOptions
  );

  const spreadsheet = response.data;
  const targetSheet = (spreadsheet.sheets ?? []).find(
    (sheet) => sheet.properties?.title?.toLowerCase() === target.sheetName.toLowerCase()
  );

  if (
    !targetSheet ||
    targetSheet.properties?.sheetId === undefined ||
    targetSheet.properties.sheetId === null
  ) {
    throw new Error(`Sheet "${target.sheetName}" not found in spreadsheet "${target.spreadsheetId}".`);
  }

  const sheetId = targetSheet.properties.sheetId;
  const sheetTitle = targetSheet.properties.title ?? target.sheetName;
  const targetRangeLower = target.rangeName.toLowerCase();
  const scopedRangeLower = `${target.sheetName}!${target.rangeName}`.toLowerCase();

  let matchedNamedRange: sheets_v4.Schema$NamedRange | undefined;
  let fallbackWorkbookRange: sheets_v4.Schema$NamedRange | undefined;

  for (const nr of spreadsheet.namedRanges ?? []) {
    const name = (nr.name ?? '').toLowerCase();
    if (name === targetRangeLower || name === scopedRangeLower) {
      const nrSheetId = nr.range?.sheetId;
      if (nrSheetId === sheetId) {
        matchedNamedRange = nr;
        break;
      }
      if ((nrSheetId === undefined || nrSheetId === null) && !fallbackWorkbookRange) {
        fallbackWorkbookRange = nr;
      }
    }
  }

  const resolved = matchedNamedRange ?? fallbackWorkbookRange;
  if (!resolved?.range) {
    throw new Error(
      `Named range "${target.rangeName}" not found on sheet "${target.sheetName}" in spreadsheet "${target.spreadsheetId}".`
    );
  }

  const gridRange: sheets_v4.Schema$GridRange = {
    ...resolved.range,
    sheetId,
  };

  return {
    sheetId,
    sheetTitle,
    gridRange,
    a1Range: gridRangeToA1(sheetTitle, gridRange),
  };
}

function matchesMarker(
  row: readonly CellValue[],
  marker: string,
  statusColIndex: number | undefined
): boolean {
  if (row[0] === marker) {
    return true;
  }
  return statusColIndex !== undefined && row[statusColIndex] === marker;
}

function isBlankRow(row: readonly CellValue[]): boolean {
  return row.length === 0 || row.every((cell) => isCellEmpty(cell));
}

function parsePositiveBounds(
  values: CellValue[][],
  target: PositiveTableTarget,
  rangeStartRowIndex: number
): ParsedBounds {
  if (values.length === 0) {
    throw new Error(
      `Positive extent anchors "${target.extentMarker}" not found in empty range "${target.rangeName}" on sheet "${target.sheetName}".`
    );
  }

  const columnIndexMap = buildColumnIndexMap(values[0] ?? []);
  const headers = Array.from(columnIndexMap.keys());
  const statusColIndex = columnIndexMap.get('Status');

  let topAnchorIndex = -1;
  let bottomAnchorIndex = -1;

  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (matchesMarker(row, target.extentMarker, statusColIndex)) {
      if (topAnchorIndex === -1) {
        topAnchorIndex = i;
      }
      bottomAnchorIndex = i;
    }
  }

  if (topAnchorIndex === -1 || bottomAnchorIndex === -1 || topAnchorIndex >= bottomAnchorIndex) {
    throw new Error(
      `Valid start and end extent anchors "${target.extentMarker}" not found in range "${target.rangeName}" on sheet "${target.sheetName}".`
    );
  }

  const betweenRows: ParsedBetweenEntry[] = [];
  for (let i = topAnchorIndex + 1; i < bottomAnchorIndex; i++) {
    const formattedRow = values[i] ?? [];
    const rowIndex = rangeStartRowIndex + i;
    let kind: PositiveRowKind;
    if (matchesMarker(formattedRow, target.groupDividerMarker, statusColIndex)) {
      kind = 'divider';
    } else if (isBlankRow(formattedRow)) {
      kind = 'blank';
    } else {
      kind = 'data';
    }
    betweenRows.push({
      relIndex: i,
      rowIndex,
      rowNumber: rowIndex + 1,
      kind,
      formattedRow,
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

function collectFormulaRelCols(
  preAnchorFormulaRows: readonly CellValue[][],
  columnCount: number
): Set<number> {
  const formulaCols = new Set<number>();
  for (const row of preAnchorFormulaRows) {
    for (let colIdx = 0; colIdx < Math.min(row.length, columnCount); colIdx++) {
      const cell = row[colIdx];
      if (typeof cell === 'string' && cell.trim().startsWith('=')) {
        formulaCols.add(colIdx);
      }
    }
  }
  return formulaCols;
}

function buildContiguousUpdateCellsRequests(params: {
  sheetId: number;
  absRowIndex: number;
  rangeStartColumnIndex: number;
  columnCount: number;
  getCellData: (relCol: number) => sheets_v4.Schema$CellData | undefined;
}): sheets_v4.Schema$Request[] {
  const { sheetId, absRowIndex, rangeStartColumnIndex, columnCount, getCellData } = params;
  const requests: sheets_v4.Schema$Request[] = [];
  let runStart: number | null = null;
  let runValues: sheets_v4.Schema$CellData[] = [];

  const flushRun = (runEndExclusive: number): void => {
    if (runStart === null) {
      return;
    }
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: absRowIndex,
          endRowIndex: absRowIndex + 1,
          startColumnIndex: rangeStartColumnIndex + runStart,
          endColumnIndex: rangeStartColumnIndex + runEndExclusive,
        },
        rows: [{ values: runValues }],
        fields: 'userEnteredValue',
      },
    });
    runStart = null;
    runValues = [];
  };

  for (let relCol = 0; relCol < columnCount; relCol++) {
    const cellData = getCellData(relCol);
    if (cellData === undefined) {
      flushRun(relCol);
      continue;
    }
    if (runStart === null) {
      runStart = relCol;
    }
    runValues.push(cellData);
  }
  flushRun(columnCount);

  return requests;
}

async function resolvePreAnchorFormulaRelCols(params: {
  sheetsApi: sheets_v4.Sheets;
  target: PositiveTableTarget;
  sheetTitle: string;
  gridRange: sheets_v4.Schema$GridRange;
  rangeStartRowIndex: number;
  rangeStartColumnIndex: number;
  topAnchorIndex: number;
  columnCount: number;
  retryOptions?: LiveSheetsRetryOptions | undefined;
}): Promise<Set<number>> {
  const {
    sheetsApi,
    target,
    sheetTitle,
    gridRange,
    rangeStartRowIndex,
    rangeStartColumnIndex,
    topAnchorIndex,
    columnCount,
    retryOptions,
  } = params;

  if (topAnchorIndex <= 1) {
    return new Set<number>();
  }

  const preAnchorA1Range = gridRangeToA1(sheetTitle, {
    ...gridRange,
    startRowIndex: rangeStartRowIndex + 1,
    endRowIndex: rangeStartRowIndex + topAnchorIndex,
    endColumnIndex: gridRange.endColumnIndex ?? rangeStartColumnIndex + columnCount,
  });
  const formulaResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.get({
        spreadsheetId: target.spreadsheetId,
        range: preAnchorA1Range,
        valueRenderOption: 'FORMULA',
      }),
    retryOptions
  );
  const preAnchorRows = (formulaResponse.data.values as CellValue[][] | undefined) ?? [];
  return collectFormulaRelCols(preAnchorRows, columnCount);
}

/**
 * Normalizes a positive-terminated template table so exactly 1 blank placeholder row exists
 * between `<--->` anchors, performing zero mutations when the template is already clean and
 * preserving pre-`<--->` formula-owned columns when clearing sample data.
 */
export async function ensureClearedPositiveTable(
  sheetsApi: sheets_v4.Sheets,
  target: PositiveTableTarget,
  retryOptions?: LiveSheetsRetryOptions
): Promise<void> {
  const { sheetId, sheetTitle, gridRange, a1Range } = await resolvePositiveNamedRange(
    sheetsApi,
    target,
    retryOptions
  );
  const formattedResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.get({
        spreadsheetId: target.spreadsheetId,
        range: a1Range,
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    retryOptions
  );

  const formattedValues = (formattedResponse.data.values as CellValue[][] | undefined) ?? [];
  const rangeStartRowIndex = gridRange.startRowIndex ?? 0;
  const rangeStartColumnIndex = gridRange.startColumnIndex ?? 0;
  const parsed = parsePositiveBounds(formattedValues, target, rangeStartRowIndex);

  if (parsed.betweenRows.length === 1 && parsed.betweenRows[0].kind === 'blank') {
    return;
  }

  const columnCount =
    gridRange.endColumnIndex !== undefined && gridRange.endColumnIndex !== null
      ? gridRange.endColumnIndex - rangeStartColumnIndex
      : Math.max((formattedValues[0] ?? []).length, parsed.headers.length, 1);

  const formulaRelCols = await resolvePreAnchorFormulaRelCols({
    sheetsApi,
    target,
    sheetTitle,
    gridRange,
    rangeStartRowIndex,
    rangeStartColumnIndex,
    topAnchorIndex: parsed.topAnchorIndex,
    columnCount,
    retryOptions,
  });

  const absTopAnchor = rangeStartRowIndex + parsed.topAnchorIndex;
  const absBottomAnchor = rangeStartRowIndex + parsed.bottomAnchorIndex;
  const requests: sheets_v4.Schema$Request[] = [];

  if (parsed.betweenRows.length === 0) {
    requests.push({
      insertDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: absBottomAnchor,
          endIndex: absBottomAnchor + 1,
        },
        inheritFromBefore: false,
      },
    });
  } else if (absBottomAnchor > absTopAnchor + 2) {
    requests.push({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: absTopAnchor + 2,
          endIndex: absBottomAnchor,
        },
      },
    });
  }

  requests.push(
    ...buildContiguousUpdateCellsRequests({
      sheetId,
      absRowIndex: absTopAnchor + 1,
      rangeStartColumnIndex,
      columnCount,
      getCellData: (relCol) => (formulaRelCols.has(relCol) ? undefined : {}),
    })
  );

  if (requests.length > 0) {
    await withSheetsRetry(
      () =>
        sheetsApi.spreadsheets.batchUpdate({
          spreadsheetId: target.spreadsheetId,
          requestBody: { requests },
        }),
      retryOptions
    );
  }
}

/**
 * Appends raw rows immediately before the bottom `<--->` anchor of a positive-terminated table,
 * skipping pre-`<--->` formula-owned columns and absent headers, and returns 1-based row numbers.
 */
export async function appendRawPositiveTableRows(
  sheetsApi: sheets_v4.Sheets,
  target: PositiveTableTarget,
  rows: ReadonlyArray<Readonly<Record<string, SheetCellInput>>>,
  retryOptions?: LiveSheetsRetryOptions
): Promise<number[]> {
  if (rows.length === 0) {
    return [];
  }

  const { sheetId, sheetTitle, gridRange, a1Range } = await resolvePositiveNamedRange(
    sheetsApi,
    target,
    retryOptions
  );
  const formattedResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.get({
        spreadsheetId: target.spreadsheetId,
        range: a1Range,
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    retryOptions
  );

  const formattedValues = (formattedResponse.data.values as CellValue[][] | undefined) ?? [];
  const rangeStartRowIndex = gridRange.startRowIndex ?? 0;
  const rangeStartColumnIndex = gridRange.startColumnIndex ?? 0;
  const parsed = parsePositiveBounds(formattedValues, target, rangeStartRowIndex);

  const columnCount =
    gridRange.endColumnIndex !== undefined && gridRange.endColumnIndex !== null
      ? gridRange.endColumnIndex - rangeStartColumnIndex
      : Math.max((formattedValues[0] ?? []).length, parsed.headers.length, 1);

  const formulaRelCols = await resolvePreAnchorFormulaRelCols({
    sheetsApi,
    target,
    sheetTitle,
    gridRange,
    rangeStartRowIndex,
    rangeStartColumnIndex,
    topAnchorIndex: parsed.topAnchorIndex,
    columnCount,
    retryOptions,
  });

  const absTopAnchor = rangeStartRowIndex + parsed.topAnchorIndex;
  const absBottomAnchor = rangeStartRowIndex + parsed.bottomAnchorIndex;

  const relColToHeader = new Map<number, string>();
  for (const [header, relCol] of parsed.columnIndexMap.entries()) {
    relColToHeader.set(relCol, header);
  }

  const requests: sheets_v4.Schema$Request[] = [
    {
      insertDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: absBottomAnchor,
          endIndex: absBottomAnchor + rows.length,
        },
        inheritFromBefore: absBottomAnchor > absTopAnchor + 1,
      },
    },
  ];

  rows.forEach((rowData, rowOffset) => {
    requests.push(
      ...buildContiguousUpdateCellsRequests({
        sheetId,
        absRowIndex: absBottomAnchor + rowOffset,
        rangeStartColumnIndex,
        columnCount,
        getCellData: (relCol) => {
          if (formulaRelCols.has(relCol)) {
            return undefined;
          }
          const header = relColToHeader.get(relCol);
          if (!header || !Object.prototype.hasOwnProperty.call(rowData, header)) {
            return undefined;
          }
          const rawValue = rowData[header];
          if (rawValue === undefined) {
            return undefined;
          }
          return cellValueToCellData(rawValue === '' ? null : rawValue);
        },
      })
    );
  });

  await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: target.spreadsheetId,
        requestBody: { requests },
      }),
    retryOptions
  );

  return rows.map((_, idx) => absBottomAnchor + idx + 1);
}

/**
 * Inspects a positive-terminated table with both `FORMATTED_VALUE` and `FORMULA`,
 * reporting anchor positions, divider Column-0 purity, and raw/formula strings per data row.
 */
export async function inspectPositiveTableLayout(
  sheetsApi: sheets_v4.Sheets,
  target: PositiveTableTarget,
  retryOptions?: LiveSheetsRetryOptions
): Promise<PositiveTableLayoutInspection> {
  const { gridRange, a1Range } = await resolvePositiveNamedRange(sheetsApi, target, retryOptions);
  const [formattedResponse, formulaResponse] = await Promise.all([
    withSheetsRetry(
      () =>
        sheetsApi.spreadsheets.values.get({
          spreadsheetId: target.spreadsheetId,
          range: a1Range,
          valueRenderOption: 'FORMATTED_VALUE',
        }),
      retryOptions
    ),
    withSheetsRetry(
      () =>
        sheetsApi.spreadsheets.values.get({
          spreadsheetId: target.spreadsheetId,
          range: a1Range,
          valueRenderOption: 'FORMULA',
        }),
      retryOptions
    ),
  ]);

  const formattedValues = (formattedResponse.data.values as CellValue[][] | undefined) ?? [];
  const formulaValues = (formulaResponse.data.values as CellValue[][] | undefined) ?? [];
  const rangeStartRowIndex = gridRange.startRowIndex ?? 0;
  const parsed = parsePositiveBounds(formattedValues, target, rangeStartRowIndex);

  const formulaRowsByHeader: Record<string, string[]> = {};
  for (const header of parsed.headers) {
    formulaRowsByHeader[header] = [];
  }

  const dividerRowIndices: number[] = [];
  const betweenRows: InspectedBetweenRow[] = parsed.betweenRows.map((entry) => {
    const formulaRow = formulaValues[entry.relIndex] ?? [];
    const maxCols = Math.max(entry.formattedRow.length, formulaRow.length);
    const nonEmptyColumnsAfterZero: number[] = [];

    for (let colIdx = 1; colIdx < maxCols; colIdx++) {
      if (!isCellEmpty(entry.formattedRow[colIdx]) || !isCellEmpty(formulaRow[colIdx])) {
        nonEmptyColumnsAfterZero.push(colIdx);
      }
    }

    const isColumnZeroOnlyDivider =
      entry.kind === 'divider' &&
      entry.formattedRow[0] === target.groupDividerMarker &&
      nonEmptyColumnsAfterZero.length === 0;

    if (entry.kind === 'divider') {
      dividerRowIndices.push(entry.rowIndex);
    } else if (entry.kind === 'data') {
      for (const [header, colIdx] of parsed.columnIndexMap.entries()) {
        const rawCell = colIdx < formulaRow.length ? formulaRow[colIdx] : undefined;
        formulaRowsByHeader[header].push(
          rawCell === null || rawCell === undefined ? '' : String(rawCell)
        );
      }
    }

    return {
      rowIndex: entry.rowIndex,
      rowNumber: entry.rowNumber,
      kind: entry.kind,
      formattedRow: entry.formattedRow,
      formulaRow,
      isColumnZeroOnlyDivider,
      nonEmptyColumnsAfterZero,
    };
  });

  return {
    headers: parsed.headers,
    topAnchorRowIndex: rangeStartRowIndex + parsed.topAnchorIndex,
    bottomAnchorRowIndex: rangeStartRowIndex + parsed.bottomAnchorIndex,
    betweenRows,
    dividerRowIndices,
      formulaRowsByHeader,
    };
}

export interface NamedRangeSnapshot {
  name: string;
  namedRangeId?: string | undefined;
  sheetId: number;
  sheetTitle: string;
  gridRange: sheets_v4.Schema$GridRange;
  a1Range: string;
}

export interface ClearOptionTableResult {
  cleared: boolean;
  blankRowIndex: number;
  absTerminatorRowIndex: number;
}

interface OptionTableGridCellInfo {
  formattedValue: string;
  userEnteredFormat?: sheets_v4.Schema$CellFormat | undefined;
}

interface OptionTableGridRowInfo {
  absRowIndex: number;
  cells: OptionTableGridCellInfo[];
}

export interface OptionTableGridFormatsInfo {
  headerRow: string[];
  headerNotes: string[];
  dataRows: OptionTableGridRowInfo[];
  sheetMerges: sheets_v4.Schema$GridRange[];
}

function findNamedRangeInSpreadsheet(
  spreadsheet: sheets_v4.Schema$Spreadsheet,
  rangeName: string,
  sheetName?: string
): {
  namedRange: sheets_v4.Schema$NamedRange;
  sheetId: number;
  sheetTitle: string;
  gridRange: sheets_v4.Schema$GridRange;
  a1Range: string;
} {
  const sheetTitleById = new Map<number, string>();
  let explicitSheetId: number | undefined;
  for (const sheet of spreadsheet.sheets ?? []) {
    const id = sheet.properties?.sheetId;
    const title = sheet.properties?.title ?? '';
    if (typeof id === 'number') {
      sheetTitleById.set(id, title);
      if (sheetName && title.toLowerCase() === sheetName.toLowerCase()) {
        explicitSheetId = id;
      }
    }
  }
  if (sheetName && explicitSheetId === undefined) {
    throw new Error(
      `Sheet "${sheetName}" not found in spreadsheet "${spreadsheet.spreadsheetId ?? ''}".`
    );
  }

  const targetLower = rangeName.toLowerCase();
  const scopedLower = sheetName ? `${sheetName}!${rangeName}`.toLowerCase() : undefined;

  let matched: sheets_v4.Schema$NamedRange | undefined;
  let fallback: sheets_v4.Schema$NamedRange | undefined;

  for (const nr of spreadsheet.namedRanges ?? []) {
    const name = (nr.name ?? '').toLowerCase();
    if (name === targetLower || (scopedLower !== undefined && name === scopedLower)) {
      if (explicitSheetId !== undefined) {
        if (nr.range?.sheetId === explicitSheetId) {
          matched = nr;
          break;
        }
        if ((nr.range?.sheetId === undefined || nr.range?.sheetId === null) && !fallback) {
          fallback = nr;
        }
      } else {
        matched = nr;
        break;
      }
    }
  }

  const resolved = matched ?? fallback;
  if (!resolved?.range) {
    throw new Error(
      `Named range "${rangeName}" not found${sheetName ? ` on sheet "${sheetName}"` : ''} in spreadsheet "${spreadsheet.spreadsheetId ?? ''}".`
    );
  }

  const sheetId = explicitSheetId ?? resolved.range.sheetId ?? 0;
  const sheetTitle = sheetName ?? sheetTitleById.get(sheetId) ?? '';
  const gridRange: sheets_v4.Schema$GridRange = {
    ...resolved.range,
    sheetId,
  };

  return {
    namedRange: resolved,
    sheetId,
    sheetTitle,
    gridRange,
    a1Range: gridRangeToA1(sheetTitle, gridRange),
  };
}

/**
 * Snapshots named range bounds for verification of Named Range expansion and side-by-side stability.
 */
export async function snapshotNamedRanges(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  rangeNames: readonly string[],
  retryOptions?: LiveSheetsRetryOptions
): Promise<Record<string, NamedRangeSnapshot>> {
  const response = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,title)),namedRanges',
      }),
    retryOptions
  );

  const spreadsheet: sheets_v4.Schema$Spreadsheet = {
    ...response.data,
    spreadsheetId,
  };

  const result: Record<string, NamedRangeSnapshot> = {};
  for (const rangeName of rangeNames) {
    const found = findNamedRangeInSpreadsheet(spreadsheet, rangeName);
    result[rangeName] = {
      name: found.namedRange.name ?? rangeName,
      ...(typeof found.namedRange.namedRangeId === 'string'
        ? { namedRangeId: found.namedRange.namedRangeId }
        : {}),
      sheetId: found.sheetId,
      sheetTitle: found.sheetTitle,
      gridRange: found.gridRange,
      a1Range: found.a1Range,
    };
  }
  return result;
}

/**
 * Reads `FORMATTED_VALUE` grids for all snapshotted named ranges in a single `values.batchGet`.
 */
export async function readNamedRangesFormattedValues(
  sheetsApi: sheets_v4.Sheets,
  spreadsheetId: string,
  snapshots: Readonly<Record<string, NamedRangeSnapshot>>,
  retryOptions?: LiveSheetsRetryOptions,
  extraRanges?: Readonly<Record<string, string>>
): Promise<Record<string, CellValue[][]>> {
  const entries = [
    ...Object.entries(snapshots).map(([key, snap]) => ({ key, a1Range: snap.a1Range })),
    ...Object.entries(extraRanges ?? {}).map(([key, a1Range]) => ({ key, a1Range })),
  ];
  if (entries.length === 0) {
    return {};
  }

  const response = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: entries.map((entry) => entry.a1Range),
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    retryOptions
  );

  const valueRanges = response.data.valueRanges ?? [];
  const output: Record<string, CellValue[][]> = {};
  entries.forEach(({ key }, idx) => {
    output[key] = (valueRanges[idx]?.values as CellValue[][] | undefined) ?? [];
  });
  return output;
}

/**
 * Verifies that untouched side-by-side `_Config` tables kept identical NamedRange bounds and cell values.
 */
export function findSideBySideTableShiftViolations(params: {
  beforeSnapshots: Readonly<Record<string, NamedRangeSnapshot>>;
  afterSnapshots: Readonly<Record<string, NamedRangeSnapshot>>;
  beforeValues: Readonly<Record<string, CellValue[][]>>;
  afterValues: Readonly<Record<string, CellValue[][]>>;
  rangeNames: readonly string[];
}): string[] {
  const { beforeSnapshots, afterSnapshots, beforeValues, afterValues, rangeNames } = params;
  const violations: string[] = [];

  for (const name of rangeNames) {
    const beforeRange = beforeSnapshots[name]?.gridRange;
    const afterRange = afterSnapshots[name]?.gridRange;
    if (JSON.stringify(beforeRange) !== JSON.stringify(afterRange)) {
      violations.push(
        `Named range "${name}" shifted from ${JSON.stringify(beforeRange)} to ${JSON.stringify(afterRange)}.`
      );
    }

    const beforeGrid = beforeValues[name];
    const afterGrid = afterValues[name];
    if (JSON.stringify(beforeGrid) !== JSON.stringify(afterGrid)) {
      violations.push(
        `Table values for "${name}" changed unexpectedly during neighboring write.`
      );
    }
  }

  return violations;
}

/**
 * Clears an option table to 1 unformatted blank row + `endMarker` using range-scoped `deleteRange`
 * so neighboring side-by-side `_Config` tables on the same sheet are unaffected.
 */
export async function clearOptionTableToEmpty(
  sheetsApi: sheets_v4.Sheets,
  target: {
    spreadsheetId: string;
    sheetName: string;
    rangeName: string;
    validationRangeName?: string | undefined;
    endMarker: string;
  },
  retryOptions?: LiveSheetsRetryOptions
): Promise<ClearOptionTableResult> {
  const metaResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId: target.spreadsheetId,
        fields: 'sheets(properties(sheetId,title)),namedRanges',
      }),
    retryOptions
  );

  const spreadsheet: sheets_v4.Schema$Spreadsheet = {
    ...metaResponse.data,
    spreadsheetId: target.spreadsheetId,
  };
  const resolved = findNamedRangeInSpreadsheet(spreadsheet, target.rangeName, target.sheetName);

  const valuesResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.values.get({
        spreadsheetId: target.spreadsheetId,
        range: resolved.a1Range,
        valueRenderOption: 'FORMATTED_VALUE',
      }),
    retryOptions
  );

  const values = (valuesResponse.data.values as CellValue[][] | undefined) ?? [];
  const startRow = resolved.gridRange.startRowIndex ?? 0;
  const startCol = resolved.gridRange.startColumnIndex ?? 0;
  const endCol =
    resolved.gridRange.endColumnIndex !== undefined && resolved.gridRange.endColumnIndex !== null
      ? resolved.gridRange.endColumnIndex
      : startCol + Math.max((values[0] ?? []).length, 1);
  const width = Math.max(endCol - startCol, 1);

  let terminatorRelIndex = -1;
  for (let i = 1; i < values.length; i++) {
    const row = values[i] ?? [];
    if (row.some((cell) => cell !== null && cell !== undefined && String(cell).trim() === target.endMarker)) {
      terminatorRelIndex = i;
      break;
    }
  }

  if (terminatorRelIndex === -1) {
    throw new Error(
      `Option table "${target.rangeName}" on sheet "${target.sheetName}" is missing endMarker "${target.endMarker}".`
    );
  }

  if (terminatorRelIndex <= 1) {
    return {
      cleared: false,
      blankRowIndex: startRow + 1,
      absTerminatorRowIndex: startRow + terminatorRelIndex,
    };
  }

  const requests: sheets_v4.Schema$Request[] = [
    {
      updateCells: {
        range: {
          sheetId: resolved.sheetId,
          startRowIndex: startRow + 1,
          endRowIndex: startRow + 2,
          startColumnIndex: startCol,
          endColumnIndex: startCol + width,
        },
        rows: [{ values: Array.from({ length: width }, () => ({})) }],
        fields: 'userEnteredValue,userEnteredFormat',
      },
    },
  ];

  if (terminatorRelIndex > 2) {
    requests.push({
      deleteRange: {
        range: {
          sheetId: resolved.sheetId,
          startRowIndex: startRow + 2,
          endRowIndex: startRow + terminatorRelIndex,
          startColumnIndex: startCol,
          endColumnIndex: startCol + width,
        },
        shiftDimension: 'ROWS',
      },
    });
  }

  if (target.validationRangeName) {
    const valResolved = findNamedRangeInSpreadsheet(
      spreadsheet,
      target.validationRangeName,
      target.sheetName
    );
    requests.push({
      updateNamedRange: {
        namedRange: {
          ...(typeof valResolved.namedRange.namedRangeId === 'string'
            ? { namedRangeId: valResolved.namedRange.namedRangeId }
            : {}),
          ...(typeof valResolved.namedRange.name === 'string'
            ? { name: valResolved.namedRange.name }
            : {}),
          range: {
            ...valResolved.gridRange,
            sheetId: valResolved.sheetId,
            startRowIndex: startRow + 1,
            endRowIndex: startRow + 2,
          },
        },
        fields: 'range',
      },
    });
  }

  await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: target.spreadsheetId,
        requestBody: { requests },
      }),
    retryOptions
  );

  return {
    cleared: true,
    blankRowIndex: startRow + 1,
    absTerminatorRowIndex: startRow + 2,
  };
}

/**
 * Reads `formattedValue`, `userEnteredFormat`, header `note`s, and sheet `merges` for an option table.
 */
export async function readOptionTableGridFormats(
  sheetsApi: sheets_v4.Sheets,
  target: {
    spreadsheetId: string;
    sheetName: string;
    rangeName: string;
    endMarker: string;
  },
  retryOptions?: LiveSheetsRetryOptions
): Promise<OptionTableGridFormatsInfo> {
  const metaResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId: target.spreadsheetId,
        fields: 'sheets(properties(sheetId,title),merges),namedRanges',
      }),
    retryOptions
  );
  const resolved = findNamedRangeInSpreadsheet(
    { ...metaResponse.data, spreadsheetId: target.spreadsheetId },
    target.rangeName,
    target.sheetName
  );
  const metaSheet = (metaResponse.data.sheets ?? []).find(
    (s) =>
      s.properties?.sheetId === resolved.sheetId ||
      s.properties?.title?.toLowerCase() === resolved.sheetTitle.toLowerCase()
  );
  const sheetMerges = metaSheet?.merges ?? [];

  const gridResponse = await withSheetsRetry(
    () =>
      sheetsApi.spreadsheets.get({
        spreadsheetId: target.spreadsheetId,
        ranges: [resolved.a1Range],
        includeGridData: true,
        fields:
          'sheets(properties(sheetId,title),data(startRow,startColumn,rowData(values(formattedValue,userEnteredFormat,note))))',
      }),
    retryOptions
  );

  const sheet = (gridResponse.data.sheets ?? []).find(
    (s) =>
      s.properties?.sheetId === resolved.sheetId ||
      s.properties?.title?.toLowerCase() === resolved.sheetTitle.toLowerCase()
  );
  const gridData = sheet?.data?.[0];
  const baseRow = gridData?.startRow ?? resolved.gridRange.startRowIndex ?? 0;
  const baseCol = gridData?.startColumn ?? resolved.gridRange.startColumnIndex ?? 0;
  const startRow = resolved.gridRange.startRowIndex ?? baseRow;
  const startCol = resolved.gridRange.startColumnIndex ?? baseCol;
  const rowData = gridData?.rowData ?? [];
  const headerCells = rowData[startRow - baseRow]?.values ?? [];
  const width =
    resolved.gridRange.endColumnIndex !== undefined && resolved.gridRange.endColumnIndex !== null
      ? Math.max(resolved.gridRange.endColumnIndex - startCol, 1)
      : Math.max(headerCells.length - (startCol - baseCol), 1);
  const relColStart = startCol - baseCol;

  const readRow = (absRow: number): OptionTableGridCellInfo[] => {
    const relRow = absRow - baseRow;
    const rawCells = relRow >= 0 && relRow < rowData.length ? (rowData[relRow]?.values ?? []) : [];
    return Array.from({ length: width }, (_, offset) => {
      const cell = rawCells[relColStart + offset];
      return {
        formattedValue: cell?.formattedValue ?? '',
        ...(cell?.userEnteredFormat !== undefined && cell.userEnteredFormat !== null
          ? { userEnteredFormat: structuredClone(cell.userEnteredFormat) }
          : {}),
      };
    });
  };

  const headerRow = readRow(startRow).map((c) => c.formattedValue.trim());
  const headerNotes = Array.from(
    { length: width },
    (_, offset) => headerCells[relColStart + offset]?.note ?? ''
  );
  const maxRow =
    resolved.gridRange.endRowIndex !== undefined && resolved.gridRange.endRowIndex !== null
      ? resolved.gridRange.endRowIndex
      : baseRow + rowData.length;

  const dataRows: OptionTableGridRowInfo[] = [];
  for (let absRow = startRow + 1; absRow < maxRow; absRow++) {
    const cells = readRow(absRow);
    if (cells.some((c) => c.formattedValue.trim() === target.endMarker)) {
      break;
    }
    dataRows.push({ absRowIndex: absRow, cells });
  }

  return { headerRow, headerNotes, dataRows, sheetMerges };
}

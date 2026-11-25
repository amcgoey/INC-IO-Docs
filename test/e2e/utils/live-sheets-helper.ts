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

export const DEFAULT_LIVE_RETRY_OPTIONS = {
  maxRetries: 5,
  initialDelayMs: 2000,
  backoffFactor: 2,
};

export const SHEET_ERROR_TOKENS = ['#REF!', '#ERROR!', '#N/A', '#VALUE!'] as const;

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

export interface LiveSheetsRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
}

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

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  return (
    err.statusCode === 429 ||
    err.status === 429 ||
    err.response?.status === 429 ||
    err.code === 429 ||
    err.code === '429'
  );
}

async function withSheetsRetry<T>(
  operation: () => Promise<T>,
  retryOptions: LiveSheetsRetryOptions = DEFAULT_LIVE_RETRY_OPTIONS
): Promise<T> {
  const maxRetries = retryOptions.maxRetries ?? DEFAULT_LIVE_RETRY_OPTIONS.maxRetries;
  const initialDelayMs = retryOptions.initialDelayMs ?? DEFAULT_LIVE_RETRY_OPTIONS.initialDelayMs;
  const backoffFactor = retryOptions.backoffFactor ?? DEFAULT_LIVE_RETRY_OPTIONS.backoffFactor;

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (isRateLimitError(error) && attempt < maxRetries) {
        const delayMs = initialDelayMs * Math.pow(backoffFactor, attempt);
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
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

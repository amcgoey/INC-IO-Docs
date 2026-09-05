import { google, type sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type {
  CellValue,
  FindRowsRequest,
  GoogleSheetsClientOptions,
  InsertGroupedRowRequest,
  NamedRangeTarget,
  ReadNamedRangeRequest,
  RowRecord,
  SheetsClient,
  SheetsConfigProvider,
  SheetsRetryOptions,
  SheetTargetConfig,
  WriteNamedRangeRequest,
} from './types';
import {
  GoogleSheetsApiError,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
} from './errors';

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

export function formatScopedRange(sheetName: string, rangeName: string): string {
  const unquoted = sheetName.replace(/^'|'$/g, '');
  const escaped = unquoted.replace(/'/g, "''");
  return `'${escaped}'!${rangeName}`;
}

export function cellValueToCellData(value: CellValue): sheets_v4.Schema$CellData {
  if (value === null || value === undefined) {
    return {};
  }
  if (typeof value === 'boolean') {
    return { userEnteredValue: { boolValue: value } };
  }
  if (typeof value === 'number') {
    return { userEnteredValue: { numberValue: value } };
  }
  if (typeof value === 'string') {
    if (value.startsWith('=')) {
      return { userEnteredValue: { formulaValue: value } };
    }
    return { userEnteredValue: { stringValue: value } };
  }
  return { userEnteredValue: { stringValue: String(value) } };
}

export function valuesToRowData(values: CellValue[][]): sheets_v4.Schema$RowData[] {
  return values.map((row) => ({
    values: row.map(cellValueToCellData),
  }));
}

export function isCellEmpty(value: CellValue | undefined): boolean {
  return value === null || value === undefined || value === '';
}

export function compareCellValues(a: CellValue | undefined, b: CellValue | undefined): number {
  const aEmpty = isCellEmpty(a);
  const bEmpty = isCellEmpty(b);

  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return -1;
  if (bEmpty) return 1;

  const typeA = typeof a;
  const typeB = typeof b;

  if (typeA === 'number' && typeB === 'number') {
    if ((a as number) < (b as number)) return -1;
    if ((a as number) > (b as number)) return 1;
    return 0;
  }

  if (typeA === 'number' && typeB !== 'number') {
    return 1;
  }
  if (typeA !== 'number' && typeB === 'number') {
    return -1;
  }

  const strA = String(a).toLowerCase();
  const strB = String(b).toLowerCase();
  if (strA < strB) return -1;
  if (strA > strB) return 1;
  return 0;
}

export function mapRowRecordToRow(
  rowData: RowRecord,
  headerRow: CellValue[],
  totalColumns: number
): CellValue[] {
  const result: CellValue[] = [];
  for (let c = 0; c < totalColumns; c++) {
    const headerName =
      c < headerRow.length && headerRow[c] !== null && headerRow[c] !== undefined
        ? String(headerRow[c])
        : '';
    if (headerName && Object.prototype.hasOwnProperty.call(rowData, headerName)) {
      const val = rowData[headerName];
      result.push(val !== undefined ? val : null);
    } else {
      result.push(null);
    }
  }
  return result;
}

export interface GroupedColumnTarget {
  columnIndex: number;
  value: CellValue;
}

interface SheetGroup {
  groupValue: CellValue;
  startIndex: number;
  endIndex: number;
  rowIndices: number[];
}

export function extractSheetGroups(
  dataValues: CellValue[][],
  groupColIndex: number
): SheetGroup[] {
  const groups: SheetGroup[] = [];
  if (!dataValues || dataValues.length === 0) {
    return groups;
  }

  for (let i = 0; i < dataValues.length; i++) {
    const row = dataValues[i];
    const groupVal = row ? row[groupColIndex] : null;

    if (isCellEmpty(groupVal)) {
      continue;
    }

    const existingGroup = groups.find(
      (g) => compareCellValues(g.groupValue, groupVal) === 0
    );

    if (existingGroup) {
      existingGroup.endIndex = i;
      existingGroup.rowIndices.push(i);
    } else {
      groups.push({
        groupValue: groupVal,
        startIndex: i,
        endIndex: i,
        rowIndices: [i],
      });
    }
  }

  return groups;
}

interface SheetInsertionContext {
  sheetId: number;
  dataStartRowIndex: number;
  rowDataCells: sheets_v4.Schema$RowData[];
  startColumnIndex: number;
  endColumnIndex: number;
}

function makeInsertRowRequest(
  sheetId: number,
  startIndex: number,
  count: number
): sheets_v4.Schema$Request {
  return {
    insertDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex,
        endIndex: startIndex + count,
      },
      inheritFromBefore: startIndex > 0,
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

function makeUpdateCellsRequest(
  ctx: SheetInsertionContext,
  rowIndex: number
): sheets_v4.Schema$Request {
  return {
    updateCells: {
      range: {
        sheetId: ctx.sheetId,
        startRowIndex: rowIndex,
        endRowIndex: rowIndex + 1,
        startColumnIndex: ctx.startColumnIndex,
        endColumnIndex: ctx.endColumnIndex,
      },
      rows: ctx.rowDataCells,
      fields: 'userEnteredValue',
    },
  };
}

function buildNewGroupInsertionRequests(params: {
  ctx: SheetInsertionContext;
  dataValues: CellValue[][];
  groups: SheetGroup[];
  groupTarget: GroupedColumnTarget;
}): sheets_v4.Schema$Request[] {
  const { ctx, dataValues, groups, groupTarget } = params;
  const { sheetId, dataStartRowIndex } = ctx;

  let nextGroup: SheetGroup | undefined;
  let prevGroup: SheetGroup | undefined;

  const nextGroupIdx = groups.findIndex(
    (g) => compareCellValues(groupTarget.value, g.groupValue) > 0
  );

  if (nextGroupIdx !== -1) {
    nextGroup = groups[nextGroupIdx];
    if (nextGroupIdx > 0) {
      prevGroup = groups[nextGroupIdx - 1];
    }
  } else if (groups.length > 0) {
    prevGroup = groups[groups.length - 1];
  }

  if (!prevGroup && !nextGroup) {
    const absInsertIndex = dataStartRowIndex;
    return [
      makeInsertRowRequest(sheetId, absInsertIndex, 1),
      makeUpdateCellsRequest(ctx, absInsertIndex),
    ];
  }

  const requests: sheets_v4.Schema$Request[] = [];

  if (prevGroup && nextGroup) {
    const currentBlankCount = nextGroup.startIndex - prevGroup.endIndex - 1;
    const blankStartRel = prevGroup.endIndex + 1;

    if (currentBlankCount === 0) {
      const absIndex = dataStartRowIndex + nextGroup.startIndex;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 3));
      requests.push(makeUpdateCellsRequest(ctx, absIndex + 1));
    } else if (currentBlankCount === 1) {
      const absIndex = dataStartRowIndex + nextGroup.startIndex;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 2));
      requests.push(makeUpdateCellsRequest(ctx, absIndex));
    } else if (currentBlankCount === 2) {
      const absIndex = dataStartRowIndex + blankStartRel + 1;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
      requests.push(makeUpdateCellsRequest(ctx, absIndex));
    } else {
      const excess = currentBlankCount - 2;
      const absDeleteStart = dataStartRowIndex + blankStartRel + 2;
      requests.push(makeDeleteRowsRequest(sheetId, absDeleteStart, excess));
      const absIndex = dataStartRowIndex + blankStartRel + 1;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
      requests.push(makeUpdateCellsRequest(ctx, absIndex));
    }
    return requests;
  }

  if (nextGroup && !prevGroup) {
    const currentBlankCount = nextGroup.startIndex;

    if (currentBlankCount === 0) {
      const absIndex = dataStartRowIndex;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 2));
      requests.push(makeUpdateCellsRequest(ctx, absIndex));
    } else if (currentBlankCount === 1) {
      const absIndex = dataStartRowIndex;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
      requests.push(makeUpdateCellsRequest(ctx, absIndex));
    } else {
      const excess = currentBlankCount - 1;
      const absDeleteStart = dataStartRowIndex + 1;
      requests.push(makeDeleteRowsRequest(sheetId, absDeleteStart, excess));
      const absIndex = dataStartRowIndex;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
      requests.push(makeUpdateCellsRequest(ctx, absIndex));
    }
    return requests;
  }

  const safePrevGroup = prevGroup as SheetGroup;
  const blankStartRel = safePrevGroup.endIndex + 1;
  const currentBlankCount = dataValues.length - blankStartRel;

  if (currentBlankCount === 0) {
    const absIndex = dataStartRowIndex + dataValues.length;
    requests.push(makeInsertRowRequest(sheetId, absIndex, 2));
    requests.push(makeUpdateCellsRequest(ctx, absIndex + 1));
  } else if (currentBlankCount === 1) {
    const absIndex = dataStartRowIndex + blankStartRel + 1;
    requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
    requests.push(makeUpdateCellsRequest(ctx, absIndex));
  } else {
    const excess = currentBlankCount - 1;
    const absDeleteStart = dataStartRowIndex + blankStartRel + 1;
    requests.push(makeDeleteRowsRequest(sheetId, absDeleteStart, excess));
    const absIndex = dataStartRowIndex + blankStartRel + 1;
    requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
    requests.push(makeUpdateCellsRequest(ctx, absIndex));
  }
  return requests;
}

function buildExistingGroupInsertionRequests(params: {
  ctx: SheetInsertionContext;
  dataValues: CellValue[][];
  groups: SheetGroup[];
  targetGroup: SheetGroup;
  sortTarget: GroupedColumnTarget;
}): sheets_v4.Schema$Request[] {
  const { ctx, dataValues, groups, targetGroup, sortTarget } = params;
  const { sheetId, dataStartRowIndex } = ctx;

  let internalInsertRelIndex = targetGroup.endIndex + 1;
  for (const rowIndex of targetGroup.rowIndices) {
    const row = dataValues[rowIndex];
    const rowSortVal = row ? row[sortTarget.columnIndex] : null;
    if (compareCellValues(sortTarget.value, rowSortVal) > 0) {
      internalInsertRelIndex = rowIndex;
      break;
    }
  }

  const targetGroupIdx = groups.indexOf(targetGroup);
  const prevGroup = targetGroupIdx > 0 ? groups[targetGroupIdx - 1] : undefined;
  const nextGroup = targetGroupIdx < groups.length - 1 ? groups[targetGroupIdx + 1] : undefined;

  const requests: sheets_v4.Schema$Request[] = [];
  let indexShift = 0;

  if (prevGroup) {
    const blankRowsAbove = targetGroup.startIndex - prevGroup.endIndex - 1;
    if (blankRowsAbove === 0) {
      const absIndex = dataStartRowIndex + targetGroup.startIndex;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
      indexShift += 1;
    } else if (blankRowsAbove > 1) {
      const excessAbove = blankRowsAbove - 1;
      const absDeleteStart = dataStartRowIndex + prevGroup.endIndex + 2;
      requests.push(makeDeleteRowsRequest(sheetId, absDeleteStart, excessAbove));
      indexShift -= excessAbove;
    }
  }

  const absDataRowIndex = dataStartRowIndex + internalInsertRelIndex + indexShift;
  requests.push(makeInsertRowRequest(sheetId, absDataRowIndex, 1));
  requests.push(makeUpdateCellsRequest(ctx, absDataRowIndex));

  if (nextGroup) {
    const blankRowsBelow = nextGroup.startIndex - targetGroup.endIndex - 1;
    const effectiveGroupEndIndex = targetGroup.endIndex + indexShift + 1;
    if (blankRowsBelow === 0) {
      const absIndex = dataStartRowIndex + effectiveGroupEndIndex + 1;
      requests.push(makeInsertRowRequest(sheetId, absIndex, 1));
    } else if (blankRowsBelow > 1) {
      const excessBelow = blankRowsBelow - 1;
      const absDeleteStart = dataStartRowIndex + effectiveGroupEndIndex + 2;
      requests.push(makeDeleteRowsRequest(sheetId, absDeleteStart, excessBelow));
    }
  }

  return requests;
}

export function buildGroupedInsertionRequests(params: {
  sheetId: number;
  dataValues: CellValue[][];
  groupTarget: GroupedColumnTarget;
  sortTarget: GroupedColumnTarget;
  dataStartRowIndex: number;
  mappedRow: CellValue[];
  startColumnIndex: number;
  endColumnIndex: number;
}): sheets_v4.Schema$Request[] {
  const {
    sheetId,
    dataValues,
    groupTarget,
    sortTarget,
    dataStartRowIndex,
    mappedRow,
    startColumnIndex,
    endColumnIndex,
  } = params;

  const groups = extractSheetGroups(dataValues, groupTarget.columnIndex);
  const targetGroup = groups.find(
    (g) => compareCellValues(g.groupValue, groupTarget.value) === 0
  );

  const ctx: SheetInsertionContext = {
    sheetId,
    dataStartRowIndex,
    rowDataCells: valuesToRowData([mappedRow]),
    startColumnIndex,
    endColumnIndex,
  };

  if (!targetGroup) {
    return buildNewGroupInsertionRequests({
      ctx,
      dataValues,
      groups,
      groupTarget,
    });
  }

  return buildExistingGroupInsertionRequests({
    ctx,
    dataValues,
    groups,
    targetGroup,
    sortTarget,
  });
}

function requireColumnIndex(
  columnIndexMap: Map<string, number>,
  columnName: string,
  roleDescription: string,
  context: { headerRangeName: string; sheetName: string }
): number {
  const index = columnIndexMap.get(columnName);
  if (index === undefined) {
    const available = Array.from(columnIndexMap.keys());
    const availableMsg = available.length > 0 ? available.join(', ') : 'none';
    throw new GoogleSheetsColumnNotFoundError(
      `Column "${columnName}" (${roleDescription}) not found in headers range "${context.headerRangeName}" on sheet "${context.sheetName}". Available headers: ${availableMsg}`
    );
  }
  return index;
}


export class GoogleSheetsClient implements SheetsClient {
  private readonly sheetsApi: sheets_v4.Sheets;
  private readonly retryOptions: SheetsRetryOptions;
  private readonly configProvider?: SheetsConfigProvider | undefined;

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
      namedRange: resolvedRange,
      gridRange: {
        ...resolvedRange.range,
        sheetId: targetSheetId,
      },
    };
  }

  private async resolveNamedRange(target: NamedRangeTarget): Promise<{
    sheetId: number;
    namedRange: sheets_v4.Schema$NamedRange;
    gridRange: sheets_v4.Schema$GridRange;
  }> {
    const spreadsheet = await this.getSpreadsheetMetadata(target.spreadsheetId);
    return this.findNamedRange(spreadsheet, target);
  }

  private async resolveTargetNamedRanges(target: SheetTargetConfig): Promise<{
    sheetId: number;
    headerRange: { namedRange: sheets_v4.Schema$NamedRange; gridRange: sheets_v4.Schema$GridRange };
    dataRange: { namedRange: sheets_v4.Schema$NamedRange; gridRange: sheets_v4.Schema$GridRange };
  }> {
    const spreadsheet = await this.getSpreadsheetMetadata(target.spreadsheetId);

    const headerRange = this.findNamedRange(spreadsheet, {
      spreadsheetId: target.spreadsheetId,
      sheetName: target.sheetName,
      rangeName: target.headerRangeName,
    });

    const dataRange = this.findNamedRange(spreadsheet, {
      spreadsheetId: target.spreadsheetId,
      sheetName: target.sheetName,
      rangeName: target.dataRangeName,
    });

    const headerSheetId = headerRange.gridRange.sheetId ?? headerRange.sheetId;
    const dataSheetId = dataRange.gridRange.sheetId ?? dataRange.sheetId;

    if (headerSheetId !== dataSheetId) {
      throw new GoogleSheetsApiError(
        `Headers range "${target.headerRangeName}" (sheetId ${headerSheetId}) and Data range "${target.dataRangeName}" (sheetId ${dataSheetId}) must belong to the same sheet "${target.sheetName}".`
      );
    }

    return {
      sheetId: dataSheetId,
      headerRange,
      dataRange,
    };
  }

  private async readUnformattedValues(
    spreadsheetId: string,
    sheetName: string,
    rangeName: string
  ): Promise<CellValue[][]> {
    const scopedRange = formatScopedRange(sheetName, rangeName);
    const response = await this.executeWithRetry(() =>
      this.sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: scopedRange,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
    );

    return (response.data.values as CellValue[][]) ?? [];
  }

  private async readHeaderRowAndIndexMap(target: SheetTargetConfig): Promise<{
    headerRow: CellValue[];
    columnIndexMap: Map<string, number>;
  }> {
    const headerValues = await this.readUnformattedValues(
      target.spreadsheetId,
      target.sheetName,
      target.headerRangeName
    );
    const headerRow = headerValues[0] ?? [];

    const columnIndexMap = new Map<string, number>();
    headerRow.forEach((header, index) => {
      if (header !== null && header !== undefined) {
        const colName = String(header);
        if (colName && !columnIndexMap.has(colName)) {
          columnIndexMap.set(colName, index);
        }
      }
    });

    return { headerRow, columnIndexMap };
  }

  async readNamedRange(request: ReadNamedRangeRequest): Promise<CellValue[][]> {
    await this.resolveNamedRange(request);
    return this.readUnformattedValues(request.spreadsheetId, request.sheetName, request.rangeName);
  }

  async writeNamedRange(request: WriteNamedRangeRequest): Promise<void> {
    const { sheetId, gridRange } = await this.resolveNamedRange(request);

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
      const scopedRange = formatScopedRange(request.sheetName, request.rangeName);
      await this.executeWithRetry(() =>
        this.sheetsApi.spreadsheets.values.update({
          spreadsheetId: request.spreadsheetId,
          range: scopedRange,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: request.values,
          },
        })
      );
    }
  }

  async insertIntoGroupedList(request: InsertGroupedRowRequest): Promise<void> {
    const { sheetId, headerRange, dataRange } = await this.resolveTargetNamedRanges(request.target);

    const { headerRow, columnIndexMap } = await this.readHeaderRowAndIndexMap(request.target);

    const groupColIndex = requireColumnIndex(
      columnIndexMap,
      request.groupConfig.columnName,
      'groupConfig',
      request.target
    );

    const sortColIndex = requireColumnIndex(
      columnIndexMap,
      request.sortConfig.columnName,
      'sortConfig',
      request.target
    );

    const dataValues = await this.readUnformattedValues(
      request.target.spreadsheetId,
      request.target.sheetName,
      request.target.dataRangeName
    );

    const mappedRow = mapRowRecordToRow(request.rowData, headerRow, headerRow.length);

    const startColumnIndex = headerRange.gridRange.startColumnIndex ?? 0;
    const endColumnIndex = startColumnIndex + mappedRow.length;
    const dataStartRowIndex = dataRange.gridRange.startRowIndex ?? 0;

    const requests = buildGroupedInsertionRequests({
      sheetId,
      dataValues,
      groupTarget: { columnIndex: groupColIndex, value: request.groupConfig.value },
      sortTarget: { columnIndex: sortColIndex, value: request.sortConfig.value },
      dataStartRowIndex,
      mappedRow,
      startColumnIndex,
      endColumnIndex,
    });

    const batchUpdateRequest: sheets_v4.Schema$BatchUpdateSpreadsheetRequest = {
      requests,
    };

    await this.executeWithRetry(() =>
      this.sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: request.target.spreadsheetId,
        requestBody: batchUpdateRequest,
      })
    );
  }

  async findRowsByValue(request: FindRowsRequest): Promise<RowRecord[]> {
    await this.resolveTargetNamedRanges(request.target);

    const { columnIndexMap } = await this.readHeaderRowAndIndexMap(request.target);

    const targetIndex = columnIndexMap.get(request.columnName);

    if (targetIndex === undefined) {
      const available = Array.from(columnIndexMap.keys());
      const availableMsg = available.length > 0 ? available.join(', ') : 'none';
      throw new GoogleSheetsColumnNotFoundError(
        `Column "${request.columnName}" not found in headers range "${request.target.headerRangeName}" on sheet "${request.target.sheetName}". Available headers: ${availableMsg}`
      );
    }

    const dataValues = await this.readUnformattedValues(
      request.target.spreadsheetId,
      request.target.sheetName,
      request.target.dataRangeName
    );

    const matchingRecords: RowRecord[] = [];

    for (const row of dataValues) {
      const cellValue = row[targetIndex] !== undefined ? row[targetIndex] : null;

      if (cellValue === request.value) {
        const record: RowRecord = {};
        for (const [colName, idx] of columnIndexMap.entries()) {
          const val = row[idx];
          record[colName] = val !== undefined ? val : null;
        }
        matchingRecords.push(record);
      }
    }

    return matchingRecords;
  }
}

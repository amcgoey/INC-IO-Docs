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

export function calculateGroupedInsertionIndex(
  dataValues: CellValue[][],
  groupTarget: GroupedColumnTarget,
  sortTarget: GroupedColumnTarget
): number {
  if (!dataValues || dataValues.length === 0) {
    return 0;
  }

  const groups: SheetGroup[] = [];

  for (let i = 0; i < dataValues.length; i++) {
    const row = dataValues[i];
    const groupVal = row ? row[groupTarget.columnIndex] : null;

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

  if (groups.length === 0) {
    return 0;
  }

  const targetGroup = groups.find(
    (g) => compareCellValues(g.groupValue, groupTarget.value) === 0
  );

  if (targetGroup) {
    for (const rowIndex of targetGroup.rowIndices) {
      const row = dataValues[rowIndex];
      const rowSortVal = row ? row[sortTarget.columnIndex] : null;
      if (compareCellValues(sortTarget.value, rowSortVal) > 0) {
        return rowIndex;
      }
    }
    return targetGroup.endIndex + 1;
  }

  for (const existingGroup of groups) {
    if (compareCellValues(groupTarget.value, existingGroup.groupValue) > 0) {
      return existingGroup.startIndex;
    }
  }

  return groups[groups.length - 1].endIndex + 1;
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
    const matchedNamedRange =
      namedRanges.find((namedRange) => {
        const name = (namedRange.name ?? '').toLowerCase();
        const sheetId = namedRange.range?.sheetId;
        const nameMatches = name === targetRangeLower || name === scopedRangeNameLower;
        return nameMatches && sheetId === targetSheetId;
      }) ??
      namedRanges.find((namedRange) => {
        const name = (namedRange.name ?? '').toLowerCase();
        const sheetId = namedRange.range?.sheetId;
        const nameMatches = name === targetRangeLower || name === scopedRangeNameLower;
        return nameMatches && (sheetId === undefined || sheetId === null);
      });

    if (!matchedNamedRange || !matchedNamedRange.range) {
      throw new GoogleSheetsNamedRangeNotFoundError(
        `Named range "${target.rangeName}" not found on sheet "${target.sheetName}" in spreadsheet "${target.spreadsheetId}".`
      );
    }

    return {
      sheetId: targetSheetId,
      namedRange: matchedNamedRange,
      gridRange: {
        ...matchedNamedRange.range,
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

    const headerValues = await this.readUnformattedValues(
      request.target.spreadsheetId,
      request.target.sheetName,
      request.target.headerRangeName
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

    const relativeInsertionIndex = calculateGroupedInsertionIndex(
      dataValues,
      { columnIndex: groupColIndex, value: request.groupConfig.value },
      { columnIndex: sortColIndex, value: request.sortConfig.value }
    );

    const dataStartRowIndex = dataRange.gridRange.startRowIndex ?? 0;
    const absoluteRowIndex = dataStartRowIndex + relativeInsertionIndex;

    const mappedRow = mapRowRecordToRow(request.rowData, headerRow, headerRow.length);

    const startColumnIndex = headerRange.gridRange.startColumnIndex ?? 0;
    const endColumnIndex = startColumnIndex + mappedRow.length;

    const batchUpdateRequest: sheets_v4.Schema$BatchUpdateSpreadsheetRequest = {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: absoluteRowIndex,
              endIndex: absoluteRowIndex + 1,
            },
            inheritFromBefore: absoluteRowIndex > 0,
          },
        },
        {
          updateCells: {
            range: {
              sheetId,
              startRowIndex: absoluteRowIndex,
              endRowIndex: absoluteRowIndex + 1,
              startColumnIndex,
              endColumnIndex,
            },
            rows: valuesToRowData([mappedRow]),
            fields: 'userEnteredValue',
          },
        },
      ],
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

    const headerValues = await this.readUnformattedValues(
      request.target.spreadsheetId,
      request.target.sheetName,
      request.target.headerRangeName
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

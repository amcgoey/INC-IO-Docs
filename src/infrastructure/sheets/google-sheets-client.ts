import { google, type sheets_v4 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type {
  CellValue,
  FindRowsRequest,
  GoogleSheetsClientOptions,
  InsertGroupedRowRequest,
  ReadNamedRangeRequest,
  RowRecord,
  SheetsClient,
  SheetsConfigProvider,
  SheetsRetryOptions,
  WriteNamedRangeRequest,
} from './types';
import {
  GoogleSheetsApiError,
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

  private async resolveNamedRange(
    spreadsheetId: string,
    sheetName: string,
    rangeName: string
  ): Promise<{
    sheetId: number;
    namedRange: sheets_v4.Schema$NamedRange;
    gridRange: sheets_v4.Schema$GridRange;
  }> {
    const spreadsheet = await this.executeWithRetry(async () => {
      const response = await this.sheetsApi.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets(properties(sheetId,title)),namedRanges',
      });
      return response.data;
    });

    const targetSheet = (spreadsheet.sheets ?? []).find(
      (s) => s.properties?.title?.toLowerCase() === sheetName.toLowerCase()
    );

    if (!targetSheet || targetSheet.properties?.sheetId === undefined || targetSheet.properties.sheetId === null) {
      throw new GoogleSheetsApiError(
        `Sheet "${sheetName}" not found in spreadsheet "${spreadsheetId}".`
      );
    }

    const targetSheetId = targetSheet.properties.sheetId;

    const matchedNamedRange = (spreadsheet.namedRanges ?? []).find((nr) => {
      const name = nr.name ?? '';
      const sheetMatches = nr.range?.sheetId === targetSheetId;

      if (name.toLowerCase() === rangeName.toLowerCase() && sheetMatches) {
        return true;
      }
      if (name.toLowerCase() === `${sheetName}!${rangeName}`.toLowerCase()) {
        return true;
      }
      if (name.toLowerCase() === rangeName.toLowerCase() && (nr.range?.sheetId === undefined || nr.range?.sheetId === null)) {
        return true;
      }
      return false;
    });

    if (!matchedNamedRange || !matchedNamedRange.range) {
      throw new GoogleSheetsNamedRangeNotFoundError(
        `Named range "${rangeName}" not found on sheet "${sheetName}" in spreadsheet "${spreadsheetId}".`
      );
    }

    return {
      sheetId: targetSheetId,
      namedRange: matchedNamedRange,
      gridRange: matchedNamedRange.range,
    };
  }

  async readNamedRange(request: ReadNamedRangeRequest): Promise<CellValue[][]> {
    await this.resolveNamedRange(
      request.spreadsheetId,
      request.sheetName,
      request.rangeName
    );

    const scopedRange = formatScopedRange(request.sheetName, request.rangeName);
    const response = await this.executeWithRetry(() =>
      this.sheetsApi.spreadsheets.values.get({
        spreadsheetId: request.spreadsheetId,
        range: scopedRange,
        valueRenderOption: 'UNFORMATTED_VALUE',
      })
    );

    return (response.data.values as CellValue[][]) ?? [];
  }

  async writeNamedRange(request: WriteNamedRangeRequest): Promise<void> {
    const { sheetId, gridRange } = await this.resolveNamedRange(
      request.spreadsheetId,
      request.sheetName,
      request.rangeName
    );

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
    void request;
    throw new Error('Method insertIntoGroupedList not yet implemented. Blocked by Issue #99.');
  }

  async findRowsByValue(request: FindRowsRequest): Promise<RowRecord[]> {
    void request;
    throw new Error('Method findRowsByValue not yet implemented. Blocked by Issue #98.');
  }
}

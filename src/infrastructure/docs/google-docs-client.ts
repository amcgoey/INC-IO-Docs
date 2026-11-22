import { google, type docs_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Value } from '@sinclair/typebox/value';
import {
  GoogleDocsDocumentSchema,
  type DocsOperationOptions,
  type DocsRetryOptions,
  type GoogleDocsClientOptions,
  type GoogleDocsDocument,
  type GoogleDocsDocumentTab,
  type GoogleDocsFormExtractResult,
  type GoogleDocsFormFieldValue,
  type GoogleDocsStructuralElement,
  type GoogleDocsTab,
} from './types';
import {
  GoogleDocsApiError,
  GoogleDocsCorruptedError,
  GoogleDocsNotFoundError,
} from './errors';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function extractHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  if (typeof err.code === 'number') return err.code;
  if (typeof err.code === 'string' && err.code.trim() !== '' && !Number.isNaN(Number(err.code))) {
    return Number(err.code);
  }
  return undefined;
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

function isRateLimitOrQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = extractHttpStatusCode(error);
  if (status === 429) return true;

  const err = error as Record<string, unknown>;
  if (err.code === '429' || err.code === 429) return true;

  if (status === 403 || err.code === '403' || err.code === 403) {
    try {
      const errorStr = JSON.stringify(error);
      const quotaReasons = ['userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded'];
      if (quotaReasons.some((reason) => errorStr.includes(reason))) {
        return true;
      }
    } catch {
      // Non-serializable object
    }
    const message = formatErrorMessage(error).toLowerCase();
    if (
      message.includes('rate limit') ||
      message.includes('ratelimit') ||
      message.includes('quota exceeded') ||
      message.includes('user rate limit')
    ) {
      return true;
    }
  }

  return false;
}
const PURE_HANDLEBARS_PLACEHOLDER_REGEX = /^(?:\{\{[^{}]*\}\}[\s\-_./]*)+$/;
const DIVIDER_PUNCTUATION_REGEX = /^[–—-]+$/;

type GoogleDocsTable = NonNullable<GoogleDocsStructuralElement['table']>;
type GoogleDocsTableRow = NonNullable<GoogleDocsTable['tableRows']>[number];
type GoogleDocsTableCell = NonNullable<GoogleDocsTableRow['tableCells']>[number];

export function normalizeFormLabelKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '').trim();
}

function isPlausibleFieldLabel(key: string): boolean {
  return (
    key.length >= 1 &&
    key.length <= 40 &&
    !PURE_HANDLEBARS_PLACEHOLDER_REGEX.test(key) &&
    !DIVIDER_PUNCTUATION_REGEX.test(key)
  );
}

function extractStaticLabel(cell: GoogleDocsTableCell): string | undefined {
  const lines: string[] = [];
  for (const contentEl of cell.content ?? []) {
    if (!contentEl.paragraph) {
      return undefined;
    }
    let rawParaText = '';
    for (const pe of contentEl.paragraph.elements ?? []) {
      if (pe.dropdown || pe.dateElement || pe.person) {
        return undefined;
      }
      if (pe.textRun?.content) {
        if (pe.textRun.content.includes('\ue907')) {
          return undefined;
        }
        rawParaText += pe.textRun.content;
      }
    }
    const strippedPara = rawParaText.replace(/\n$/, '');
    if (/[\r\n]/.test(strippedPara)) {
      return undefined;
    }
    lines.push(strippedPara);
  }

  if (lines.length !== 1) {
    return undefined;
  }

  const normalized = normalizeFormLabelKey(lines[0]!);
  return isPlausibleFieldLabel(normalized) ? normalized : undefined;
}

function serializeCellText(cell: GoogleDocsTableCell): string | undefined {
  const lines: string[] = [];

  for (const contentEl of cell.content ?? []) {
    if (!contentEl.paragraph) continue;
    let paraStr = '';
    for (const pe of contentEl.paragraph.elements ?? []) {
      if (pe.textRun?.content) {
        paraStr += pe.textRun.content.replace(/\ue907/g, '').replace(/\n$/, '');
      }
    }
    lines.push(paraStr);
  }

  const joined = lines.join('\n').trim();
  if (!joined || PURE_HANDLEBARS_PLACEHOLDER_REGEX.test(joined)) {
    return undefined;
  }
  return joined;
}

function isUnmergedCell(cell: GoogleDocsTableCell | undefined): cell is GoogleDocsTableCell {
  if (!cell) return false;
  return (cell.tableCellStyle?.columnSpan ?? 1) === 1 && (cell.tableCellStyle?.rowSpan ?? 1) === 1;
}

function validateGoogleDocsDocument(input: unknown): GoogleDocsDocument {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoogleDocsCorruptedError('Google Docs payload must be a non-null object');
  }

  if (!Value.Check(GoogleDocsDocumentSchema, input)) {
    const errors = [...Value.Errors(GoogleDocsDocumentSchema, input)]
      .slice(0, 3)
      .map((err) => `${err.path || '/'}: ${err.message}`)
      .join('; ');
    throw new GoogleDocsCorruptedError(
      `Invalid Google Docs document structure${errors ? `: ${errors}` : ''}`
    );
  }

  const hasTabs = Array.isArray(input.tabs);
  const hasBody = input.body !== undefined && input.body !== null;
  if (!hasTabs && !hasBody) {
    throw new GoogleDocsCorruptedError('Google Docs document is missing both tabs and body');
  }

  return input;
}

function collectDocumentTabs(tabs: GoogleDocsTab[] | null | undefined): GoogleDocsDocumentTab[] {
  const out: GoogleDocsDocumentTab[] = [];
  for (const tab of tabs ?? []) {
    if (tab.documentTab) {
      out.push(tab.documentTab);
    }
    if (tab.childTabs) {
      out.push(...collectDocumentTabs(tab.childTabs));
    }
  }
  return out;
}

export class GoogleDocsClient {
  private readonly defaultDocs: docs_v1.Docs;
  private readonly defaultRequestTimeoutMs: number;
  private readonly retryOptions: DocsRetryOptions;

  constructor(options: GoogleDocsClientOptions = {}) {
    this.retryOptions = options.retryOptions ?? {};
    this.defaultRequestTimeoutMs =
      options.requestTimeoutMs ?? options.retryOptions?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (options.docs) {
      this.defaultDocs = options.docs;
    } else if (typeof options.auth === 'string') {
      this.defaultDocs = this.createDocsClientFromToken(options.auth);
    } else if (options.auth) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.defaultDocs = google.docs({ version: 'v1', auth: options.auth as any });
    } else {
      this.defaultDocs = google.docs({ version: 'v1' });
    }
  }

  private createDocsClientFromToken(oauthCred: string): docs_v1.Docs {
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: oauthCred });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return google.docs({ version: 'v1', auth: oauth2Client as any });
  }

  extractFormData(document: unknown): GoogleDocsFormExtractResult {
    try {
      return this.extractFormDataValidated(document);
    } catch (error) {
      if (error instanceof GoogleDocsCorruptedError) {
        throw error;
      }
      if (error instanceof TypeError || error instanceof RangeError) {
        throw new GoogleDocsCorruptedError(
          `Malformed Google Docs document structure: ${error.message}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  private extractFormDataValidated(document: unknown): GoogleDocsFormExtractResult {
    const validDoc = validateGoogleDocsDocument(document);
    const docTabs: GoogleDocsDocumentTab[] =
      validDoc.tabs && validDoc.tabs.length > 0
        ? collectDocumentTabs(validDoc.tabs)
        : validDoc.body
          ? [{ body: validDoc.body }]
          : [];

    const fieldMap = new Map<string, GoogleDocsFormFieldValue>();
    const ambiguousSet = new Set<string>();
    let widgetCount = 0;

    for (const tab of docTabs) {
      for (const el of tab.body?.content ?? []) {
        if (!el.table) continue;
        const rows = el.table.tableRows ?? [];
        const rowCount = rows.length;
        const colCount = el.table.columns ?? rows[0]?.tableCells?.length ?? 0;

        // Pattern 4: N x 2 Key/Value Form Tables (e.g. 1x2 "Submittal No.")
        if (colCount === 2 && rowCount >= 1) {
          const parsedRows: Array<{ label: string; valueCell: GoogleDocsTableCell }> = [];
          let validKvTable = true;
          for (const row of rows) {
            const cells = row.tableCells ?? [];
            const col0 = cells[0];
            const col1 = cells[1];
            if (cells.length !== 2 || !isUnmergedCell(col0) || !isUnmergedCell(col1)) {
              validKvTable = false;
              break;
            }
            const label = extractStaticLabel(col0);
            if (label === undefined) {
              validKvTable = false;
              break;
            }
            parsedRows.push({ label, valueCell: col1 });
          }

          if (validKvTable) {
            for (const { label, valueCell } of parsedRows) {
              widgetCount += 1;
              const val = serializeCellText(valueCell);
              if (val !== undefined && !fieldMap.has(label) && !ambiguousSet.has(label)) {
                fieldMap.set(label, val);
              }
            }
          }
        }
      }
    }

    const fields: Record<string, GoogleDocsFormFieldValue> = {};
    for (const [key, value] of fieldMap.entries()) {
      Object.defineProperty(fields, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    return {
      widgetCount,
      fields,
      ...(ambiguousSet.size > 0 ? { ambiguousFields: [...ambiguousSet] } : {}),
    };
  }

  private getDocs(options?: DocsOperationOptions): docs_v1.Docs {
    const credential = options?.accessToken ?? options?.auth;
    if (credential) {
      if (typeof credential === 'string') {
        return this.createDocsClientFromToken(credential);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return google.docs({ version: 'v1', auth: credential as any });
    }
    return this.defaultDocs;
  }

  private wrapApiError(methodName: string, error: unknown): never {
    if (error instanceof GoogleDocsApiError || error instanceof GoogleDocsCorruptedError) {
      throw error;
    }
    const statusCode = extractHttpStatusCode(error);
    const message = `Google Docs API error in ${methodName}: ${formatErrorMessage(error)}`;

    if (statusCode === 404) {
      throw new GoogleDocsNotFoundError(message, { cause: error, statusCode: 404 });
    }

    throw new GoogleDocsApiError(message, { cause: error, statusCode });
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    const maxRetries = this.retryOptions.maxRetries ?? 3;
    const initialDelayMs = this.retryOptions.initialDelayMs ?? 1000;
    const backoffFactor = this.retryOptions.backoffFactor ?? 2;
    const sleep =
      this.retryOptions.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (isRateLimitOrQuotaError(error) && attempt < maxRetries) {
          const baseDelay = initialDelayMs * Math.pow(backoffFactor, attempt);
          const jitter = 0.75 + Math.random() * 0.5;
          const delay = Math.round(baseDelay * jitter);
          attempt++;
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }
  }

  async extractDocumentFormFields(
    documentId: string,
    options?: DocsOperationOptions
  ): Promise<GoogleDocsFormExtractResult> {
    const docs = this.getDocs(options);
    const timeout = options?.requestTimeoutMs ?? this.defaultRequestTimeoutMs;

    let response: { data: unknown };
    try {
      response = await this.executeWithRetry(() =>
        docs.documents.get(
          {
            documentId,
            includeTabsContent: true,
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          },
          { timeout }
        )
      );
    } catch (error) {
      this.wrapApiError('extractDocumentFormFields', error);
    }

    return this.extractFormData(response.data);
  }
}

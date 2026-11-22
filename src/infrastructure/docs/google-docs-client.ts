import { google, type docs_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type {
  DocsOperationOptions,
  DocsRetryOptions,
  GoogleDocsClientOptions,
  GoogleDocsFormExtractResult,
} from './types';
import {
  GoogleDocsApiError,
  GoogleDocsCorruptedError,
  GoogleDocsNotFoundError,
} from './errors';
import {
  extractHttpStatusCode,
  formatErrorMessage,
  executeWithRateLimitRetry,
} from '../google/retry';
import { extractGoogleDocsFormData } from './form-extractor';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

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
    } else if (options.auth !== undefined) {
      this.defaultDocs = this.resolveDocsClient(options.auth);
    } else {
      this.defaultDocs = google.docs({ version: 'v1' });
    }
  }

  private resolveDocsClient(credential: OAuth2Client | string): docs_v1.Docs {
    let auth: OAuth2Client;
    if (typeof credential === 'string') {
      auth = new OAuth2Client();
      auth.setCredentials({ access_token: credential });
    } else {
      auth = credential;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return google.docs({ version: 'v1', auth: auth as any });
  }

  extractFormData(document: unknown): GoogleDocsFormExtractResult {
    return extractGoogleDocsFormData(document);
  }

  private getDocs(options?: DocsOperationOptions): docs_v1.Docs {
    const credential = options?.accessToken ?? options?.auth;
    if (credential) {
      return this.resolveDocsClient(credential);
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

  private executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    return executeWithRateLimitRetry(operation, this.retryOptions);
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

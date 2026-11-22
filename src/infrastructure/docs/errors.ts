export class GoogleDocsApiError extends Error {
  readonly statusCode?: number | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GoogleDocsApiError';
    this.statusCode = options?.statusCode;
  }
}

export class GoogleDocsNotFoundError extends GoogleDocsApiError {
  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, { statusCode: 404, ...options });
    this.name = 'GoogleDocsNotFoundError';
  }
}

export class GoogleDocsCorruptedError extends Error {
  constructor(
    message = 'Google Docs document structure is malformed or corrupted',
    options?: { cause?: unknown }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GoogleDocsCorruptedError';
  }
}

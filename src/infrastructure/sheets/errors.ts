export class GoogleSheetsApiError extends Error {
  readonly statusCode?: number | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GoogleSheetsApiError';
    this.statusCode = options?.statusCode;
  }
}

export class GoogleSheetsNamedRangeNotFoundError extends GoogleSheetsApiError {
  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, options);
    this.name = 'GoogleSheetsNamedRangeNotFoundError';
  }
}

export class GoogleSheetsColumnNotFoundError extends GoogleSheetsApiError {
  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, options);
    this.name = 'GoogleSheetsColumnNotFoundError';
  }
}


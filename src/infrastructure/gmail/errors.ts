export class GoogleGmailApiError extends Error {
  readonly statusCode?: number | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GoogleGmailApiError';
    this.statusCode = options?.statusCode;
  }
}

export class GoogleGmailNotFoundError extends GoogleGmailApiError {
  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, { statusCode: 404, ...options });
    this.name = 'GoogleGmailNotFoundError';
  }
}

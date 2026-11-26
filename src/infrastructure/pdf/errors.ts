export class PdfProcessorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfProcessorError';
  }
}

export class PdfEncryptionError extends PdfProcessorError {
  constructor(message: string = 'PDF document is encrypted and password-protected', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfEncryptionError';
  }
}

export class PdfCorruptedError extends PdfProcessorError {
  constructor(message: string = 'PDF document is malformed or corrupted', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfCorruptedError';
  }
}

export class PdfOutOfBoundsError extends PdfProcessorError {
  constructor(message: string = 'Requested page number is out of bounds', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfOutOfBoundsError';
  }
}

export class PdfFileTooLargeError extends PdfProcessorError {
  readonly totalBytes: number;
  readonly maxBytes: number;

  constructor(
    message: string = 'PDF payload exceeds maximum in-memory size limit',
    options?: { totalBytes?: number | undefined; maxBytes?: number | undefined; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PdfFileTooLargeError';
    this.totalBytes = options?.totalBytes ?? 0;
    this.maxBytes = options?.maxBytes ?? 0;
  }
}

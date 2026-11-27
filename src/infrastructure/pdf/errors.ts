export class PdfProcessorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PdfProcessorError';
  }
}

export type PdfSourceRole = 'target' | 'insert';

export class PdfEncryptionError extends PdfProcessorError {
  readonly sourceRole: PdfSourceRole | undefined;

  constructor(
    message: string = 'PDF document is encrypted and password-protected',
    options?: { sourceRole?: PdfSourceRole | undefined; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PdfEncryptionError';
    this.sourceRole = options?.sourceRole;
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

export type PdfUnsupportedFormReason = 'xfa' | 'signed' | 'unsupported';

export class PdfUnsupportedFormError extends PdfProcessorError {
  readonly reason: PdfUnsupportedFormReason;
  readonly sourceRole: PdfSourceRole | undefined;

  constructor(
    message: string = 'PDF contains an unsupported interactive form or cryptographic signature',
    options?: {
      reason?: PdfUnsupportedFormReason | undefined;
      sourceRole?: PdfSourceRole | undefined;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PdfUnsupportedFormError';
    this.reason = options?.reason ?? 'unsupported';
    this.sourceRole = options?.sourceRole;
  }
}

export class PdfFormFieldError extends PdfProcessorError {
  readonly fieldName: string | undefined;

  constructor(
    message: string = 'Invalid PDF form field operation or value',
    options?: { fieldName?: string | undefined; cause?: unknown }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PdfFormFieldError';
    this.fieldName = options?.fieldName;
  }
}

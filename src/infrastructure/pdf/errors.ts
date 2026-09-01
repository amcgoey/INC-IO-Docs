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

import type {
  DriveFormMediaClientPort,
  FormExtractOutcome,
  FormExtractTarget,
  FormExtractorPort,
  FormFieldValue,
  GoogleDocsFormReaderPort,
  PdfFormExtractorPort,
} from '../ports';

export interface DriveFormExtractorDeps {
  driveMediaClient: DriveFormMediaClientPort;
  pdfProcessor: PdfFormExtractorPort;
  googleDocsFormReader?: GoogleDocsFormReaderPort | undefined;
  getMaxInMemoryFileBytes?:
    | (() => Promise<number | undefined> | number | undefined)
    | undefined;
}

export class DriveFormExtractorAdapter implements FormExtractorPort {
  private readonly outcomeCache = new Map<string, Promise<FormExtractOutcome>>();

  constructor(private readonly deps: DriveFormExtractorDeps) {}

  extractFormFields(item: FormExtractTarget): Promise<FormExtractOutcome> {
    const cacheKey = `${item.mimeType}:${item.id}`;
    const existing = this.outcomeCache.get(cacheKey);
    if (existing) {
      return existing;
    }
    const promise = this.loadFormFields(item);
    this.outcomeCache.set(cacheKey, promise);
    return promise;
  }

  private async loadFormFields(item: FormExtractTarget): Promise<FormExtractOutcome> {
    if (item.mimeType === 'application/pdf') {
      return this.extractPdfFormFields(item);
    }

    if (item.mimeType === 'application/vnd.google-apps.document') {
      return this.extractGoogleDocFormFields(item.id);
    }

    return { status: 'ok', widgetCount: 0, fields: {} };
  }

  private async extractPdfFormFields(item: FormExtractTarget): Promise<FormExtractOutcome> {
    if (item.size !== undefined && this.deps.getMaxInMemoryFileBytes) {
      const maxBytes = await this.deps.getMaxInMemoryFileBytes();
      if (maxBytes !== undefined && item.size > maxBytes) {
        return { status: 'file_too_large' };
      }
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.deps.driveMediaClient.downloadFileMedia(item.id);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.name === 'GoogleDriveFileTooLargeError' ||
          error.name === 'DriveFileTooLargeError')
      ) {
        return { status: 'file_too_large' };
      }
      return { status: 'source_error' };
    }

    let rawData: Record<string, string | boolean | string[] | undefined>;
    try {
      rawData = await this.deps.pdfProcessor.extractFormData(bytes);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'PdfEncryptionError') {
        return { status: 'encrypted' };
      }
      if (error instanceof Error && error.name === 'PdfFileTooLargeError') {
        return { status: 'file_too_large' };
      }
      return { status: 'corrupted' };
    }

    const widgetCount = Object.keys(rawData).length;
    const fields: Record<string, FormFieldValue> = {};
    for (const [key, value] of Object.entries(rawData)) {
      if (value !== undefined) {
        fields[key] = value;
      }
    }

    return {
      status: 'ok',
      widgetCount,
      fields,
    };
  }

  private async extractGoogleDocFormFields(documentId: string): Promise<FormExtractOutcome> {
    if (!this.deps.googleDocsFormReader) {
      return { status: 'ok', widgetCount: 0, fields: {} };
    }

    try {
      const result = await this.deps.googleDocsFormReader.extractDocumentFormFields(documentId);
      const normalizedAmbiguous =
        result.ambiguousFields && result.ambiguousFields.length > 0
          ? result.ambiguousFields
          : undefined;
      return {
        status: 'ok',
        widgetCount: result.widgetCount,
        fields: result.fields,
        ...(normalizedAmbiguous !== undefined ? { ambiguousFields: normalizedAmbiguous } : {}),
      };
    } catch (error: unknown) {
      if (
        (error instanceof Error && error.name === 'GoogleDocsCorruptedError') ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        return { status: 'corrupted' };
      }
      return { status: 'source_error' };
    }
  }
}

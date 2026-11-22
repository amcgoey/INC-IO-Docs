import type {
  FormExtractOutcome,
  FormExtractTarget,
  FormExtractorPort,
  FormFieldValue,
} from '../ports';

export interface DriveFormMediaClient {
  downloadFileMedia(fileId: string): Promise<Uint8Array>;
}

export interface PdfFormExtractor {
  extractFormData(
    buffer: Uint8Array
  ): Promise<Record<string, string | boolean | string[] | undefined>>;
}

export interface GoogleDocsFormReader {
  extractDocumentFormFields(documentId: string): Promise<FormExtractOutcome>;
}

export interface DriveFormExtractorDeps {
  driveMediaClient: DriveFormMediaClient;
  pdfProcessor: PdfFormExtractor;
  googleDocsFormReader?: GoogleDocsFormReader | undefined;
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
      return this.extractPdfFormFields(item.id);
    }

    if (item.mimeType === 'application/vnd.google-apps.document') {
      return this.extractGoogleDocFormFields(item.id);
    }

    return { status: 'ok', widgetCount: 0, fields: {} };
  }

  private async extractPdfFormFields(fileId: string): Promise<FormExtractOutcome> {
    let bytes: Uint8Array;
    try {
      bytes = await this.deps.driveMediaClient.downloadFileMedia(fileId);
    } catch {
      return { status: 'source_error' };
    }

    let rawData: Record<string, string | boolean | string[] | undefined>;
    try {
      rawData = await this.deps.pdfProcessor.extractFormData(bytes);
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'PdfEncryptionError') {
        return { status: 'encrypted' };
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
      const outcome = await this.deps.googleDocsFormReader.extractDocumentFormFields(documentId);
      if (outcome.status !== 'ok') {
        return outcome;
      }
      const normalizedAmbiguous =
        outcome.ambiguousFields && outcome.ambiguousFields.length > 0
          ? outcome.ambiguousFields
          : undefined;
      return {
        status: 'ok',
        widgetCount: outcome.widgetCount,
        fields: outcome.fields,
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

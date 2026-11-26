import {
  DriveFileTooLargeError,
  UnsupportedDocumentMimeTypeError,
  type DocumentContentEditResult,
  type DocumentContentEditorPort,
  type DocumentContentInsertDataRequest,
  type DocumentFormFieldInputValue,
  type DriveFileResult,
  type DriveServicePort,
  type FileLocator,
} from '../ports';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';

export interface DocumentContentEditorAdapterDeps {
  driveService: DriveServicePort;
  pdfProcessor: PdfProcessor;
  getMaxInMemoryFileBytes?:
    | (() => Promise<number | undefined> | number | undefined)
    | undefined;
}

const PDF_MIME_TYPE = 'application/pdf';

function hasWritableFormValues(
  formData: Readonly<Record<string, DocumentFormFieldInputValue>>
): boolean {
  return Object.values(formData).some((value) => {
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === 'string') {
      return value.length > 0;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  });
}

function toFileLocator(
  file: Pick<DriveFileResult, 'id' | 'name' | 'parents' | 'mimeType' | 'webViewLink'>,
  fallbackName?: string,
  fallbackMimeType?: string
): FileLocator {
  const resolvedName = file.name || fallbackName || '';
  const resolvedMimeType = file.mimeType ?? fallbackMimeType;
  const parentId = file.parents?.[0];
  return {
    id: file.id,
    name: resolvedName,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(resolvedMimeType !== undefined ? { mimeType: resolvedMimeType } : {}),
    ...(file.webViewLink !== undefined ? { uri: file.webViewLink } : {}),
  };
}

/**
 * Format-agnostic `DocumentContentEditorPort` adapter dispatching by resolved `mimeType`
 * (`application/pdf` via `PdfProcessor`, never flattening PDFs).
 */
export class DocumentContentEditorAdapter implements DocumentContentEditorPort {
  constructor(private readonly deps: DocumentContentEditorAdapterDeps) {}

  async insertData(request: DocumentContentInsertDataRequest): Promise<DocumentContentEditResult> {
    let targetMeta: DriveFileResult | undefined;
    let resolvedMimeType = request.targetMimeType;

    if (!resolvedMimeType) {
      targetMeta = await this.deps.driveService.getFile(request.targetFileId);
      resolvedMimeType = targetMeta.mimeType;
    }

    if (resolvedMimeType !== PDF_MIME_TYPE) {
      throw new UnsupportedDocumentMimeTypeError(
        `INSERT_DATA does not support target MIME type "${resolvedMimeType ?? 'unknown'}".`,
        { mimeType: resolvedMimeType }
      );
    }

    if (!hasWritableFormValues(request.formData)) {
      const locator = targetMeta
        ? toFileLocator(targetMeta, request.targetFileName, resolvedMimeType)
        : {
            id: request.targetFileId,
            name: request.targetFileName ?? '',
            mimeType: resolvedMimeType,
          };
      return { file: locator, skipped: true };
    }

    return this.insertPdfData(request, targetMeta);
  }

  private async insertPdfData(
    request: DocumentContentInsertDataRequest,
    existingMeta?: DriveFileResult
  ): Promise<DocumentContentEditResult> {
    let targetMeta = existingMeta;
    const maxBytes = this.deps.getMaxInMemoryFileBytes
      ? await this.deps.getMaxInMemoryFileBytes()
      : undefined;

    if (maxBytes !== undefined) {
      if (!targetMeta) {
        targetMeta = await this.deps.driveService.getFile(request.targetFileId);
      }
      if (targetMeta?.size !== undefined && targetMeta.size > maxBytes) {
        throw new DriveFileTooLargeError(
          `File "${request.targetFileId}" (${targetMeta.size} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`
        );
      }
    }

    const sourceBytes = await this.deps.driveService.downloadAsBuffer(request.targetFileId);
    const updatedBytes = await this.deps.pdfProcessor.processFormSubmission(
      sourceBytes,
      request.formData
    );

    const saved = await this.deps.driveService.saveBuffer(updatedBytes, {
      action: 'update',
      fileId: request.targetFileId,
      mimeType: PDF_MIME_TYPE,
    });

    return {
      file: toFileLocator(
        saved,
        request.targetFileName ?? targetMeta?.name,
        PDF_MIME_TYPE
      ),
    };
  }
}

import {
  DocumentContentError,
  DriveFileTooLargeError,
  UnsupportedDocumentMimeTypeError,
  type DocumentContentEditResult,
  type DocumentContentEditorPort,
  type DocumentContentInsertDataRequest,
  type DocumentContentInsertPagesRequest,
  type DocumentFormFieldInputValue,
  type DriveFileResult,
  type DriveServicePort,
  type FileLocator,
} from '../ports';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';
import { REDACTED_TEMPLATE_ID_PLACEHOLDER } from './env-template-registry.adapter';

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

function redactSourceSecret(message: string, sourceFileId: string, isTemplate?: boolean): string {
  if (!isTemplate || !sourceFileId) {
    return message;
  }
  return message.includes(sourceFileId)
    ? message.split(sourceFileId).join(REDACTED_TEMPLATE_ID_PLACEHOLDER)
    : message;
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

  async insertPages(request: DocumentContentInsertPagesRequest): Promise<DocumentContentEditResult> {
    let targetMeta: DriveFileResult | undefined;
    let targetMimeType = request.targetMimeType;

    if (!targetMimeType) {
      targetMeta = await this.deps.driveService.getFile(request.targetFileId);
      targetMimeType = targetMeta.mimeType;
    }

    if (targetMimeType !== PDF_MIME_TYPE) {
      throw new UnsupportedDocumentMimeTypeError(
        `INSERT_PAGES does not support target MIME type "${targetMimeType ?? 'unknown'}".`,
        { mimeType: targetMimeType }
      );
    }

    return this.insertPdfPages(request, targetMeta);
  }

  private async insertPdfPages(
    request: DocumentContentInsertPagesRequest,
    existingTargetMeta?: DriveFileResult
  ): Promise<DocumentContentEditResult> {
    let targetMeta = existingTargetMeta;
    let sourceMeta: DriveFileResult | undefined;
    let sourceMimeType = request.sourceMimeType;

    const loadSourceMeta = async (): Promise<DriveFileResult> => {
      if (sourceMeta) {
        return sourceMeta;
      }
      try {
        sourceMeta = await this.deps.driveService.getFile(request.sourceFileId);
        return sourceMeta;
      } catch (error) {
        if (request.sourceIsTemplate) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new DocumentContentError(
            redactSourceSecret(msg, request.sourceFileId, true),
            { cause: error }
          );
        }
        throw error;
      }
    };

    if (!sourceMimeType) {
      const loaded = await loadSourceMeta();
      sourceMimeType = loaded.mimeType;
    }

    if (sourceMimeType !== PDF_MIME_TYPE) {
      const errMsg = `INSERT_PAGES does not support source MIME type "${sourceMimeType ?? 'unknown'}".`;
      throw new UnsupportedDocumentMimeTypeError(
        redactSourceSecret(errMsg, request.sourceFileId, request.sourceIsTemplate),
        { mimeType: sourceMimeType }
      );
    }

    const maxBytes = this.deps.getMaxInMemoryFileBytes
      ? await this.deps.getMaxInMemoryFileBytes()
      : undefined;

    if (maxBytes !== undefined) {
      if (!targetMeta) {
        targetMeta = await this.deps.driveService.getFile(request.targetFileId);
      }
      if (!sourceMeta) {
        sourceMeta = await loadSourceMeta();
      }
      if (targetMeta.size !== undefined && targetMeta.size > maxBytes) {
        throw new DriveFileTooLargeError(
          `File "${request.targetFileId}" (${targetMeta.size} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`
        );
      }
      if (sourceMeta.size !== undefined && sourceMeta.size > maxBytes) {
        const msg = `File "${request.sourceFileId}" (${sourceMeta.size} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`;
        throw new DriveFileTooLargeError(
          redactSourceSecret(msg, request.sourceFileId, request.sourceIsTemplate)
        );
      }
      if (
        targetMeta.size !== undefined &&
        sourceMeta.size !== undefined &&
        targetMeta.size + sourceMeta.size > maxBytes
      ) {
        const total = targetMeta.size + sourceMeta.size;
        const msg = `Cumulative size of target "${request.targetFileId}" and source "${request.sourceFileId}" (${total} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`;
        throw new DriveFileTooLargeError(
          redactSourceSecret(msg, request.sourceFileId, request.sourceIsTemplate)
        );
      }
    }

    const targetBytes = await this.deps.driveService.downloadAsBuffer(request.targetFileId);

    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await this.deps.driveService.downloadAsBuffer(request.sourceFileId);
    } catch (error) {
      if (request.sourceIsTemplate) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new DocumentContentError(
          redactSourceSecret(msg, request.sourceFileId, true),
          { cause: error }
        );
      }
      throw error;
    }

    const updatedBytes = await this.deps.pdfProcessor.insertPages(targetBytes, sourceBytes, {
      position: request.position ?? 'start',
      ...(request.sourcePages !== undefined ? { sourcePages: request.sourcePages } : {}),
      targetAcroFormPolicy: 'namespace',
      ...(request.formData !== undefined ? { formData: request.formData } : {}),
    });

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

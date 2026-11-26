import {
  DocumentContentError,
  DriveFileTooLargeError,
  UnsupportedDocumentMimeTypeError,
  type DocumentContentEditResult,
  type DocumentContentEditorPort,
  type DocumentContentInsertDataRequest,
  type DocumentContentInsertPagesRequest,
  type DocumentContentUnmodifiableTargetReason,
  type DocumentFormFieldInputValue,
  type DriveFileResult,
  type DriveServicePort,
  type FileLocator,
} from '../ports';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';
import {
  PdfEncryptionError,
  PdfFileTooLargeError,
  PdfUnsupportedFormError,
} from '../../../infrastructure/pdf/errors';
import { redactTemplateId } from './env-template-registry.adapter';

export interface DocumentContentEditorAdapterDeps {
  driveService: DriveServicePort;
  pdfProcessor: PdfProcessor;
  getMaxInMemoryFileBytes?:
    | (() => Promise<number | undefined> | number | undefined)
    | undefined;
}

const PDF_MIME_TYPE = 'application/pdf';

function isDriveTooLargeError(error: unknown): boolean {
  return (
    error instanceof DriveFileTooLargeError ||
    (error instanceof Error && error.name === 'GoogleDriveFileTooLargeError')
  );
}

/**
 * Ensures a sibling Transmittal PDF filename ends cleanly in `.pdf` without producing `..pdf` or `.pdf.pdf`.
 */
function ensurePdfFileName(rawFileName: string): string {
  const trimmed = rawFileName.trim();
  if (trimmed.length === 0) {
    throw new DocumentContentError('Sibling PDF fileName must be a non-empty string.');
  }
  if (/\.pdf$/i.test(trimmed)) {
    const baseWithoutExt = trimmed.slice(0, -4).replace(/\.+$/, '');
    if (baseWithoutExt.length === 0) {
      throw new DocumentContentError('Sibling PDF fileName must contain a valid base name.');
    }
    return `${baseWithoutExt}${trimmed.slice(-4)}`;
  }
  const cleanBase = trimmed.replace(/\.+$/, '');
  if (cleanBase.length === 0) {
    throw new DocumentContentError('Sibling PDF fileName must contain a valid base name.');
  }
  return `${cleanBase}.pdf`;
}

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
  if (!isTemplate) {
    return message;
  }
  return redactTemplateId(message, sourceFileId);
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

    const fallbackPolicy =
      request.onUnmodifiableTarget?.strategy === 'createSiblingPdf'
        ? request.onUnmodifiableTarget
        : undefined;

    if (targetMimeType !== PDF_MIME_TYPE) {
      if (!fallbackPolicy) {
        throw new UnsupportedDocumentMimeTypeError(
          `INSERT_PAGES does not support target MIME type "${targetMimeType ?? 'unknown'}".`,
          { mimeType: targetMimeType }
        );
      }
      return this.createSiblingPdf(request, 'non_pdf', {
        siblingFileName: fallbackPolicy.fileName,
        targetFolderId: fallbackPolicy.targetFolderId ?? request.targetFolderId,
        targetMeta,
      });
    }

    return this.insertPdfPages(request, targetMeta);
  }

  private async resolveAndValidateSource(
    request: DocumentContentInsertPagesRequest,
    existingSourceMeta?: DriveFileResult
  ): Promise<{
    sourceMeta: DriveFileResult | undefined;
    maxBytes: number | undefined;
  }> {
    let sourceMeta = existingSourceMeta;
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
      if (!sourceMeta) {
        sourceMeta = await loadSourceMeta();
      }
      if (sourceMeta.size !== undefined && sourceMeta.size > maxBytes) {
        const msg = `File "${request.sourceFileId}" (${sourceMeta.size} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`;
        const redacted = redactSourceSecret(msg, request.sourceFileId, request.sourceIsTemplate);
        if (request.sourceIsTemplate) {
          throw new DocumentContentError(redacted);
        }
        throw new DriveFileTooLargeError(redacted);
      }
    }

    return { sourceMeta, maxBytes };
  }

  private async downloadSourceBuffer(
    request: DocumentContentInsertPagesRequest,
    maxBytes: number | undefined
  ): Promise<Uint8Array> {
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

    if (maxBytes !== undefined && sourceBytes.byteLength > maxBytes) {
      const msg = `File "${request.sourceFileId}" (${sourceBytes.byteLength} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`;
      const redacted = redactSourceSecret(msg, request.sourceFileId, request.sourceIsTemplate);
      if (request.sourceIsTemplate) {
        throw new DocumentContentError(redacted);
      }
      throw new DriveFileTooLargeError(redacted);
    }

    return sourceBytes;
  }

  private async createSiblingPdf(
    request: DocumentContentInsertPagesRequest,
    reason: DocumentContentUnmodifiableTargetReason,
    options: {
      siblingFileName: string;
      targetFolderId?: string | undefined;
      targetMeta?: DriveFileResult | undefined;
      sourceMeta?: DriveFileResult | undefined;
      preloadedSourceBytes?: Uint8Array | undefined;
      maxBytes?: number | undefined;
    }
  ): Promise<DocumentContentEditResult> {
    const resolvedFileName = ensurePdfFileName(options.siblingFileName);

    const { maxBytes } = options.preloadedSourceBytes
      ? { maxBytes: options.maxBytes }
      : await this.resolveAndValidateSource(request, options.sourceMeta);

    let resolvedTargetFolderId = options.targetFolderId ?? options.targetMeta?.parents?.[0];
    if (!resolvedTargetFolderId) {
      const targetMeta = await this.deps.driveService.getFile(request.targetFileId);
      resolvedTargetFolderId = targetMeta.parents?.[0];
    }
    if (!resolvedTargetFolderId) {
      throw new DocumentContentError(
        `Cannot create sibling PDF for target "${request.targetFileId}": destination folder ID could not be resolved.`
      );
    }

    const sourceBytes =
      options.preloadedSourceBytes ?? (await this.downloadSourceBuffer(request, maxBytes));

    const siblingBytes = await this.deps.pdfProcessor.createDocumentFromPages(sourceBytes, {
      ...(request.sourcePages !== undefined ? { sourcePages: request.sourcePages } : {}),
      ...(request.formData !== undefined ? { formData: request.formData } : {}),
    });

    const saved = await this.deps.driveService.saveBuffer(siblingBytes, {
      action: 'create',
      targetFolderId: resolvedTargetFolderId,
      name: resolvedFileName,
      mimeType: PDF_MIME_TYPE,
    });

    return {
      file: toFileLocator(saved, resolvedFileName, PDF_MIME_TYPE),
      fallbackUsed: true,
      unmodifiableReason: reason,
    };
  }

  private async insertPdfPages(
    request: DocumentContentInsertPagesRequest,
    existingTargetMeta?: DriveFileResult
  ): Promise<DocumentContentEditResult> {
    const fallbackPolicy =
      request.onUnmodifiableTarget?.strategy === 'createSiblingPdf'
        ? request.onUnmodifiableTarget
        : undefined;

    let targetMeta = existingTargetMeta;
    const { sourceMeta, maxBytes } = await this.resolveAndValidateSource(request);

    if (maxBytes !== undefined) {
      if (!targetMeta) {
        targetMeta = await this.deps.driveService.getFile(request.targetFileId);
      }
      const targetOversized =
        targetMeta.size !== undefined &&
        (targetMeta.size > maxBytes ||
          (sourceMeta?.size !== undefined && targetMeta.size + sourceMeta.size > maxBytes));
      if (targetOversized) {
        if (fallbackPolicy) {
          return this.createSiblingPdf(request, 'oversized', {
            siblingFileName: fallbackPolicy.fileName,
            targetFolderId: fallbackPolicy.targetFolderId ?? request.targetFolderId,
            targetMeta,
            sourceMeta,
            maxBytes,
          });
        }
        const total =
          targetMeta.size! > maxBytes
            ? targetMeta.size!
            : targetMeta.size! + (sourceMeta?.size ?? 0);
        const rawMsg =
          targetMeta.size! > maxBytes
            ? `File "${request.targetFileId}" (${total} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`
            : `Cumulative size of target "${request.targetFileId}" and source "${request.sourceFileId}" (${total} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes.`;
        throw new DriveFileTooLargeError(
          redactSourceSecret(rawMsg, request.sourceFileId, request.sourceIsTemplate)
        );
      }
    }

    let targetBytes: Uint8Array;
    try {
      targetBytes = await this.deps.driveService.downloadAsBuffer(request.targetFileId);
    } catch (error) {
      if (fallbackPolicy && isDriveTooLargeError(error)) {
        return this.createSiblingPdf(request, 'oversized', {
          siblingFileName: fallbackPolicy.fileName,
          targetFolderId: fallbackPolicy.targetFolderId ?? request.targetFolderId,
          targetMeta,
          sourceMeta,
          maxBytes,
        });
      }
      throw error;
    }

    const sourceBytes = await this.downloadSourceBuffer(request, maxBytes);

    let updatedBytes: Uint8Array;
    try {
      updatedBytes = await this.deps.pdfProcessor.insertPages(targetBytes, sourceBytes, {
        position: request.position ?? 'start',
        ...(request.sourcePages !== undefined ? { sourcePages: request.sourcePages } : {}),
        targetAcroFormPolicy: 'namespace',
        ...(request.formData !== undefined ? { formData: request.formData } : {}),
      });
    } catch (error) {
      if (fallbackPolicy) {
        if (error instanceof PdfEncryptionError && error.sourceRole !== 'insert') {
          return this.createSiblingPdf(request, 'encrypted', {
            siblingFileName: fallbackPolicy.fileName,
            targetFolderId: fallbackPolicy.targetFolderId ?? request.targetFolderId,
            targetMeta,
            sourceMeta,
            preloadedSourceBytes: sourceBytes,
            maxBytes,
          });
        }
        if (error instanceof PdfUnsupportedFormError && error.sourceRole !== 'insert') {
          if (error.reason === 'signed' || error.reason === 'xfa') {
            return this.createSiblingPdf(
              request,
              error.reason === 'signed' ? 'signed' : 'pure_xfa',
              {
                siblingFileName: fallbackPolicy.fileName,
                targetFolderId: fallbackPolicy.targetFolderId ?? request.targetFolderId,
                targetMeta,
                sourceMeta,
                preloadedSourceBytes: sourceBytes,
                maxBytes,
              }
            );
          }
        }
        if (error instanceof PdfFileTooLargeError) {
          return this.createSiblingPdf(request, 'oversized', {
            siblingFileName: fallbackPolicy.fileName,
            targetFolderId: fallbackPolicy.targetFolderId ?? request.targetFolderId,
            targetMeta,
            sourceMeta,
            preloadedSourceBytes: sourceBytes,
            maxBytes,
          });
        }
      }
      throw error;
    }

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

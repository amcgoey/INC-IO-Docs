import { describe, it, expect, vi } from 'vitest';
import { DocumentContentEditorAdapter } from './document-content-editor.adapter';
import {
  DriveFileTooLargeError,
  UnsupportedDocumentMimeTypeError,
  type DriveFileResult,
  type DriveServicePort,
} from '../ports';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';
import { createAnonymizedSubmittalCoverSheetPdf } from '../../../../test/fixtures/submittal-cover-sheet.fixture';

function createMockDriveService(overrides?: Partial<DriveServicePort>): DriveServicePort {
  return {
    getFile: vi.fn(),
    findOrCreateFolder: vi.fn(),
    resolveFolderPath: vi.fn(),
    move: vi.fn(),
    rename: vi.fn(),
    duplicate: vi.fn(),
    searchFiles: vi.fn(),
    downloadAsBuffer: vi.fn(),
    saveBuffer: vi.fn(),
    uploadStream: vi.fn(),
    ...overrides,
  };
}

describe('DocumentContentEditorAdapter (#378)', () => {
  it('dispatches application/pdf insertData, updates the target file in Drive without flattening AcroForms, and returns FileLocator', async () => {
    const initialPdf = await createAnonymizedSubmittalCoverSheetPdf({
      submittalResponse: 'Revise and Resubmit',
      date: '2026-11-01',
      reviewedBy: 'Architect',
    });

    let uploadedBuffer: Uint8Array | undefined;
    const driveService = createMockDriveService({
      getFile: vi.fn().mockResolvedValue({
        id: 'pdf-target-1',
        name: '_071200-001-0 Waterproofing.pdf',
        mimeType: 'application/pdf',
        size: initialPdf.byteLength,
        parents: ['folder-submittals'],
        webViewLink: 'https://drive.google.com/file/d/pdf-target-1/view',
      } satisfies DriveFileResult),
      downloadAsBuffer: vi.fn().mockResolvedValue(initialPdf),
      saveBuffer: vi.fn().mockImplementation(async (content: Uint8Array) => {
        uploadedBuffer = content;
        return {
          id: 'pdf-target-1',
          name: '_071200-001-0 Waterproofing.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-submittals'],
          webViewLink: 'https://drive.google.com/file/d/pdf-target-1/view',
        } satisfies DriveFileResult;
      }),
    });

    const pdfProcessor = new PdfProcessor();
    const adapter = new DocumentContentEditorAdapter({
      driveService,
      pdfProcessor,
    });

    const result = await adapter.insertData({
      targetFileId: 'pdf-target-1',
      formData: { 'Submittal No': '071200-001-0' },
    });

    expect(result.skipped).toBeUndefined();
    expect(result.file).toEqual({
      id: 'pdf-target-1',
      name: '_071200-001-0 Waterproofing.pdf',
      parentId: 'folder-submittals',
      mimeType: 'application/pdf',
      uri: 'https://drive.google.com/file/d/pdf-target-1/view',
    });
    expect(driveService.saveBuffer).toHaveBeenCalledWith(expect.any(Uint8Array), {
      action: 'update',
      fileId: 'pdf-target-1',
      mimeType: 'application/pdf',
    });

    expect(uploadedBuffer).toBeInstanceOf(Uint8Array);
    const extracted = await pdfProcessor.extractFormData(uploadedBuffer!);
    expect(extracted['Submittal No']).toBe('071200-001-0');
    expect(extracted['Submittal Response']).toBe('Revise and Resubmit');
    expect(extracted['Date']).toBe('2026-11-01');
    expect(extracted['Reviewed By']).toBe('Architect');
  });

  it('fails explicitly with UnsupportedDocumentMimeTypeError on non-PDF MIME types without downloading or uploading', async () => {
    const driveService = createMockDriveService({
      getFile: vi.fn().mockResolvedValue({
        id: 'gdoc-1',
        name: 'Submittal Notes',
        mimeType: 'application/vnd.google-apps.document',
      }),
    });

    const adapter = new DocumentContentEditorAdapter({
      driveService,
      pdfProcessor: new PdfProcessor(),
    });

    await expect(
      adapter.insertData({
        targetFileId: 'gdoc-1',
        formData: { 'Submittal No': '071200-001-0' },
      })
    ).rejects.toThrow(UnsupportedDocumentMimeTypeError);

    expect(driveService.downloadAsBuffer).not.toHaveBeenCalled();
    expect(driveService.saveBuffer).not.toHaveBeenCalled();
  });

  it('skips Drive download and upload when formData is empty', async () => {
    const driveService = createMockDriveService({
      getFile: vi.fn().mockResolvedValue({
        id: 'pdf-empty-write',
        name: 'Target.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-1'],
        webViewLink: 'https://drive.google.com/file/d/pdf-empty-write/view',
      }),
    });

    const adapter = new DocumentContentEditorAdapter({
      driveService,
      pdfProcessor: new PdfProcessor(),
    });

    const result = await adapter.insertData({
      targetFileId: 'pdf-empty-write',
      targetMimeType: 'application/pdf',
      targetFileName: 'Target.pdf',
      formData: {},
    });

    expect(result.skipped).toBe(true);
    expect(result.file).toEqual({
      id: 'pdf-empty-write',
      name: 'Target.pdf',
      mimeType: 'application/pdf',
    });
    expect(driveService.downloadAsBuffer).not.toHaveBeenCalled();
    expect(driveService.saveBuffer).not.toHaveBeenCalled();
  });

  it('enforces centralized getMaxInMemoryFileBytes pre-download before buffering oversized PDFs', async () => {
    const driveService = createMockDriveService({
      getFile: vi.fn().mockResolvedValue({
        id: 'pdf-huge',
        name: 'Huge.pdf',
        mimeType: 'application/pdf',
        size: 5_000,
      }),
    });

    const adapter = new DocumentContentEditorAdapter({
      driveService,
      pdfProcessor: new PdfProcessor({ getMaxInMemoryFileBytes: async () => 1_024 }),
      getMaxInMemoryFileBytes: async () => 1_024,
    });

    await expect(
      adapter.insertData({
        targetFileId: 'pdf-huge',
        targetMimeType: 'application/pdf',
        formData: { 'Submittal No': '071200-001-0' },
      })
    ).rejects.toThrow(DriveFileTooLargeError);

    expect(driveService.downloadAsBuffer).not.toHaveBeenCalled();
    expect(driveService.saveBuffer).not.toHaveBeenCalled();
  });
});

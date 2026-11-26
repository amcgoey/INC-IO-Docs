import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { DocumentContentEditorAdapter } from './document-content-editor.adapter';
import {
  DocumentContentError,
  DriveFileTooLargeError,
  DriveServiceError,
  UnsupportedDocumentMimeTypeError,
  type DriveFileResult,
  type DriveServicePort,
} from '../ports';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';
import { PdfCorruptedError } from '../../../infrastructure/pdf/errors';
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

  describe('insertPages (#379)', () => {
    it('grafts cover-sheet page 1 onto target PDF in a single pass with namespace collision isolation, keeping all fields editable', async () => {
      const coverSheetBytes = await createAnonymizedSubmittalCoverSheetPdf();
      // Target PDF also has a colliding "Submittal No" field and its own editable "Contractor Note" field
      const targetDoc = await PDFDocument.create();
      const targetPage = targetDoc.addPage([612, 792]);
      const targetForm = targetDoc.getForm();
      const collidingField = targetForm.createTextField('Submittal No');
      collidingField.setText('OLD-CONTRACTOR-NO');
      collidingField.addToPage(targetPage, { x: 50, y: 700, width: 150, height: 20 });
      const targetNote = targetForm.createTextField('Contractor Note');
      targetNote.setText('Keep Editable');
      targetNote.addToPage(targetPage, { x: 50, y: 650, width: 200, height: 20 });
      const targetBytes = await targetDoc.save();

      let uploadedBuffer: Uint8Array | undefined;
      const driveService = createMockDriveService({
        getFile: vi.fn().mockImplementation(async (fileId: string) => {
          if (fileId === 'tpl-cover-1') {
            return {
              id: 'tpl-cover-1',
              name: 'Cover Sheet Template.pdf',
              mimeType: 'application/pdf',
              size: coverSheetBytes.byteLength,
            };
          }
          return {
            id: 'target-dup-1',
            name: '_071200-001-0 Waterproofing.pdf',
            mimeType: 'application/pdf',
            size: targetBytes.byteLength,
            parents: ['folder-submittals'],
            webViewLink: 'https://drive.google.com/file/d/target-dup-1/view',
          };
        }),
        downloadAsBuffer: vi.fn().mockImplementation(async (fileId: string) => {
          if (fileId === 'tpl-cover-1') return coverSheetBytes;
          if (fileId === 'target-dup-1') return targetBytes;
          throw new Error(`Unexpected fileId ${fileId}`);
        }),
        saveBuffer: vi.fn().mockImplementation(async (content: Uint8Array) => {
          uploadedBuffer = content;
          return {
            id: 'target-dup-1',
            name: '_071200-001-0 Waterproofing.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-submittals'],
            webViewLink: 'https://drive.google.com/file/d/target-dup-1/view',
          };
        }),
      });

      const pdfProcessor = new PdfProcessor();
      const adapter = new DocumentContentEditorAdapter({ driveService, pdfProcessor });

      const result = await adapter.insertPages({
        targetFileId: 'target-dup-1',
        sourceFileId: 'tpl-cover-1',
        sourceIsTemplate: true,
        position: 'start',
        sourcePages: [1],
        formData: { 'Submittal No': '071200-001-0' },
      });

      expect(result.file).toEqual({
        id: 'target-dup-1',
        name: '_071200-001-0 Waterproofing.pdf',
        parentId: 'folder-submittals',
        mimeType: 'application/pdf',
        uri: 'https://drive.google.com/file/d/target-dup-1/view',
      });
      expect(driveService.saveBuffer).toHaveBeenCalledTimes(1);
      expect(driveService.saveBuffer).toHaveBeenCalledWith(expect.any(Uint8Array), {
        action: 'update',
        fileId: 'target-dup-1',
        mimeType: 'application/pdf',
      });

      expect(uploadedBuffer).toBeInstanceOf(Uint8Array);
      const savedDoc = await PDFDocument.load(uploadedBuffer!);
      expect(savedDoc.getPageCount()).toBe(2);

      // Cover sheet and target fields remain editable (zero flattening)
      const extracted = await pdfProcessor.extractFormData(uploadedBuffer!);
      expect(extracted['Submittal No']).toBe('071200-001-0');
      expect(extracted['Submittal Response']).toBeUndefined();
      expect(extracted['Date']).toBeUndefined();
      expect(extracted['Contractor Note']).toBe('Keep Editable');
      expect(extracted['__target.Submittal No']).toBe('OLD-CONTRACTOR-NO');
    });

    it('rejects non-PDF targets with UnsupportedDocumentMimeTypeError without downloading', async () => {
      const driveService = createMockDriveService({
        getFile: vi.fn().mockResolvedValue({
          id: 'gdoc-target',
          name: 'Submittal Doc',
          mimeType: 'application/vnd.google-apps.document',
        }),
      });
      const adapter = new DocumentContentEditorAdapter({
        driveService,
        pdfProcessor: new PdfProcessor(),
      });

      await expect(
        adapter.insertPages({
          targetFileId: 'gdoc-target',
          sourceFileId: 'tpl-cover-1',
          sourceIsTemplate: true,
          position: 'start',
          sourcePages: [1],
        })
      ).rejects.toThrow(UnsupportedDocumentMimeTypeError);
      expect(driveService.downloadAsBuffer).not.toHaveBeenCalled();
    });

    it('enforces cumulative getMaxInMemoryFileBytes pre-download and rejects oversized pairs', async () => {
      const driveService = createMockDriveService({
        getFile: vi.fn().mockImplementation(async (fileId: string) => ({
          id: fileId,
          name: `${fileId}.pdf`,
          mimeType: 'application/pdf',
          size: 700,
        })),
      });
      const adapter = new DocumentContentEditorAdapter({
        driveService,
        pdfProcessor: new PdfProcessor({ getMaxInMemoryFileBytes: async () => 1_000 }),
        getMaxInMemoryFileBytes: async () => 1_000,
      });

      await expect(
        adapter.insertPages({
          targetFileId: 'target-1',
          targetMimeType: 'application/pdf',
          sourceFileId: 'tpl-secret-123',
          sourceIsTemplate: true,
        })
      ).rejects.toThrow(DriveFileTooLargeError);

      expect(driveService.downloadAsBuffer).not.toHaveBeenCalled();
    });

    it('redacts sourceFileId when sourceIsTemplate is true and fails fast on corrupted target without saving', async () => {
      const confidentialTemplateId = 'secret-template-drive-id-xyz';
      const driveFailService = createMockDriveService({
        getFile: vi.fn().mockImplementation(async (fileId: string) => {
          if (fileId === confidentialTemplateId) {
            throw new DriveServiceError(`File not found: ${confidentialTemplateId}`);
          }
          return {
            id: fileId,
            name: 'Target.pdf',
            mimeType: 'application/pdf',
            size: 500,
          };
        }),
      });

      const failAdapter = new DocumentContentEditorAdapter({
        driveService: driveFailService,
        pdfProcessor: new PdfProcessor(),
      });

      let caughtTemplateErr: unknown;
      try {
        await failAdapter.insertPages({
          targetFileId: 'target-1',
          targetMimeType: 'application/pdf',
          sourceFileId: confidentialTemplateId,
          sourceIsTemplate: true,
        });
      } catch (err) {
        caughtTemplateErr = err;
      }
      expect(caughtTemplateErr).toBeInstanceOf(DocumentContentError);
      expect((caughtTemplateErr as Error).message).not.toContain(confidentialTemplateId);
      expect((caughtTemplateErr as Error).message).toContain('[REDACTED_TEMPLATE_ID]');

      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();
      const corruptedDriveService = createMockDriveService({
        getFile: vi.fn().mockImplementation(async (fileId: string) => ({
          id: fileId,
          name: `${fileId}.pdf`,
          mimeType: 'application/pdf',
          size: 500,
        })),
        downloadAsBuffer: vi.fn().mockImplementation(async (fileId: string) => {
          if (fileId === confidentialTemplateId) return coverBytes;
          return new Uint8Array([1, 2, 3, 4]);
        }),
      });
      const corruptedAdapter = new DocumentContentEditorAdapter({
        driveService: corruptedDriveService,
        pdfProcessor: new PdfProcessor(),
      });

      await expect(
        corruptedAdapter.insertPages({
          targetFileId: 'corrupt-target',
          targetMimeType: 'application/pdf',
          sourceFileId: confidentialTemplateId,
          sourceIsTemplate: true,
        })
      ).rejects.toThrow(PdfCorruptedError);
      expect(corruptedDriveService.saveBuffer).not.toHaveBeenCalled();
    });
  });
});

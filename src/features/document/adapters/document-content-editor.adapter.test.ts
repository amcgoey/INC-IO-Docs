import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
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
import {
  PdfCorruptedError,
  PdfEncryptionError,
  PdfUnsupportedFormError,
} from '../../../infrastructure/pdf/errors';
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

  describe('insertPages onUnmodifiableTarget createSiblingPdf (#380)', () => {
    it('creates editable sibling Transmittal PDF without ..pdf double suffix for non-PDF, encrypted, pure-XFA, signed, and oversized targets while leaving target untouched', async () => {
      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();
      const pdfProcessor = new PdfProcessor();

      // Pure-XFA target
      const pureXfaDoc = await PDFDocument.create();
      pureXfaDoc.addPage([400, 400]);
      pureXfaDoc.catalog
        .getOrCreateAcroForm()
        .dict.set(
          PDFName.of('XFA'),
          pureXfaDoc.context.register(pureXfaDoc.context.flateStream('<xdp/>'))
        );
      const pureXfaBytes = await pureXfaDoc.save({ updateFieldAppearances: false });

      // Signed target
      const signedDoc = await PDFDocument.create();
      const sPage = signedDoc.addPage([400, 400]);
      const sForm = signedDoc.getForm();
      const sigValRef = signedDoc.context.register(
        signedDoc.context.obj({
          Type: 'Sig',
          Filter: 'Adobe.PPKLite',
          ByteRange: [0, 100, 200, 300],
          Contents: PDFString.of('0000'),
        })
      );
      const sigRef = signedDoc.context.register(
        signedDoc.context.obj({
          FT: 'Sig',
          T: PDFString.of('DigitalSig'),
          V: sigValRef,
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [20, 300, 180, 340],
          P: sPage.ref,
        })
      );
      sForm.acroForm.addField(sigRef);
      sForm.acroForm.dict.set(PDFName.of('SigFlags'), signedDoc.context.obj(3));
      sPage.node.addAnnot(sigRef);
      const signedBytes = await signedDoc.save({ updateFieldAppearances: false });

      // Normal PDF for streaming/cumulative oversized test
      const validPdfDoc = await PDFDocument.create();
      validPdfDoc.addPage([400, 400]);
      const validPdfBytes = await validPdfDoc.save();

      const cases: Array<{
        name: string;
        targetMimeType: string;
        targetSize?: number;
        maxBytes?: number;
        targetBytes?: Uint8Array;
        downloadError?: Error;
        requestedFileName: string;
        expectedSavedName: string;
        expectedReason: 'non_pdf' | 'encrypted' | 'pure_xfa' | 'signed' | 'oversized';
      }> = [
        {
          name: 'non-PDF MIME',
          targetMimeType: 'application/vnd.google-apps.document',
          requestedFileName: '_071200-001-0 Spec Transmittal.pdf',
          expectedSavedName: '_071200-001-0 Spec Transmittal.pdf',
          expectedReason: 'non_pdf',
        },
        {
          name: 'encrypted PDF',
          targetMimeType: 'application/pdf',
          targetBytes: validPdfBytes,
          requestedFileName: '_071200-001-0 Spec Transmittal..pdf',
          expectedSavedName: '_071200-001-0 Spec Transmittal.pdf',
          expectedReason: 'encrypted',
        },
        {
          name: 'pure-XFA PDF',
          targetMimeType: 'application/pdf',
          targetBytes: pureXfaBytes,
          requestedFileName: '_071200-001-0 Spec Transmittal',
          expectedSavedName: '_071200-001-0 Spec Transmittal.pdf',
          expectedReason: 'pure_xfa',
        },
        {
          name: 'signed PDF',
          targetMimeType: 'application/pdf',
          targetBytes: signedBytes,
          requestedFileName: '_071200-001-0 Spec Transmittal.',
          expectedSavedName: '_071200-001-0 Spec Transmittal.pdf',
          expectedReason: 'signed',
        },
        {
          name: 'oversized target metadata',
          targetMimeType: 'application/pdf',
          targetSize: 50_000,
          maxBytes: 20_000,
          requestedFileName: '_071200-001-0 Spec Transmittal.pdf',
          expectedSavedName: '_071200-001-0 Spec Transmittal.pdf',
          expectedReason: 'oversized',
        },
        {
          name: 'oversized target download stream',
          targetMimeType: 'application/pdf',
          downloadError: new DriveFileTooLargeError('Stream exceeded limit'),
          requestedFileName: '_071200-001-0 Spec Transmittal.pdf',
          expectedSavedName: '_071200-001-0 Spec Transmittal.pdf',
          expectedReason: 'oversized',
        },
      ];

      for (const testCase of cases) {
        let savedSiblingBytes: Uint8Array | undefined;
        const driveService = createMockDriveService({
          getFile: vi.fn().mockImplementation(async (fileId: string) => {
            if (fileId === 'tpl-cover') {
              return {
                id: 'tpl-cover',
                name: 'Cover.pdf',
                mimeType: 'application/pdf',
                size: coverBytes.byteLength,
              };
            }
            return {
              id: 'dup-target',
              name: '_071200-001-0 Spec',
              mimeType: testCase.targetMimeType,
              parents: ['folder-submittals'],
              ...(testCase.targetSize !== undefined ? { size: testCase.targetSize } : {}),
            };
          }),
          downloadAsBuffer: vi.fn().mockImplementation(async (fileId: string) => {
            if (fileId === 'tpl-cover') return coverBytes;
            if (testCase.downloadError) throw testCase.downloadError;
            return testCase.targetBytes!;
          }),
          saveBuffer: vi.fn().mockImplementation(async (content: Uint8Array, opts) => {
            savedSiblingBytes = content;
            return {
              id: 'sibling-transmittal-1',
              name: opts.action === 'create' ? opts.name : '',
              parents: ['folder-submittals'],
              mimeType: 'application/pdf',
              webViewLink: 'https://drive.google.com/file/d/sibling-transmittal-1/view',
            };
          }),
        });

        const scopedProcessor =
          testCase.maxBytes !== undefined
            ? new PdfProcessor({ getMaxInMemoryFileBytes: async () => testCase.maxBytes })
            : pdfProcessor;

        if (testCase.expectedReason === 'encrypted') {
          vi.spyOn(scopedProcessor, 'insertPages').mockRejectedValueOnce(
            new PdfEncryptionError('Encrypted target', { sourceRole: 'target' })
          );
        }

        const adapter = new DocumentContentEditorAdapter({
          driveService,
          pdfProcessor: scopedProcessor,
          ...(testCase.maxBytes !== undefined
            ? { getMaxInMemoryFileBytes: async () => testCase.maxBytes }
            : {}),
        });

        const result = await adapter.insertPages({
          targetFileId: 'dup-target',
          sourceFileId: 'tpl-cover',
          sourceIsTemplate: true,
          position: 'start',
          sourcePages: [1],
          formData: { 'Submittal No': '071200-001-0' },
          onUnmodifiableTarget: {
            strategy: 'createSiblingPdf',
            fileName: testCase.requestedFileName,
          },
        });

        expect(result.fallbackUsed, testCase.name).toBe(true);
        expect(result.unmodifiableReason, testCase.name).toBe(testCase.expectedReason);
        expect(result.file, testCase.name).toEqual({
          id: 'sibling-transmittal-1',
          name: testCase.expectedSavedName,
          parentId: 'folder-submittals',
          mimeType: 'application/pdf',
          uri: 'https://drive.google.com/file/d/sibling-transmittal-1/view',
        });

        expect(driveService.saveBuffer, testCase.name).toHaveBeenCalledTimes(1);
        expect(driveService.saveBuffer, testCase.name).toHaveBeenCalledWith(expect.any(Uint8Array), {
          action: 'create',
          targetFolderId: 'folder-submittals',
          name: testCase.expectedSavedName,
          mimeType: 'application/pdf',
        });

        if (testCase.expectedReason === 'non_pdf' || testCase.targetSize !== undefined) {
          expect(driveService.downloadAsBuffer, testCase.name).not.toHaveBeenCalledWith('dup-target');
        }

        expect(savedSiblingBytes, testCase.name).toBeInstanceOf(Uint8Array);
        const extracted = await pdfProcessor.extractFormData(savedSiblingBytes!);
        expect(extracted['Submittal No'], testCase.name).toBe('071200-001-0');
        expect(extracted['Submittal Response'], testCase.name).toBeUndefined();
      }
    });

    it('still fails fast under createSiblingPdf on corrupted target PDF, template errors, and Drive save errors', async () => {
      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();
      const pdfProcessor = new PdfProcessor();

      // Corrupted target PDF fails fast
      const corruptDrive = createMockDriveService({
        getFile: vi.fn().mockImplementation(async (id: string) => ({
          id,
          name: `${id}.pdf`,
          mimeType: 'application/pdf',
          parents: ['folder-1'],
        })),
        downloadAsBuffer: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'tpl-cover') return coverBytes;
          return new Uint8Array([0, 1, 2, 3]);
        }),
      });
      const corruptAdapter = new DocumentContentEditorAdapter({
        driveService: corruptDrive,
        pdfProcessor,
      });
      await expect(
        corruptAdapter.insertPages({
          targetFileId: 'corrupt-dup',
          sourceFileId: 'tpl-cover',
          sourceIsTemplate: true,
          onUnmodifiableTarget: {
            strategy: 'createSiblingPdf',
            fileName: '_Sibling Transmittal.pdf',
          },
        })
      ).rejects.toThrow(PdfCorruptedError);
      expect(corruptDrive.saveBuffer).not.toHaveBeenCalled();

      // Encrypted or XFA cover template fails fast rather than creating sibling
      const validTarget = await PDFDocument.create();
      validTarget.addPage([400, 400]);
      const validTargetBytes = await validTarget.save();

      const xfaCover = await PDFDocument.load(coverBytes);
      xfaCover.catalog
        .getOrCreateAcroForm()
        .dict.set(PDFName.of('XFA'), xfaCover.context.register(xfaCover.context.flateStream('<xdp/>')));
      const xfaCoverBytes = await xfaCover.save({ updateFieldAppearances: false });

      const badTemplateDrive = createMockDriveService({
        getFile: vi.fn().mockImplementation(async (id: string) => ({
          id,
          name: `${id}.pdf`,
          mimeType: 'application/pdf',
          parents: ['folder-1'],
        })),
        downloadAsBuffer: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'tpl-xfa') return xfaCoverBytes;
          return validTargetBytes;
        }),
      });
      const badTemplateAdapter = new DocumentContentEditorAdapter({
        driveService: badTemplateDrive,
        pdfProcessor,
      });
      await expect(
        badTemplateAdapter.insertPages({
          targetFileId: 'valid-dup',
          sourceFileId: 'tpl-xfa',
          sourceIsTemplate: true,
          onUnmodifiableTarget: {
            strategy: 'createSiblingPdf',
            fileName: '_Sibling Transmittal.pdf',
          },
        })
      ).rejects.toThrow(PdfUnsupportedFormError);
      expect(badTemplateDrive.saveBuffer).not.toHaveBeenCalled();
    });
  });
});

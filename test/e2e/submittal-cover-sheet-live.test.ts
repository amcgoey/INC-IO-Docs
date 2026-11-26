import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createDocumentLogWiring, type DocumentLogWiring } from '../../src/app/document-log.wiring';
import {
  createDocumentFeatureWiring,
  createDocumentServiceFactory,
} from '../../src/app/document.wiring';
import { createLookupOptionsWiring } from '../../src/app/lookup-options.wiring';
import type { DocumentServiceFactory } from '../../src/app/ui-process-manager.wiring';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { PdfProcessor } from '../../src/infrastructure/pdf/pdf-processor';
import { GoogleSheetsClient } from '../../src/infrastructure/sheets';
import { HandlebarsAdapter } from '../../src/infrastructure/template-engine/handlebars-adapter';
import {
  getDocumentLogTestFolderId,
  getSubmittalCoverSheetTemplateId,
  resolveLiveGoogleAuth,
} from './utils/live-google-auth';
import {
  DEFAULT_LIVE_RETRY_OPTIONS,
  createLiveSheetsApi,
  loadDocumentLogSampleFixture,
} from './utils/live-sheets-helper';

const sampleFixture = loadDocumentLogSampleFixture();
const TEST_FOLDER_ID = getDocumentLogTestFolderId();
const COVER_SHEET_TEMPLATE_ID = getSubmittalCoverSheetTemplateId();

describe.skipIf(!TEST_FOLDER_ID || !COVER_SHEET_TEMPLATE_ID)(
  'Live Submittal Cover-Sheet & createSiblingPdf E2E Verification (Copy-and-Trash)',
  () => {
    const cleanupIds: string[] = [];
    let driveClient: GoogleDriveClient | undefined;
    let pdfProcessor: PdfProcessor;
    let logWiring: DocumentLogWiring;
    let documentServiceFactory: DocumentServiceFactory;

    let spaceFolderId: string;
    let space: { id: string; typeId: string; name: string; abstractStorageId: string };
    let copiedSpreadsheetId: string;
    let adminFolderId: string | undefined;
    let archPdfFileId: string;
    let archPdfFileName: string;
    let ffeTextFileId: string;
    let ffeTextFileName: string;

    const trackCleanupId = (id: string | undefined): void => {
      if (!id || id.trim().length === 0) {
        return;
      }
      if (
        id === TEST_FOLDER_ID ||
        id === COVER_SHEET_TEMPLATE_ID ||
        id === sampleFixture.metadata.templateSpreadsheetId
      ) {
        return;
      }
      if (!cleanupIds.includes(id)) {
        cleanupIds.push(id);
      }
    };

    const requireDriveClient = (): GoogleDriveClient => {
      if (!driveClient) {
        throw new Error('GoogleDriveClient is not initialized.');
      }
      return driveClient;
    };

    beforeAll(async () => {
      if (!TEST_FOLDER_ID || !COVER_SHEET_TEMPLATE_ID) {
        throw new Error(
          'DOCUMENT_LOG_TEST_FOLDER_ID and SUBMITTAL_COVER_SHEET_TEMPLATE_ID are required for live cover-sheet E2E tests.'
        );
      }

      const auth = resolveLiveGoogleAuth();
      const liveDriveClient = new GoogleDriveClient({
        auth,
        retryOptions: DEFAULT_LIVE_RETRY_OPTIONS,
      });
      driveClient = liveDriveClient;
      const sheetsApi = createLiveSheetsApi(auth);
      const sheetsClient = new GoogleSheetsClient({
        sheets: sheetsApi,
        retryOptions: DEFAULT_LIVE_RETRY_OPTIONS,
      });

      const manifestProvider = new AppManifestProvider({
        manifestPath: path.resolve(__dirname, '../../assets/manifest.json'),
      });
      const handlebars = new HandlebarsAdapter();
      pdfProcessor = new PdfProcessor({
        getMaxInMemoryFileBytes: async () =>
          (await manifestProvider.getMaxInMemoryFileBytes()) ?? undefined,
      });

      const { documentSchemaRegistry, compiledSchemaRegistry } = createDocumentFeatureWiring({
        manifestProvider,
        templateEvaluator: handlebars,
      });
      await compiledSchemaRegistry.initialize();

      logWiring = createDocumentLogWiring({
        manifestProvider,
        driveClient: liveDriveClient,
        sheetsClient,
        configProvider: manifestProvider,
        templateEvaluator: handlebars,
      });
      await logWiring.logSchemaRegistry.initialize();

      const lookupOptionsWiring = createLookupOptionsWiring({
        manifestProvider,
        documentSchemaRegistry,
        driveClient: liveDriveClient,
        configProvider: manifestProvider,
        getDocumentLogService: (ctx) => logWiring.getPerRequestService(ctx),
        ensureDocumentLogInitialized: () => logWiring.logSchemaRegistry.initialize(),
      });

      documentServiceFactory = createDocumentServiceFactory({
        manifestProvider,
        documentSchemaRegistry,
        templateEvaluator: handlebars,
        compiledSchemaRegistry,
        configProvider: manifestProvider,
        driveClient: liveDriveClient,
        pdfProcessor,
        documentLogService: logWiring.documentLogService,
        ensureDocumentLogInitialized: () => logWiring.logSchemaRegistry.initialize(),
        getDynamicValidator: (requestContext) =>
          lookupOptionsWiring.createDynamicValidator(requestContext),
        createAdditionalActivityHandlers: (context, requestContext) => {
          const effectiveCtx = requestContext ?? context;
          const sharedLookup = lookupOptionsWiring.getPerRequestLookupOptions(effectiveCtx);
          return [
            logWiring.createPerRequestActivityHandler(effectiveCtx, {
              ...(context.selectedLogId !== undefined
                ? { selectedLogId: context.selectedLogId }
                : {}),
              onWriteLogSuccess: () => sharedLookup.invalidate(),
            }),
          ];
        },
      });

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const spaceName = `CoverSheet Live E2E ${runId}`;

      const spaceFolder = await liveDriveClient.findOrCreateFolder(TEST_FOLDER_ID, spaceName);
      spaceFolderId = spaceFolder.id;
      trackCleanupId(spaceFolder.id);
      space = {
        id: `live-cover-space-${runId}`,
        typeId: 'proposals',
        name: spaceName,
        abstractStorageId: spaceFolder.id,
      };

      const initialCopy = await logWiring.documentLogService.copyLog(space);
      copiedSpreadsheetId = initialCopy.candidate.id;
      const copiedParentId = initialCopy.candidate.parents?.[0];
      if (copiedParentId && copiedParentId !== spaceFolder.id) {
        adminFolderId = copiedParentId;
      }
      trackCleanupId(adminFolderId);
      trackCleanupId(copiedSpreadsheetId);

      const constructionFolder = await liveDriveClient.findOrCreateFolder(
        spaceFolder.id,
        '6 Construction'
      );
      trackCleanupId(constructionFolder.id);

      const ffeFolder = await liveDriveClient.findOrCreateFolder(spaceFolder.id, '3 FFE');
      trackCleanupId(ffeFolder.id);

      // Create a real 1-page PDF for happy-path cover-sheet grafting
      const targetDoc = await PDFDocument.create();
      const page = targetDoc.addPage([612, 792]);
      page.drawText('Live Submittal Target Content');
      const targetPdfBytes = await targetDoc.save();

      archPdfFileName = `Live_Cover_Target_${runId}.pdf`;
      const uploadedArch = await liveDriveClient.saveBuffer(targetPdfBytes, {
        action: 'create',
        name: archPdfFileName,
        targetFolderId: spaceFolder.id,
        mimeType: 'application/pdf',
      });
      archPdfFileId = uploadedArch.id;
      trackCleanupId(uploadedArch.id);

      // Create a non-PDF file to trigger onUnmodifiableTarget: createSiblingPdf
      ffeTextFileName = `Live_NonPdf_Target_${runId}.txt`;
      const uploadedText = await liveDriveClient.saveBuffer(
        Buffer.from('Vendor submittal specification text attachment', 'utf-8'),
        {
          action: 'create',
          name: ffeTextFileName,
          targetFolderId: spaceFolder.id,
          mimeType: 'text/plain',
        }
      );
      ffeTextFileId = uploadedText.id;
      trackCleanupId(uploadedText.id);
    }, 90_000);

    afterAll(async () => {
      if (!driveClient) {
        return;
      }
      if (spaceFolderId && !adminFolderId) {
        try {
          const adminFolder = await driveClient.resolveFolderPath(spaceFolderId, ['1 Admin']);
          adminFolderId = adminFolder.id;
          trackCleanupId(adminFolder.id);
        } catch {
          // Best-effort discovery
        }
      }
      for (const id of [...cleanupIds].reverse()) {
        try {
          await driveClient.trash(id);
        } catch {
          // Best-effort cleanup of every created artifact
        }
      }
    }, 90_000);

    it('grafts live editable cover sheet on submittal-arch SubmittalReceived without flattening and binds WRITE_LOG to moveOriginal', async () => {
      const liveDriveClient = requireDriveClient();
      const service = await documentServiceFactory({
        selectedLogId: copiedSpreadsheetId,
        sourceFiles: [{ id: archPdfFileId, name: archPdfFileName, mimeType: 'application/pdf' }],
      });

      const result = await service.processDocument(
        {
          type: 'submittal-arch',
          space,
          sourceFiles: [{ id: archPdfFileId, name: archPdfFileName, mimeType: 'application/pdf' }],
          data: {
            status: 'Open',
            section: '071200',
            number: '001',
            revision: '0',
            title: 'Live Waterproofing',
            date: '261104',
            contact: 'MB',
            action: 'REC',
          },
        },
        'onSubmit'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.activities.map((a) => a.type)).toEqual([
        'MOVE_FILE',
        'DUPLICATE_FILE',
        'INSERT_PAGES',
        'WRITE_LOG',
      ]);
      expect(result.contextVariables?.notices).toBeUndefined();

      const movedFileId = result.stepOutputs?.moveOriginal?.files?.[0]?.id;
      const graftedReviewFileId = result.stepOutputs?.insertCoverSheet?.files?.[0]?.id;
      expect(movedFileId).toBe(archPdfFileId);
      expect(graftedReviewFileId).toBeDefined();
      expect(graftedReviewFileId).not.toBe(movedFileId);
      trackCleanupId(graftedReviewFileId);

      // Verify grafted review copy in Drive has cover sheet prepended and stays editable
      const reviewBytes = await liveDriveClient.downloadAsBuffer(graftedReviewFileId!);
      const reviewDoc = await PDFDocument.load(reviewBytes);
      expect(reviewDoc.getPageCount()).toBe(2);

      const extracted = await pdfProcessor.extractFormData(reviewBytes);
      expect(extracted['Submittal No']).toBe('071200-001-0');
      expect(extracted['Submittal Response']).toBeUndefined();
      expect(extracted['Date']).toBeUndefined();

      // Verify DocumentLog links to moveOriginal (Closed/), not the review duplicate
      const logRead = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
      });
      expect(logRead.entries).toHaveLength(1);
      expect(logRead.entries[0]!.fileUri).toContain(archPdfFileId);
    }, 120_000);

    it('falls back to editable sibling Transmittal PDF and emits notice when target is non-PDF on submittal-ffe SubmittalReceived', async () => {
      const liveDriveClient = requireDriveClient();
      const service = await documentServiceFactory({
        selectedLogId: copiedSpreadsheetId,
        sourceFiles: [{ id: ffeTextFileId, name: ffeTextFileName, mimeType: 'text/plain' }],
      });

      const result = await service.processDocument(
        {
          type: 'submittal-ffe',
          space,
          sourceFiles: [{ id: ffeTextFileId, name: ffeTextFileName, mimeType: 'text/plain' }],
          data: {
            status: 'Open',
            specTag: 'AC102',
            revision: '0',
            specTitle: 'HOOK',
            vendor: 'HPG',
            date: '261104',
            contact: 'MB',
            action: 'REC',
          },
        },
        'onSubmit'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const dupFile = result.stepOutputs?.duplicateForReview?.files?.[0];
      const siblingFile = result.stepOutputs?.insertCoverSheet?.files?.[0];
      expect(dupFile).toBeDefined();
      expect(siblingFile).toBeDefined();
      expect(siblingFile?.id).not.toBe(dupFile?.id);
      expect(siblingFile?.mimeType).toBe('application/pdf');
      expect(siblingFile?.name).toMatch(/^_.* Transmittal\.pdf$/);
      expect(siblingFile?.name).not.toContain('..pdf');
      trackCleanupId(dupFile?.id);
      trackCleanupId(siblingFile?.id);

      // Duplicate remains untouched non-PDF
      const dupMeta = await liveDriveClient.getFile(dupFile!.id);
      expect(dupMeta.mimeType).toBe('text/plain');

      // Sibling Transmittal PDF is editable with Submittal No stamped
      const siblingBytes = await liveDriveClient.downloadAsBuffer(siblingFile!.id);
      const extracted = await pdfProcessor.extractFormData(siblingBytes);
      expect(extracted['Submittal No']).toBe('AC102-0');

      const notices = result.contextVariables?.notices as string[] | undefined;
      expect(Array.isArray(notices)).toBe(true);
      expect(notices?.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(notices)).not.toContain(COVER_SHEET_TEMPLATE_ID);

      // DocumentLog links to moveOriginal
      const logRead = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
      });
      expect(logRead.entries).toHaveLength(1);
      expect(logRead.entries[0]!.fileUri).toContain(ffeTextFileId);
    }, 120_000);
  }
);

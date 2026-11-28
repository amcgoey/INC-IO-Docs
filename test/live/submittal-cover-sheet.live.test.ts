import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  LiveTestHarness,
  type LiveAppWiring,
} from './live-test-harness';

const TEST_FOLDER_ID = LiveTestHarness.auth.getDocumentLogTestFolderId();
const COVER_SHEET_TEMPLATE_ID = LiveTestHarness.auth.getSubmittalCoverSheetTemplateId();

describe.skipIf(!TEST_FOLDER_ID || !COVER_SHEET_TEMPLATE_ID)(
  'Live Submittal Cover-Sheet & createSiblingPdf E2E Verification (Copy-and-Trash)',
  () => {
    const cleanupTracker = LiveTestHarness.cleanup.createCleanupTracker();
    let wiring: LiveAppWiring | undefined;

    let spaceFolderId: string;
    let space: { id: string; typeId: string; name: string; abstractStorageId: string };
    let copiedSpreadsheetId: string;
    let adminFolderId: string | undefined;
    let archPdfFileId: string;
    let archPdfFileName: string;
    let ffeTextFileId: string;
    let ffeTextFileName: string;
    let templateFields: Record<string, string | boolean | string[] | undefined>;

    const requireWiring = (): LiveAppWiring => {
      if (!wiring) {
        throw new Error('LiveAppWiring is not initialized.');
      }
      return wiring;
    };

    const trackCleanupId = (id: string | undefined): void => {
      cleanupTracker.track(id);
    };

    beforeAll(async () => {
      if (!TEST_FOLDER_ID || !COVER_SHEET_TEMPLATE_ID) {
        throw new Error(
          'DOCUMENT_LOG_TEST_FOLDER_ID and SUBMITTAL_COVER_SHEET_TEMPLATE_ID are required for live cover-sheet E2E tests.'
        );
      }

      wiring = await LiveTestHarness.app.createWiring();
      expect(wiring.lookupTimeoutMs).toBe(LiveTestHarness.app.DEFAULT_LIVE_LOOKUP_TIMEOUT_MS);

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const spaceName = `CoverSheet Live E2E ${runId}`;

      const targetDoc = await PDFDocument.create();
      targetDoc.addPage([612, 792]).drawText('Live Submittal Target Content');

      const [spaceFolder, templateBytes, targetPdfBytes] = await Promise.all([
        wiring.driveClient.findOrCreateFolder(TEST_FOLDER_ID, spaceName),
        wiring.driveClient.downloadAsBuffer(COVER_SHEET_TEMPLATE_ID),
        targetDoc.save(),
      ]);
      spaceFolderId = spaceFolder.id;
      cleanupTracker.trackFolder(spaceFolder.id);
      space = {
        id: `live-cover-space-${runId}`,
        typeId: 'proposals',
        name: spaceName,
        abstractStorageId: spaceFolder.id,
      };

      const initialCopy = await wiring.logWiring.documentLogService.copyLog(space);
      copiedSpreadsheetId = initialCopy.candidate.id;
      const copiedParentId = initialCopy.candidate.parents?.[0];
      if (copiedParentId && copiedParentId !== spaceFolder.id) {
        adminFolderId = copiedParentId;
      }
      cleanupTracker.trackFolder(adminFolderId, spaceFolder.id);
      cleanupTracker.trackSpreadsheet(copiedSpreadsheetId, adminFolderId ?? spaceFolder.id);

      archPdfFileName = `Live_Cover_Target_${runId}.pdf`;
      ffeTextFileName = `Live_NonPdf_Target_${runId}.txt`;

      const [
        constructionFolder,
        ffeFolder,
        uploadedArch,
        uploadedText,
      ] = await Promise.all([
        wiring.driveClient.findOrCreateFolder(spaceFolder.id, '6 Construction'),
        wiring.driveClient.findOrCreateFolder(spaceFolder.id, '3 FFE'),
        wiring.driveClient.saveBuffer(targetPdfBytes, {
          action: 'create',
          name: archPdfFileName,
          targetFolderId: spaceFolder.id,
          mimeType: 'application/pdf',
        }),
        wiring.driveClient.saveBuffer(
          Buffer.from('Vendor submittal specification text attachment', 'utf-8'),
          {
            action: 'create',
            name: ffeTextFileName,
            targetFolderId: spaceFolder.id,
            mimeType: 'text/plain',
          }
        ),
      ]);

      trackCleanupId(constructionFolder.id);
      trackCleanupId(ffeFolder.id);
      archPdfFileId = uploadedArch.id;
      trackCleanupId(uploadedArch.id);
      ffeTextFileId = uploadedText.id;
      trackCleanupId(uploadedText.id);

      templateFields = await wiring.pdfProcessor.extractFormData(templateBytes);
    }, 90_000);

    afterAll(async () => {
      await LiveTestHarness.cleanup.cleanupScratchSpace({
        driveClient: wiring?.driveClient,
        spaceFolderId,
        adminFolderId,
        tracker: cleanupTracker,
      });
    }, 90_000);

    it('grafts live editable cover sheet on submittal-arch SubmittalReceived without flattening and binds WRITE_LOG to moveOriginal', async () => {
      const liveWiring = requireWiring();
      const service = await liveWiring.documentServiceFactory({
        selectedLogId: copiedSpreadsheetId,
        sourceFiles: [{ id: archPdfFileId, name: archPdfFileName, mimeType: 'application/pdf' }],
      });

      const { result, counts } = await liveWiring.apiTracker.measure(() =>
        service.processDocument(
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
        )
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Explicit API-call-count guard: getOptionTablePort + per-request memoization avoid duplicate
      // _Config Sheets reads (5 Sheets reads, 1 write) and selectedLogId skips Drive discovery.
      expect(counts.sheets.reads).toBe(5);
      expect(counts.sheets.writes).toBe(1);
      expect(counts.sheets.byMethod).toEqual({
        'spreadsheets.get': 2,
        'spreadsheets.values.batchGet': 3,
        'spreadsheets.batchUpdate': 1,
      });
      expect(counts.drive.byMethod['drives.list'] ?? 0).toBe(0);
      expect(counts.drive.reads).toBeLessThanOrEqual(14);
      expect(counts.drive.writes).toBeLessThanOrEqual(7);

      expect(result.activities.map((a) => a.type)).toEqual([
        'MOVE_FILE',
        'DUPLICATE_FILE',
        'INSERT_PAGES',
        'WRITE_LOG',
      ]);
      expect(result.contextVariables?.notices).toBeUndefined();

      const movedFile = result.stepOutputs?.moveOriginal?.files?.[0];
      const dupFile = result.stepOutputs?.duplicateForReview?.files?.[0];
      const graftedReviewFile = result.stepOutputs?.insertCoverSheet?.files?.[0];
      const movedFileId = movedFile?.id;
      const graftedReviewFileId = graftedReviewFile?.id;
      expect(movedFileId).toBe(archPdfFileId);
      expect(graftedReviewFileId).toBeDefined();
      expect(graftedReviewFileId).not.toBe(movedFileId);
      expect(movedFile?.parentId).toBeDefined();
      expect(movedFile?.parentUri).toMatch(/^https:\/\/drive\.google\.com\//);
      expect(movedFile?.parentUri).toContain(movedFile?.parentId);
      expect(dupFile?.parentId).toBeDefined();
      expect(dupFile?.parentUri).toMatch(/^https:\/\/drive\.google\.com\//);
      expect(dupFile?.parentUri).toContain(dupFile?.parentId);
      expect(graftedReviewFile?.parentId).toBe(dupFile?.parentId);
      expect(graftedReviewFile?.parentUri).toBe(dupFile?.parentUri);
      trackCleanupId(graftedReviewFileId);

      // Verify grafted review copy in Drive has cover sheet prepended and stays editable
      const reviewBytes = await liveWiring.driveClient.downloadAsBuffer(graftedReviewFileId!);
      const reviewDoc = await PDFDocument.load(reviewBytes);
      expect(reviewDoc.getPageCount()).toBe(2);

      const extracted = await liveWiring.pdfProcessor.extractFormData(reviewBytes);
      expect(extracted['Submittal No']).toBe('071200-001-0');
      expect(extracted['Submittal Response']).toBe(templateFields['Submittal Response']);
      expect(extracted['Date']).toBe(templateFields['Date']);
      expect(extracted['Date']).not.toBe('2026-11-04');

      // Verify DocumentLog links to moveOriginal (Closed/), not the review duplicate
      const logRead = await liveWiring.logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
      });
      expect(logRead.entries).toHaveLength(1);
      expect(logRead.entries[0]!.fileUri).toContain(archPdfFileId);
    }, 120_000);

    it('falls back to editable sibling Transmittal PDF and emits notice when target is non-PDF on submittal-ffe SubmittalReceived', async () => {
      const liveWiring = requireWiring();
      const service = await liveWiring.documentServiceFactory({
        selectedLogId: copiedSpreadsheetId,
        sourceFiles: [{ id: ffeTextFileId, name: ffeTextFileName, mimeType: 'text/plain' }],
      });

      const { result, counts } = await liveWiring.apiTracker.measure(() =>
        service.processDocument(
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
        )
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Explicit API-call-count guard: same 5 Sheets reads / 1 write with 0 Drive log discovery
      expect(counts.sheets.reads).toBe(5);
      expect(counts.sheets.writes).toBe(1);
      expect(counts.sheets.byMethod).toEqual({
        'spreadsheets.get': 2,
        'spreadsheets.values.batchGet': 3,
        'spreadsheets.batchUpdate': 1,
      });
      expect(counts.drive.byMethod['drives.list'] ?? 0).toBe(0);
      expect(counts.drive.reads).toBeLessThanOrEqual(14);
      expect(counts.drive.writes).toBeLessThanOrEqual(7);

      const dupFile = result.stepOutputs?.duplicateForReview?.files?.[0];
      const siblingFile = result.stepOutputs?.insertCoverSheet?.files?.[0];
      expect(dupFile).toBeDefined();
      expect(siblingFile).toBeDefined();
      expect(siblingFile?.id).not.toBe(dupFile?.id);
      expect(siblingFile?.mimeType).toBe('application/pdf');
      expect(siblingFile?.name).toMatch(/^_.* Transmittal\.pdf$/);
      expect(siblingFile?.name).not.toContain('..pdf');
      expect(dupFile?.parentId).toBeDefined();
      expect(dupFile?.parentUri).toMatch(/^https:\/\/drive\.google\.com\//);
      expect(dupFile?.parentUri).toContain(dupFile?.parentId);
      expect(siblingFile?.parentId).toBe(dupFile?.parentId);
      expect(siblingFile?.parentUri).toBe(dupFile?.parentUri);
      trackCleanupId(dupFile?.id);
      trackCleanupId(siblingFile?.id);

      // Duplicate remains untouched non-PDF
      const dupMeta = await liveWiring.driveClient.getFile(dupFile!.id);
      expect(dupMeta.mimeType).toBe('text/plain');

      // Sibling Transmittal PDF is editable with Submittal No stamped
      const siblingBytes = await liveWiring.driveClient.downloadAsBuffer(siblingFile!.id);
      const extracted = await liveWiring.pdfProcessor.extractFormData(siblingBytes);
      expect(extracted['Submittal No']).toBe('AC102-0');

      const notices = result.contextVariables?.notices as string[] | undefined;
      expect(Array.isArray(notices)).toBe(true);
      expect(notices?.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(notices)).not.toContain(COVER_SHEET_TEMPLATE_ID);

      // DocumentLog links to moveOriginal
      const logRead = await liveWiring.logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
      });
      expect(logRead.entries).toHaveLength(1);
      expect(logRead.entries[0]!.fileUri).toContain(ffeTextFileId);

      // Cumulative suite Sheets read budget check (must stay lean so full test:live stays <=45)
      const cumulative = liveWiring.apiTracker.getCounts();
      expect(cumulative.sheets.reads).toBeLessThanOrEqual(20);
      expect(cumulative.sheets.writes).toBe(2);
    }, 120_000);
  }
);

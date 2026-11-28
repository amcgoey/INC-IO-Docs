import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import type { DocumentLogWiring } from '../../src/app/document-log.wiring';
import type { SourceParserWiring } from '../../src/app/source-parser.wiring';
import type { DocumentServiceFactory } from '../../src/app/ui-process-manager.wiring';
import type { CopyDocumentLogResult } from '../../src/features/document-log';
import type { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import {
  columnIndexToLetter,
  type GoogleSheetsClient,
  type PositiveTableTarget,
} from '../../src/infrastructure/sheets';
import {
  DEFAULT_LIVE_RETRY_OPTIONS,
  appendRawPositiveTableRows,
  clearOptionTableToEmpty,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSpreadsheetErrorTokens,
  findSideBySideTableShiftViolations,
  inspectPositiveTableLayout,
  partialHydrationRowToCellInputs,
  readNamedRangesFormattedValues,
  readOptionTableGridFormats,
  snapshotNamedRanges,
} from '../e2e/utils/live-sheets-helper';
import {
  TEST_FOLDER_ID,
  buildPositiveTableTarget,
  cleanupScratchSpace,
  createCleanupTracker,
  expectAliasesHeaderNote,
  initializeDocumentLogLiveWiring,
  provisionDocumentLogScratchSpace,
  sampleFixture,
  uploadDummyPdf,
} from './document-log-live-setup';

describe.skipIf(!TEST_FOLDER_ID)(
  'Live DocumentLog Submittal Arch E2E Verification (Copy-and-Trash)',
  () => {
    const cleanupTracker = createCleanupTracker();
    let driveClient: GoogleDriveClient | undefined;
    let sheetsApi: sheets_v4.Sheets;
    let sheetsClient: GoogleSheetsClient;
    let logWiring: DocumentLogWiring;
    let sourceParserWiring: SourceParserWiring;
    let documentServiceFactory: DocumentServiceFactory;

    let spaceName: string;
    let spaceFolderId: string;
    let space: { id: string; typeId: string; name: string; abstractStorageId: string };
    let copiedSpreadsheetId: string;
    let initialCopyResult: CopyDocumentLogResult;
    let adminFolderId: string | undefined;
    let archFileId: string;
    let archFileName: string;

    const requireDriveClient = (): GoogleDriveClient => {
      if (!driveClient) {
        throw new Error('GoogleDriveClient is not initialized.');
      }
      return driveClient;
    };

    const archTarget = (): PositiveTableTarget =>
      buildPositiveTableTarget(copiedSpreadsheetId, sampleFixture.submittalArch);

    beforeAll(async () => {
      const wiring = await initializeDocumentLogLiveWiring();
      driveClient = wiring.driveClient;
      sheetsApi = wiring.sheetsApi;
      sheetsClient = wiring.sheetsClient;
      logWiring = wiring.logWiring;
      sourceParserWiring = wiring.sourceParserWiring;
      documentServiceFactory = wiring.documentServiceFactory;

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const provisioned = await provisionDocumentLogScratchSpace({
        driveClient: wiring.driveClient,
        logWiring,
        spaceName: `Harborview Live E2E ${runId}`,
        spaceId: `live-space-${runId}`,
        trackCleanupId: cleanupTracker.track,
      });
      spaceName = provisioned.spaceName;
      spaceFolderId = provisioned.spaceFolderId;
      space = provisioned.space;
      initialCopyResult = provisioned.copyResult;
      copiedSpreadsheetId = provisioned.spreadsheetId;
      adminFolderId = provisioned.adminFolderId;

      const constructionFolder = await wiring.driveClient.findOrCreateFolder(
        spaceFolderId,
        '6 Construction'
      );
      cleanupTracker.track(constructionFolder.id);

      await ensureClearedPositiveTable(sheetsApi, archTarget());

      const archFile = await uploadDummyPdf({
        driveClient: wiring.driveClient,
        targetFolderId: spaceFolderId,
        fileName: `Live_Arch_Submittal_${runId}.pdf`,
        textContent: 'Live DocumentLog E2E Target Content',
        trackCleanupId: cleanupTracker.track,
      });
      archFileId = archFile.id;
      archFileName = archFile.name;
    }, 60_000);

    afterAll(async () => {
      await cleanupScratchSpace({
        driveClient,
        spaceFolderId,
        adminFolderId,
        tracker: cleanupTracker,
      });
    }, 90_000);

    it('provisions a new DocumentLog via DocumentLogPort.copyLog() (auto-creating "1 Admin" and applying copyNameTemplate) and resolves it', async () => {
      const liveDriveClient = requireDriveClient();

      expect(initialCopyResult.created).toBe(true);
      expect(initialCopyResult.folderPath).toBe('1 Admin');
      expect(initialCopyResult.candidate.id).toBe(copiedSpreadsheetId);
      expect(copiedSpreadsheetId).not.toBe(sampleFixture.metadata.templateSpreadsheetId);
      expect(initialCopyResult.candidate.name).toBe(`${spaceName} Document Log`);

      const adminFolder = await liveDriveClient.resolveFolderPath(spaceFolderId, ['1 Admin']);
      adminFolderId = adminFolder.id;
      cleanupTracker.track(adminFolder.id);
      expect(adminFolder.name).toBe('1 Admin');

      const copiedMeta = await liveDriveClient.getFile(copiedSpreadsheetId);
      expect(copiedMeta.name).toBe(`${spaceName} Document Log`);
      expect(copiedMeta.parents).toContain(adminFolder.id);

      const resolved = await logWiring.documentLogService.resolveLog(space);
      expect(resolved.status).toBe('resolved');
      if (resolved.status !== 'resolved') return;
      expect(resolved.candidate).toMatchObject({
        id: copiedSpreadsheetId,
        name: `${spaceName} Document Log`,
      });
    }, 30_000);

    it('is idempotent when DocumentLogPort.copyLog() is called a second time on the same scratch DocumentSpace', async () => {
      const secondCopy = await logWiring.documentLogService.copyLog(space);
      cleanupTracker.track(secondCopy.candidate.id);

      expect(secondCopy.created).toBe(false);
      expect(secondCopy.folderPath).toBe('1 Admin');
      expect(secondCopy.candidate.id).toBe(copiedSpreadsheetId);
      expect(secondCopy.candidate.name).toBe(`${spaceName} Document Log`);

      const resolved = await logWiring.documentLogService.resolveLog(space);
      expect(resolved.status).toBe('resolved');
      if (resolved.status !== 'resolved') return;
      expect(resolved.candidates).toHaveLength(1);
      expect(resolved.candidate.id).toBe(copiedSpreadsheetId);
    }, 30_000);

    it('executes full DocumentService.processDocument() (MOVE_FILE -> WRITE_LOG) for submittal-arch', async () => {
      const liveDriveClient = requireDriveClient();
      const spreadsheetMeta = await sheetsApi.spreadsheets.get({
        spreadsheetId: copiedSpreadsheetId,
        fields: 'sheets(properties(sheetId,title))',
      });
      const archSheetId = spreadsheetMeta.data.sheets?.find(
        (s) => s.properties?.title === sampleFixture.submittalArch.sheetName
      )?.properties?.sheetId;
      expect(typeof archSheetId).toBe('number');

      const archService = await documentServiceFactory({
        sourceFiles: [{ id: archFileId, name: archFileName, mimeType: 'application/pdf' }],
      });

      const archEntries: Array<Record<string, unknown>> = [
        ...[0, 2, 3, 4, 5, 6, 7, 9].map((idx) => sampleFixture.submittalArch.seedEntries[idx].documentData),
        ...sampleFixture.submittalArch.writeScenarios.map((scenario) => scenario.documentData),
        {
          status: 'Open',
          section: '099000',
          number: '001',
          revision: '0',
          title: '=1+1',
          date: '260325',
          contact: 'MB',
          action: 'REC',
          notes: '=SUM(A1)',
        },
      ];

      for (const data of archEntries) {
        const result = await archService.processDocument(
          {
            type: 'submittal-arch',
            space,
            data,
          },
          'onSubmit'
        );

        expect(result.success).toBe(true);
        if (!result.success) return;
        expect(result.activities.map((a) => a.type)).toEqual(
          data.action === 'REC'
            ? ['MOVE_FILE', 'DUPLICATE_FILE', 'INSERT_PAGES', 'WRITE_LOG']
            : ['MOVE_FILE', 'WRITE_LOG']
        );
        const logWrite = result.contextVariables?.documentLogWrite as
          | { spreadsheetId: string; sheetName: string; sheetId?: number; rowNumber: number; uri: string }
          | undefined;
        expect(logWrite).toMatchObject({
          spreadsheetId: copiedSpreadsheetId,
          sheetName: sampleFixture.submittalArch.sheetName,
          sheetId: archSheetId,
        });
        expect(logWrite?.uri).toBe(
          `https://docs.google.com/spreadsheets/d/${copiedSpreadsheetId}/edit#gid=${archSheetId}&range=${logWrite?.rowNumber}:${logWrite?.rowNumber}`
        );
        expect(result.stepOutputs?.writeLog?.files).toBeUndefined();
        expect(result.files?.length).toBeGreaterThan(0);
      }

      const table = await sheetsClient.readTable({ target: archTarget() });
      expect(table.rows).toHaveLength(14);

      const actualOrder = table.rows.map(
        (r) =>
          `${r.values.Section}-${r.values.Number}-${r.values.Revision}-${r.values.Date}-${r.values.Contact}`
      );
      expect(actualOrder).toEqual([
        '013300-001-0-260110-MB',
        '033000-001-0-260115-MB',
        '071200-001-0-260204-MB',
        '071200-001-0-260205-PST',
        '071200-001-0-260205-SME',
        '071200-001-0-260205-LMD',
        '071200-001-0-260212-ARC',
        '071200-001-1-260220-MB',
        '071200-001-1-260224-ARC',
        '071200-002-0-260218-MB',
        '075100-001-0-260220-MB',
        '087100-001-0-260303-MB',
        '096500-001-0-260314-MB',
        '099000-001-0-260325-MB',
      ]);

      expect(table.rows[9].values).toMatchObject({
        Section: '071200',
        Number: '002',
        Date: '260218',
      });

      const literalRowIdx = table.rows.findIndex((r) => r.values.Section === '099000');
      expect(literalRowIdx).toBe(13);
      expect(table.rows[literalRowIdx].values.Title).toBe('=1+1');
      expect(table.rows[literalRowIdx].values.Notes).toBe('=SUM(A1)');

      const layout = await inspectPositiveTableLayout(sheetsApi, archTarget());
      expect(layout.formulaRowsByHeader.Title[literalRowIdx]).toBe('=1+1');
      expect(layout.formulaRowsByHeader.Notes[literalRowIdx]).toBe('=SUM(A1)');

      expect(layout.formulaRowsByHeader['Calc Link']).toHaveLength(14);
      for (let i = 0; i < 14; i++) {
        expect(table.rows[i].values['Calc Link']).toBe('Link');
        const formulaCell = layout.formulaRowsByHeader['Calc Link'][i];
        expect(formulaCell).toMatch(/^=HYPERLINK\("https:\/\/.+", "Link"\)$/);
        expect(formulaCell).toContain(archFileId);
      }

      expect(
        findCleanDividerViolations({
          ...layout,
          expectedDividerCount: 7,
        })
      ).toEqual([]);

      const submittalsFolder = await liveDriveClient.resolveFolderPath(spaceFolderId, [
        '6 Construction',
        'Submittals',
      ]);
      cleanupTracker.track(submittalsFolder.id);
      const closedArchFolder = await liveDriveClient.resolveFolderPath(submittalsFolder.id, ['Closed']);
      const archFileMeta = await liveDriveClient.getFile(archFileId);
      const archLeafFolderId = archFileMeta.parents?.[0];
      expect(archLeafFolderId).toBeDefined();
      if (archLeafFolderId) {
        const archLeafMeta = await liveDriveClient.getFile(archLeafFolderId);
        expect(archLeafMeta.name).toMatch(/^09\b/);
        expect(archLeafMeta.parents).toContain(closedArchFolder.id);
      }
    }, 180_000);

    it('hydrates full and batch-filtered Submittal Arch logs with live =HYPERLINK fileUri via DocumentLogPort.readLog()', async () => {
      const fullRead = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        space,
      });

      expect(fullRead.spreadsheetId).toBe(copiedSpreadsheetId);
      expect(fullRead.sheetName).toBe(sampleFixture.submittalArch.sheetName);
      expect(fullRead.warnings).toEqual([]);
      expect(fullRead.entries).toHaveLength(14);

      for (const entry of fullRead.entries) {
        expect(entry.valid).toBe(true);
        expect(entry.validationErrors).toBeUndefined();
        expect(entry.document.type).toBe('submittal-arch');
        expect(entry.document.calculated).toBeUndefined();
        expect('calculated' in entry.document).toBe(false);
        expect(entry.rowNumber).toBeGreaterThan(0);
        expect(entry.fileUri).toMatch(/^https:\/\//);
        expect(entry.fileUri).toContain(archFileId);
      }

      expect(fullRead.entries.map((entry) => entry.document.id)).toEqual([
        '013300-001-0-260110-1',
        '033000-001-0-260115-1',
        '071200-001-0-260204-1',
        '071200-001-0-260205-2',
        '071200-001-0-260205-2',
        '071200-001-0-260205-2',
        '071200-001-0-260212-5',
        '071200-001-1-260220-1',
        '071200-001-1-260224-6',
        '071200-002-0-260218-1',
        '075100-001-0-260220-1',
        '087100-001-0-260303-1',
        '096500-001-0-260314-1',
        '099000-001-0-260325-1',
      ]);

      expect(
        fullRead.entries.map((entry) => {
          const data = entry.document.data as {
            section?: string;
            number?: string;
            revision?: string;
            date?: string;
            contact?: { key?: string };
          };
          return `${data.section}-${data.number}-${data.revision}-${data.date}-${data.contact?.key}`;
        })
      ).toEqual([
        '013300-001-0-260110-MB',
        '033000-001-0-260115-MB',
        '071200-001-0-260204-MB',
        '071200-001-0-260205-PST',
        '071200-001-0-260205-SME',
        '071200-001-0-260205-LMD',
        '071200-001-0-260212-ARC',
        '071200-001-1-260220-MB',
        '071200-001-1-260224-ARC',
        '071200-002-0-260218-MB',
        '075100-001-0-260220-MB',
        '087100-001-0-260303-MB',
        '096500-001-0-260314-MB',
        '099000-001-0-260325-MB',
      ]);

      expect(fullRead.entries[9].document.id).toBe('071200-002-0-260218-1');
      expect(fullRead.entries[9].document.data).toMatchObject({
        section: '071200',
        number: '002',
        date: '260218',
        status: { key: 'Waiting' },
        action: { key: 'REC', name: 'Received', suffix: '', order: '1' },
      });
      expect('notes' in fullRead.entries[9].document.data).toBe(false);

      expect(fullRead.entries[13].document.id).toBe('099000-001-0-260325-1');
      expect(fullRead.entries[13].document.data).toMatchObject({
        title: '=1+1',
        notes: '=SUM(A1)',
      });

      const byIdGroup = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idGroup',
        values: [' 071200-001 ', '033000-001'],
      });
      expect(byIdGroup.warnings).toEqual([]);
      expect(byIdGroup.entries).toHaveLength(8);
      expect(byIdGroup.entries.map((entry) => entry.document.idGroup)).toEqual([
        '033000-001',
        '071200-001',
        '071200-001',
        '071200-001',
        '071200-001',
        '071200-001',
        '071200-001',
        '071200-001',
      ]);
      for (const entry of byIdGroup.entries) {
        expect(entry.fileUri).toContain(archFileId);
      }

      const byIdDocument = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idDocument',
        values: [' 071200-001-1 ', '071200-002-0'],
      });
      expect(byIdDocument.warnings).toEqual([]);
      expect(byIdDocument.entries.map((entry) => entry.document.id)).toEqual([
        '071200-001-1-260220-1',
        '071200-001-1-260224-6',
        '071200-002-0-260218-1',
      ]);

      const byId = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'id',
        values: [' 071200-001-0-260205-2 ', '013300-001-0-260110-1'],
      });
      expect(byId.warnings).toEqual([]);
      expect(byId.entries.map((entry) => entry.document.id)).toEqual([
        '013300-001-0-260110-1',
        '071200-001-0-260205-2',
        '071200-001-0-260205-2',
        '071200-001-0-260205-2',
      ]);
    }, 60_000);

    it('resiliently hydrates injected partial-hydration invalid rows on Submittal Arch against real Google Sheets with filter-scoped warning isolation', async () => {
      const archRowsToAppend = [
        ...sampleFixture.submittalArch.partialHydrationRows.map((row) =>
          partialHydrationRowToCellInputs(row)
        ),
        { Title: 'General note' },
      ];
      const insertedArchRows = await appendRawPositiveTableRows(
        sheetsApi,
        archTarget(),
        archRowsToAppend,
        DEFAULT_LIVE_RETRY_OPTIONS
      );
      expect(insertedArchRows).toHaveLength(4);

      const archFull = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
      });
      expect(archFull.entries).toHaveLength(18);

      const invalidSectionEntry = archFull.entries.find(
        (entry) => entry.rowNumber === insertedArchRows[0]
      );
      expect(invalidSectionEntry).toBeDefined();
      expect(invalidSectionEntry?.valid).toBe(false);
      expect(invalidSectionEntry?.document.idGroup).toBe('7120-001');
      expect(invalidSectionEntry?.fileUri).toBe(
        'https://drive.google.com/file/d/fixture-arch-partial-sec/view'
      );
      expect(invalidSectionEntry?.validationErrors).toHaveLength(1);
      expect(
        archFull.warnings
          .filter((warning) => warning.rowNumber === insertedArchRows[0])
          .map((warning) => warning.field)
      ).toEqual(['section']);

      const unknownActionEntry = archFull.entries.find(
        (entry) => entry.rowNumber === insertedArchRows[1]
      );
      expect(unknownActionEntry).toBeDefined();
      expect(unknownActionEntry?.valid).toBe(false);
      expect(unknownActionEntry?.document.idGroup).toBe('071200-001');
      expect(unknownActionEntry?.document.data.action).toEqual({
        key: 'Approved',
        name: 'Approved',
      });
      expect(unknownActionEntry?.fileUri).toBe(
        'https://drive.google.com/file/d/fixture-arch-raw-url/view'
      );
      expect(unknownActionEntry?.validationErrors).toHaveLength(1);
      expect(
        archFull.warnings
          .filter((warning) => warning.rowNumber === insertedArchRows[1])
          .map((warning) => warning.field)
      ).toEqual(['action']);

      const missingDateEntry = archFull.entries.find(
        (entry) => entry.rowNumber === insertedArchRows[2]
      );
      expect(missingDateEntry).toBeDefined();
      expect(missingDateEntry?.valid).toBe(false);
      expect(missingDateEntry?.document.idGroup).toBe('071200-001');
      expect('date' in (missingDateEntry?.document.data ?? {})).toBe(false);
      expect(missingDateEntry?.fileUri).toBeUndefined();
      expect(missingDateEntry?.validationErrors).toHaveLength(1);
      expect(
        archFull.warnings
          .filter((warning) => warning.rowNumber === insertedArchRows[2])
          .map((warning) => warning.field)
      ).toEqual(['date']);

      const generalNoteEntry = archFull.entries.find(
        (entry) => entry.rowNumber === insertedArchRows[3]
      );
      expect(generalNoteEntry).toBeDefined();
      expect(generalNoteEntry?.valid).toBe(false);
      expect(generalNoteEntry?.document.idGroup).toBeUndefined();
      expect(generalNoteEntry?.document.idDocument).toBeUndefined();
      expect(generalNoteEntry?.document.id).toBeUndefined();
      expect(archFull.warnings.some((warning) => warning.rowNumber === insertedArchRows[3])).toBe(
        true
      );

      const archGroup071200 = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idGroup',
        values: [' 071200-001 '],
      });
      expect(archGroup071200.entries).toHaveLength(9);
      expect(archGroup071200.warnings.map((warning) => warning.field)).toEqual(['action', 'date']);
      for (const warning of archGroup071200.warnings) {
        expect([insertedArchRows[1], insertedArchRows[2]]).toContain(warning.rowNumber);
      }

      const archCleanGroups = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idGroup',
        values: [' 033000-001 ', '087100-001'],
      });
      expect(archCleanGroups.entries).toHaveLength(2);
      expect(archCleanGroups.entries.every((entry) => entry.valid === true)).toBe(true);
      expect(archCleanGroups.warnings).toEqual([]);

      const archDashFilter = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idGroup',
        values: ['-'],
      });
      expect(archDashFilter.entries).toEqual([]);
      expect(archDashFilter.warnings).toEqual([]);
    }, 90_000);

    it('verifies live submittal-arch DocumentLog option reads, seeded Aliases, Validation_* bounds, empty-table Row 4 format cloning, Named Range expansion, and side-by-side _Config stability on a fresh copied template', async () => {
      const liveDriveClient = requireDriveClient();
      const templateId = sampleFixture.metadata.templateSpreadsheetId;
      const discoveryConfig = logWiring.logSchemaRegistry.getDiscoveryConfig('proposals');
      expect(discoveryConfig?.templateSpreadsheetId).toBe(templateId);
      const archLogSchema = logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-arch');
      expect(archLogSchema).toBeDefined();
      if (!archLogSchema) {
        return;
      }

      const archContactsBinding = archLogSchema.optionBindings?.contacts;
      const archStatusesBinding = archLogSchema.optionBindings?.statuses;
      const archActionsBinding = archLogSchema.optionBindings?.actions;
      expect(archContactsBinding).toBeDefined();
      expect(archStatusesBinding).toBeDefined();
      expect(archActionsBinding).toBeDefined();
      if (!archContactsBinding || !archStatusesBinding || !archActionsBinding) {
        return;
      }

      const runId = `opt-arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          driveClient: liveDriveClient,
          logWiring,
          spaceName: `Harborview Arch Options Live ${runId}`,
          spaceId: `live-opt-arch-space-${runId}`,
          trackCleanupId: localTracker.track,
        });
        const optSpace = provisioned.space;
        const optCopy = provisioned.copyResult;
        const optSpreadsheetId = provisioned.spreadsheetId;

        expect(optCopy.created).toBe(true);
        expect(optSpreadsheetId).not.toBe(templateId);

        const optArchTarget = buildPositiveTableTarget(optSpreadsheetId, archLogSchema.target);
        await ensureClearedPositiveTable(sheetsApi, optArchTarget);
        expect(
          await findSpreadsheetErrorTokens(sheetsApi, optSpreadsheetId, DEFAULT_LIVE_RETRY_OPTIONS)
        ).toEqual([]);

        // 1) Live option reads from untouched copied template (unprefixed Row 3 headers + 6 seeded Aliases rows)
        const initialArchOptions = await logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-arch',
          space: optSpace,
          selectedLogId: optSpreadsheetId,
        });
        expect(initialArchOptions.status).toBe('ready');
        if (initialArchOptions.status !== 'ready') return;
        expect(initialArchOptions.spreadsheetId).toBe(optSpreadsheetId);
        expect(initialArchOptions.tables.statuses?.status).toBe('ready');
        expect(initialArchOptions.tables.statuses?.tuples.length).toBeGreaterThan(0);
        expect(initialArchOptions.tables.actions?.status).toBe('ready');
        expect(initialArchOptions.tables.actions?.tuples.length).toBeGreaterThan(0);
        expect(initialArchOptions.tables.contacts?.status).toBe('ready');
        expect(initialArchOptions.tables.contacts?.tuples).toEqual([
          {
            key: 'INC',
            name: 'INC Architecture and Design',
            aliases: ['@inc.nyc', 'INC Architecture', 'INC Architecture and Design', 'INC Architecture & Design'],
          },
          {
            key: 'PMG',
            name: 'Pavarini McGovern',
            aliases: ['@pavarini.com', 'Pavarini McGovern', 'Pavarini'],
          },
          {
            key: 'FXC',
            name: 'FX Collaborative',
            aliases: ['@fxcollaborative.com', 'FX Collaborative', 'FXCollaborative', 'FXFOWLE'],
          },
          {
            key: 'IE',
            name: 'Interface Engineering',
            aliases: ['@interfaceeng.com', 'Interface Engineering', 'Interface Eng'],
          },
          {
            key: 'VLD',
            name: 'Ventresca Lighting Design',
            aliases: ['@ventresca.com', 'Ventresca Lighting Design', 'Ventresca Lighting', 'Ventresca'],
          },
          {
            key: 'TT',
            name: 'Thornton Tomasetti',
            aliases: ['@thorntontomasetti.com', 'Thornton Tomasetti', 'Thorton Tomasetti'],
          },
        ]);

        // Verify split Validation_* policy: Arch Contacts targets Key and excludes "---", Statuses keeps "---" at index 6
        const initialSnapshots = await snapshotNamedRanges(
          sheetsApi,
          optSpreadsheetId,
          [
            archStatusesBinding.validationRangeName!,
            archContactsBinding.validationRangeName!,
          ],
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const initialValidationValues = await readNamedRangesFormattedValues(
          sheetsApi,
          optSpreadsheetId,
          initialSnapshots,
          DEFAULT_LIVE_RETRY_OPTIONS,
          { archHeaderBanner: `'${archContactsBinding.sheetName}'!A1:K2` }
        );
        const archHeaderBanner = initialValidationValues.archHeaderBanner;
        expect(archHeaderBanner?.[0]?.[0]).toBe('Architecture Submittal Log Settings');
        expect((archHeaderBanner?.[1] ?? []).map((c) => String(c ?? '').trim())).toContain(
          'Specification Divisions'
        );
        expect(initialSnapshots[archContactsBinding.validationRangeName!].gridRange).toMatchObject({
          startColumnIndex: 6,
          endColumnIndex: 7,
        });
        const contactValidationItems = (
          initialValidationValues[archContactsBinding.validationRangeName!] ?? []
        ).map((row) => String(row[0] ?? ''));
        expect(contactValidationItems).toEqual(['INC', 'PMG', 'FXC', 'IE', 'VLD', 'TT']);
        expect(contactValidationItems).not.toContain('---');

        const statusValidationItems = (
          initialValidationValues[archStatusesBinding.validationRangeName!] ?? []
        ).map((row) => String(row[0] ?? ''));
        expect(statusValidationItems[5]).toBe('---');

        // Create source folder and PDF for DocumentService.processDocument()
        const constructionFolder = await liveDriveClient.findOrCreateFolder(
          provisioned.spaceFolderId,
          '6 Construction'
        );
        localTracker.track(constructionFolder.id);

        const optArchFile = await uploadDummyPdf({
          driveClient: liveDriveClient,
          targetFolderId: provisioned.spaceFolderId,
          fileName: `Opt_Arch_${runId}.pdf`,
          textContent: 'Live Arch Options E2E Target Content',
          trackCleanupId: localTracker.track,
        });

        // 2) Clear Options_Submittal_Arch_Contacts to empty and verify empty-table formatting inheritance + NamedRange expansion + side-by-side stability
        const templateContactsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: templateId,
          sheetName: archContactsBinding.sheetName,
          rangeName: archContactsBinding.rangeName,
          endMarker: archContactsBinding.endMarker,
        });
        expect(templateContactsGrid.headerRow).toEqual(['Type', 'Key', 'Name', 'Aliases']);
        expectAliasesHeaderNote(templateContactsGrid.headerNotes[3]);
        expect(templateContactsGrid.sheetMerges).toContainEqual(
          expect.objectContaining({
            startRowIndex: 1,
            endRowIndex: 2,
            startColumnIndex: 5,
            endColumnIndex: 9,
          })
        );
        const templateDataRow = templateContactsGrid.dataRows.find((r) =>
          r.cells.some((c) => c.formattedValue.trim().length > 0)
        );
        expect(templateDataRow).toBeDefined();
        if (!templateDataRow) return;
        expect(templateDataRow.cells.some((c) => c.userEnteredFormat !== undefined)).toBe(true);

        const clearResult = await clearOptionTableToEmpty(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: archContactsBinding.sheetName,
          rangeName: archContactsBinding.rangeName,
          validationRangeName: archContactsBinding.validationRangeName,
          endMarker: archContactsBinding.endMarker,
        });
        expect(clearResult.absTerminatorRowIndex).toBeGreaterThan(0);

        const clearedArchRead = await logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-arch',
          selectedLogId: optSpreadsheetId,
          sourceKeys: ['contacts'],
        });
        expect(clearedArchRead.status).toBe('ready');
        if (clearedArchRead.status !== 'ready') return;
        expect(clearedArchRead.tables.contacts?.tuples).toEqual([]);

        const archConfigRanges = [
          archStatusesBinding.rangeName,
          ...(archStatusesBinding.validationRangeName ? [archStatusesBinding.validationRangeName] : []),
          archActionsBinding.rangeName,
          archContactsBinding.rangeName,
          ...(archContactsBinding.validationRangeName ? [archContactsBinding.validationRangeName] : []),
        ];
        const archSnapshotsBefore = await snapshotNamedRanges(
          sheetsApi,
          optSpreadsheetId,
          archConfigRanges,
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const archValuesBefore = await readNamedRangesFormattedValues(
          sheetsApi,
          optSpreadsheetId,
          archSnapshotsBefore,
          DEFAULT_LIVE_RETRY_OPTIONS
        );

        const customArchContact = `T363C_${runId.slice(-4).toUpperCase()}`;
        const optArchService = await documentServiceFactory({
          selectedLogId: optSpreadsheetId,
          sourceFiles: [{ id: optArchFile.id, name: optArchFile.name, mimeType: 'application/pdf' }],
        });
        const archSubmit = await optArchService.processDocument(
          {
            type: 'submittal-arch',
            space: optSpace,
            data: {
              status: 'Open',
              section: '071200',
              number: '001',
              revision: '0',
              title: 'Empty Contacts Format Inheritance Test',
              date: '260401',
              contact: customArchContact,
              action: 'REC',
              notes: 'Ticket 363 empty table insert',
            },
          },
          'onSubmit'
        );
        expect(archSubmit.success).toBe(true);
        if (!archSubmit.success) return;
        expect(archSubmit.activities.map((a) => a.type)).toEqual([
          'MOVE_FILE',
          'DUPLICATE_FILE',
          'INSERT_PAGES',
          'WRITE_LOG',
        ]);

        const archSnapshotsAfter = await snapshotNamedRanges(
          sheetsApi,
          optSpreadsheetId,
          archConfigRanges,
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const archValuesAfter = await readNamedRangesFormattedValues(
          sheetsApi,
          optSpreadsheetId,
          archSnapshotsAfter,
          DEFAULT_LIVE_RETRY_OPTIONS
        );

        expect(archSnapshotsAfter[archContactsBinding.rangeName].gridRange.endRowIndex).toBe(
          (archSnapshotsBefore[archContactsBinding.rangeName].gridRange.endRowIndex ?? 0) + 1
        );
        if (archContactsBinding.validationRangeName) {
          expect(
            archSnapshotsAfter[archContactsBinding.validationRangeName].gridRange.endRowIndex
          ).toBe(clearResult.absTerminatorRowIndex + 1);
        }

        const untouchedArchRanges = [
          archStatusesBinding.rangeName,
          ...(archStatusesBinding.validationRangeName ? [archStatusesBinding.validationRangeName] : []),
          archActionsBinding.rangeName,
        ];
        expect(
          findSideBySideTableShiftViolations({
            beforeSnapshots: archSnapshotsBefore,
            afterSnapshots: archSnapshotsAfter,
            beforeValues: archValuesBefore,
            afterValues: archValuesAfter,
            rangeNames: untouchedArchRanges,
          })
        ).toEqual([]);

        const copiedContactsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: archContactsBinding.sheetName,
          rangeName: archContactsBinding.rangeName,
          endMarker: archContactsBinding.endMarker,
        });
        const keyColIndex = copiedContactsGrid.headerRow.indexOf('Key');
        expect(keyColIndex).toBeGreaterThanOrEqual(0);
        const insertedContactRow = copiedContactsGrid.dataRows.find(
          (r) => r.cells[keyColIndex]?.formattedValue.trim() === customArchContact
        );
        expect(insertedContactRow).toBeDefined();
        expect(insertedContactRow?.cells.map((c) => c.userEnteredFormat)).toEqual(
          templateDataRow.cells.map((c) => c.userEnteredFormat)
        );

        const updatedArchRead = await logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-arch',
          selectedLogId: optSpreadsheetId,
          sourceKeys: ['contacts'],
        });
        expect(updatedArchRead.status).toBe('ready');
        if (updatedArchRead.status !== 'ready') return;
        expect(updatedArchRead.tables.contacts?.tuples).toContainEqual(
          expect.objectContaining({ key: customArchContact, name: customArchContact })
        );
        expect(
          await findSpreadsheetErrorTokens(sheetsApi, optSpreadsheetId, DEFAULT_LIVE_RETRY_OPTIONS)
        ).toEqual([]);
      } finally {
        await localTracker.trashAll(liveDriveClient);
      }
    }, 180_000);

    it('resolves submittal-arch Contacts via SourceParser Pass 2 using seeded and RFC 4180 CSV Tier 2 Aliases alongside additive Tier 3 @domain fallback on a copied DocumentLog', async () => {
      const liveDriveClient = requireDriveClient();
      const archLogSchema = logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-arch');
      expect(archLogSchema).toBeDefined();
      if (!archLogSchema) {
        return;
      }

      const archContactsBinding = archLogSchema.optionBindings?.contacts;
      expect(archContactsBinding).toBeDefined();
      if (!archContactsBinding) {
        return;
      }

      const runId = `sp-arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          driveClient: liveDriveClient,
          logWiring,
          spaceName: `Harborview SourceParser Live ${runId}`,
          spaceId: `live-sp-arch-space-${runId}`,
          trackCleanupId: localTracker.track,
        });
        const spSpace = provisioned.space;
        const spSpreadsheetId = provisioned.spreadsheetId;

        // 1) Seeded Tier 2 Aliases match out of the box on untouched copied template
        const seededParser = sourceParserWiring.createSourceParser({});
        const seededDomainMatch = await seededParser.extractFields({
          documentTypeKey: 'submittal-arch',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-seeded-domain-${runId}`,
              subject: '071200-001 Waterproofing Membrane',
              from: 'Structural Engineer <structural@thorntontomasetti.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(seededDomainMatch.fields.contact).toBe('TT');

        const seededPhraseMatch = await seededParser.extractFields({
          documentTypeKey: 'submittal-arch',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-seeded-phrase-${runId}`,
              subject: '071200-001 Waterproofing Membrane',
              from: 'FXFOWLE <noreply@external-relay.example>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(seededPhraseMatch.fields.contact).toBe('FXC');

        // 2) Customize Tier 2 Aliases on copied DocumentLog:
        //    - PMG gets RFC 4180 CSV with comma + escaped "" quotes and omits @pavarini.com (verifying additive Tier 3 retention)
        //    - FXC gets @ventresca.com (verifying Tier 2 token override over Tier 3 VLD)
        const contactsSnapshot = await snapshotNamedRanges(
          sheetsApi,
          spSpreadsheetId,
          [archContactsBinding.rangeName],
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const contactsRange = contactsSnapshot[archContactsBinding.rangeName];
        const contactsValues =
          (
            await readNamedRangesFormattedValues(
              sheetsApi,
              spSpreadsheetId,
              contactsSnapshot,
              DEFAULT_LIVE_RETRY_OPTIONS
            )
          )[archContactsBinding.rangeName] ?? [];
        const headerRow = contactsValues[0] ?? [];
        const keyColOffset = headerRow.findIndex((c) => String(c).trim() === 'Key');
        const aliasesColOffset = headerRow.findIndex((c) => String(c).trim() === 'Aliases');
        expect(keyColOffset).toBeGreaterThanOrEqual(0);
        expect(aliasesColOffset).toBeGreaterThanOrEqual(0);

        const pmgRowOffset = contactsValues.findIndex(
          (r) => String(r[keyColOffset] ?? '').trim() === 'PMG'
        );
        const fxcRowOffset = contactsValues.findIndex(
          (r) => String(r[keyColOffset] ?? '').trim() === 'FXC'
        );
        expect(pmgRowOffset).toBeGreaterThan(0);
        expect(fxcRowOffset).toBeGreaterThan(0);

        const startRow = (contactsRange.gridRange.startRowIndex ?? 0) + 1;
        const aliasesColLetter = columnIndexToLetter(
          (contactsRange.gridRange.startColumnIndex ?? 0) + aliasesColOffset
        );
        await sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId: spSpreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              {
                range: `'${archContactsBinding.sheetName}'!${aliasesColLetter}${startRow + pmgRowOffset}`,
                values: [['"Pavarini, ""NYC"" Group", PMG-Custom']],
              },
              {
                range: `'${archContactsBinding.sheetName}'!${aliasesColLetter}${startRow + fxcRowOffset}`,
                values: [['@ventresca.com, FXC-Custom']],
              },
            ],
          },
        });

        // Use a fresh WorkspaceExecutionContext so per-request LookupOptions cache reads updated Aliases
        const customParser = sourceParserWiring.createSourceParser({});

        const rfc4180CsvMatch = await customParser.extractFields({
          documentTypeKey: 'submittal-arch',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-csv-quoted-${runId}`,
              subject: '071200-001 Waterproofing Membrane',
              from: 'Pavarini, "NYC" Group <noreply@relay.example.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(rfc4180CsvMatch.fields.contact).toBe('PMG');

        const additiveTier3DomainMatch = await customParser.extractFields({
          documentTypeKey: 'submittal-arch',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-tier3-retained-${runId}`,
              subject: '071200-001 Waterproofing Membrane',
              from: 'Alice <alice@pavarini.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(additiveTier3DomainMatch.fields.contact).toBe('PMG');

        const tier2OverrideMatch = await customParser.extractFields({
          documentTypeKey: 'submittal-arch',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-tier2-override-${runId}`,
              subject: '071200-001 Waterproofing Membrane',
              from: 'Lighting <lighting@ventresca.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(tier2OverrideMatch.fields.contact).toBe('FXC');

        const tier3NonCollidingPhraseMatch = await customParser.extractFields({
          documentTypeKey: 'submittal-arch',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-tier3-vld-${runId}`,
              subject: '071200-001 Waterproofing Membrane',
              from: 'Ventresca Lighting <noreply@other.example.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(tier3NonCollidingPhraseMatch.fields.contact).toBe('VLD');

        expect(
          await findSpreadsheetErrorTokens(sheetsApi, spSpreadsheetId, DEFAULT_LIVE_RETRY_OPTIONS)
        ).toEqual([]);
      } finally {
        await localTracker.trashAll(liveDriveClient);
      }
    }, 120_000);
  }
);

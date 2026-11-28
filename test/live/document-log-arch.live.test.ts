import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { columnIndexToLetter, type PositiveTableTarget } from '../../src/infrastructure/sheets';
import {
  LiveTestHarness,
  type LiveAppWiring,
} from './live-test-harness';
import {
  TEST_FOLDER_ID,
  findGridErrorTokens,
  getRowCellsFromSpreadsheetGrid,
  provisionDocumentLogScratchSpace,
  sampleFixture,
  uploadDummyPdf,
} from './document-log-live-setup';

describe.skipIf(!TEST_FOLDER_ID)(
  'Live DocumentLog Submittal Arch Tracer Bullets (Copy-and-Trash)',
  () => {
    const cleanupTracker = LiveTestHarness.cleanup.createCleanupTracker();
    let wiring: LiveAppWiring | undefined;

    let spaceFolderId: string;
    let space: { id: string; typeId: string; name: string; abstractStorageId: string };
    let copiedSpreadsheetId: string;
    let adminFolderId: string | undefined;
    let archFile1: { id: string; name: string };
    let archFile2: { id: string; name: string };

    const requireWiring = (): LiveAppWiring => {
      if (!wiring) {
        throw new Error('LiveAppWiring is not initialized.');
      }
      return wiring;
    };

    const archTarget = (spreadsheetId = copiedSpreadsheetId): PositiveTableTarget =>
      LiveTestHarness.sheets.buildPositiveTableTarget(spreadsheetId, sampleFixture.submittalArch);

    beforeAll(async () => {
      if (!TEST_FOLDER_ID) {
        throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live DocumentLog Arch tests.');
      }

      wiring = await LiveTestHarness.app.createWiring();
      expect(wiring.lookupTimeoutMs).toBe(LiveTestHarness.app.DEFAULT_LIVE_LOOKUP_TIMEOUT_MS);

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const provisioned = await provisionDocumentLogScratchSpace({
        wiring,
        spaceName: `Harborview Arch Live ${runId}`,
        spaceId: `live-arch-space-${runId}`,
        tracker: cleanupTracker,
      });
      spaceFolderId = provisioned.spaceFolderId;
      space = provisioned.space;
      copiedSpreadsheetId = provisioned.spreadsheetId;
      adminFolderId = provisioned.adminFolderId;

      const [constructionFolder, file1, file2] = await Promise.all([
        wiring.driveClient.findOrCreateFolder(spaceFolderId, '6 Construction'),
        uploadDummyPdf({
          driveClient: wiring.driveClient,
          targetFolderId: spaceFolderId,
          fileName: `Live_Arch_1_${runId}.pdf`,
          textContent: 'Live Submittal Arch Tracer Bullet 1',
          tracker: cleanupTracker,
        }),
        uploadDummyPdf({
          driveClient: wiring.driveClient,
          targetFolderId: spaceFolderId,
          fileName: `Live_Arch_2_${runId}.pdf`,
          textContent: 'Live Submittal Arch Tracer Bullet 2',
          tracker: cleanupTracker,
        }),
      ]);
      cleanupTracker.trackFolder(constructionFolder.id, spaceFolderId);
      archFile1 = file1;
      archFile2 = file2;

      await LiveTestHarness.sheets.ensureClearedPositiveTable(
        wiring.sheetsApi,
        archTarget(copiedSpreadsheetId),
        LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
      );
    }, 90_000);

    afterAll(async () => {
      const counts = wiring?.apiTracker.getCounts();
      if (counts) {
        console.info(
          `[test:live:arch] Sheets reads=${counts.sheets.reads}, writes=${counts.sheets.writes}, Drive reads=${counts.drive.reads}, writes=${counts.drive.writes}`,
          counts.sheets.byMethod
        );
      }
      await LiveTestHarness.cleanup.cleanupScratchSpace({
        driveClient: wiring?.driveClient,
        spaceFolderId,
        adminFolderId,
        tracker: cleanupTracker,
      });
      if (counts) {
        expect(counts.sheets.reads).toBeLessThanOrEqual(50);
      }
    }, 90_000);

    it('provisions a new DocumentLog (0 -> 1) via copyLog() and stays idempotent on repeat calls in an isolated sub-space', async () => {
      const liveWiring = requireWiring();
      const runId = `copy-arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const { counts } = await liveWiring.apiTracker.measure(async () => {
          const provisioned = await provisionDocumentLogScratchSpace({
            wiring: liveWiring,
            spaceName: `Harborview Arch Copy ${runId}`,
            spaceId: `live-copy-arch-${runId}`,
            tracker: localTracker,
          });
          expect(provisioned.copyResult.created).toBe(true);
          expect(provisioned.copyResult.folderPath).toBe('1 Admin');
          expect(provisioned.copyResult.candidate.name).toBe(`${provisioned.spaceName} Document Log`);
          expect(provisioned.spreadsheetId).not.toBe(sampleFixture.metadata.templateSpreadsheetId);

          const adminFolder = await liveWiring.driveClient.resolveFolderPath(
            provisioned.spaceFolderId,
            ['1 Admin']
          );
          expect(adminFolder.name).toBe('1 Admin');
          const copiedMeta = await liveWiring.driveClient.getFile(provisioned.spreadsheetId);
          expect(copiedMeta.parents).toContain(adminFolder.id);

          const firstResolved = await liveWiring.logWiring.documentLogService.resolveLog(
            provisioned.space
          );
          expect(firstResolved.status).toBe('resolved');
          if (firstResolved.status !== 'resolved') return;
          expect(firstResolved.candidate.id).toBe(provisioned.spreadsheetId);

          const secondCopy = await liveWiring.logWiring.documentLogService.copyLog(provisioned.space);
          localTracker.trackSpreadsheet(
            secondCopy.candidate.id,
            provisioned.adminFolderId ?? provisioned.spaceFolderId
          );
          expect(secondCopy.created).toBe(false);
          expect(secondCopy.candidate.id).toBe(provisioned.spreadsheetId);

          const secondResolved = await liveWiring.logWiring.documentLogService.resolveLog(
            provisioned.space
          );
          expect(secondResolved.status).toBe('resolved');
          if (secondResolved.status !== 'resolved') return;
          expect(secondResolved.candidates).toHaveLength(1);
        });

        expect(counts.sheets.reads).toBe(0);
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 60_000);

    it('executes representative submittal-arch processDocument() tracer bullets with pre-seeded INC contact, selectedLogId fast-path, and Drive leaf-folder filing', async () => {
      const liveWiring = requireWiring();

      const entries: Array<{
        file: { id: string; name: string };
        data: Record<string, unknown>;
        expectedLeafPrefix: RegExp;
      }> = [
        {
          file: archFile1,
          data: {
            status: 'Closed',
            section: '033000',
            number: '001',
            revision: '0',
            title: 'Cast-in-Place Concrete Mix Design',
            date: '260115',
            contact: 'INC',
            action: 'NET',
            notes: '',
          },
          expectedLeafPrefix: /^03\b/,
        },
        {
          file: archFile2,
          data: {
            status: 'Open',
            section: '071200',
            number: '001',
            revision: '0',
            title: 'Fluid-Applied Waterproofing Membrane',
            date: '260204',
            contact: 'INC',
            action: 'RR',
            notes: 'Terrace deck assembly',
          },
          expectedLeafPrefix: /^07\b/,
        },
      ];

      for (const entry of entries) {
        const service = await liveWiring.documentServiceFactory({
          selectedLogId: copiedSpreadsheetId,
          sourceFiles: [{ id: entry.file.id, name: entry.file.name, mimeType: 'application/pdf' }],
        });

        const { result, counts } = await liveWiring.apiTracker.measure(() =>
          service.processDocument(
            {
              type: 'submittal-arch',
              space,
              sourceFiles: [{ id: entry.file.id, name: entry.file.name, mimeType: 'application/pdf' }],
              data: entry.data,
            },
            'onSubmit'
          )
        );

        expect(result.success).toBe(true);
        if (!result.success) return;

        expect(counts.sheets.reads).toBe(5);
        expect(counts.sheets.writes).toBe(1);
        expect(counts.drive.byMethod['drives.list'] ?? 0).toBe(0);

        expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
        const logWrite = result.contextVariables?.documentLogWrite as
          | { spreadsheetId: string; sheetName: string; sheetId?: number; rowNumber: number; uri: string }
          | undefined;
        expect(logWrite).toMatchObject({
          spreadsheetId: copiedSpreadsheetId,
          sheetName: sampleFixture.submittalArch.sheetName,
        });
        expect(typeof logWrite?.sheetId).toBe('number');
        expect(logWrite?.uri).toBe(
          `https://docs.google.com/spreadsheets/d/${copiedSpreadsheetId}/edit#gid=${logWrite?.sheetId}&range=${logWrite?.rowNumber}:${logWrite?.rowNumber}`
        );
        expect(result.stepOutputs?.writeLog?.files).toBeUndefined();
        expect(result.files?.length).toBeGreaterThan(0);

        const movedFileMeta = await liveWiring.driveClient.getFile(entry.file.id);
        const leafFolderId = movedFileMeta.parents?.[0];
        expect(leafFolderId).toBeDefined();
        if (leafFolderId) {
          const leafMeta = await liveWiring.driveClient.getFile(leafFolderId);
          expect(leafMeta.name).toMatch(entry.expectedLeafPrefix);
          const closedFolder = await liveWiring.driveClient.resolveFolderPath(spaceFolderId, [
            '6 Construction',
            'Submittals',
            'Closed',
          ]);
          expect(leafMeta.parents).toContain(closedFolder.id);
        }
      }
    }, 90_000);

    it('hydrates full and batch-filtered Submittal Arch logs with =HYPERLINK fileUri via DocumentLogPort.readLog()', async () => {
      const liveWiring = requireWiring();
      const perReqLogService = liveWiring.logWiring.getPerRequestService({});

      let fullRead = await perReqLogService.readLog({
        documentTypeKey: 'submittal-arch',
        space,
      });

      // Self-heal when executed standalone via -t without the preceding processDocument test
      if (fullRead.entries.length === 0) {
        await LiveTestHarness.sheets.appendRawPositiveTableRows(
          liveWiring.sheetsApi,
          archTarget(copiedSpreadsheetId),
          [
            {
              Status: 'Closed',
              Section: '033000',
              Number: '001',
              Revision: '0',
              Title: 'Cast-in-Place Concrete Mix Design',
              Date: '260115',
              Contact: 'INC',
              Action: 'No Exceptions Taken',
              Notes: null,
              'Calc Link': {
                formula: `=HYPERLINK("https://drive.google.com/file/d/${archFile1.id}/view", "Link")`,
              },
            },
            {
              Status: 'Open',
              Section: '071200',
              Number: '001',
              Revision: '0',
              Title: 'Fluid-Applied Waterproofing Membrane',
              Date: '260204',
              Contact: 'INC',
              Action: 'Revise & Resubmit',
              Notes: 'Terrace deck assembly',
              'Calc Link': {
                formula: `=HYPERLINK("https://drive.google.com/file/d/${archFile2.id}/view", "Link")`,
              },
            },
          ],
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        fullRead = await perReqLogService.readLog({
          documentTypeKey: 'submittal-arch',
          space,
        });
      }

      expect(fullRead.spreadsheetId).toBe(copiedSpreadsheetId);
      expect(fullRead.sheetName).toBe(sampleFixture.submittalArch.sheetName);
      expect(fullRead.warnings).toEqual([]);
      expect(fullRead.entries).toHaveLength(2);
      expect(fullRead.entries.map((e) => e.document.id)).toEqual([
        '033000-001-0-260115-7',
        '071200-001-0-260204-5',
      ]);
      expect(fullRead.entries[0].document.data).toMatchObject({
        section: '033000',
        number: '001',
        status: { key: 'Closed' },
        contact: { key: 'INC', name: 'INC Architecture and Design' },
        action: { key: 'NET', name: 'No Exceptions Taken', order: '7' },
      });
      expect('notes' in fullRead.entries[0].document.data).toBe(false);
      expect('calculated' in fullRead.entries[0].document).toBe(false);
      expect(fullRead.entries[0].fileUri).toContain(archFile1.id);
      expect(fullRead.entries[1].fileUri).toContain(archFile2.id);

      const { result: byIdGroup, counts: filterCounts } = await liveWiring.apiTracker.measure(() =>
        perReqLogService.readLog({
          documentTypeKey: 'submittal-arch',
          selectedLogId: copiedSpreadsheetId,
          filterBy: 'idGroup',
          values: [' 071200-001 '],
        })
      );
      expect(filterCounts.sheets.reads).toBe(3);
      expect(byIdGroup.warnings).toEqual([]);
      expect(byIdGroup.entries).toHaveLength(1);
      expect(byIdGroup.entries[0].document.id).toBe('071200-001-0-260204-5');
      expect(byIdGroup.entries[0].fileUri).toContain(archFile2.id);
    }, 60_000);

    it('reads option tables with zero Drive discovery and resolves submittal-arch Contacts via SourceParser Pass 2 seeded and RFC 4180 CSV Aliases on an isolated copy', async () => {
      const liveWiring = requireWiring();
      const archLogSchema = liveWiring.logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-arch');
      const archContactsBinding = archLogSchema?.optionBindings?.contacts;
      expect(archContactsBinding).toBeDefined();
      if (!archContactsBinding) return;

      const runId = `sp-arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          wiring: liveWiring,
          spaceName: `Harborview Arch SourceParser ${runId}`,
          spaceId: `live-sp-arch-${runId}`,
          tracker: localTracker,
        });
        const spSpace = provisioned.space;
        const spSpreadsheetId = provisioned.spreadsheetId;

        const seededCtx = {};
        const perReqLogService = liveWiring.logWiring.getPerRequestService(seededCtx);
        const { result: initialArchOptions, counts: optCounts } =
          await liveWiring.apiTracker.measure(() =>
            perReqLogService.readOptionTables!({
              documentTypeKey: 'submittal-arch',
              space: spSpace,
              selectedLogId: spSpreadsheetId,
            })
          );

        expect(optCounts.sheets.reads).toBe(2);
        expect(optCounts.drive.total).toBe(0);
        expect(initialArchOptions.status).toBe('ready');
        if (initialArchOptions.status !== 'ready') return;
        expect(initialArchOptions.tables.statuses?.tuples.length).toBeGreaterThan(0);
        expect(initialArchOptions.tables.actions?.tuples.length).toBeGreaterThan(0);
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

        // Shares seededCtx optionTablesMemo -> 0 extra Sheets reads
        const seededParser = liveWiring.sourceParserWiring.createSourceParser(seededCtx);
        const { result: seededMatch, counts: seededParseCounts } =
          await liveWiring.apiTracker.measure(() =>
            seededParser.extractFields({
              documentTypeKey: 'submittal-arch',
              spaceId: spSpace.abstractStorageId,
              selectedLogId: spSpreadsheetId,
              context: {
                isDriveUrl: false,
                email: {
                  id: `msg-seeded-${runId}`,
                  subject: '071200-001 Waterproofing Membrane',
                  from: 'Structural Engineer <structural@thorntontomasetti.com>',
                  to: 'PM <pm@inc.nyc>',
                  date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                  labels: ['INBOX'],
                },
              },
            })
          );
        expect(seededParseCounts.sheets.reads).toBe(0);
        expect(seededMatch.fields.contact).toBe('TT');

        const gridSnapshot = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
          liveWiring.sheetsApi,
          {
            spreadsheetId: spSpreadsheetId,
            targets: [
              {
                sheetName: archContactsBinding.sheetName,
                rangeName: archContactsBinding.rangeName,
                endMarker: archContactsBinding.endMarker,
              },
            ],
            snapshotRangeNames: [archContactsBinding.rangeName],
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        const contactsSnap = gridSnapshot.namedRanges[archContactsBinding.rangeName];
        const contactsValues = gridSnapshot.valuesByNamedRange[archContactsBinding.rangeName] ?? [];
        const headerRow = contactsValues[0] ?? [];
        const keyColOffset = headerRow.findIndex((c) => String(c).trim() === 'Key');
        const aliasesColOffset = headerRow.findIndex((c) => String(c).trim() === 'Aliases');
        const pmgRowOffset = contactsValues.findIndex((r) => String(r[keyColOffset] ?? '').trim() === 'PMG');
        const fxcRowOffset = contactsValues.findIndex((r) => String(r[keyColOffset] ?? '').trim() === 'FXC');
        expect(pmgRowOffset).toBeGreaterThan(0);
        expect(fxcRowOffset).toBeGreaterThan(0);

        const startRow = (contactsSnap.gridRange.startRowIndex ?? 0) + 1;
        const aliasesColLetter = columnIndexToLetter(
          (contactsSnap.gridRange.startColumnIndex ?? 0) + aliasesColOffset
        );
        await LiveTestHarness.sheets.batchUpdateSpreadsheetValues(
          liveWiring.sheetsApi,
          spSpreadsheetId,
          [
            {
              range: `'${archContactsBinding.sheetName}'!${aliasesColLetter}${startRow + pmgRowOffset}`,
              values: [['"Pavarini, ""NYC"" Group", PMG-Custom']],
            },
            {
              range: `'${archContactsBinding.sheetName}'!${aliasesColLetter}${startRow + fxcRowOffset}`,
              values: [['@ventresca.com, FXC-Custom']],
            },
          ],
          'RAW',
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );

        const customParser = liveWiring.sourceParserWiring.createSourceParser({});
        const { result: csvMatch, counts: customParseCounts } =
          await liveWiring.apiTracker.measure(() =>
            customParser.extractFields({
              documentTypeKey: 'submittal-arch',
              spaceId: spSpace.abstractStorageId,
              selectedLogId: spSpreadsheetId,
              context: {
                isDriveUrl: false,
                email: {
                  id: `msg-csv-${runId}`,
                  subject: '071200-001 Waterproofing Membrane',
                  from: 'Pavarini, "NYC" Group <noreply@relay.example.com>',
                  to: 'PM <pm@inc.nyc>',
                  date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                  labels: ['INBOX'],
                },
              },
            })
          );
        expect(customParseCounts.sheets.reads).toBe(2);
        expect(csvMatch.fields.contact).toBe('PMG');

        const [additiveTier3, tier2Override, nonCollidingVld] = await Promise.all([
          customParser.extractFields({
            documentTypeKey: 'submittal-arch',
            spaceId: spSpace.abstractStorageId,
            selectedLogId: spSpreadsheetId,
            context: {
              isDriveUrl: false,
              email: {
                id: `msg-tier3-${runId}`,
                subject: '071200-001 Waterproofing Membrane',
                from: 'Alice <alice@pavarini.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                labels: ['INBOX'],
              },
            },
          }),
          customParser.extractFields({
            documentTypeKey: 'submittal-arch',
            spaceId: spSpace.abstractStorageId,
            selectedLogId: spSpreadsheetId,
            context: {
              isDriveUrl: false,
              email: {
                id: `msg-override-${runId}`,
                subject: '071200-001 Waterproofing Membrane',
                from: 'Lighting <lighting@ventresca.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                labels: ['INBOX'],
              },
            },
          }),
          customParser.extractFields({
            documentTypeKey: 'submittal-arch',
            spaceId: spSpace.abstractStorageId,
            selectedLogId: spSpreadsheetId,
            context: {
              isDriveUrl: false,
              email: {
                id: `msg-vld-${runId}`,
                subject: '071200-001 Waterproofing Membrane',
                from: 'Ventresca Lighting <noreply@other.example.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                labels: ['INBOX'],
              },
            },
          }),
        ]);
        expect(additiveTier3.fields.contact).toBe('PMG');
        expect(tier2Override.fields.contact).toBe('FXC');
        expect(nonCollidingVld.fields.contact).toBe('VLD');
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 120_000);

    it('verifies Validation_* expansion, 4-column Row 4 format cloning, clean-template write-back, and side-by-side _Config stability on an isolated copy', async () => {
      const liveWiring = requireWiring();
      const templateId = sampleFixture.metadata.templateSpreadsheetId;
      const archLogSchema = liveWiring.logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-arch');
      const archContactsBinding = archLogSchema?.optionBindings?.contacts;
      const archStatusesBinding = archLogSchema?.optionBindings?.statuses;
      const archActionsBinding = archLogSchema?.optionBindings?.actions;
      expect(archContactsBinding).toBeDefined();
      expect(archStatusesBinding).toBeDefined();
      expect(archActionsBinding).toBeDefined();
      if (!archContactsBinding || !archStatusesBinding || !archActionsBinding) return;

      const templateGrid = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
        liveWiring.sheetsApi,
        {
          spreadsheetId: templateId,
          targets: [
            {
              sheetName: archContactsBinding.sheetName,
              rangeName: archContactsBinding.rangeName,
              endMarker: archContactsBinding.endMarker,
            },
          ],
        },
        LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
      );
      const templateContactsInfo = templateGrid.tables[archContactsBinding.rangeName];
      expect(templateContactsInfo.headerRow).toEqual(['Type', 'Key', 'Name', 'Aliases']);
      LiveTestHarness.sheets.expectAliasesHeaderNote(templateContactsInfo.headerNotes[3]);
      expect(templateContactsInfo.sheetMerges).toContainEqual(
        expect.objectContaining({
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 5,
          endColumnIndex: 9,
        })
      );
      const templateDataRow = templateContactsInfo.dataRows.find((r) =>
        r.cells.some((c) => c.formattedValue.trim().length > 0)
      );
      expect(templateDataRow).toBeDefined();
      if (!templateDataRow) return;
      expect(templateDataRow.cells.some((c) => c.userEnteredFormat !== undefined)).toBe(true);

      const runId = `opt-arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          wiring: liveWiring,
          spaceName: `Harborview Arch Writeback ${runId}`,
          spaceId: `live-opt-arch-${runId}`,
          tracker: localTracker,
        });
        const optSpace = provisioned.space;
        const optSpreadsheetId = provisioned.spreadsheetId;

        const [constructionFolder, optArchFile] = await Promise.all([
          liveWiring.driveClient.findOrCreateFolder(provisioned.spaceFolderId, '6 Construction'),
          uploadDummyPdf({
            driveClient: liveWiring.driveClient,
            targetFolderId: provisioned.spaceFolderId,
            fileName: `Opt_Arch_${runId}.pdf`,
            textContent: 'Live Arch Options Writeback Target',
            tracker: localTracker,
          }),
        ]);
        localTracker.trackFolder(constructionFolder.id, provisioned.spaceFolderId);

        const clearResults = await LiveTestHarness.sheets.clearOptionTablesToEmpty(
          liveWiring.sheetsApi,
          {
            spreadsheetId: optSpreadsheetId,
            targets: [
              {
                sheetName: archContactsBinding.sheetName,
                rangeName: archContactsBinding.rangeName,
                validationRangeName: archContactsBinding.validationRangeName,
                endMarker: archContactsBinding.endMarker,
              },
            ],
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        const clearResult = clearResults[archContactsBinding.rangeName];
        expect(clearResult.absTerminatorRowIndex).toBeGreaterThan(0);

        const archConfigRanges = [
          archStatusesBinding.rangeName,
          ...(archStatusesBinding.validationRangeName ? [archStatusesBinding.validationRangeName] : []),
          archActionsBinding.rangeName,
          archContactsBinding.rangeName,
          ...(archContactsBinding.validationRangeName ? [archContactsBinding.validationRangeName] : []),
        ];

        const beforeGrid = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
          liveWiring.sheetsApi,
          {
            spreadsheetId: optSpreadsheetId,
            targets: [
              {
                sheetName: archContactsBinding.sheetName,
                rangeName: archContactsBinding.rangeName,
                endMarker: archContactsBinding.endMarker,
              },
            ],
            snapshotRangeNames: archConfigRanges,
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        expect(beforeGrid.tables[archContactsBinding.rangeName].dataRows.every(
          (r) => r.cells.every((c) => c.formattedValue.trim() === '')
        )).toBe(true);
        const statusValBefore = (
          beforeGrid.valuesByNamedRange[archStatusesBinding.validationRangeName!] ?? []
        ).map((row) => String(row[0] ?? ''));
        expect(statusValBefore[5]).toBe('---');

        const customArchContact = `T417C_${runId.slice(-4).toUpperCase()}`;
        const optArchService = await liveWiring.documentServiceFactory({
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
              action: 'RR',
              notes: 'Ticket 417 empty table insert',
            },
          },
          'onSubmit'
        );
        expect(archSubmit.success).toBe(true);
        if (!archSubmit.success) return;
        expect(archSubmit.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);

        const afterGrid = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
          liveWiring.sheetsApi,
          {
            spreadsheetId: optSpreadsheetId,
            targets: [
              {
                sheetName: archContactsBinding.sheetName,
                rangeName: archContactsBinding.rangeName,
                endMarker: archContactsBinding.endMarker,
              },
            ],
            snapshotRangeNames: archConfigRanges,
            extraRanges: [`'${sampleFixture.submittalArch.sheetName}'!A4:J6`],
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );

        expect(afterGrid.namedRanges[archContactsBinding.rangeName].gridRange.endRowIndex).toBe(
          (beforeGrid.namedRanges[archContactsBinding.rangeName].gridRange.endRowIndex ?? 0) + 1
        );
        if (archContactsBinding.validationRangeName) {
          expect(afterGrid.namedRanges[archContactsBinding.validationRangeName].gridRange).toMatchObject({
            startColumnIndex: 6,
            endColumnIndex: 7,
            endRowIndex: clearResult.absTerminatorRowIndex + 1,
          });
          const valItems = (afterGrid.valuesByNamedRange[archContactsBinding.validationRangeName] ?? [])
            .map((r) => String(r[0] ?? ''));
          expect(valItems).toEqual(['', customArchContact]);
          expect(valItems).not.toContain('---');
        }

        const untouchedArchRanges = [
          archStatusesBinding.rangeName,
          ...(archStatusesBinding.validationRangeName ? [archStatusesBinding.validationRangeName] : []),
          archActionsBinding.rangeName,
        ];
        expect(
          LiveTestHarness.sheets.findSideBySideTableShiftViolations({
            beforeSnapshots: beforeGrid.namedRanges,
            afterSnapshots: afterGrid.namedRanges,
            beforeValues: beforeGrid.valuesByNamedRange,
            afterValues: afterGrid.valuesByNamedRange,
            rangeNames: untouchedArchRanges,
          })
        ).toEqual([]);

        const bannerRow0 = getRowCellsFromSpreadsheetGrid(afterGrid.spreadsheet, archContactsBinding.sheetName, 0);
        const bannerRow1 = getRowCellsFromSpreadsheetGrid(afterGrid.spreadsheet, archContactsBinding.sheetName, 1);
        expect(bannerRow0[0]?.formattedValue).toBe('Architecture Submittal Log Settings');
        expect(bannerRow1.map((c) => (c.formattedValue ?? '').trim())).toContain('Specification Divisions');

        const copiedContactsInfo = afterGrid.tables[archContactsBinding.rangeName];
        const keyColIndex = copiedContactsInfo.headerRow.indexOf('Key');
        const insertedContactRow = copiedContactsInfo.dataRows.find(
          (r) => r.cells[keyColIndex]?.formattedValue.trim() === customArchContact
        );
        expect(insertedContactRow).toBeDefined();
        expect(insertedContactRow?.cells.map((c) => c.userEnteredFormat)).toEqual(
          templateDataRow.cells.map((c) => c.userEnteredFormat)
        );
        expect(findGridErrorTokens(afterGrid.spreadsheet)).toEqual([]);

        const updatedArchRead = await liveWiring.logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-arch',
          selectedLogId: optSpreadsheetId,
          sourceKeys: ['contacts'],
        });
        expect(updatedArchRead.status).toBe('ready');
        if (updatedArchRead.status !== 'ready') return;
        expect(updatedArchRead.tables.contacts?.tuples).toContainEqual(
          expect.objectContaining({ key: customArchContact, name: customArchContact })
        );
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 120_000);

    it('resiliently hydrates injected partial-hydration rows on Submittal Arch with filter-scoped warning isolation on an isolated copy', async () => {
      const liveWiring = requireWiring();
      const runId = `ph-arch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          wiring: liveWiring,
          spaceName: `Harborview Arch Partial ${runId}`,
          spaceId: `live-ph-arch-${runId}`,
          tracker: localTracker,
        });
        const phSpreadsheetId = provisioned.spreadsheetId;

        const archRowsToAppend = [
          ...sampleFixture.submittalArch.partialHydrationRows.map((row) =>
            LiveTestHarness.sheets.partialHydrationRowToCellInputs(row)
          ),
          {
            Status: 'Closed',
            Section: '033000',
            Number: '001',
            Revision: '0',
            Title: 'Clean Reference Entry',
            Date: '260115',
            Contact: 'INC',
            Action: 'No Exceptions Taken',
            Notes: null,
            'Calc Link': {
              formula: '=HYPERLINK("https://drive.google.com/file/d/fixture-arch-clean/view", "Link")',
            },
          },
        ];

        const insertedRows = await LiveTestHarness.sheets.appendRawPositiveTableRows(
          liveWiring.sheetsApi,
          archTarget(phSpreadsheetId),
          archRowsToAppend,
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        expect(insertedRows).toHaveLength(4);

        const perReqLogService = liveWiring.logWiring.getPerRequestService({});
        const fullRead = await perReqLogService.readLog({
          documentTypeKey: 'submittal-arch',
          selectedLogId: phSpreadsheetId,
        });
        expect(fullRead.entries).toHaveLength(4);

        const invalidSectionEntry = fullRead.entries.find((e) => e.rowNumber === insertedRows[0]);
        expect(invalidSectionEntry?.valid).toBe(false);
        expect(invalidSectionEntry?.document.idGroup).toBe('7120-001');
        expect(invalidSectionEntry?.fileUri).toBe(
          'https://drive.google.com/file/d/fixture-arch-partial-sec/view'
        );
        expect(
          fullRead.warnings.filter((w) => w.rowNumber === insertedRows[0]).map((w) => w.field)
        ).toEqual(['section']);

        const unknownActionEntry = fullRead.entries.find((e) => e.rowNumber === insertedRows[1]);
        expect(unknownActionEntry?.valid).toBe(false);
        expect(unknownActionEntry?.document.idGroup).toBe('071200-001');
        expect(unknownActionEntry?.document.data.action).toEqual({
          key: 'Approved',
          name: 'Approved',
        });
        expect(unknownActionEntry?.fileUri).toBe(
          'https://drive.google.com/file/d/fixture-arch-raw-url/view'
        );

        const missingDateEntry = fullRead.entries.find((e) => e.rowNumber === insertedRows[2]);
        expect(missingDateEntry?.valid).toBe(false);
        expect('date' in (missingDateEntry?.document.data ?? {})).toBe(false);
        expect(missingDateEntry?.fileUri).toBeUndefined();

        const cleanEntry = fullRead.entries.find((e) => e.rowNumber === insertedRows[3]);
        expect(cleanEntry?.valid).toBe(true);

        const scoped071200 = await perReqLogService.readLog({
          documentTypeKey: 'submittal-arch',
          selectedLogId: phSpreadsheetId,
          filterBy: 'idGroup',
          values: [' 071200-001 '],
        });
        expect(scoped071200.entries).toHaveLength(2);
        expect(scoped071200.warnings.map((w) => w.field)).toEqual(['action', 'date']);
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 90_000);
  }
);

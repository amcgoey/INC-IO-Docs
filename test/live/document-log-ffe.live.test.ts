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
  'Live DocumentLog Submittal FF&E Tracer Bullets (Copy-and-Trash)',
  () => {
    const cleanupTracker = LiveTestHarness.cleanup.createCleanupTracker();
    let wiring: LiveAppWiring | undefined;

    let spaceFolderId: string;
    let space: { id: string; typeId: string; name: string; abstractStorageId: string };
    let copiedSpreadsheetId: string;
    let adminFolderId: string | undefined;
    let ffeFile1: { id: string; name: string };
    let ffeFile2: { id: string; name: string };

    const requireWiring = (): LiveAppWiring => {
      if (!wiring) {
        throw new Error('LiveAppWiring is not initialized.');
      }
      return wiring;
    };

    const ffeTarget = (spreadsheetId = copiedSpreadsheetId): PositiveTableTarget =>
      LiveTestHarness.sheets.buildPositiveTableTarget(spreadsheetId, sampleFixture.submittalFfe);

    beforeAll(async () => {
      if (!TEST_FOLDER_ID) {
        throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live DocumentLog FF&E tests.');
      }

      wiring = await LiveTestHarness.app.createWiring();
      expect(wiring.lookupTimeoutMs).toBe(LiveTestHarness.app.DEFAULT_LIVE_LOOKUP_TIMEOUT_MS);

      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const provisioned = await provisionDocumentLogScratchSpace({
        wiring,
        spaceName: `Harborview FFE Live ${runId}`,
        spaceId: `live-ffe-space-${runId}`,
        tracker: cleanupTracker,
      });
      spaceFolderId = provisioned.spaceFolderId;
      space = provisioned.space;
      copiedSpreadsheetId = provisioned.spreadsheetId;
      adminFolderId = provisioned.adminFolderId;

      const [ffeFolder, file1, file2] = await Promise.all([
        wiring.driveClient.findOrCreateFolder(spaceFolderId, '3 FFE'),
        uploadDummyPdf({
          driveClient: wiring.driveClient,
          targetFolderId: spaceFolderId,
          fileName: `Live_FFE_1_${runId}.pdf`,
          textContent: 'Live Submittal FF&E Tracer Bullet 1',
          tracker: cleanupTracker,
        }),
        uploadDummyPdf({
          driveClient: wiring.driveClient,
          targetFolderId: spaceFolderId,
          fileName: `Live_FFE_2_${runId}.pdf`,
          textContent: 'Live Submittal FF&E Tracer Bullet 2',
          tracker: cleanupTracker,
        }),
      ]);
      cleanupTracker.trackFolder(ffeFolder.id, spaceFolderId);
      ffeFile1 = file1;
      ffeFile2 = file2;

      await LiveTestHarness.sheets.ensureClearedPositiveTable(
        wiring.sheetsApi,
        ffeTarget(copiedSpreadsheetId),
        LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
      );
    }, 90_000);

    afterAll(async () => {
      const counts = wiring?.apiTracker.getCounts();
      if (counts) {
        console.info(
          `[test:live:ffe] Sheets reads=${counts.sheets.reads}, writes=${counts.sheets.writes}, Drive reads=${counts.drive.reads}, writes=${counts.drive.writes}`,
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
      const runId = `copy-ffe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const { counts } = await liveWiring.apiTracker.measure(async () => {
          const provisioned = await provisionDocumentLogScratchSpace({
            wiring: liveWiring,
            spaceName: `Harborview FFE Copy ${runId}`,
            spaceId: `live-copy-ffe-${runId}`,
            tracker: localTracker,
          });
          expect(provisioned.copyResult.created).toBe(true);
          expect(provisioned.copyResult.folderPath).toBe('1 Admin');
          expect(provisioned.copyResult.candidate.name).toBe(`${provisioned.spaceName} Document Log`);
          expect(provisioned.spreadsheetId).not.toBe(sampleFixture.metadata.templateSpreadsheetId);

          const secondCopy = await liveWiring.logWiring.documentLogService.copyLog(provisioned.space);
          localTracker.trackSpreadsheet(
            secondCopy.candidate.id,
            provisioned.adminFolderId ?? provisioned.spaceFolderId
          );
          expect(secondCopy.created).toBe(false);
          expect(secondCopy.candidate.id).toBe(provisioned.spreadsheetId);

          const resolved = await liveWiring.logWiring.documentLogService.resolveLog(provisioned.space);
          expect(resolved.status).toBe('resolved');
          if (resolved.status !== 'resolved') return;
          expect(resolved.candidates).toHaveLength(1);
        });

        expect(counts.sheets.reads).toBe(0);
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 60_000);

    it('executes representative submittal-ffe processDocument() tracer bullets with pre-seeded contacts/vendors, blank Related Tag, and Drive leaf-folder filing', async () => {
      const liveWiring = requireWiring();

      const entries: Array<{
        file: { id: string; name: string };
        data: Record<string, unknown>;
        leafSegments: string[];
      }> = [
        {
          file: ffeFile1,
          data: {
            status: 'Open',
            specTag: 'CG104',
            relatedTag: 'FB127',
            revision: '0',
            specTitle: 'BED - KING',
            vendor: 'BM',
            date: '260120',
            contact: 'INC',
            action: 'RR',
            notes: 'Headboard upholstered in FB127',
          },
          leafSegments: ['3 FFE', '05 Submittals', 'Closed', 'CG', 'CG104'],
        },
        {
          file: ffeFile2,
          data: {
            status: 'Closed',
            specTag: 'AC102',
            relatedTag: '',
            revision: '0',
            specTitle: 'HOOK',
            vendor: 'AL',
            date: '260112',
            contact: 'BW',
            action: 'NET',
            notes: '',
          },
          leafSegments: ['3 FFE', '05 Submittals', 'Closed', 'AC', 'AC102'],
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
              type: 'submittal-ffe',
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
          sheetName: sampleFixture.submittalFfe.sheetName,
        });
        expect(typeof logWrite?.sheetId).toBe('number');
        expect(logWrite?.uri).toBe(
          `https://docs.google.com/spreadsheets/d/${copiedSpreadsheetId}/edit#gid=${logWrite?.sheetId}&range=${logWrite?.rowNumber}:${logWrite?.rowNumber}`
        );
        expect(result.stepOutputs?.writeLog?.files).toBeUndefined();
        expect(result.files?.length).toBeGreaterThan(0);

        const leafFolder = await liveWiring.driveClient.resolveFolderPath(
          spaceFolderId,
          entry.leafSegments
        );
        const movedFileMeta = await liveWiring.driveClient.getFile(entry.file.id);
        expect(movedFileMeta.parents).toContain(leafFolder.id);
      }
    }, 90_000);

    it('hydrates full and case-insensitive batch-filtered Submittal FF&E logs including readOnly Spec Title and =HYPERLINK fileUri via DocumentLogPort.readLog()', async () => {
      const liveWiring = requireWiring();
      const perReqLogService = liveWiring.logWiring.getPerRequestService({});

      let fullRead = await perReqLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        space,
      });

      // Self-heal when executed standalone via -t without the preceding processDocument test
      if (fullRead.entries.length === 0) {
        await LiveTestHarness.sheets.appendRawPositiveTableRows(
          liveWiring.sheetsApi,
          ffeTarget(copiedSpreadsheetId),
          [
            {
              Status: 'Closed',
              'Spec Tag': 'AC102',
              'Related Tag': null,
              Revision: '0',
              Vendor: 'Ashley Lighting',
              Date: '260112',
              Contact: 'BW',
              Action: 'No Exceptions Taken',
              Notes: null,
              'Calc Link': {
                formula: `=HYPERLINK("https://drive.google.com/file/d/${ffeFile2.id}/view", "Link")`,
              },
            },
            {
              Status: 'Open',
              'Spec Tag': 'CG104',
              'Related Tag': 'FB127',
              Revision: '0',
              Vendor: 'Berman Falk',
              Date: '260120',
              Contact: 'INC',
              Action: 'Revise & Resubmit',
              Notes: 'Headboard upholstered in FB127',
              'Calc Link': {
                formula: `=HYPERLINK("https://drive.google.com/file/d/${ffeFile1.id}/view", "Link")`,
              },
            },
          ],
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        fullRead = await perReqLogService.readLog({
          documentTypeKey: 'submittal-ffe',
          space,
        });
      }

      expect(fullRead.spreadsheetId).toBe(copiedSpreadsheetId);
      expect(fullRead.sheetName).toBe(sampleFixture.submittalFfe.sheetName);
      expect(fullRead.warnings).toEqual([]);
      expect(fullRead.entries).toHaveLength(2);
      expect(fullRead.entries.map((e) => e.document.id)).toEqual([
        'AC102-0-260112-7',
        'CG104-0-260120-5',
      ]);

      const [ac102Entry, cg104Entry] = fullRead.entries;
      expect('relatedTag' in ac102Entry.document.data).toBe(false);
      expect('calculated' in ac102Entry.document).toBe(false);
      expect(ac102Entry.document.data).toMatchObject({
        specTag: { key: 'AC102', name: 'HOOK' },
        specTitle: 'HOOK',
        vendor: { key: 'AL', name: 'Ashley Lighting' },
        contact: { key: 'BW', name: 'Benjamin West' },
      });
      expect(ac102Entry.fileUri).toContain(ffeFile2.id);

      expect(cg104Entry.document.data).toMatchObject({
        specTag: { key: 'CG104', name: 'BED - KING' },
        relatedTag: { key: 'FB127', name: 'FABRIC - LEATHER' },
        specTitle: 'BED - KING',
        vendor: { key: 'BM', name: 'Berman Falk' },
        contact: { key: 'INC', name: 'INC Architecture & Design' },
        action: { key: 'RR', name: 'Revise & Resubmit', suffix: '_RR', order: '5' },
      });
      expect(cg104Entry.fileUri).toContain(ffeFile1.id);

      const { result: byIdGroup, counts: filterCounts } = await liveWiring.apiTracker.measure(() =>
        perReqLogService.readLog({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: copiedSpreadsheetId,
          filterBy: 'idGroup',
          values: [' cg104 '],
        })
      );
      expect(filterCounts.sheets.reads).toBe(3);
      expect(byIdGroup.warnings).toEqual([]);
      expect(byIdGroup.entries).toHaveLength(1);
      expect(byIdGroup.entries[0].document.id).toBe('CG104-0-260120-5');
      expect(byIdGroup.entries[0].fileUri).toContain(ffeFile1.id);
    }, 60_000);

    it('reads option tables with zero Drive discovery and resolves submittal-ffe Vendors, Contacts, and duplicate-row Specs via SourceParser Pass 2 Aliases on an isolated copy', async () => {
      const liveWiring = requireWiring();
      const ffeLogSchema = liveWiring.logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-ffe');
      const ffeSpecsBinding = ffeLogSchema?.optionBindings?.specs;
      const ffeVendorsBinding = ffeLogSchema?.optionBindings?.vendors;
      const ffeContactsBinding = ffeLogSchema?.optionBindings?.contacts;
      expect(ffeSpecsBinding).toBeDefined();
      expect(ffeVendorsBinding).toBeDefined();
      expect(ffeContactsBinding).toBeDefined();
      if (!ffeSpecsBinding || !ffeVendorsBinding || !ffeContactsBinding) return;

      const runId = `sp-ffe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          wiring: liveWiring,
          spaceName: `Harborview FFE SourceParser ${runId}`,
          spaceId: `live-sp-ffe-${runId}`,
          tracker: localTracker,
        });
        const spSpace = provisioned.space;
        const spSpreadsheetId = provisioned.spreadsheetId;

        const seededCtx = {};
        const perReqLogService = liveWiring.logWiring.getPerRequestService(seededCtx);
        const { result: initialFfeOptions, counts: optCounts } =
          await liveWiring.apiTracker.measure(() =>
            perReqLogService.readOptionTables!({
              documentTypeKey: 'submittal-ffe',
              space: spSpace,
              selectedLogId: spSpreadsheetId,
            })
          );

        expect(optCounts.sheets.reads).toBe(2);
        expect(optCounts.drive.total).toBe(0);
        expect(initialFfeOptions.status).toBe('ready');
        if (initialFfeOptions.status !== 'ready') return;
        expect(initialFfeOptions.tables.statuses?.tuples.map((t) => t.key)).toEqual([
          'Open',
          'Closed',
          'Waiting',
          'Manager',
          'Billed',
        ]);
        expect(initialFfeOptions.tables.actions?.tuples).toHaveLength(7);
        expect(initialFfeOptions.tables.contacts?.tuples).toHaveLength(4);
        expect(initialFfeOptions.tables.vendors?.tuples).toHaveLength(7);
        expect(initialFfeOptions.tables.specs?.tuples).toHaveLength(33);
        expect(initialFfeOptions.tables.specs?.tuples.every((t) => t.aliases === undefined)).toBe(true);

        // Shares seededCtx optionTablesMemo -> 0 extra Sheets reads
        const seededParser = liveWiring.sourceParserWiring.createSourceParser(seededCtx);
        const { result: seededMatch, counts: seededParseCounts } =
          await liveWiring.apiTracker.measure(() =>
            seededParser.extractFields({
              documentTypeKey: 'submittal-ffe',
              spaceId: spSpace.abstractStorageId,
              selectedLogId: spSpreadsheetId,
              context: {
                isDriveUrl: false,
                email: {
                  id: `msg-ffe-seeded-${runId}`,
                  subject: 'CG104-0 Bed Spec Submittal',
                  from: 'Vendor <sales@fildoux.com>',
                  to: 'PM <pm@inc.nyc>',
                  date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                  labels: ['INBOX'],
                },
              },
            })
          );
        expect(seededParseCounts.sheets.reads).toBe(0);
        expect(seededMatch.fields.specTag).toBe('CG104');
        expect(seededMatch.fields.specTitle).toBe('BED - KING');
        expect(seededMatch.fields.vendor).toBe('FDT');

        const gridSnapshot = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
          liveWiring.sheetsApi,
          {
            spreadsheetId: spSpreadsheetId,
            targets: [
              {
                sheetName: ffeSpecsBinding.sheetName,
                rangeName: ffeSpecsBinding.rangeName,
                endMarker: ffeSpecsBinding.endMarker,
              },
            ],
            snapshotRangeNames: [
              ffeSpecsBinding.rangeName,
              ffeVendorsBinding.rangeName,
              ffeContactsBinding.rangeName,
            ],
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );

        const cellA1ForRowKey = (
          rangeName: string,
          keyHeader: string,
          keyValue: string,
          occurrence = 0
        ): string => {
          const snap = gridSnapshot.namedRanges[rangeName];
          const rows = gridSnapshot.valuesByNamedRange[rangeName] ?? [];
          const header = rows[0] ?? [];
          const keyCol = header.findIndex((c) => String(c).trim() === keyHeader);
          const aliasesCol = header.findIndex((c) => String(c).trim() === 'Aliases');
          let seen = 0;
          const rowOffset = rows.findIndex((r, idx) => {
            if (idx === 0 || String(r[keyCol] ?? '').trim() !== keyValue) {
              return false;
            }
            if (seen === occurrence) {
              return true;
            }
            seen++;
            return false;
          });
          expect(rowOffset).toBeGreaterThan(0);
          const startRow = (snap.gridRange.startRowIndex ?? 0) + 1;
          const colLetter = columnIndexToLetter((snap.gridRange.startColumnIndex ?? 0) + aliasesCol);
          return `'${snap.sheetTitle}'!${colLetter}${startRow + rowOffset}`;
        };

        await LiveTestHarness.sheets.batchUpdateSpreadsheetValues(
          liveWiring.sheetsApi,
          spSpreadsheetId,
          [
            {
              range: cellA1ForRowKey(ffeSpecsBinding.rangeName, 'Tag', 'AC102', 0),
              values: [['XY999, "Hook, ""Solid"" Brass"']],
            },
            {
              range: cellA1ForRowKey(ffeSpecsBinding.rangeName, 'Tag', 'AC102', 1),
              values: [['xy999, ZZ888, "Hook, ""Solid"" Brass"']],
            },
            {
              range: cellA1ForRowKey(ffeVendorsBinding.rangeName, 'Key', 'BM'),
              values: [['"Berman, ""Custom"" Falk", BM-Custom']],
            },
            {
              range: cellA1ForRowKey(ffeVendorsBinding.rangeName, 'Key', 'AL'),
              values: [['AL-Custom']],
            },
            {
              range: cellA1ForRowKey(ffeVendorsBinding.rangeName, 'Key', 'LA'),
              values: [['@ashleylighting.com, LA-Custom']],
            },
            {
              range: cellA1ForRowKey(ffeContactsBinding.rangeName, 'Key', 'BW'),
              values: [['"West, ""NYC"" Procurement", BW-Custom']],
            },
          ],
          'RAW',
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );

        const customParser = liveWiring.sourceParserWiring.createSourceParser({});
        const { result: dupSpecCsvMatch, counts: customParseCounts } =
          await liveWiring.apiTracker.measure(() =>
            customParser.extractFields({
              documentTypeKey: 'submittal-ffe',
              spaceId: spSpace.abstractStorageId,
              selectedLogId: spSpreadsheetId,
              context: {
                isDriveUrl: false,
                email: {
                  id: `msg-ffe-dup-csv-${runId}`,
                  subject: 'ZZ888-0 Berman, "Custom" Falk Submittal',
                  from: 'West, "NYC" Procurement <noreply@relay.example.com>',
                  to: 'PM <pm@inc.nyc>',
                  date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                  labels: ['INBOX'],
                },
              },
            })
          );
        expect(customParseCounts.sheets.reads).toBe(2);
        expect(dupSpecCsvMatch.fields.specTag).toBe('AC102');
        expect(dupSpecCsvMatch.fields.specTitle).toBe('HOOK');
        expect(dupSpecCsvMatch.fields.vendor).toBe('BM');
        expect(dupSpecCsvMatch.fields.contact).toBe('BW');

        const [tier3Vendor, tier3Contact, tier2Override, tier3Al] = await Promise.all([
          customParser.extractFields({
            documentTypeKey: 'submittal-ffe',
            spaceId: spSpace.abstractStorageId,
            selectedLogId: spSpreadsheetId,
            context: {
              isDriveUrl: false,
              email: {
                id: `msg-ffe-tier3-vendor-${runId}`,
                subject: 'CG104-0 Lounge Bed',
                from: 'Sales <sales@bermanfalk.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                labels: ['INBOX'],
              },
            },
          }),
          customParser.extractFields({
            documentTypeKey: 'submittal-ffe',
            spaceId: spSpace.abstractStorageId,
            selectedLogId: spSpreadsheetId,
            context: {
              isDriveUrl: false,
              email: {
                id: `msg-ffe-tier3-contact-${runId}`,
                subject: 'CG104-0 Lounge Bed',
                from: 'Buyer <buyer@benjaminwest.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                labels: ['INBOX'],
              },
            },
          }),
          customParser.extractFields({
            documentTypeKey: 'submittal-ffe',
            spaceId: spSpace.abstractStorageId,
            selectedLogId: spSpreadsheetId,
            context: {
              isDriveUrl: false,
              email: {
                id: `msg-ffe-override-${runId}`,
                subject: 'CG104-0 Lounge Bed',
                from: 'Sales <sales@ashleylighting.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                labels: ['INBOX'],
              },
            },
          }),
          customParser.extractFields({
            documentTypeKey: 'submittal-ffe',
            spaceId: spSpace.abstractStorageId,
            selectedLogId: spSpreadsheetId,
            context: {
              isDriveUrl: false,
              email: {
                id: `msg-ffe-al-${runId}`,
                subject: 'CG104-0 Lounge Bed',
                from: 'Ashley Lighting <noreply@other.example.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 10:00:00 -0500',
                labels: ['INBOX'],
              },
            },
          }),
        ]);
        expect(tier3Vendor.fields.vendor).toBe('BM');
        expect(tier3Contact.fields.contact).toBe('BW');
        expect(tier2Override.fields.vendor).toBe('LA');
        expect(tier3Al.fields.vendor).toBe('AL');
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 120_000);

    it('verifies Validation_* expansion, VLOOKUP Spec Title & Calc File Name, 3- and 4-column Row 4 format cloning, and side-by-side _Config stability on an isolated copy', async () => {
      const liveWiring = requireWiring();
      const templateId = sampleFixture.metadata.templateSpreadsheetId;
      const ffeLogSchema = liveWiring.logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-ffe');
      const ffeSpecsBinding = ffeLogSchema?.optionBindings?.specs;
      const ffeVendorsBinding = ffeLogSchema?.optionBindings?.vendors;
      const ffeContactsBinding = ffeLogSchema?.optionBindings?.contacts;
      const ffeStatusesBinding = ffeLogSchema?.optionBindings?.statuses;
      const ffeActionsBinding = ffeLogSchema?.optionBindings?.actions;
      expect(ffeSpecsBinding).toBeDefined();
      expect(ffeVendorsBinding).toBeDefined();
      expect(ffeContactsBinding).toBeDefined();
      expect(ffeStatusesBinding).toBeDefined();
      expect(ffeActionsBinding).toBeDefined();
      if (
        !ffeSpecsBinding ||
        !ffeVendorsBinding ||
        !ffeContactsBinding ||
        !ffeStatusesBinding ||
        !ffeActionsBinding
      ) {
        return;
      }

      const templateGrid = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
        liveWiring.sheetsApi,
        {
          spreadsheetId: templateId,
          targets: [
            {
              sheetName: ffeSpecsBinding.sheetName,
              rangeName: ffeSpecsBinding.rangeName,
              endMarker: ffeSpecsBinding.endMarker,
            },
            {
              sheetName: ffeVendorsBinding.sheetName,
              rangeName: ffeVendorsBinding.rangeName,
              endMarker: ffeVendorsBinding.endMarker,
            },
            {
              sheetName: ffeContactsBinding.sheetName,
              rangeName: ffeContactsBinding.rangeName,
              endMarker: ffeContactsBinding.endMarker,
            },
          ],
        },
        LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
      );

      const templateSpecsInfo = templateGrid.tables[ffeSpecsBinding.rangeName];
      const templateVendorsInfo = templateGrid.tables[ffeVendorsBinding.rangeName];
      const templateContactsInfo = templateGrid.tables[ffeContactsBinding.rangeName];
      expect(templateSpecsInfo.headerRow).toEqual(['Tag', 'Title', 'Aliases']);
      LiveTestHarness.sheets.expectAliasesHeaderNote(templateSpecsInfo.headerNotes[2]);
      expect(templateVendorsInfo.headerRow).toEqual(['Type', 'Key', 'Name', 'Aliases']);
      LiveTestHarness.sheets.expectAliasesHeaderNote(templateVendorsInfo.headerNotes[3]);
      expect(templateContactsInfo.headerRow).toEqual(['Type', 'Key', 'Name', 'Aliases']);
      LiveTestHarness.sheets.expectAliasesHeaderNote(templateContactsInfo.headerNotes[3]);
      expect(templateSpecsInfo.sheetMerges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 3 }),
          expect.objectContaining({ startRowIndex: 1, endRowIndex: 2, startColumnIndex: 3, endColumnIndex: 7 }),
          expect.objectContaining({ startRowIndex: 1, endRowIndex: 2, startColumnIndex: 12, endColumnIndex: 16 }),
        ])
      );

      const findNonEmptyRow = (rows: typeof templateSpecsInfo.dataRows) =>
        rows.find((r) => r.cells.some((c) => c.formattedValue.trim().length > 0));
      const templateSpecsRow = findNonEmptyRow(templateSpecsInfo.dataRows);
      const templateVendorsRow = findNonEmptyRow(templateVendorsInfo.dataRows);
      const templateContactsRow = findNonEmptyRow(templateContactsInfo.dataRows);
      expect(templateSpecsRow).toBeDefined();
      expect(templateVendorsRow).toBeDefined();
      expect(templateContactsRow).toBeDefined();
      if (!templateSpecsRow || !templateVendorsRow || !templateContactsRow) return;

      const runId = `opt-ffe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          wiring: liveWiring,
          spaceName: `Harborview FFE Writeback ${runId}`,
          spaceId: `live-opt-ffe-${runId}`,
          tracker: localTracker,
        });
        const optSpace = provisioned.space;
        const optSpreadsheetId = provisioned.spreadsheetId;

        const [ffeFolder, optFfeFile] = await Promise.all([
          liveWiring.driveClient.findOrCreateFolder(provisioned.spaceFolderId, '3 FFE'),
          uploadDummyPdf({
            driveClient: liveWiring.driveClient,
            targetFolderId: provisioned.spaceFolderId,
            fileName: `Opt_FFE_${runId}.pdf`,
            textContent: 'Live FFE Options Writeback Target',
            tracker: localTracker,
          }),
        ]);
        localTracker.trackFolder(ffeFolder.id, provisioned.spaceFolderId);

        const clearResults = await LiveTestHarness.sheets.clearOptionTablesToEmpty(
          liveWiring.sheetsApi,
          {
            spreadsheetId: optSpreadsheetId,
            targets: [
              {
                sheetName: ffeSpecsBinding.sheetName,
                rangeName: ffeSpecsBinding.rangeName,
                validationRangeName: ffeSpecsBinding.validationRangeName,
                endMarker: ffeSpecsBinding.endMarker,
              },
              {
                sheetName: ffeVendorsBinding.sheetName,
                rangeName: ffeVendorsBinding.rangeName,
                validationRangeName: ffeVendorsBinding.validationRangeName,
                endMarker: ffeVendorsBinding.endMarker,
              },
              {
                sheetName: ffeContactsBinding.sheetName,
                rangeName: ffeContactsBinding.rangeName,
                validationRangeName: ffeContactsBinding.validationRangeName,
                endMarker: ffeContactsBinding.endMarker,
              },
            ],
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        expect(clearResults[ffeSpecsBinding.rangeName].absTerminatorRowIndex).toBeGreaterThan(0);
        expect(clearResults[ffeVendorsBinding.rangeName].absTerminatorRowIndex).toBeGreaterThan(0);
        expect(clearResults[ffeContactsBinding.rangeName].absTerminatorRowIndex).toBeGreaterThan(0);

        const ffeActionValidationName = 'Validation_Submittal_FFE_Actions';
        const ffeConfigRanges = [
          ffeStatusesBinding.rangeName,
          ...(ffeStatusesBinding.validationRangeName ? [ffeStatusesBinding.validationRangeName] : []),
          ffeActionsBinding.rangeName,
          ffeActionValidationName,
          ffeContactsBinding.rangeName,
          ...(ffeContactsBinding.validationRangeName ? [ffeContactsBinding.validationRangeName] : []),
          ffeVendorsBinding.rangeName,
          ...(ffeVendorsBinding.validationRangeName ? [ffeVendorsBinding.validationRangeName] : []),
          ffeSpecsBinding.rangeName,
          ...(ffeSpecsBinding.validationRangeName ? [ffeSpecsBinding.validationRangeName] : []),
        ];

        const beforeGrid = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
          liveWiring.sheetsApi,
          {
            spreadsheetId: optSpreadsheetId,
            targets: [
              {
                sheetName: ffeSpecsBinding.sheetName,
                rangeName: ffeSpecsBinding.rangeName,
                endMarker: ffeSpecsBinding.endMarker,
              },
              {
                sheetName: ffeVendorsBinding.sheetName,
                rangeName: ffeVendorsBinding.rangeName,
                endMarker: ffeVendorsBinding.endMarker,
              },
              {
                sheetName: ffeContactsBinding.sheetName,
                rangeName: ffeContactsBinding.rangeName,
                endMarker: ffeContactsBinding.endMarker,
              },
            ],
            snapshotRangeNames: ffeConfigRanges,
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );

        expect(
          (beforeGrid.valuesByNamedRange[ffeStatusesBinding.validationRangeName!] ?? []).map((r) =>
            String(r[0] ?? '')
          )
        ).toEqual(['Open', 'Closed', 'Waiting', 'Manager', 'Billed', '---']);
        expect(beforeGrid.namedRanges[ffeActionValidationName].gridRange).toMatchObject({
          startColumnIndex: 7,
          endColumnIndex: 8,
        });

        const customSpecTag = `ZZ${runId.slice(-4).toUpperCase()}`;
        const customRelatedTag = `ZR${runId.slice(-4).toUpperCase()}`;
        const customSpecTitle = `CUSTOM LIVE LOUNGE ${runId.slice(-4).toUpperCase()}`;
        const customVendor = `Custom Live Millwork ${runId.slice(-4).toUpperCase()}`;
        const customFfeContact = `T417F_${runId.slice(-4).toUpperCase()}`;

        const optFfeService = await liveWiring.documentServiceFactory({
          selectedLogId: optSpreadsheetId,
          sourceFiles: [{ id: optFfeFile.id, name: optFfeFile.name, mimeType: 'application/pdf' }],
        });
        const ffeSubmit = await optFfeService.processDocument(
          {
            type: 'submittal-ffe',
            space: optSpace,
            data: {
              status: 'Open',
              specTag: customSpecTag,
              relatedTag: customRelatedTag,
              revision: '0',
              specTitle: customSpecTitle,
              vendor: customVendor,
              date: '260401',
              contact: customFfeContact,
              action: 'RR',
              notes: 'Ticket 417 custom FF&E option write-back',
            },
          },
          'onSubmit'
        );
        expect(ffeSubmit.success).toBe(true);
        if (!ffeSubmit.success) return;
        expect(ffeSubmit.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);

        const afterGrid = await LiveTestHarness.sheets.readMultiOptionTableGridFormats(
          liveWiring.sheetsApi,
          {
            spreadsheetId: optSpreadsheetId,
            targets: [
              {
                sheetName: ffeSpecsBinding.sheetName,
                rangeName: ffeSpecsBinding.rangeName,
                endMarker: ffeSpecsBinding.endMarker,
              },
              {
                sheetName: ffeVendorsBinding.sheetName,
                rangeName: ffeVendorsBinding.rangeName,
                endMarker: ffeVendorsBinding.endMarker,
              },
              {
                sheetName: ffeContactsBinding.sheetName,
                rangeName: ffeContactsBinding.rangeName,
                endMarker: ffeContactsBinding.endMarker,
              },
            ],
            snapshotRangeNames: ffeConfigRanges,
            extraRanges: [`'${sampleFixture.submittalFfe.sheetName}'!A4:L6`],
          },
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );

        expect(afterGrid.namedRanges[ffeSpecsBinding.rangeName].gridRange.endRowIndex).toBe(
          (beforeGrid.namedRanges[ffeSpecsBinding.rangeName].gridRange.endRowIndex ?? 0) + 2
        );
        for (const expandedRange of [ffeVendorsBinding.rangeName, ffeContactsBinding.rangeName]) {
          expect(afterGrid.namedRanges[expandedRange].gridRange.endRowIndex).toBe(
            (beforeGrid.namedRanges[expandedRange].gridRange.endRowIndex ?? 0) + 1
          );
        }

        for (const { binding, delta } of [
          { binding: ffeSpecsBinding, delta: 2 },
          { binding: ffeVendorsBinding, delta: 1 },
          { binding: ffeContactsBinding, delta: 1 },
        ]) {
          if (!binding.validationRangeName) continue;
          const rowsBefore = beforeGrid.valuesByNamedRange[binding.rangeName] ?? [];
          const termRel = rowsBefore.findIndex((r) =>
            r.some((cell) => cell !== null && cell !== undefined && String(cell).trim() === binding.endMarker)
          );
          expect(termRel).toBeGreaterThan(0);
          const absTerminatorBefore =
            (beforeGrid.namedRanges[binding.rangeName].gridRange.startRowIndex ?? 0) + termRel;
          expect(afterGrid.namedRanges[binding.validationRangeName].gridRange.endRowIndex).toBe(
            absTerminatorBefore + delta
          );
          const valItems = (afterGrid.valuesByNamedRange[binding.validationRangeName] ?? []).map((r) =>
            String(r[0] ?? '')
          );
          expect(valItems).not.toContain('---');
        }

        const untouchedFfeRanges = [
          ffeStatusesBinding.rangeName,
          ...(ffeStatusesBinding.validationRangeName ? [ffeStatusesBinding.validationRangeName] : []),
          ffeActionsBinding.rangeName,
          ffeActionValidationName,
        ];
        expect(
          LiveTestHarness.sheets.findSideBySideTableShiftViolations({
            beforeSnapshots: beforeGrid.namedRanges,
            afterSnapshots: afterGrid.namedRanges,
            beforeValues: beforeGrid.valuesByNamedRange,
            afterValues: afterGrid.valuesByNamedRange,
            rangeNames: untouchedFfeRanges,
          })
        ).toEqual([]);

        // Verify 3-col Specs & 4-col Vendors/Contacts Row 4 format cloning
        const assertFormatCloned = (
          rangeName: string,
          keyHeader: string,
          keyValue: string,
          templateRow: typeof templateSpecsRow
        ) => {
          const info = afterGrid.tables[rangeName];
          const keyIdx = info.headerRow.indexOf(keyHeader);
          const inserted = info.dataRows.find((r) => r.cells[keyIdx]?.formattedValue.trim() === keyValue);
          expect(inserted).toBeDefined();
          expect(inserted?.cells.map((c) => c.userEnteredFormat)).toEqual(
            templateRow.cells.map((c) => c.userEnteredFormat)
          );
        };
        assertFormatCloned(ffeSpecsBinding.rangeName, 'Tag', customSpecTag, templateSpecsRow);
        assertFormatCloned(ffeVendorsBinding.rangeName, 'Key', customVendor, templateVendorsRow);
        assertFormatCloned(ffeContactsBinding.rangeName, 'Key', customFfeContact, templateContactsRow);

        // Verify Submittal FF&E!E4 ARRAYFORMULA / VLOOKUP Spec Title & shifted Calc File Name (L4/L6)
        const ffeRow4 = getRowCellsFromSpreadsheetGrid(afterGrid.spreadsheet, sampleFixture.submittalFfe.sheetName, 3);
        expect(ffeRow4[4]?.userEnteredValue?.formulaValue).toBe(
          '=ARRAYFORMULA(IFERROR(VLOOKUP(B4:B,Options_Submittal_FFE_Specs,2,FALSE)))'
        );
        expect(ffeRow4[11]?.userEnteredValue?.formulaValue).toContain("'_Config Submittal FF&E'!H4:I");

        const ffeRow6 = getRowCellsFromSpreadsheetGrid(afterGrid.spreadsheet, sampleFixture.submittalFfe.sheetName, 5);
        expect(ffeRow6[4]?.formattedValue).toBe(customSpecTitle);
        expect(ffeRow6[11]?.formattedValue).toBe(
          `${customSpecTag}-0 ${customVendor} - 260401 ${customFfeContact}_RR`
        );
        expect(findGridErrorTokens(afterGrid.spreadsheet)).toEqual([]);

        const updatedFfeRead = await liveWiring.logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: optSpreadsheetId,
        });
        expect(updatedFfeRead.status).toBe('ready');
        if (updatedFfeRead.status !== 'ready') return;
        expect(updatedFfeRead.tables.specs?.tuples).toContainEqual(
          expect.objectContaining({ key: customSpecTag, name: customSpecTitle })
        );
        expect(updatedFfeRead.tables.specs?.tuples).toContainEqual(
          expect.objectContaining({ key: customRelatedTag, name: '' })
        );
        expect(updatedFfeRead.tables.vendors?.tuples).toContainEqual(
          expect.objectContaining({ key: customVendor, name: customVendor })
        );
        expect(updatedFfeRead.tables.contacts?.tuples).toContainEqual(
          expect.objectContaining({ key: customFfeContact, name: customFfeContact })
        );
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 120_000);

    it('resiliently hydrates injected partial-hydration rows on Submittal FF&E with filter-scoped warning isolation on an isolated copy', async () => {
      const liveWiring = requireWiring();
      const runId = `ph-ffe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = LiveTestHarness.cleanup.createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          wiring: liveWiring,
          spaceName: `Harborview FFE Partial ${runId}`,
          spaceId: `live-ph-ffe-${runId}`,
          tracker: localTracker,
        });
        const phSpreadsheetId = provisioned.spreadsheetId;

        const ffeRowsToAppend = [
          ...sampleFixture.submittalFfe.partialHydrationRows.map((row) =>
            LiveTestHarness.sheets.partialHydrationRowToCellInputs(row)
          ),
          {
            Status: 'Closed',
            'Spec Tag': 'FB127',
            'Related Tag': null,
            Revision: '0',
            Vendor: 'Berman Falk',
            Date: '260118',
            Contact: 'INC',
            Action: 'Received',
            Notes: null,
            'Calc Link': {
              formula: '=HYPERLINK("https://drive.google.com/file/d/fixture-ffe-clean/view", "Link")',
            },
          },
        ];

        const insertedRows = await LiveTestHarness.sheets.appendRawPositiveTableRows(
          liveWiring.sheetsApi,
          ffeTarget(phSpreadsheetId),
          ffeRowsToAppend,
          LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
        );
        expect(insertedRows).toHaveLength(3);

        const perReqLogService = liveWiring.logWiring.getPerRequestService({});
        const fullRead = await perReqLogService.readLog({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: phSpreadsheetId,
        });
        expect(fullRead.entries).toHaveLength(3);

        const invalidStatusEntry = fullRead.entries.find((e) => e.rowNumber === insertedRows[0]);
        expect(invalidStatusEntry?.valid).toBe(false);
        expect(invalidStatusEntry?.document.idGroup).toBe('LT108');
        expect(invalidStatusEntry?.document.data.specTitle).toBe('SCONCE');
        expect(invalidStatusEntry?.document.data.status).toEqual({ key: 'In Review' });
        expect('vendor' in (invalidStatusEntry?.document.data ?? {})).toBe(false);
        expect(invalidStatusEntry?.fileUri).toBe(
          'https://drive.google.com/file/d/fixture-ffe-partial-vendor/view'
        );
        expect(
          fullRead.warnings.filter((w) => w.rowNumber === insertedRows[0]).map((w) => w.field)
        ).toEqual(['status', 'vendor']);

        const missingRevEntry = fullRead.entries.find((e) => e.rowNumber === insertedRows[1]);
        expect(missingRevEntry?.valid).toBe(false);
        expect(missingRevEntry?.document.idGroup).toBe('CG104');
        expect(missingRevEntry?.document.data.specTitle).toBe('BED - KING');
        expect('revision' in (missingRevEntry?.document.data ?? {})).toBe(false);
        expect(missingRevEntry?.fileUri).toBe(
          'https://drive.google.com/file/d/fixture-ffe-raw-url/view'
        );

        const cleanEntry = fullRead.entries.find((e) => e.rowNumber === insertedRows[2]);
        expect(cleanEntry?.valid).toBe(true);

        const scopedLt108 = await perReqLogService.readLog({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: phSpreadsheetId,
          filterBy: 'idGroup',
          values: [' lt108 '],
        });
        expect(scopedLt108.entries).toHaveLength(1);
        expect(scopedLt108.warnings.map((w) => w.field)).toEqual(['status', 'vendor']);
      } finally {
        await localTracker.trashAll(liveWiring.driveClient);
      }
    }, 90_000);
  }
);

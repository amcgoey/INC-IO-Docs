import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import type { DocumentLogWiring } from '../../src/app/document-log.wiring';
import type { SourceParserWiring } from '../../src/app/source-parser.wiring';
import type { DocumentServiceFactory } from '../../src/app/ui-process-manager.wiring';
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
  findSheetErrorTokens,
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
  'Live DocumentLog Submittal FF&E E2E Verification (Copy-and-Trash)',
  () => {
    const cleanupTracker = createCleanupTracker();
    let driveClient: GoogleDriveClient | undefined;
    let sheetsApi: sheets_v4.Sheets;
    let sheetsClient: GoogleSheetsClient;
    let logWiring: DocumentLogWiring;
    let sourceParserWiring: SourceParserWiring;
    let documentServiceFactory: DocumentServiceFactory;

    let spaceFolderId: string;
    let space: { id: string; typeId: string; name: string; abstractStorageId: string };
    let copiedSpreadsheetId: string;
    let adminFolderId: string | undefined;
    let ffeFileId: string;
    let ffeFileName: string;

    const requireDriveClient = (): GoogleDriveClient => {
      if (!driveClient) {
        throw new Error('GoogleDriveClient is not initialized.');
      }
      return driveClient;
    };

    const ffeTarget = (): PositiveTableTarget =>
      buildPositiveTableTarget(copiedSpreadsheetId, sampleFixture.submittalFfe);

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
        spaceName: `Harborview FFE Live E2E ${runId}`,
        spaceId: `live-ffe-space-${runId}`,
        trackCleanupId: cleanupTracker.track,
      });
      spaceFolderId = provisioned.spaceFolderId;
      space = provisioned.space;
      copiedSpreadsheetId = provisioned.spreadsheetId;
      adminFolderId = provisioned.adminFolderId;

      const ffeFolder = await wiring.driveClient.findOrCreateFolder(spaceFolderId, '3 FFE');
      cleanupTracker.track(ffeFolder.id);

      await ensureClearedPositiveTable(sheetsApi, ffeTarget());

      const ffeFile = await uploadDummyPdf({
        driveClient: wiring.driveClient,
        targetFolderId: spaceFolderId,
        fileName: `Live_FFE_Submittal_${runId}.pdf`,
        textContent: 'Live DocumentLog E2E Target Content',
        trackCleanupId: cleanupTracker.track,
      });
      ffeFileId = ffeFile.id;
      ffeFileName = ffeFile.name;
    }, 60_000);

    afterAll(async () => {
      await cleanupScratchSpace({
        driveClient,
        spaceFolderId,
        adminFolderId,
        tracker: cleanupTracker,
      });
    }, 90_000);

    it('executes full DocumentService.processDocument() (MOVE_FILE -> WRITE_LOG) for submittal-ffe', async () => {
      const liveDriveClient = requireDriveClient();
      const spreadsheetMeta = await sheetsApi.spreadsheets.get({
        spreadsheetId: copiedSpreadsheetId,
        fields: 'sheets(properties(sheetId,title))',
      });
      const ffeSheetId = spreadsheetMeta.data.sheets?.find(
        (s) => s.properties?.title === sampleFixture.submittalFfe.sheetName
      )?.properties?.sheetId;
      expect(typeof ffeSheetId).toBe('number');

      const ffeService = await documentServiceFactory({
        sourceFiles: [{ id: ffeFileId, name: ffeFileName, mimeType: 'application/pdf' }],
      });

      const ffeEntries: Array<Record<string, unknown>> = [
        ...[0, 1, 2, 3].map((idx) => sampleFixture.submittalFfe.seedEntries[idx].documentData),
        ...sampleFixture.submittalFfe.writeScenarios.map((scenario) => scenario.documentData),
      ];

      for (const data of ffeEntries) {
        const result = await ffeService.processDocument(
          {
            type: 'submittal-ffe',
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
          sheetName: sampleFixture.submittalFfe.sheetName,
          sheetId: ffeSheetId,
        });
        expect(logWrite?.uri).toBe(
          `https://docs.google.com/spreadsheets/d/${copiedSpreadsheetId}/edit#gid=${ffeSheetId}&range=${logWrite?.rowNumber}:${logWrite?.rowNumber}`
        );
        expect(result.stepOutputs?.writeLog?.files).toBeUndefined();
        expect(result.files?.length).toBeGreaterThan(0);
      }

      const table = await sheetsClient.readTable({ target: ffeTarget() });
      expect(table.formulaColumns).toEqual(['Spec Title']);
      expect(table.rows).toHaveLength(7);

      const actualOrder = table.rows.map(
        (r) =>
          `${r.values['Spec Tag']}-${r.values.Revision}-${r.values.Date}-${r.values.Contact}|${r.values['Related Tag'] ?? ''}`
      );
      expect(actualOrder).toEqual([
        'AC102-0-260112-HPG|',
        'CG104-0-260120-HPG|FB127',
        'CG104-0-260128-ARC|FB127',
        'CG104-1-260205-HPG|FB127',
        'CG104-1-260210-ARC|FB127',
        'CP119-0-260201-HPG|',
        'FB127-0-260118-HPG|',
      ]);

      const expectedSpecTitles: Record<string, string> = {
        AC102: 'HOOK',
        CG104: 'BED - KING',
        CP119: 'CARPET',
        FB127: 'FABRIC - LEATHER',
      };

      for (const row of table.rows) {
        const specTag = String(row.values['Spec Tag'] ?? '');
        expect(row.values['Spec Title']).toBe(expectedSpecTitles[specTag]);
        expect(findSheetErrorTokens(row.values)).toEqual([]);
      }

      const layout = await inspectPositiveTableLayout(sheetsApi, ffeTarget());
      expect(layout.formulaRowsByHeader['Calc Link']).toHaveLength(7);
      for (let i = 0; i < 7; i++) {
        expect(table.rows[i].values['Calc Link']).toBe('Link');
        const formulaCell = layout.formulaRowsByHeader['Calc Link'][i];
        expect(formulaCell).toMatch(/^=HYPERLINK\("https:\/\/.+", "Link"\)$/);
        expect(formulaCell).toContain(ffeFileId);
      }

      expect(
        findCleanDividerViolations({
          ...layout,
          expectedDividerCount: 3,
        })
      ).toEqual([]);

      const ffeSubmittalsFolder = await liveDriveClient.resolveFolderPath(spaceFolderId, [
        '3 FFE',
        '05 Submittals',
      ]);
      cleanupTracker.track(ffeSubmittalsFolder.id);
      const ffeClosedLeafFolder = await liveDriveClient.resolveFolderPath(ffeSubmittalsFolder.id, [
        'Closed',
        'CG',
        'CG104',
      ]);
      const ffeFileMeta = await liveDriveClient.getFile(ffeFileId);
      expect(ffeFileMeta.parents).toContain(ffeClosedLeafFolder.id);
    }, 180_000);

    it('hydrates full and case-insensitive batch-filtered Submittal FF&E logs including readOnly Spec Title and live =HYPERLINK fileUri via DocumentLogPort.readLog()', async () => {
      const expectedSpecTitles: Record<string, string> = {
        AC102: 'HOOK',
        CG104: 'BED - KING',
        CP119: 'CARPET',
        FB127: 'FABRIC - LEATHER',
      };

      const fullRead = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        space,
      });

      expect(fullRead.spreadsheetId).toBe(copiedSpreadsheetId);
      expect(fullRead.sheetName).toBe(sampleFixture.submittalFfe.sheetName);
      expect(fullRead.warnings).toEqual([]);
      expect(fullRead.entries).toHaveLength(7);

      for (const entry of fullRead.entries) {
        expect(entry.valid).toBe(true);
        expect(entry.validationErrors).toBeUndefined();
        expect(entry.document.type).toBe('submittal-ffe');
        expect(entry.document.calculated).toBeUndefined();
        expect('calculated' in entry.document).toBe(false);
        expect(entry.fileUri).toMatch(/^https:\/\//);
        expect(entry.fileUri).toContain(ffeFileId);

        const specGroup = entry.document.idGroup ?? '';
        expect(entry.document.data.specTitle).toBe(expectedSpecTitles[specGroup]);
      }

      expect(fullRead.entries[0].document.id).toBe('AC102-0-260112-1');
      expect(fullRead.entries[0].document.data.date).toBe('260112');
      expect('relatedTag' in fullRead.entries[0].document.data).toBe(false);

      const cg104RrEntry = fullRead.entries.find(
        (entry) => entry.document.id === 'CG104-0-260128-5'
      );
      expect(cg104RrEntry).toBeDefined();
      expect(cg104RrEntry?.document.data).toMatchObject({
        specTag: { key: 'CG104', name: 'BED - KING' },
        relatedTag: { key: 'FB127', name: 'FABRIC - LEATHER' },
        specTitle: 'BED - KING',
        action: { key: 'RR', name: 'Revise & Resubmit', suffix: '_RR', order: '5' },
      });

      const byIdGroup = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idGroup',
        values: [' cg104 ', ' fb127 '],
      });
      expect(byIdGroup.warnings).toEqual([]);
      expect(byIdGroup.entries).toHaveLength(5);
      expect(byIdGroup.entries.map((entry) => entry.document.idGroup)).toEqual([
        'CG104',
        'CG104',
        'CG104',
        'CG104',
        'FB127',
      ]);
      for (const entry of byIdGroup.entries) {
        const specGroup = entry.document.idGroup ?? '';
        expect(entry.document.data.specTitle).toBe(expectedSpecTitles[specGroup]);
        expect(entry.fileUri).toContain(ffeFileId);
      }

      const byIdDocument = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idDocument',
        values: [' cg104-1 ', ' ac102-0 '],
      });
      expect(byIdDocument.warnings).toEqual([]);
      expect(byIdDocument.entries.map((entry) => entry.document.id)).toEqual([
        'AC102-0-260112-1',
        'CG104-1-260205-1',
        'CG104-1-260210-6',
      ]);

      const byId = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'id',
        values: [' cg104-0-260128-5 ', ' cp119-0-260201-1 '],
      });
      expect(byId.warnings).toEqual([]);
      expect(byId.entries.map((entry) => entry.document.id)).toEqual([
        'CG104-0-260128-5',
        'CP119-0-260201-1',
      ]);
    }, 60_000);

    it('resiliently hydrates injected partial-hydration invalid rows on Submittal FF&E against real Google Sheets with filter-scoped warning isolation', async () => {
      const ffeRowsToAppend = sampleFixture.submittalFfe.partialHydrationRows.map((row) =>
        partialHydrationRowToCellInputs(row)
      );
      const insertedFfeRows = await appendRawPositiveTableRows(
        sheetsApi,
        ffeTarget(),
        ffeRowsToAppend,
        DEFAULT_LIVE_RETRY_OPTIONS
      );
      expect(insertedFfeRows).toHaveLength(2);

      const ffeFull = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
      });
      expect(ffeFull.entries).toHaveLength(9);

      const invalidStatusEntry = ffeFull.entries.find(
        (entry) => entry.rowNumber === insertedFfeRows[0]
      );
      expect(invalidStatusEntry).toBeDefined();
      expect(invalidStatusEntry?.valid).toBe(false);
      expect(invalidStatusEntry?.document.idGroup).toBe('LT108');
      expect(invalidStatusEntry?.document.data.specTitle).toBe('SCONCE');
      expect(invalidStatusEntry?.document.data.status).toEqual({ key: 'In Review' });
      expect('vendor' in (invalidStatusEntry?.document.data ?? {})).toBe(false);
      expect(invalidStatusEntry?.fileUri).toBe(
        'https://drive.google.com/file/d/fixture-ffe-partial-vendor/view'
      );
      expect(invalidStatusEntry?.validationErrors).toHaveLength(2);
      expect(
        ffeFull.warnings
          .filter((warning) => warning.rowNumber === insertedFfeRows[0])
          .map((warning) => warning.field)
      ).toEqual(['status', 'vendor']);

      const missingRevisionEntry = ffeFull.entries.find(
        (entry) => entry.rowNumber === insertedFfeRows[1]
      );
      expect(missingRevisionEntry).toBeDefined();
      expect(missingRevisionEntry?.valid).toBe(false);
      expect(missingRevisionEntry?.document.idGroup).toBe('CG104');
      expect(missingRevisionEntry?.document.data.specTitle).toBe('BED - KING');
      expect('revision' in (missingRevisionEntry?.document.data ?? {})).toBe(false);
      expect(missingRevisionEntry?.fileUri).toBe(
        'https://drive.google.com/file/d/fixture-ffe-raw-url/view'
      );
      expect(missingRevisionEntry?.validationErrors).toHaveLength(1);
      expect(
        ffeFull.warnings
          .filter((warning) => warning.rowNumber === insertedFfeRows[1])
          .map((warning) => warning.field)
      ).toEqual(['revision']);

      const ffeLt108 = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idGroup',
        values: [' lt108 '],
      });
      expect(ffeLt108.entries).toHaveLength(1);
      expect(ffeLt108.warnings.map((warning) => warning.field)).toEqual(['status', 'vendor']);

      const ffeFb127 = await logWiring.documentLogService.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: copiedSpreadsheetId,
        filterBy: 'idGroup',
        values: [' fb127 '],
      });
      expect(ffeFb127.entries).toHaveLength(1);
      expect(ffeFb127.entries[0].valid).toBe(true);
      expect(ffeFb127.warnings).toEqual([]);
    }, 90_000);

    it('verifies live submittal-ffe DocumentLog option reads, seeded Aliases, Validation_* bounds, empty-table Row 4 format cloning across 3- and 4-column tables, Named Range expansion, VLOOKUP Spec Title & shifted Calc File Name formulas, and side-by-side _Config Submittal FF&E stability on a fresh copied template', async () => {
      const liveDriveClient = requireDriveClient();
      const templateId = sampleFixture.metadata.templateSpreadsheetId;
      const discoveryConfig = logWiring.logSchemaRegistry.getDiscoveryConfig('proposals');
      expect(discoveryConfig?.templateSpreadsheetId).toBe(templateId);
      const ffeLogSchema = logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-ffe');
      expect(ffeLogSchema).toBeDefined();
      if (!ffeLogSchema) {
        return;
      }

      const ffeSpecsBinding = ffeLogSchema.optionBindings?.specs;
      const ffeVendorsBinding = ffeLogSchema.optionBindings?.vendors;
      const ffeContactsBinding = ffeLogSchema.optionBindings?.contacts;
      const ffeStatusesBinding = ffeLogSchema.optionBindings?.statuses;
      const ffeActionsBinding = ffeLogSchema.optionBindings?.actions;
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

      const runId = `opt-ffe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          driveClient: liveDriveClient,
          logWiring,
          spaceName: `Harborview FFE Options Live ${runId}`,
          spaceId: `live-opt-ffe-space-${runId}`,
          trackCleanupId: localTracker.track,
        });
        const optSpace = provisioned.space;
        const optCopy = provisioned.copyResult;
        const optSpreadsheetId = provisioned.spreadsheetId;

        expect(optCopy.created).toBe(true);
        expect(optSpreadsheetId).not.toBe(templateId);

        const optFfeTarget = buildPositiveTableTarget(optSpreadsheetId, ffeLogSchema.target);
        await ensureClearedPositiveTable(sheetsApi, optFfeTarget);
        expect(
          await findSpreadsheetErrorTokens(sheetsApi, optSpreadsheetId, DEFAULT_LIVE_RETRY_OPTIONS)
        ).toEqual([]);

        // Verify Submittal FF&E cross-tab formulas reference shifted Actions columns (H4:I) and VLOOKUP col 2 (Title)
        const ffeFormulaRowRes = await sheetsApi.spreadsheets.values.get({
          spreadsheetId: optSpreadsheetId,
          range: `'${ffeLogSchema.target.sheetName}'!A4:O4`,
          valueRenderOption: 'FORMULA',
        });
        const ffeFormulaRow = (ffeFormulaRowRes.data.values?.[0] as string[] | undefined) ?? [];
        expect(ffeFormulaRow[4]).toBe(
          '=ARRAYFORMULA(IFERROR(VLOOKUP(B4:B,Options_Submittal_FFE_Specs,2,FALSE)))'
        );
        expect(ffeFormulaRow[11]).toContain("'_Config Submittal FF&E'!H4:I");

        // 1) Live option reads from untouched copied template (unprefixed Row 3 headers + seeded Contacts/Vendors Aliases + blank Specs Aliases)
        const initialFfeOptions = await logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-ffe',
          space: optSpace,
          selectedLogId: optSpreadsheetId,
        });
        expect(initialFfeOptions.status).toBe('ready');
        if (initialFfeOptions.status !== 'ready') return;
        expect(initialFfeOptions.spreadsheetId).toBe(optSpreadsheetId);
        expect(initialFfeOptions.tables.statuses?.status).toBe('ready');
        expect(initialFfeOptions.tables.statuses?.tuples.map((t) => t.key)).toEqual([
          'Open',
          'Closed',
          'Waiting',
          'Manager',
          'Billed',
        ]);
        expect(initialFfeOptions.tables.actions?.status).toBe('ready');
        expect(initialFfeOptions.tables.actions?.tuples.length).toBe(7);
        expect(initialFfeOptions.tables.contacts?.status).toBe('ready');
        expect(initialFfeOptions.tables.contacts?.tuples).toEqual([
          {
            key: 'INC',
            name: 'INC Architecture & Design',
            aliases: ['@inc.nyc', 'INC Architecture', 'INC Architecture and Design', 'INC Architecture & Design'],
          },
          {
            key: 'BW',
            name: 'Benjamin West',
            aliases: ['@benjaminwest.com', 'Benjamin West', 'BenjaminWest'],
          },
          {
            key: 'VLD',
            name: 'Ventresca Lighting Design',
            aliases: ['@ventresca.com', 'Ventresca Lighting Design', 'Ventresca Lighting', 'Ventresca'],
          },
          {
            key: 'IHG',
            name: 'IHG Hotels & Resorts',
            aliases: ['@ihg.com', 'IHG Hotels', 'IHG Hotels & Resorts', 'InterContinental Hotels Group'],
          },
        ]);
        expect(initialFfeOptions.tables.vendors?.status).toBe('ready');
        expect(initialFfeOptions.tables.vendors?.tuples).toEqual([
          {
            key: 'BM',
            name: 'Berman Falk',
            aliases: ['@bermanfalk.com', 'Berman Falk', 'BermanFalk', 'Berman'],
          },
          {
            key: 'AL',
            name: 'Ashley Lighting',
            aliases: ['@ashleylighting.com', 'Ashley Lighting', 'Ashley'],
          },
          {
            key: 'Carn',
            name: 'Carnegie',
            aliases: ['@carnegiefabrics.com', 'Carnegie Fabrics', 'Carnegie'],
          },
          {
            key: 'Delta',
            name: 'Delta',
            aliases: ['@deltafabrics.com', 'Delta Fabrics', 'Delta Furniture'],
          },
          {
            key: 'FDT',
            name: 'Fil Doux Textiles',
            aliases: ['@fildoux.com', 'Fil Doux Textiles', 'Fil Doux', 'FilDoux'],
          },
          {
            key: 'LA',
            name: 'Light Annex',
            aliases: ['@lightannex.com', 'Light Annex', 'LightAnnex'],
          },
          {
            key: 'MH',
            name: 'Mohawk',
            aliases: ['@mohawkgroup.com', 'Mohawk Group', 'Mohawk Fabrics', 'Mohawk'],
          },
        ]);
        expect(initialFfeOptions.tables.specs?.status).toBe('ready');
        expect(initialFfeOptions.tables.specs?.tuples).toHaveLength(33);
        expect(initialFfeOptions.tables.specs?.tuples.every((t) => t.aliases === undefined)).toBe(true);

        // Verify split Validation_* policy across all 5 FF&E Validation_* ranges
        const ffeActionValidationName = 'Validation_Submittal_FFE_Actions';
        const initialValSnapshots = await snapshotNamedRanges(
          sheetsApi,
          optSpreadsheetId,
          [
            ffeSpecsBinding.validationRangeName!,
            ffeVendorsBinding.validationRangeName!,
            ffeContactsBinding.validationRangeName!,
            ffeStatusesBinding.validationRangeName!,
            ffeActionValidationName,
          ],
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const initialValValues = await readNamedRangesFormattedValues(
          sheetsApi,
          optSpreadsheetId,
          initialValSnapshots,
          DEFAULT_LIVE_RETRY_OPTIONS
        );

        expect(initialValSnapshots[ffeSpecsBinding.validationRangeName!].gridRange).toMatchObject({
          startColumnIndex: 0,
          endColumnIndex: 1,
        });
        const specValItems = (initialValValues[ffeSpecsBinding.validationRangeName!] ?? []).map((r) =>
          String(r[0] ?? '')
        );
        expect(specValItems).toHaveLength(44);
        expect(specValItems).not.toContain('---');

        expect(initialValSnapshots[ffeVendorsBinding.validationRangeName!].gridRange).toMatchObject({
          startColumnIndex: 5,
          endColumnIndex: 6,
        });
        const vendorValItems = (initialValValues[ffeVendorsBinding.validationRangeName!] ?? []).map(
          (r) => String(r[0] ?? '')
        );
        expect(vendorValItems).toEqual([
          'Berman Falk',
          'Ashley Lighting',
          'Carnegie',
          'Delta',
          'Fil Doux Textiles',
          'Light Annex',
          'Mohawk',
        ]);
        expect(vendorValItems).not.toContain('---');

        expect(initialValSnapshots[ffeContactsBinding.validationRangeName!].gridRange).toMatchObject({
          startColumnIndex: 13,
          endColumnIndex: 14,
        });
        const contactValItems = (initialValValues[ffeContactsBinding.validationRangeName!] ?? []).map(
          (r) => String(r[0] ?? '')
        );
        expect(contactValItems).toEqual(['INC', 'BW', 'VLD', 'IHG']);
        expect(contactValItems).not.toContain('---');

        expect(initialValSnapshots[ffeActionValidationName].gridRange).toMatchObject({
          startColumnIndex: 7,
          endColumnIndex: 8,
        });
        const actionValItems = (initialValValues[ffeActionValidationName] ?? []).map((r) =>
          String(r[0] ?? '')
        );
        expect(actionValItems).toEqual([
          'Received',
          'Referred',
          'Not Reviewed',
          'Rejected',
          'Revise & Resubmit',
          'No Objections As Corrected',
          'No Exceptions Taken',
          '---',
        ]);

        expect(initialValSnapshots[ffeStatusesBinding.validationRangeName!].gridRange).toMatchObject({
          startColumnIndex: 11,
          endColumnIndex: 12,
        });
        const statusValItems = (initialValValues[ffeStatusesBinding.validationRangeName!] ?? []).map(
          (r) => String(r[0] ?? '')
        );
        expect(statusValItems).toEqual(['Open', 'Closed', 'Waiting', 'Manager', 'Billed', '---']);

        const ffeFolder = await liveDriveClient.findOrCreateFolder(provisioned.spaceFolderId, '3 FFE');
        localTracker.track(ffeFolder.id);

        const optFfeFile = await uploadDummyPdf({
          driveClient: liveDriveClient,
          targetFolderId: provisioned.spaceFolderId,
          fileName: `Opt_FFE_${runId}.pdf`,
          textContent: 'Live FFE Options E2E Target Content',
          trackCleanupId: localTracker.track,
        });

        // 2) Clear 3-col Specs and 4-col Vendors & Contacts to empty and verify Row 4 format cloning + Named Range expansion + side-by-side stability
        const templateSpecsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: templateId,
          sheetName: ffeSpecsBinding.sheetName,
          rangeName: ffeSpecsBinding.rangeName,
          endMarker: ffeSpecsBinding.endMarker,
        });
        expect(templateSpecsGrid.headerRow).toEqual(['Tag', 'Title', 'Aliases']);
        expectAliasesHeaderNote(templateSpecsGrid.headerNotes[2]);
        expect(templateSpecsGrid.sheetMerges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 0,
              endColumnIndex: 3,
            }),
            expect.objectContaining({
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 3,
              endColumnIndex: 7,
            }),
            expect.objectContaining({
              startRowIndex: 1,
              endRowIndex: 2,
              startColumnIndex: 12,
              endColumnIndex: 16,
            }),
          ])
        );
        const templateSpecsRow = templateSpecsGrid.dataRows.find((r) =>
          r.cells.some((c) => c.formattedValue.trim().length > 0)
        );
        expect(templateSpecsRow).toBeDefined();
        if (!templateSpecsRow) return;

        const templateVendorsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: templateId,
          sheetName: ffeVendorsBinding.sheetName,
          rangeName: ffeVendorsBinding.rangeName,
          endMarker: ffeVendorsBinding.endMarker,
        });
        expect(templateVendorsGrid.headerRow).toEqual(['Type', 'Key', 'Name', 'Aliases']);
        expectAliasesHeaderNote(templateVendorsGrid.headerNotes[3]);
        const templateVendorsRow = templateVendorsGrid.dataRows.find((r) =>
          r.cells.some((c) => c.formattedValue.trim().length > 0)
        );
        expect(templateVendorsRow).toBeDefined();
        if (!templateVendorsRow) return;

        const templateContactsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: templateId,
          sheetName: ffeContactsBinding.sheetName,
          rangeName: ffeContactsBinding.rangeName,
          endMarker: ffeContactsBinding.endMarker,
        });
        expect(templateContactsGrid.headerRow).toEqual(['Type', 'Key', 'Name', 'Aliases']);
        expectAliasesHeaderNote(templateContactsGrid.headerNotes[3]);
        const templateContactsRow = templateContactsGrid.dataRows.find((r) =>
          r.cells.some((c) => c.formattedValue.trim().length > 0)
        );
        expect(templateContactsRow).toBeDefined();
        if (!templateContactsRow) return;

        const clearedSpecs = await clearOptionTableToEmpty(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: ffeSpecsBinding.sheetName,
          rangeName: ffeSpecsBinding.rangeName,
          validationRangeName: ffeSpecsBinding.validationRangeName,
          endMarker: ffeSpecsBinding.endMarker,
        });
        const clearedVendors = await clearOptionTableToEmpty(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: ffeVendorsBinding.sheetName,
          rangeName: ffeVendorsBinding.rangeName,
          validationRangeName: ffeVendorsBinding.validationRangeName,
          endMarker: ffeVendorsBinding.endMarker,
        });
        const clearedContacts = await clearOptionTableToEmpty(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: ffeContactsBinding.sheetName,
          rangeName: ffeContactsBinding.rangeName,
          validationRangeName: ffeContactsBinding.validationRangeName,
          endMarker: ffeContactsBinding.endMarker,
        });
        expect(clearedSpecs.absTerminatorRowIndex).toBeGreaterThan(0);
        expect(clearedVendors.absTerminatorRowIndex).toBeGreaterThan(0);
        expect(clearedContacts.absTerminatorRowIndex).toBeGreaterThan(0);

        const clearedFfeRead = await logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: optSpreadsheetId,
          sourceKeys: ['specs', 'vendors', 'contacts'],
        });
        expect(clearedFfeRead.status).toBe('ready');
        if (clearedFfeRead.status !== 'ready') return;
        expect(clearedFfeRead.tables.specs?.tuples).toEqual([]);
        expect(clearedFfeRead.tables.vendors?.tuples).toEqual([]);
        expect(clearedFfeRead.tables.contacts?.tuples).toEqual([]);

        // 3) Custom Spec Tag + Related Tag + Vendor + Contact atomic WRITE_LOG, Validation_* expansion, VLOOKUP & Calc File Name verification, and side-by-side stability
        const ffeConfigRanges = [
          ffeStatusesBinding.rangeName,
          ...(ffeStatusesBinding.validationRangeName ? [ffeStatusesBinding.validationRangeName] : []),
          ffeActionsBinding.rangeName,
          ffeContactsBinding.rangeName,
          ...(ffeContactsBinding.validationRangeName ? [ffeContactsBinding.validationRangeName] : []),
          ffeVendorsBinding.rangeName,
          ...(ffeVendorsBinding.validationRangeName ? [ffeVendorsBinding.validationRangeName] : []),
          ffeSpecsBinding.rangeName,
          ...(ffeSpecsBinding.validationRangeName ? [ffeSpecsBinding.validationRangeName] : []),
        ];
        const ffeSnapshotsBefore = await snapshotNamedRanges(
          sheetsApi,
          optSpreadsheetId,
          ffeConfigRanges,
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const ffeValuesBefore = await readNamedRangesFormattedValues(
          sheetsApi,
          optSpreadsheetId,
          ffeSnapshotsBefore,
          DEFAULT_LIVE_RETRY_OPTIONS
        );

        const customSpecTag = `ZZ${runId.slice(-4).toUpperCase()}`;
        const customRelatedTag = `ZR${runId.slice(-4).toUpperCase()}`;
        const customSpecTitle = `CUSTOM LIVE LOUNGE ${runId.slice(-4).toUpperCase()}`;
        const customVendor = `Custom Live Millwork ${runId.slice(-4).toUpperCase()}`;
        const customFfeContact = `T391F_${runId.slice(-4).toUpperCase()}`;

        const optFfeService = await documentServiceFactory({
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
              notes: 'Ticket 391 custom FF&E option write-back',
            },
          },
          'onSubmit'
        );
        expect(ffeSubmit.success).toBe(true);
        if (!ffeSubmit.success) return;
        expect(ffeSubmit.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);

        const ffeSnapshotsAfter = await snapshotNamedRanges(
          sheetsApi,
          optSpreadsheetId,
          ffeConfigRanges,
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const ffeValuesAfter = await readNamedRangesFormattedValues(
          sheetsApi,
          optSpreadsheetId,
          ffeSnapshotsAfter,
          DEFAULT_LIVE_RETRY_OPTIONS
        );

        expect(ffeSnapshotsAfter[ffeSpecsBinding.rangeName].gridRange.endRowIndex).toBe(
          (ffeSnapshotsBefore[ffeSpecsBinding.rangeName].gridRange.endRowIndex ?? 0) + 2
        );
        for (const expandedRange of [ffeVendorsBinding.rangeName, ffeContactsBinding.rangeName]) {
          expect(ffeSnapshotsAfter[expandedRange].gridRange.endRowIndex).toBe(
            (ffeSnapshotsBefore[expandedRange].gridRange.endRowIndex ?? 0) + 1
          );
        }

        const expectedExpansions = [
          { binding: ffeSpecsBinding, delta: 2 },
          { binding: ffeVendorsBinding, delta: 1 },
          { binding: ffeContactsBinding, delta: 1 },
        ];
        for (const { binding, delta } of expectedExpansions) {
          if (!binding.validationRangeName) continue;
          const rowsBefore = ffeValuesBefore[binding.rangeName] ?? [];
          const termRel = rowsBefore.findIndex((r) =>
            r.some((cell) => cell !== null && cell !== undefined && String(cell).trim() === binding.endMarker)
          );
          expect(termRel).toBeGreaterThan(0);
          const absTerminatorBefore =
            (ffeSnapshotsBefore[binding.rangeName].gridRange.startRowIndex ?? 0) + termRel;
          expect(ffeSnapshotsAfter[binding.validationRangeName].gridRange.endRowIndex).toBe(
            absTerminatorBefore + delta
          );
        }

        const untouchedFfeRanges = [
          ffeStatusesBinding.rangeName,
          ...(ffeStatusesBinding.validationRangeName ? [ffeStatusesBinding.validationRangeName] : []),
          ffeActionsBinding.rangeName,
        ];
        expect(
          findSideBySideTableShiftViolations({
            beforeSnapshots: ffeSnapshotsBefore,
            afterSnapshots: ffeSnapshotsAfter,
            beforeValues: ffeValuesBefore,
            afterValues: ffeValuesAfter,
            rangeNames: untouchedFfeRanges,
          })
        ).toEqual([]);

        // Verify empty-table Row 4 format cloning on 3-column Specs and 4-column Vendors & Contacts
        const copiedSpecsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: ffeSpecsBinding.sheetName,
          rangeName: ffeSpecsBinding.rangeName,
          endMarker: ffeSpecsBinding.endMarker,
        });
        const specsTagIdx = copiedSpecsGrid.headerRow.indexOf('Tag');
        const insertedSpecRow = copiedSpecsGrid.dataRows.find(
          (r) => r.cells[specsTagIdx]?.formattedValue.trim() === customSpecTag
        );
        expect(insertedSpecRow?.cells.map((c) => c.userEnteredFormat)).toEqual(
          templateSpecsRow.cells.map((c) => c.userEnteredFormat)
        );

        const copiedVendorsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: ffeVendorsBinding.sheetName,
          rangeName: ffeVendorsBinding.rangeName,
          endMarker: ffeVendorsBinding.endMarker,
        });
        const vendorsKeyIdx = copiedVendorsGrid.headerRow.indexOf('Key');
        const insertedVendorRow = copiedVendorsGrid.dataRows.find(
          (r) => r.cells[vendorsKeyIdx]?.formattedValue.trim() === customVendor
        );
        expect(insertedVendorRow?.cells.map((c) => c.userEnteredFormat)).toEqual(
          templateVendorsRow.cells.map((c) => c.userEnteredFormat)
        );

        const copiedContactsGrid = await readOptionTableGridFormats(sheetsApi, {
          spreadsheetId: optSpreadsheetId,
          sheetName: ffeContactsBinding.sheetName,
          rangeName: ffeContactsBinding.rangeName,
          endMarker: ffeContactsBinding.endMarker,
        });
        const contactsKeyIdx = copiedContactsGrid.headerRow.indexOf('Key');
        const insertedContactRow = copiedContactsGrid.dataRows.find(
          (r) => r.cells[contactsKeyIdx]?.formattedValue.trim() === customFfeContact
        );
        expect(insertedContactRow?.cells.map((c) => c.userEnteredFormat)).toEqual(
          templateContactsRow.cells.map((c) => c.userEnteredFormat)
        );

        const ffeTableAfter = await sheetsClient.readTable({ target: optFfeTarget });
        expect(ffeTableAfter.formulaColumns).toEqual(['Spec Title']);
        expect(ffeTableAfter.rows).toHaveLength(1);
        expect(ffeTableAfter.rows[0].values).toMatchObject({
          'Spec Tag': customSpecTag,
          'Related Tag': customRelatedTag,
          'Spec Title': customSpecTitle,
          Vendor: customVendor,
          Contact: customFfeContact,
        });
        expect(findSheetErrorTokens(ffeTableAfter.rows[0].values)).toEqual([]);

        // Verify Submittal FF&E!L6 (Calc File Name) evaluates shifted Actions lookup cleanly (_RR)
        const calcFileNameRes = await sheetsApi.spreadsheets.values.get({
          spreadsheetId: optSpreadsheetId,
          range: `'${ffeLogSchema.target.sheetName}'!L6`,
          valueRenderOption: 'FORMATTED_VALUE',
        });
        expect(calcFileNameRes.data.values?.[0]?.[0]).toBe(
          `${customSpecTag}-0 ${customVendor} - 260401 ${customFfeContact}_RR`
        );

        const updatedFfeOptions = await logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: optSpreadsheetId,
        });
        expect(updatedFfeOptions.status).toBe('ready');
        if (updatedFfeOptions.status !== 'ready') return;
        expect(updatedFfeOptions.tables.specs?.tuples).toContainEqual(
          expect.objectContaining({ key: customSpecTag, name: customSpecTitle })
        );
        expect(updatedFfeOptions.tables.specs?.tuples).toContainEqual(
          expect.objectContaining({ key: customRelatedTag, name: '' })
        );
        expect(updatedFfeOptions.tables.vendors?.tuples).toContainEqual(
          expect.objectContaining({ key: customVendor, name: customVendor })
        );
        expect(updatedFfeOptions.tables.contacts?.tuples).toContainEqual(
          expect.objectContaining({ key: customFfeContact, name: customFfeContact })
        );

        const ffeLogRead = await logWiring.documentLogService.readLog({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: optSpreadsheetId,
        });
        expect(ffeLogRead.warnings).toEqual([]);
        expect(ffeLogRead.entries).toHaveLength(1);
        expect(ffeLogRead.entries[0].valid).toBe(true);
        expect(ffeLogRead.entries[0].document.data).toMatchObject({
          specTag: { key: customSpecTag, name: customSpecTitle },
          relatedTag: { key: customRelatedTag, name: '' },
          specTitle: customSpecTitle,
          vendor: { key: customVendor, name: customVendor },
          contact: { key: customFfeContact, name: customFfeContact },
        });
        expect(
          await findSpreadsheetErrorTokens(sheetsApi, optSpreadsheetId, DEFAULT_LIVE_RETRY_OPTIONS)
        ).toEqual([]);
      } finally {
        await localTracker.trashAll(liveDriveClient);
      }
    }, 180_000);

    it('resolves submittal-ffe Vendors, Contacts, and duplicate-row Specs via SourceParser Pass 2 using seeded, concatenated, and RFC 4180 CSV Tier 2 Aliases alongside additive Tier 3 @domain fallback on a copied DocumentLog', async () => {
      const liveDriveClient = requireDriveClient();
      const ffeLogSchema = logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-ffe');
      expect(ffeLogSchema).toBeDefined();
      if (!ffeLogSchema) {
        return;
      }

      const ffeSpecsBinding = ffeLogSchema.optionBindings?.specs;
      const ffeVendorsBinding = ffeLogSchema.optionBindings?.vendors;
      const ffeContactsBinding = ffeLogSchema.optionBindings?.contacts;
      expect(ffeSpecsBinding).toBeDefined();
      expect(ffeVendorsBinding).toBeDefined();
      expect(ffeContactsBinding).toBeDefined();
      if (!ffeSpecsBinding || !ffeVendorsBinding || !ffeContactsBinding) {
        return;
      }

      const runId = `sp-ffe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const localTracker = createCleanupTracker();

      try {
        const provisioned = await provisionDocumentLogScratchSpace({
          driveClient: liveDriveClient,
          logWiring,
          spaceName: `Harborview FFE SourceParser Live ${runId}`,
          spaceId: `live-sp-ffe-space-${runId}`,
          trackCleanupId: localTracker.track,
        });
        const spSpace = provisioned.space;
        const spSpreadsheetId = provisioned.spreadsheetId;

        // 1) Seeded Tier 2 Vendors & Contacts Aliases match out of the box on untouched copied template
        const seededParser = sourceParserWiring.createSourceParser({});
        const seededFfeMatch = await seededParser.extractFields({
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
        });
        expect(seededFfeMatch.fields.specTag).toBe('CG104');
        expect(seededFfeMatch.fields.specTitle).toBe('BED - KING');
        expect(seededFfeMatch.fields.vendor).toBe('FDT');

        const seededContactMatch = await seededParser.extractFields({
          documentTypeKey: 'submittal-ffe',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-ffe-seeded-contact-${runId}`,
              subject: 'AC102-0 Coat Hook',
              from: 'Buyer <buyer@benjaminwest.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(seededContactMatch.fields.contact).toBe('BW');
        expect(seededContactMatch.fields.specTag).toBe('AC102');
        expect(seededContactMatch.fields.specTitle).toBe('HOOK');

        // 2) Customize Tier 2 Aliases on copied DocumentLog:
        //    - Duplicate Spec Tag rows (AC102) receive distinct Aliases strings concatenated & deduplicated
        //    - BM & BW receive RFC 4180 CSV with commas + escaped "" quotes and omit @domain (verifying additive Tier 3 retention)
        //    - LA receives @ashleylighting.com (verifying Tier 2 token override over Tier 3 AL)
        const rangeNames = [
          ffeSpecsBinding.rangeName,
          ffeVendorsBinding.rangeName,
          ffeContactsBinding.rangeName,
        ];
        const snapshots = await snapshotNamedRanges(
          sheetsApi,
          spSpreadsheetId,
          rangeNames,
          DEFAULT_LIVE_RETRY_OPTIONS
        );
        const gridValues = await readNamedRangesFormattedValues(
          sheetsApi,
          spSpreadsheetId,
          snapshots,
          DEFAULT_LIVE_RETRY_OPTIONS
        );

        const cellA1ForRowKey = (
          rangeName: string,
          keyHeader: string,
          keyValue: string,
          occurrence = 0
        ): string => {
          const snap = snapshots[rangeName];
          const rows = gridValues[rangeName] ?? [];
          const header = rows[0] ?? [];
          const keyCol = header.findIndex((c) => String(c).trim() === keyHeader);
          const aliasesCol = header.findIndex((c) => String(c).trim() === 'Aliases');
          expect(keyCol).toBeGreaterThanOrEqual(0);
          expect(aliasesCol).toBeGreaterThanOrEqual(0);
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

        await sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId: spSpreadsheetId,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
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
          },
        });

        const updatedOptions = await logWiring.documentLogService.readOptionTables!({
          documentTypeKey: 'submittal-ffe',
          selectedLogId: spSpreadsheetId,
          sourceKeys: ['specs'],
        });
        expect(updatedOptions.status).toBe('ready');
        if (updatedOptions.status !== 'ready') return;
        const ac102Tuple = updatedOptions.tables.specs?.tuples.find((t) => t.key === 'AC102');
        expect(ac102Tuple).toEqual({
          key: 'AC102',
          name: 'HOOK',
          aliases: ['XY999', 'Hook, "Solid" Brass', 'ZZ888'],
        });

        // Fresh WorkspaceExecutionContext so per-request LookupOptions cache reads updated Aliases
        const customParser = sourceParserWiring.createSourceParser({});

        const duplicateSpecAndCsvMatch = await customParser.extractFields({
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
        });
        expect(duplicateSpecAndCsvMatch.fields.specTag).toBe('AC102');
        expect(duplicateSpecAndCsvMatch.fields.specTitle).toBe('HOOK');
        expect(duplicateSpecAndCsvMatch.fields.vendor).toBe('BM');
        expect(duplicateSpecAndCsvMatch.fields.contact).toBe('BW');

        const additiveTier3VendorMatch = await customParser.extractFields({
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
        });
        expect(additiveTier3VendorMatch.fields.vendor).toBe('BM');

        const additiveTier3ContactMatch = await customParser.extractFields({
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
        });
        expect(additiveTier3ContactMatch.fields.contact).toBe('BW');

        const tier2OverrideVendorMatch = await customParser.extractFields({
          documentTypeKey: 'submittal-ffe',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-ffe-tier2-override-${runId}`,
              subject: 'CG104-0 Lounge Bed',
              from: 'Sales <sales@ashleylighting.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(tier2OverrideVendorMatch.fields.vendor).toBe('LA');

        const tier3NonCollidingVendorMatch = await customParser.extractFields({
          documentTypeKey: 'submittal-ffe',
          spaceId: spSpace.abstractStorageId,
          selectedLogId: spSpreadsheetId,
          context: {
            isDriveUrl: false,
            email: {
              id: `msg-ffe-tier3-al-${runId}`,
              subject: 'CG104-0 Lounge Bed',
              from: 'Ashley Lighting <noreply@other.example.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 10:00:00 -0500',
              labels: ['INBOX'],
            },
          },
        });
        expect(tier3NonCollidingVendorMatch.fields.vendor).toBe('AL');

        expect(
          await findSpreadsheetErrorTokens(sheetsApi, spSpreadsheetId, DEFAULT_LIVE_RETRY_OPTIONS)
        ).toEqual([]);
      } finally {
        await localTracker.trashAll(liveDriveClient);
      }
    }, 120_000);
  }
);

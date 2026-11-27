import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PDFDocument } from 'pdf-lib';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import { createDocumentLogWiring, type DocumentLogWiring } from '../../src/app/document-log.wiring';
import { createDocumentSpaceFeatureWiring } from '../../src/app/document-space.wiring';
import {
  createDocumentFeatureWiring,
  createDocumentServiceFactory,
} from '../../src/app/document.wiring';
import { createLookupOptionsWiring, type LookupOptionsWiring } from '../../src/app/lookup-options.wiring';
import { createSourceParserWiring, type SourceParserWiring } from '../../src/app/source-parser.wiring';
import type { DocumentServiceFactory } from '../../src/app/ui-process-manager.wiring';
import type { CopyDocumentLogResult } from '../../src/features/document-log';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { GoogleSheetsClient, type PositiveTableTarget } from '../../src/infrastructure/sheets';
import { HandlebarsAdapter } from '../../src/infrastructure/template-engine/handlebars-adapter';
import {
  getDocumentLogTestFolderId,
  resolveLiveGoogleAuth,
} from './utils/live-google-auth';
import {
  DEFAULT_LIVE_RETRY_OPTIONS,
  appendRawPositiveTableRows,
  clearOptionTableToEmpty,
  createLiveSheetsApi,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSheetErrorTokens,
  findSpreadsheetErrorTokens,
  findSideBySideTableShiftViolations,
  inspectPositiveTableLayout,
  loadDocumentLogSampleFixture,
  partialHydrationRowToCellInputs,
  readNamedRangesFormattedValues,
  readOptionTableGridFormats,
  snapshotNamedRanges,
} from './utils/live-sheets-helper';

const sampleFixture = loadDocumentLogSampleFixture();

const TEST_FOLDER_ID = getDocumentLogTestFolderId();

describe.skipIf(!TEST_FOLDER_ID)('Live DocumentLog E2E Verification (Copy-and-Trash)', () => {
  const cleanupIds: string[] = [];
  let driveClient: GoogleDriveClient | undefined;
  let sheetsApi: sheets_v4.Sheets;
  let sheetsClient: GoogleSheetsClient;
  let logWiring: DocumentLogWiring;
  let lookupOptionsWiring: LookupOptionsWiring;
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
  let ffeFileId: string;
  let ffeFileName: string;

  const trackCleanupId = (id: string | undefined): void => {
    if (!id || id.trim().length === 0) {
      return;
    }
    if (id === TEST_FOLDER_ID || id === sampleFixture.metadata.templateSpreadsheetId) {
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

  const archTarget = (): PositiveTableTarget => ({
    spreadsheetId: copiedSpreadsheetId,
    sheetName: sampleFixture.submittalArch.sheetName,
    rangeName: sampleFixture.submittalArch.rangeName,
    extentMarker: '<--->',
    groupDividerMarker: '---',
  });

  const ffeTarget = (): PositiveTableTarget => ({
    spreadsheetId: copiedSpreadsheetId,
    sheetName: sampleFixture.submittalFfe.sheetName,
    rangeName: sampleFixture.submittalFfe.rangeName,
    extentMarker: '<--->',
    groupDividerMarker: '---',
  });

  beforeAll(async () => {
    if (!TEST_FOLDER_ID) {
      throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live DocumentLog E2E tests.');
    }
    const auth = resolveLiveGoogleAuth();
    const liveDriveClient = new GoogleDriveClient({
      auth,
      retryOptions: DEFAULT_LIVE_RETRY_OPTIONS,
    });
    driveClient = liveDriveClient;
    sheetsApi = createLiveSheetsApi(auth);
    sheetsClient = new GoogleSheetsClient({
      sheets: sheetsApi,
      retryOptions: DEFAULT_LIVE_RETRY_OPTIONS,
    });

    const manifestProvider = new AppManifestProvider({
      manifestPath: path.resolve(__dirname, '../../assets/manifest.json'),
    });
    const handlebars = new HandlebarsAdapter();
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

    lookupOptionsWiring = createLookupOptionsWiring({
      manifestProvider,
      documentSchemaRegistry,
      driveClient: liveDriveClient,
      configProvider: manifestProvider,
      getDocumentLogService: (ctx) => logWiring.getPerRequestService(ctx),
      ensureDocumentLogInitialized: () => logWiring.logSchemaRegistry.initialize(),
    });

    const spaceWiring = createDocumentSpaceFeatureWiring({
      rawManifestProvider: manifestProvider,
      driveClient: liveDriveClient,
    });
    await spaceWiring.documentSpaceService.initialize();

    sourceParserWiring = createSourceParserWiring({
      spaceTypesProvider: spaceWiring.documentSpaceService,
      manifestProvider,
      driveClient: liveDriveClient,
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
      getCanonicalOptionsProvider: (ctx) =>
        lookupOptionsWiring.createCanonicalOptionsProvider(ctx),
    });
    await sourceParserWiring.parseSchemaRegistry.initialize();

    documentServiceFactory = createDocumentServiceFactory({
      manifestProvider,
      documentSchemaRegistry,
      templateEvaluator: handlebars,
      compiledSchemaRegistry,
      configProvider: manifestProvider,
      driveClient: liveDriveClient,
      documentLogService: logWiring.documentLogService,
      ensureDocumentLogInitialized: () => logWiring.logSchemaRegistry.initialize(),
      getDynamicValidator: (requestContext) =>
        lookupOptionsWiring.createDynamicValidator(requestContext),
      createAdditionalActivityHandlers: (context, requestContext) => {
        const effectiveCtx = requestContext ?? context;
        const sharedLookup = lookupOptionsWiring.getPerRequestLookupOptions(effectiveCtx);
        return [
          logWiring.createPerRequestActivityHandler(effectiveCtx, {
            ...(context.selectedLogId !== undefined ? { selectedLogId: context.selectedLogId } : {}),
            onWriteLogSuccess: () => sharedLookup.invalidate(),
          }),
        ];
      },
    });

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    spaceName = `Harborview Live E2E ${runId}`;

    const spaceFolder = await liveDriveClient.findOrCreateFolder(TEST_FOLDER_ID, spaceName);
    spaceFolderId = spaceFolder.id;
    trackCleanupId(spaceFolder.id);
    space = {
      id: `live-space-${runId}`,
      typeId: 'proposals',
      name: spaceName,
      abstractStorageId: spaceFolder.id,
    };

    initialCopyResult = await logWiring.documentLogService.copyLog(space);
    copiedSpreadsheetId = initialCopyResult.candidate.id;
    const copiedParentId = initialCopyResult.candidate.parents?.[0];
    if (copiedParentId && copiedParentId !== spaceFolder.id) {
      adminFolderId = copiedParentId;
    } else {
      try {
        const resolvedAdmin = await liveDriveClient.resolveFolderPath(spaceFolder.id, ['1 Admin']);
        adminFolderId = resolvedAdmin.id;
      } catch {
        // Verified in test assertions; afterAll also performs best-effort cleanup
      }
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

    await ensureClearedPositiveTable(sheetsApi, archTarget());
    await ensureClearedPositiveTable(sheetsApi, ffeTarget());

    const dummyPdfDoc = await PDFDocument.create();
    dummyPdfDoc.addPage([612, 792]).drawText('Live DocumentLog E2E Target Content');
    const dummyPdfBytes = Buffer.from(await dummyPdfDoc.save());

    archFileName = `Live_Arch_Submittal_${runId}.pdf`;
    const archFile = await liveDriveClient.saveBuffer(dummyPdfBytes, {
      action: 'create',
      name: archFileName,
      targetFolderId: spaceFolder.id,
      mimeType: 'application/pdf',
    });
    archFileId = archFile.id;
    trackCleanupId(archFile.id);

    ffeFileName = `Live_FFE_Submittal_${runId}.pdf`;
    const ffeFile = await liveDriveClient.saveBuffer(dummyPdfBytes, {
      action: 'create',
      name: ffeFileName,
      targetFolderId: spaceFolder.id,
      mimeType: 'application/pdf',
    });
    ffeFileId = ffeFile.id;
    trackCleanupId(ffeFile.id);
  }, 60_000);

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
        // Best-effort discovery if copyLog failed after creating 1 Admin
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

  it('provisions a new DocumentLog via DocumentLogPort.copyLog() (auto-creating "1 Admin" and applying copyNameTemplate) and resolves it', async () => {
    const liveDriveClient = requireDriveClient();

    expect(initialCopyResult.created).toBe(true);
    expect(initialCopyResult.folderPath).toBe('1 Admin');
    expect(initialCopyResult.candidate.id).toBe(copiedSpreadsheetId);
    expect(copiedSpreadsheetId).not.toBe(sampleFixture.metadata.templateSpreadsheetId);
    expect(initialCopyResult.candidate.name).toBe(`${spaceName} Document Log`);

    const adminFolder = await liveDriveClient.resolveFolderPath(spaceFolderId, ['1 Admin']);
    adminFolderId = adminFolder.id;
    trackCleanupId(adminFolder.id);
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
    trackCleanupId(secondCopy.candidate.id);

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
    trackCleanupId(submittalsFolder.id);
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
    trackCleanupId(ffeSubmittalsFolder.id);
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

  it('resiliently hydrates injected partial-hydration invalid rows against real Google Sheets with filter-scoped warning isolation', async () => {
    // 1) Submittal Arch
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

    // 2) Submittal FF&E
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
    const localCleanupIds: string[] = [];
    const trackLocal = (id: string | undefined): void => {
      if (!id || id.trim().length === 0) return;
      if (id === TEST_FOLDER_ID || id === templateId) return;
      if (!localCleanupIds.includes(id)) localCleanupIds.push(id);
    };

    try {
      const optSpaceName = `Harborview Arch Options Live ${runId}`;
      const optSpaceFolder = await liveDriveClient.findOrCreateFolder(TEST_FOLDER_ID!, optSpaceName);
      trackLocal(optSpaceFolder.id);

      const optSpace = {
        id: `live-opt-arch-space-${runId}`,
        typeId: 'proposals',
        name: optSpaceName,
        abstractStorageId: optSpaceFolder.id,
      };

      const optCopy = await logWiring.documentLogService.copyLog(optSpace);
      const optSpreadsheetId = optCopy.candidate.id;
      const optAdminId = optCopy.candidate.parents?.[0];
      if (optAdminId && optAdminId !== optSpaceFolder.id) {
        trackLocal(optAdminId);
      }
      trackLocal(optSpreadsheetId);

      expect(optCopy.created).toBe(true);
      expect(optSpreadsheetId).not.toBe(templateId);

      const optArchTarget: PositiveTableTarget = {
        spreadsheetId: optSpreadsheetId,
        sheetName: archLogSchema.target.sheetName,
        rangeName: archLogSchema.target.rangeName,
        extentMarker: archLogSchema.target.extentMarker,
        groupDividerMarker: archLogSchema.target.groupDividerMarker,
      };
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
        DEFAULT_LIVE_RETRY_OPTIONS
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
        optSpaceFolder.id,
        '6 Construction'
      );
      trackLocal(constructionFolder.id);

      const dummyPdfDoc = await PDFDocument.create();
      dummyPdfDoc.addPage([612, 792]).drawText('Live Arch Options E2E Target Content');
      const dummyPdfBytes = Buffer.from(await dummyPdfDoc.save());
      const optArchFile = await liveDriveClient.saveBuffer(dummyPdfBytes, {
        action: 'create',
        name: `Opt_Arch_${runId}.pdf`,
        targetFolderId: optSpaceFolder.id,
        mimeType: 'application/pdf',
      });
      trackLocal(optArchFile.id);

      // 2) Clear Options_Submittal_Arch_Contacts to empty and verify empty-table formatting inheritance + NamedRange expansion + side-by-side stability
      const templateContactsGrid = await readOptionTableGridFormats(sheetsApi, {
        spreadsheetId: templateId,
        sheetName: archContactsBinding.sheetName,
        rangeName: archContactsBinding.rangeName,
        endMarker: archContactsBinding.endMarker,
      });
      expect(templateContactsGrid.headerRow).toEqual(['Type', 'Key', 'Name', 'Aliases']);
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
      expect(archSubmit.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'DUPLICATE_FILE', 'INSERT_PAGES', 'WRITE_LOG']);

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
      for (const id of [...localCleanupIds].reverse()) {
        try {
          await liveDriveClient.trash(id);
        } catch {
          // Best-effort cleanup of every created artifact
        }
      }
    }
  }, 180_000);

  it('resolves submittal-arch Contacts via SourceParser Pass 2 using seeded and RFC 4180 CSV Tier 2 Aliases alongside additive Tier 3 @domain fallback on a copied DocumentLog', async () => {
    const liveDriveClient = requireDriveClient();
    const templateId = sampleFixture.metadata.templateSpreadsheetId;
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
    const localCleanupIds: string[] = [];
    const trackLocal = (id: string | undefined): void => {
      if (!id || id.trim().length === 0) return;
      if (id === TEST_FOLDER_ID || id === templateId) return;
      if (!localCleanupIds.includes(id)) localCleanupIds.push(id);
    };

    try {
      const spSpaceName = `Harborview SourceParser Live ${runId}`;
      const spSpaceFolder = await liveDriveClient.findOrCreateFolder(TEST_FOLDER_ID!, spSpaceName);
      trackLocal(spSpaceFolder.id);

      const spSpace = {
        id: `live-sp-arch-space-${runId}`,
        typeId: 'proposals',
        name: spSpaceName,
        abstractStorageId: spSpaceFolder.id,
      };

      const spCopy = await logWiring.documentLogService.copyLog(spSpace);
      const spSpreadsheetId = spCopy.candidate.id;
      const spAdminId = spCopy.candidate.parents?.[0];
      if (spAdminId && spAdminId !== spSpaceFolder.id) {
        trackLocal(spAdminId);
      }
      trackLocal(spSpreadsheetId);

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
      const contactsValues = (
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

      const pmgRowOffset = contactsValues.findIndex((r) => String(r[keyColOffset] ?? '').trim() === 'PMG');
      const fxcRowOffset = contactsValues.findIndex((r) => String(r[keyColOffset] ?? '').trim() === 'FXC');
      expect(pmgRowOffset).toBeGreaterThan(0);
      expect(fxcRowOffset).toBeGreaterThan(0);

      const startRow = (contactsRange.gridRange.startRowIndex ?? 0) + 1;
      const aliasesColLetter = String.fromCharCode(
        65 + (contactsRange.gridRange.startColumnIndex ?? 0) + aliasesColOffset
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
      for (const id of [...localCleanupIds].reverse()) {
        try {
          await liveDriveClient.trash(id);
        } catch {
          // Best-effort cleanup of every created artifact
        }
      }
    }
  }, 120_000);

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
    const localCleanupIds: string[] = [];
    const trackLocal = (id: string | undefined): void => {
      if (!id || id.trim().length === 0) return;
      if (id === TEST_FOLDER_ID || id === templateId) return;
      if (!localCleanupIds.includes(id)) localCleanupIds.push(id);
    };

    try {
      const optSpaceName = `Harborview FFE Options Live ${runId}`;
      const optSpaceFolder = await liveDriveClient.findOrCreateFolder(TEST_FOLDER_ID!, optSpaceName);
      trackLocal(optSpaceFolder.id);

      const optSpace = {
        id: `live-opt-ffe-space-${runId}`,
        typeId: 'proposals',
        name: optSpaceName,
        abstractStorageId: optSpaceFolder.id,
      };

      const optCopy = await logWiring.documentLogService.copyLog(optSpace);
      const optSpreadsheetId = optCopy.candidate.id;
      const optAdminId = optCopy.candidate.parents?.[0];
      if (optAdminId && optAdminId !== optSpaceFolder.id) {
        trackLocal(optAdminId);
      }
      trackLocal(optSpreadsheetId);

      expect(optCopy.created).toBe(true);
      expect(optSpreadsheetId).not.toBe(templateId);

      const optFfeTarget: PositiveTableTarget = {
        spreadsheetId: optSpreadsheetId,
        sheetName: ffeLogSchema.target.sheetName,
        rangeName: ffeLogSchema.target.rangeName,
        extentMarker: ffeLogSchema.target.extentMarker,
        groupDividerMarker: ffeLogSchema.target.groupDividerMarker,
      };
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

      const ffeFolder = await liveDriveClient.findOrCreateFolder(optSpaceFolder.id, '3 FFE');
      trackLocal(ffeFolder.id);

      const dummyPdfDoc = await PDFDocument.create();
      dummyPdfDoc.addPage([612, 792]).drawText('Live FFE Options E2E Target Content');
      const dummyPdfBytes = Buffer.from(await dummyPdfDoc.save());
      const optFfeFile = await liveDriveClient.saveBuffer(dummyPdfBytes, {
        action: 'create',
        name: `Opt_FFE_${runId}.pdf`,
        targetFolderId: optSpaceFolder.id,
        mimeType: 'application/pdf',
      });
      trackLocal(optFfeFile.id);

      // 2) Clear 3-col Specs and 4-col Vendors & Contacts to empty and verify Row 4 format cloning + Named Range expansion + side-by-side stability
      const templateSpecsGrid = await readOptionTableGridFormats(sheetsApi, {
        spreadsheetId: templateId,
        sheetName: ffeSpecsBinding.sheetName,
        rangeName: ffeSpecsBinding.rangeName,
        endMarker: ffeSpecsBinding.endMarker,
      });
      expect(templateSpecsGrid.headerRow).toEqual(['Tag', 'Title', 'Aliases']);
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
      for (const id of [...localCleanupIds].reverse()) {
        try {
          await liveDriveClient.trash(id);
        } catch {
          // Best-effort cleanup of every created artifact
        }
      }
    }
  }, 180_000);

  it('resolves submittal-ffe Vendors, Contacts, and duplicate-row Specs via SourceParser Pass 2 using seeded, concatenated, and RFC 4180 CSV Tier 2 Aliases alongside additive Tier 3 @domain fallback on a copied DocumentLog', async () => {
    const liveDriveClient = requireDriveClient();
    const templateId = sampleFixture.metadata.templateSpreadsheetId;
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
    const localCleanupIds: string[] = [];
    const trackLocal = (id: string | undefined): void => {
      if (!id || id.trim().length === 0) return;
      if (id === TEST_FOLDER_ID || id === templateId) return;
      if (!localCleanupIds.includes(id)) localCleanupIds.push(id);
    };

    try {
      const spSpaceName = `Harborview FFE SourceParser Live ${runId}`;
      const spSpaceFolder = await liveDriveClient.findOrCreateFolder(TEST_FOLDER_ID!, spSpaceName);
      trackLocal(spSpaceFolder.id);

      const spSpace = {
        id: `live-sp-ffe-space-${runId}`,
        typeId: 'proposals',
        name: spSpaceName,
        abstractStorageId: spSpaceFolder.id,
      };

      const spCopy = await logWiring.documentLogService.copyLog(spSpace);
      const spSpreadsheetId = spCopy.candidate.id;
      const spAdminId = spCopy.candidate.parents?.[0];
      if (spAdminId && spAdminId !== spSpaceFolder.id) {
        trackLocal(spAdminId);
      }
      trackLocal(spSpreadsheetId);

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
        const colLetter = String.fromCharCode(65 + (snap.gridRange.startColumnIndex ?? 0) + aliasesCol);
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
      for (const id of [...localCleanupIds].reverse()) {
        try {
          await liveDriveClient.trash(id);
        } catch {
          // Best-effort cleanup of every created artifact
        }
      }
    }
  }, 120_000);
});

import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import { createDocumentLogWiring, type DocumentLogWiring } from '../../src/app/document-log.wiring';
import {
  createDocumentFeatureWiring,
  createDocumentServiceFactory,
} from '../../src/app/document.wiring';
import { createLookupOptionsWiring } from '../../src/app/lookup-options.wiring';
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

    const dummyPdfBytes = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
      'utf-8'
    );

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

  it('verifies live DocumentLog option reads, empty-table template formatting inheritance, Named Range expansion, VLOOKUP Spec Title resolution, and side-by-side _Config stability on a fresh copied template with finally cleanup', async () => {
    const liveDriveClient = requireDriveClient();
    const templateId = sampleFixture.metadata.templateSpreadsheetId;
    const discoveryConfig = logWiring.logSchemaRegistry.getDiscoveryConfig('proposals');
    expect(discoveryConfig?.templateSpreadsheetId).toBe(templateId);
    const archLogSchema = logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-arch');
    const ffeLogSchema = logWiring.logSchemaRegistry.getDocumentLogSchema('submittal-ffe');
    expect(archLogSchema).toBeDefined();
    expect(ffeLogSchema).toBeDefined();
    if (!archLogSchema || !ffeLogSchema) {
      return;
    }

    const archContactsBinding = archLogSchema.optionBindings?.contacts;
    const archStatusesBinding = archLogSchema.optionBindings?.statuses;
    const archActionsBinding = archLogSchema.optionBindings?.actions;
    const ffeSpecsBinding = ffeLogSchema.optionBindings?.specs;
    const ffeVendorsBinding = ffeLogSchema.optionBindings?.vendors;
    const ffeContactsBinding = ffeLogSchema.optionBindings?.contacts;
    const ffeStatusesBinding = ffeLogSchema.optionBindings?.statuses;
    const ffeActionsBinding = ffeLogSchema.optionBindings?.actions;
    expect(archContactsBinding).toBeDefined();
    expect(archStatusesBinding).toBeDefined();
    expect(archActionsBinding).toBeDefined();
    expect(ffeSpecsBinding).toBeDefined();
    expect(ffeVendorsBinding).toBeDefined();
    expect(ffeContactsBinding).toBeDefined();
    expect(ffeStatusesBinding).toBeDefined();
    expect(ffeActionsBinding).toBeDefined();
    if (
      !archContactsBinding ||
      !archStatusesBinding ||
      !archActionsBinding ||
      !ffeSpecsBinding ||
      !ffeVendorsBinding ||
      !ffeContactsBinding ||
      !ffeStatusesBinding ||
      !ffeActionsBinding
    ) {
      return;
    }

    const runId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const localCleanupIds: string[] = [];
    const trackLocal = (id: string | undefined): void => {
      if (!id || id.trim().length === 0) return;
      if (id === TEST_FOLDER_ID || id === templateId) return;
      if (!localCleanupIds.includes(id)) localCleanupIds.push(id);
    };

    try {
      const optSpaceName = `Harborview Options Live ${runId}`;
      const optSpaceFolder = await liveDriveClient.findOrCreateFolder(TEST_FOLDER_ID!, optSpaceName);
      trackLocal(optSpaceFolder.id);

      const optSpace = {
        id: `live-opt-space-${runId}`,
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
      const optFfeTarget: PositiveTableTarget = {
        spreadsheetId: optSpreadsheetId,
        sheetName: ffeLogSchema.target.sheetName,
        rangeName: ffeLogSchema.target.rangeName,
        extentMarker: ffeLogSchema.target.extentMarker,
        groupDividerMarker: ffeLogSchema.target.groupDividerMarker,
      };
      await ensureClearedPositiveTable(sheetsApi, optArchTarget);
      await ensureClearedPositiveTable(sheetsApi, optFfeTarget);

      // 1) Live option reads from untouched copied firm template
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
      expect(initialArchOptions.tables.contacts?.tuples.length).toBeGreaterThan(0);

      const initialFfeOptions = await logWiring.documentLogService.readOptionTables!({
        documentTypeKey: 'submittal-ffe',
        space: optSpace,
        selectedLogId: optSpreadsheetId,
      });
      expect(initialFfeOptions.status).toBe('ready');
      if (initialFfeOptions.status !== 'ready') return;
      expect(initialFfeOptions.spreadsheetId).toBe(optSpreadsheetId);
      for (const sourceKey of ['statuses', 'actions', 'contacts', 'vendors', 'specs']) {
        expect(initialFfeOptions.tables[sourceKey]?.status).toBe('ready');
        expect(initialFfeOptions.tables[sourceKey]?.tuples.length).toBeGreaterThan(0);
      }

      // Create source folders and PDFs for DocumentService.processDocument()
      const constructionFolder = await liveDriveClient.findOrCreateFolder(
        optSpaceFolder.id,
        '6 Construction'
      );
      trackLocal(constructionFolder.id);
      const ffeFolder = await liveDriveClient.findOrCreateFolder(optSpaceFolder.id, '3 FFE');
      trackLocal(ffeFolder.id);

      const dummyPdfBytes = Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
        'utf-8'
      );
      const optArchFile = await liveDriveClient.saveBuffer(dummyPdfBytes, {
        action: 'create',
        name: `Opt_Arch_${runId}.pdf`,
        targetFolderId: optSpaceFolder.id,
        mimeType: 'application/pdf',
      });
      trackLocal(optArchFile.id);
      const optFfeFile = await liveDriveClient.saveBuffer(dummyPdfBytes, {
        action: 'create',
        name: `Opt_FFE_${runId}.pdf`,
        targetFolderId: optSpaceFolder.id,
        mimeType: 'application/pdf',
      });
      trackLocal(optFfeFile.id);

      // 2) Clear Options_Submittal_Arch_Contacts to empty and verify empty-table formatting inheritance + NamedRange expansion + side-by-side stability
      const templateContactsGrid = await readOptionTableGridFormats(sheetsApi, {
        spreadsheetId: templateId,
        sheetName: archContactsBinding.sheetName,
        rangeName: archContactsBinding.rangeName,
        endMarker: archContactsBinding.endMarker,
      });
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
      const insertedContactRow = copiedContactsGrid.dataRows.find(
        (r) => r.cells[0]?.formattedValue.trim() === customArchContact
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

      // 3) Custom Spec Tag + Spec Title atomic WRITE_LOG, Validation_* expansion, VLOOKUP resolution, and side-by-side _Config Submittal FF&E stability
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
      const customSpecTitle = `CUSTOM LIVE LOUNGE ${runId.slice(-4).toUpperCase()}`;
      const customVendor = `Custom Live Millwork ${runId.slice(-4).toUpperCase()}`;
      const customFfeContact = `T363F_${runId.slice(-4).toUpperCase()}`;

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
            revision: '0',
            specTitle: customSpecTitle,
            vendor: customVendor,
            date: '260401',
            contact: customFfeContact,
            action: 'REC',
            notes: 'Ticket 363 custom FF&E option write-back',
          },
        },
        'onSubmit'
      );
      expect(ffeSubmit.success).toBe(true);
      if (!ffeSubmit.success) return;
      expect(ffeSubmit.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'DUPLICATE_FILE', 'INSERT_PAGES', 'WRITE_LOG']);

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

      for (const expandedRange of [
        ffeSpecsBinding.rangeName,
        ffeVendorsBinding.rangeName,
        ffeContactsBinding.rangeName,
      ]) {
        expect(ffeSnapshotsAfter[expandedRange].gridRange.endRowIndex).toBe(
          (ffeSnapshotsBefore[expandedRange].gridRange.endRowIndex ?? 0) + 1
        );
      }

      for (const binding of [ffeSpecsBinding, ffeVendorsBinding, ffeContactsBinding]) {
        if (!binding.validationRangeName) continue;
        const rowsBefore = ffeValuesBefore[binding.rangeName] ?? [];
        const termRel = rowsBefore.findIndex((r) =>
          r.some((cell) => cell !== null && cell !== undefined && String(cell).trim() === binding.endMarker)
        );
        expect(termRel).toBeGreaterThan(0);
        const absTerminatorBefore =
          (ffeSnapshotsBefore[binding.rangeName].gridRange.startRowIndex ?? 0) + termRel;
        expect(ffeSnapshotsAfter[binding.validationRangeName].gridRange.endRowIndex).toBe(
          absTerminatorBefore + 1
        );
        expect(
          ffeSnapshotsAfter[binding.validationRangeName].gridRange.endRowIndex
        ).toBeGreaterThan(
          ffeSnapshotsBefore[binding.validationRangeName].gridRange.endRowIndex ?? 0
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

      const ffeTableAfter = await sheetsClient.readTable({ target: optFfeTarget });
      expect(ffeTableAfter.formulaColumns).toEqual(['Spec Title']);
      expect(ffeTableAfter.rows).toHaveLength(1);
      expect(ffeTableAfter.rows[0].values).toMatchObject({
        'Spec Tag': customSpecTag,
        'Spec Title': customSpecTitle,
        Vendor: customVendor,
        Contact: customFfeContact,
      });
      expect(findSheetErrorTokens(ffeTableAfter.rows[0].values)).toEqual([]);

      const updatedFfeOptions = await logWiring.documentLogService.readOptionTables!({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: optSpreadsheetId,
      });
      expect(updatedFfeOptions.status).toBe('ready');
      if (updatedFfeOptions.status !== 'ready') return;
      expect(updatedFfeOptions.tables.specs?.tuples).toContainEqual(
        expect.objectContaining({ key: customSpecTag, name: customSpecTitle })
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
        specTitle: customSpecTitle,
        vendor: { key: customVendor, name: customVendor },
        contact: { key: customFfeContact, name: customFfeContact },
      });
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
});

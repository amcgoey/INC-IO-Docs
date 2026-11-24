import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import { createDocumentLogWiring, type DocumentLogWiring } from '../../src/app/document-log.wiring';
import {
  createDocumentFeatureWiring,
  createDocumentServiceFactory,
} from '../../src/app/document.wiring';
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
  createLiveSheetsApi,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSheetErrorTokens,
  inspectPositiveTableLayout,
  loadDocumentLogSampleFixture,
  partialHydrationRowToCellInputs,
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

    documentServiceFactory = createDocumentServiceFactory({
      documentSchemaRegistry,
      templateEvaluator: handlebars,
      compiledSchemaRegistry,
      configProvider: manifestProvider,
      driveClient: liveDriveClient,
      createAdditionalActivityHandlers: (context) => [
        logWiring.createPerRequestActivityHandler(context),
      ],
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
      expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
      expect(result.contextVariables?.documentLogWrite).toMatchObject({
        spreadsheetId: copiedSpreadsheetId,
        sheetName: sampleFixture.submittalArch.sheetName,
      });
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
    const archFileMeta = await liveDriveClient.getFile(archFileId);
    expect(archFileMeta.parents).toContain(submittalsFolder.id);
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
      expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
      expect(result.contextVariables?.documentLogWrite).toMatchObject({
        spreadsheetId: copiedSpreadsheetId,
        sheetName: sampleFixture.submittalFfe.sheetName,
      });
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
    const ffeFileMeta = await liveDriveClient.getFile(ffeFileId);
    expect(ffeFileMeta.parents).toContain(ffeSubmittalsFolder.id);
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
});

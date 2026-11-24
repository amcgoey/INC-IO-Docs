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
  createLiveSheetsApi,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSheetErrorTokens,
  inspectPositiveTableLayout,
  loadDocumentLogSampleFixture,
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
  let archFileId: string;
  let archFileName: string;
  let ffeFileId: string;
  let ffeFileName: string;

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
    cleanupIds.push(spaceFolder.id);
    space = {
      id: `live-space-${runId}`,
      typeId: 'proposals',
      name: spaceName,
      abstractStorageId: spaceFolder.id,
    };

    const adminFolder = await liveDriveClient.findOrCreateFolder(spaceFolder.id, '1 Admin');
    cleanupIds.push(adminFolder.id);

    const constructionFolder = await liveDriveClient.findOrCreateFolder(
      spaceFolder.id,
      '6 Construction'
    );
    cleanupIds.push(constructionFolder.id);

    const ffeFolder = await liveDriveClient.findOrCreateFolder(spaceFolder.id, '3 FFE');
    cleanupIds.push(ffeFolder.id);

    const copied = await liveDriveClient.duplicate(sampleFixture.metadata.templateSpreadsheetId, {
      newName: `${spaceName} Document Log`,
      targetFolderId: adminFolder.id,
    });
    copiedSpreadsheetId = copied.id;
    cleanupIds.push(copied.id);

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
    cleanupIds.push(archFile.id);

    ffeFileName = `Live_FFE_Submittal_${runId}.pdf`;
    const ffeFile = await liveDriveClient.saveBuffer(dummyPdfBytes, {
      action: 'create',
      name: ffeFileName,
      targetFolderId: spaceFolder.id,
      mimeType: 'application/pdf',
    });
    ffeFileId = ffeFile.id;
    cleanupIds.push(ffeFile.id);
  }, 60_000);

  afterAll(async () => {
    if (!driveClient) {
      return;
    }
    for (const id of [...cleanupIds].reverse()) {
      try {
        await driveClient.trash(id);
      } catch {
        // Best-effort cleanup of every created artifact
      }
    }
  }, 90_000);

  it('resolves the folder-backed DocumentLog inside DOCUMENT_LOG_TEST_FOLDER_ID', async () => {
    const resolved = await logWiring.documentLogService.resolveLog(space);

    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') return;
    expect(resolved.candidate).toMatchObject({
      id: copiedSpreadsheetId,
      name: `${spaceName} Document Log`,
    });
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
    const archFileMeta = await liveDriveClient.getFile(archFileId);
    expect(archFileMeta.parents).toContain(submittalsFolder.id);
  }, 180_000);

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
    const ffeFileMeta = await liveDriveClient.getFile(ffeFileId);
    expect(ffeFileMeta.parents).toContain(ffeSubmittalsFolder.id);
  }, 180_000);
});

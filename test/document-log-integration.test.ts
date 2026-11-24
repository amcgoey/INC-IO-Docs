import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type AppOptions } from '../src/app/server';
import { DocumentLogActivityHandler } from '../src/app/document-log-activity-handler';
import { createDocumentLogWiring } from '../src/app/document-log.wiring';
import {
  createDocumentServiceFactory,
  wireDocumentServicesAndRoutes,
} from '../src/app/document.wiring';
import { createHttpServer } from '../src/infrastructure/http';
import { ActivityEngine } from '../src/features/document/adapters/activity-engine';
import { CompiledSchemaRegistry } from '../src/features/document/adapters/compiled-schema-registry';
import { DocumentSchemaRegistryAdapter } from '../src/features/document/adapters/document-schema-registry';
import { DriveActivityHandler } from '../src/features/document/adapters/drive-activity-handler';
import { DocumentService, type Document, type DocumentType } from '../src/features/document/domain';
import type { ActivityHandler, DocumentSchemaRegistryPort } from '../src/features/document/ports';
import type { DocumentLogPort } from '../src/features/document-log';
import { GoogleDriveClient, type GoogleDriveClientOptions } from '../src/infrastructure/drive/drive-client';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { GoogleSheetsClient, type GoogleSheetsClientOptions } from '../src/infrastructure/sheets';
import { HandlebarsAdapter } from '../src/infrastructure/template-engine/handlebars-adapter';
import { ensureEvaluationOrder } from '../src/infrastructure/validation/json-logic-graph';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';

const sampleFixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'fixtures/document-log-sample-data.json'), 'utf-8')
) as {
  space: {
    id: string;
    typeId: string;
    name: string;
    abstractStorageId: string;
    expectedLogFileName: string;
  };
  submittalArch: {
    sheetName: string;
    rangeName: string;
    headers: string[];
    seedEntries: Array<{
      documentData: Record<string, unknown>;
      actionName: string;
      fileUri: string | null;
      identity: { idGroup: string; idDocument: string; id: string };
    }>;
  };
};

interface MockDriveState {
  searchResults: Array<{
    id: string;
    name: string;
    parents?: string[];
    mimeType?: string;
    webViewLink?: string;
  }>;
}

function createMockDriveSdk(state: MockDriveState): NonNullable<GoogleDriveClientOptions['drive']> {
  const list = vi.fn().mockImplementation(async (params: { q?: string }) => {
    const q = params.q ?? '';
    // Folder resolution for MOVE_FILE ("6 Construction" -> "Submittals")
    if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
      if (q.includes("name = '6 Construction'")) {
        return {
          data: {
            files: [
              {
                id: 'folder-6-construction',
                name: '6 Construction',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [sampleFixture.space.abstractStorageId],
              },
            ],
          },
        };
      }
      if (q.includes("name = 'Submittals'")) {
        return {
          data: {
            files: [
              {
                id: 'folder-submittals',
                name: 'Submittals',
                mimeType: 'application/vnd.google-apps.folder',
                parents: ['folder-6-construction'],
              },
            ],
          },
        };
      }
      return { data: { files: [] } };
    }

    // Spreadsheet discovery for resolveLog
    if (q.includes("mimeType = 'application/vnd.google-apps.spreadsheet'")) {
      return {
        data: {
          files: state.searchResults,
        },
      };
    }

    return { data: { files: [] } };
  });

  const get = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({
    data: {
      id: fileId,
      name: '071200-001-0 Fluid-Applied Waterproofing Membrane.pdf',
      parents: ['inbox-folder'],
      mimeType: 'application/pdf',
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    },
  }));

  const update = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({
    data: {
      id: fileId,
      name: '071200-001-0 Fluid-Applied Waterproofing Membrane - 260204 MB.pdf',
      parents: ['folder-submittals'],
      mimeType: 'application/pdf',
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    },
  }));

  return {
    files: { list, get, update },
  } as unknown as NonNullable<GoogleDriveClientOptions['drive']>;
}

interface MockBatchRequest {
  insertDimension?: { range?: { startIndex?: number } };
  updateCells?: {
    range?: { startRowIndex?: number };
    rows?: Array<{ values?: unknown[] }>;
  };
}

interface MockSheetsState {
  tableValues: Array<Array<string | number | boolean | null>>;
  batchUpdates: Array<{ spreadsheetId: string; requests: MockBatchRequest[] }>;
}

function createMockSheetsSdk(state: MockSheetsState): NonNullable<GoogleSheetsClientOptions['sheets']> {
  const getMetadata = vi.fn().mockImplementation(async ({ spreadsheetId }: { spreadsheetId: string }) => ({
    data: {
      spreadsheetId,
      sheets: [{ properties: { sheetId: 101, title: sampleFixture.submittalArch.sheetName } }],
      namedRanges: [
        {
          namedRangeId: 'nr-arch',
          name: sampleFixture.submittalArch.rangeName,
          range: {
            sheetId: 101,
            startRowIndex: 2,
            endRowIndex: 25,
            startColumnIndex: 0,
            endColumnIndex: 10,
          },
        },
      ],
    },
  }));

  const valuesGet = vi.fn().mockImplementation(async () => ({
    data: {
      values: state.tableValues,
    },
  }));

  const batchUpdate = vi.fn().mockImplementation(
    async ({
      spreadsheetId,
      requestBody,
    }: {
      spreadsheetId: string;
      requestBody: { requests?: MockBatchRequest[] };
    }) => {
      state.batchUpdates.push({
        spreadsheetId,
        requests: requestBody.requests ?? [],
      });
      return { data: {} };
    }
  );

  return {
    spreadsheets: {
      get: getMetadata,
      batchUpdate,
      values: {
        get: valuesGet,
        update: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  } as unknown as NonNullable<GoogleSheetsClientOptions['sheets']>;
}

describe('DocumentLog Tracer Bullet Integration (Issue #339)', () => {
  const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
  let manifestProvider: AppManifestProvider;
  let handlebars: HandlebarsAdapter;

  beforeEach(() => {
    manifestProvider = new AppManifestProvider({ manifestPath });
    handlebars = new HandlebarsAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildWiredDocumentService(params: {
    driveState: MockDriveState;
    sheetsState: MockSheetsState;
    primaryTargetId?: string;
    sourceFiles?: Array<{ id: string; name?: string }>;
    selectedLogId?: string;
  }) {
    const driveSdk = createMockDriveSdk(params.driveState);
    const sheetsSdk = createMockSheetsSdk(params.sheetsState);
    const driveClient = new GoogleDriveClient({
      drive: driveSdk,
      configProvider: manifestProvider,
    });
    const sheetsClient = new GoogleSheetsClient({
      sheets: sheetsSdk,
      configProvider: manifestProvider,
    });

    const docSchemaRegistry = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const compiledRegistry = new CompiledSchemaRegistry(docSchemaRegistry);
    await compiledRegistry.initialize();

    const logWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient,
      sheetsClient,
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const driveActivityHandler = new DriveActivityHandler(
      {
        getFile: (id) => driveClient.getFile(id),
        findOrCreateFolder: (p, n) => driveClient.findOrCreateFolder(p, n),
        resolveFolderPath: (r, s) => driveClient.resolveFolderPath(r, s),
        move: (f, t) => driveClient.move(f, t),
        rename: (f, n) => driveClient.rename(f, n),
        duplicate: (f, o) => driveClient.duplicate(f, o),
        searchFiles: (q) => driveClient.searchFiles(q),
        downloadAsBuffer: (f) => driveClient.downloadAsBuffer(f),
        saveBuffer: (c, o) => driveClient.saveBuffer(c, o),
        uploadStream: (s, o) => driveClient.uploadStream(s, o),
      },
      {
        configProvider: manifestProvider,
        ...(params.primaryTargetId !== undefined ? { primaryTargetId: params.primaryTargetId } : {}),
        ...(params.sourceFiles !== undefined ? { sourceFiles: params.sourceFiles } : {}),
      }
    );

    const logHandler = new DocumentLogActivityHandler(logWiring.documentLogService, {
      ...(params.selectedLogId !== undefined ? { selectedLogId: params.selectedLogId } : {}),
    });

    const activityEngine = new ActivityEngine([driveActivityHandler, logHandler]);
    const documentService = new DocumentService(
      activityEngine,
      docSchemaRegistry,
      handlebars,
      compiledRegistry
    );
    await documentService.initialize();

    return {
      documentService,
      driveSdk,
      sheetsSdk,
      driveClient,
      sheetsClient,
    };
  }

  it('executes FileSubmittalArch MOVE_FILE -> WRITE_LOG into an empty/cleared log with =HYPERLINK Calc Link and preserved leading zeros', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'copy-tmpl',
          name: 'Copy of Harborview Hotel Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        {
          id: 'org-tmpl',
          name: 'INC Document Log Template',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['admin-folder-1'],
        },
      ],
    };
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [], // Row 4 Formula Row
        ['<--->'], // Row 5 Top Anchor
        [], // Row 6 Cleared Placeholder Row
        ['<--->'], // Row 7 Bottom Anchor
      ],
      batchUpdates: [],
    };

    const { documentService } = await buildWiredDocumentService({
      driveState,
      sheetsState,
      primaryTargetId: 'moved-submittal-file-001',
    });

    const seedEntry = sampleFixture.submittalArch.seedEntries[2]; // 071200-001-0 REC
    const doc: Document = {
      type: 'submittal-arch',
      space: {
        id: sampleFixture.space.id,
        typeId: sampleFixture.space.typeId,
        name: sampleFixture.space.name,
        abstractStorageId: sampleFixture.space.abstractStorageId,
      },
      data: seedEntry.documentData,
    };

    const result = await documentService.processDocument(doc, 'onSubmit');
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
    expect(result.contextVariables).toEqual({
      documentLogWrite: {
        spreadsheetId: 'harborview-log-1',
        sheetName: 'Submittal Arch',
        rowNumber: 6,
        action: 'inserted',
      },
    });

    expect(sheetsState.batchUpdates).toHaveLength(1);
    const updateReq = sheetsState.batchUpdates[0].requests.find((r) => r.updateCells)?.updateCells;
    expect(updateReq?.range?.startRowIndex).toBe(5); // 0-based Row 6
    const cells = updateReq?.rows?.[0]?.values ?? [];
    expect(cells).toEqual([
      { userEnteredValue: { stringValue: 'Open' } },
      { userEnteredValue: { stringValue: '071200' } },
      { userEnteredValue: { stringValue: '001' } },
      { userEnteredValue: { stringValue: '0' } },
      { userEnteredValue: { stringValue: 'Fluid-Applied Waterproofing Membrane' } },
      { userEnteredValue: { stringValue: '260204' } },
      { userEnteredValue: { stringValue: 'MB' } },
      { userEnteredValue: { stringValue: 'Received' } },
      { userEnteredValue: { stringValue: 'Terrace deck assembly' } },
      {
        userEnteredValue: {
          formulaValue:
            '=HYPERLINK("https://drive.google.com/file/d/moved-submittal-file-001/view", "Link")',
        },
      },
    ]);
  });

  it('appends to a non-empty log and leaves Calc Link blank (null) when MOVE_FILE yields zero files', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        ['Closed', '033000', '001', '0', 'Concrete Mix', '260115', 'MB', 'Received', '4000 psi', 'Link'],
        ['<--->'],
      ],
      batchUpdates: [],
    };

    const { documentService } = await buildWiredDocumentService({
      driveState,
      sheetsState,
      sourceFiles: [],
    });

    const result = await documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: {
          status: 'Waiting',
          section: '071200',
          number: '002',
          revision: '0',
          title: 'Below-Grade Sheet Waterproofing',
          date: '260219',
          contact: 'PST',
          action: 'REF',
          notes: '',
        },
      },
      'onSubmit'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 7,
      action: 'inserted',
    });

    const batchReqs = sheetsState.batchUpdates[0].requests;
    expect(batchReqs[0].insertDimension?.range?.startIndex).toBe(6); // before bottom anchor row 7
    const cells = batchReqs[1].updateCells?.rows?.[0]?.values ?? [];
    expect(cells[8]).toEqual({}); // Notes: empty optional -> null -> {}
    expect(cells[9]).toEqual({}); // Calc Link: zero-file -> null -> {}
  });

  it('supports fileSourceStepId multi-step chaining and fails fast when referencing an unexecuted step', async () => {
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    };
    const driveSdk = createMockDriveSdk({
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    });
    const sheetsSdk = createMockSheetsSdk(sheetsState);
    const logWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient: new GoogleDriveClient({ drive: driveSdk }),
      sheetsClient: new GoogleSheetsClient({ sheets: sheetsSdk }),
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const makeMultiStepType = (fileSourceStepId: string): DocumentType => {
      const archRaw = fs.readFileSync(
        path.resolve(__dirname, '../assets/document-types/submittal-arch.json'),
        'utf-8'
      );
      const archDef = JSON.parse(archRaw) as DocumentType;
      return {
        ...archDef,
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'FileSubmittalArch',
              activitySequence: [
                { id: 'createSubmittal', type: 'CREATE_SUBMITTAL', payload: {} },
                { id: 'archiveCopy', type: 'ARCHIVE_COPY', payload: {} },
                { id: 'writeLog', type: 'WRITE_LOG', payload: { fileSourceStepId } },
              ],
            },
          ],
        },
      };
    };

    const runWithStepId = async (stepId: string) => {
      const customRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([makeMultiStepType(stepId)]),
      };
      const compiled = new CompiledSchemaRegistry(customRegistry);
      await compiled.initialize();

      const createHandler: ActivityHandler = {
        canHandle: (a) => a.type === 'CREATE_SUBMITTAL',
        handle: () => ({
          success: true,
          files: [
            {
              id: 'primary-submittal-id',
              name: 'Primary.pdf',
              uri: 'https://drive.google.com/file/d/primary-submittal-id/view',
            },
          ],
        }),
      };
      const archiveHandler: ActivityHandler = {
        canHandle: (a) => a.type === 'ARCHIVE_COPY',
        handle: () => ({
          success: true,
          files: [
            {
              id: 'archive-copy-id',
              name: 'Archive.pdf',
              uri: 'https://drive.google.com/file/d/archive-copy-id/view',
            },
          ],
        }),
      };

      const engine = new ActivityEngine([
        createHandler,
        archiveHandler,
        new DocumentLogActivityHandler(logWiring.documentLogService),
      ]);
      const service = new DocumentService(engine, customRegistry, handlebars, compiled);
      await service.initialize();

      return service.processDocument(
        {
          type: 'submittal-arch',
          space: {
            id: sampleFixture.space.id,
            typeId: sampleFixture.space.typeId,
            name: sampleFixture.space.name,
            abstractStorageId: sampleFixture.space.abstractStorageId,
          },
          data: sampleFixture.submittalArch.seedEntries[0].documentData,
        },
        'onSubmit'
      );
    };

    const okResult = await runWithStepId('createSubmittal');
    expect(okResult.success).toBe(true);
    const cells = sheetsState.batchUpdates[0].requests[0].updateCells?.rows?.[0]?.values ?? [];
    expect(cells[9]).toEqual({
      userEnteredValue: {
        formulaValue:
          '=HYPERLINK("https://drive.google.com/file/d/primary-submittal-id/view", "Link")',
      },
    });

    // Unexecuted / missing step fails fast before hitting Drive/Sheets
    const callsBeforeFail = sheetsState.batchUpdates.length;
    const failResult = await runWithStepId('neverExecutedStep');
    expect(failResult.success).toBe(false);
    if (!failResult.success) {
      expect(failResult.errors[0]).toContain('neverExecutedStep');
    }
    expect(sheetsState.batchUpdates).toHaveLength(callsBeforeFail);
  });

  it('writes user text starting with =, +, -, @ strictly as literal stringValue (never formulaValue)', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    };

    const { documentService } = await buildWiredDocumentService({
      driveState,
      sheetsState,
      primaryTargetId: 'safe-file-1',
    });

    const result = await documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '-100',
          title: '=1+1',
          date: '260204',
          contact: '+CMD',
          action: 'REC',
          notes: '@SUM(A1)',
        },
      },
      'onSubmit'
    );

    expect(result.success).toBe(true);
    const cells = sheetsState.batchUpdates[0].requests[0].updateCells?.rows?.[0]?.values ?? [];
    expect(cells[3]).toEqual({ userEnteredValue: { stringValue: '-100' } });
    expect(cells[4]).toEqual({ userEnteredValue: { stringValue: '=1+1' } });
    expect(cells[6]).toEqual({ userEnteredValue: { stringValue: '+CMD' } });
    expect(cells[8]).toEqual({ userEnteredValue: { stringValue: '@SUM(A1)' } });
  });

  it('supports selectedLogId override without calling Drive discovery', async () => {
    const driveSdk = createMockDriveSdk({ searchResults: [] });
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    };
    const sheetsSdk = createMockSheetsSdk(sheetsState);
    const driveClient = new GoogleDriveClient({ drive: driveSdk });
    const sheetsClient = new GoogleSheetsClient({ sheets: sheetsSdk });

    const docSchemaRegistry = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const compiledRegistry = new CompiledSchemaRegistry(docSchemaRegistry);
    await compiledRegistry.initialize();

    const logWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient,
      sheetsClient,
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const factory = createDocumentServiceFactory({
      documentSchemaRegistry: docSchemaRegistry,
      templateEvaluator: handlebars,
      compiledSchemaRegistry: compiledRegistry,
      configProvider: manifestProvider,
      driveClient,
      createDocumentLogService: logWiring.createDocumentLogService,
    });

    const service = await factory({
      selectedLogId: 'explicit-selected-log-777',
      sourceFiles: [],
    });

    const result = await service.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
      'onSubmit'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'explicit-selected-log-777',
      sheetName: 'Submittal Arch',
      rowNumber: 6,
      action: 'inserted',
    });
    // Zero Drive searchSpreadsheets calls when selectedLogId is provided
    expect(driveSdk.files.list).not.toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining('application/vnd.google-apps.spreadsheet'),
      })
    );
  });

  it('fails fast on missing (0 matches) and ambiguous (2+ matches) without writing to Sheets', async () => {
    const emptyDriveState: MockDriveState = {
      searchResults: [
        { id: 'tmpl-ignored', name: 'INC Document Log Template' },
        { id: 'copy-ignored', name: 'Copy of Project Document Log' },
      ],
    };
    const emptySheetsState: MockSheetsState = { tableValues: [], batchUpdates: [] };
    const missingCtx = await buildWiredDocumentService({
      driveState: emptyDriveState,
      sheetsState: emptySheetsState,
      sourceFiles: [],
    });

    const missingResult = await missingCtx.documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
      'onSubmit'
    );

    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.errors[0]).toContain(sampleFixture.space.name);
      expect(missingResult.errors[0]).toContain('1 Admin');
    }
    expect(missingCtx.sheetsSdk.spreadsheets.batchUpdate).not.toHaveBeenCalled();

    const ambiguousDriveState: MockDriveState = {
      searchResults: [
        { id: 'log-1', name: 'Harborview Hotel Document Log' },
        { id: 'log-2', name: 'Harborview Hotel Document Log v2' },
      ],
    };
    const ambiguousCtx = await buildWiredDocumentService({
      driveState: ambiguousDriveState,
      sheetsState: { tableValues: [], batchUpdates: [] },
      sourceFiles: [],
    });

    const ambiguousResult = await ambiguousCtx.documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
      'onSubmit'
    );

    expect(ambiguousResult.success).toBe(false);
    if (!ambiguousResult.success) {
      expect(ambiguousResult.errors[0]).toContain('Harborview Hotel Document Log');
      expect(ambiguousResult.errors[0]).toContain('Harborview Hotel Document Log v2');
    }
    expect(ambiguousCtx.sheetsSdk.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });

  it('wires AppOptions sheetsClient and documentLogService overrides in createApp() across /documents and /workspace/action', async () => {
    const writeLog = vi.fn().mockResolvedValue({
      spreadsheetId: 'override-svc-sheet',
      sheetName: 'Submittal Arch',
      rowNumber: 12,
      action: 'inserted',
    });
    const customDocLogService: DocumentLogPort = {
      resolveLog: vi.fn(),
      writeLog,
    };

    const headlessDocRegistry = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const headlessCompiled = new CompiledSchemaRegistry(headlessDocRegistry);
    await headlessCompiled.initialize();

    const headlessServer = createHttpServer();
    const headlessService = wireDocumentServicesAndRoutes({
      server: headlessServer,
      driveClient: new GoogleDriveClient({ drive: createMockDriveSdk({ searchResults: [] }) }),
      configProvider: manifestProvider,
      documentSchemaRegistry: headlessDocRegistry,
      templateEvaluator: handlebars,
      compiledSchemaRegistry: headlessCompiled,
      primaryTargetId: 'headless-file-1',
      documentLogService: customDocLogService,
    });
    if ('initialize' in headlessService && typeof headlessService.initialize === 'function') {
      await headlessService.initialize();
    }

    const res = await headlessServer.inject({
      method: 'POST',
      url: '/documents?eventName=onSubmit',
      payload: {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.contextVariables.documentLogWrite).toEqual({
      spreadsheetId: 'override-svc-sheet',
      sheetName: 'Submittal Arch',
      rowNumber: 12,
      action: 'inserted',
    });
    expect(writeLog).toHaveBeenCalledTimes(1);

    const authVerifier: WorkspaceAuthVerifierPort = {
      verifyToken: vi.fn().mockResolvedValue({
        isValid: true,
        payload: { email: 'user@inc.nyc', sub: 'user-1' },
      }),
    };
    const storageAdapter: DocumentSpaceStoragePort = {
      fetchSpaces: vi.fn().mockResolvedValue([
        {
          id: 'proj-1',
          typeId: 'projects',
          name: 'Active Projects',
          abstractStorageId: 'shared-drive-1',
        },
      ]),
      resolveStorageLocation: vi.fn().mockResolvedValue({
        provider: 'google_drive',
        abstractStorageId: 'shared-drive-1',
      }),
    };

    const driveSpy = vi
      .spyOn(GoogleDriveClient.prototype, 'resolveFolderPath')
      .mockResolvedValue({ id: 'const-id', name: '6 Construction' });
    vi.spyOn(GoogleDriveClient.prototype, 'findOrCreateFolder').mockResolvedValue({
      id: 'submittals-id',
      name: 'Submittals',
    });
    vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
      id: 'moved-doc-1',
      name: 'Waterproofing.pdf',
      parents: ['inbox-id'],
    });
    vi.spyOn(GoogleDriveClient.prototype, 'move').mockResolvedValue({
      id: 'moved-doc-1',
      name: 'Moved.pdf',
      webViewLink: 'https://drive.google.com/file/d/moved-doc-1/view',
    });
    vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
      {
        id: 'found-sheet-via-override',
        name: 'Active Projects Document Log',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
    ]);

    const appWithDocLogOverride = createApp({
      manifestPath,
      skipSpaceValidation: true,
      documentLogService: customDocLogService,
      authVerifier,
      storageAdapter,
    });
    await appWithDocLogOverride.initialize();
    expect(appWithDocLogOverride.documentLogService).toBe(customDocLogService);

    const overrideWsRes = await appWithDocLogOverride.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.override-test-cred' },
        drive: { selectedItems: [{ id: 'moved-doc-1', title: 'Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['moved-doc-1'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });
    expect(overrideWsRes.statusCode).toBe(200);
    expect(
      JSON.parse(overrideWsRes.payload).action?.notification?.text,
      overrideWsRes.payload
    ).toBe('Document processed successfully');
    expect(writeLog).toHaveBeenCalledTimes(2);

    // Also verify AppOptions.sheetsClient works via /workspace/action even with userOAuthToken
    const mockSheetsSdk = createMockSheetsSdk({
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    });
    const overrideSheetsClient = new GoogleSheetsClient({ sheets: mockSheetsSdk });

    const sheetsOverrideApp = createApp({
      manifestPath,
      skipSpaceValidation: true,
      sheetsClient: overrideSheetsClient,
      authVerifier,
      storageAdapter,
    } satisfies AppOptions);
    await sheetsOverrideApp.initialize();

    const wsRes = await sheetsOverrideApp.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.override-test-cred' },
        drive: { selectedItems: [{ id: 'moved-doc-1', title: 'Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['moved-doc-1'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });

    expect(wsRes.statusCode).toBe(200);
    const wsBody = JSON.parse(wsRes.payload);
    expect(wsBody.action?.notification?.text).toBe('Document processed successfully');
    expect(mockSheetsSdk.spreadsheets.batchUpdate).toHaveBeenCalledTimes(1);
    expect(driveSpy).toHaveBeenCalled();
  });

  it('fails fast during createApp().initialize() when a manifest has invalid documentLog configuration', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclog-failfast-'));
    try {
      const archRaw = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../assets/document-types/submittal-arch.json'), 'utf-8')
      ) as Record<string, unknown>;
      fs.writeFileSync(path.join(tmpDir, 'submittal-arch.json'), JSON.stringify(archRaw), 'utf-8');
      const badManifestPath = path.join(tmpDir, 'manifest.json');
      fs.writeFileSync(
        badManifestPath,
        JSON.stringify({
          documentTypes: ['./submittal-arch.json'],
          // Missing configuration.documentLog while submittal-arch declares documentLogSchema
        }),
        'utf-8'
      );

      const badApp = createApp({
        manifestPath: badManifestPath,
        skipSpaceValidation: true,
      });

      await expect(badApp.initialize()).rejects.toThrow(/configuration\.documentLog/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

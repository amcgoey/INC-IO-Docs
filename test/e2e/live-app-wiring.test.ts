import { describe, it, expect, vi } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { drive_v3 } from '@googleapis/drive';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from '@googleapis/sheets';
import type { CompositeManifestProvider } from '../../src/app/server';
import { LiveTestHarness } from '../live/live-test-harness';

function createMinimalManifestProvider(): CompositeManifestProvider {
  const rawManifest = {
    version: '1.0.0',
    configuration: {
      drive: {
        maxRetries: 2,
        initialDelayMs: 5,
        backoffFactor: 2,
      },
      documentLog: {
        preferredFolderPath: '1 Admin',
        fileNameContains: 'Document Log',
        excludePrefixes: ['Copy of'],
        excludeSubstrings: ['Template'],
        copyNameTemplate: '{{DocumentSpace.name}} Document Log',
        templateSpreadsheetId: 'template-sheet-1',
      },
    },
    DocumentSpaceTypes: [
      {
        id: 'proposals',
        displayName: 'Proposals',
        spaceSchema: {
          allowedDocumentTypes: ['submittal-arch'],
          defaultDocumentType: 'submittal-arch',
        },
        storageConfig: {
          provider: 'google_drive',
          fetchMethod: 'folders',
          parentFolderId: 'root-folder-1',
        },
      },
    ],
    documentTypes: ['./document-types/submittal-arch.json'],
  };

  const docTypeSchema = {
    key: 'submittal-arch',
    name: 'Submittal Arch',
    documentSchema: {
      identity: {
        idGroup: '{{section}}-{{number}}',
        idDocument: '{{section}}-{{number}}-{{revision}}',
        id: '{{section}}-{{number}}-{{revision}}-{{date}}-1',
      },
      fields: [
        {
          key: 'section',
          name: 'Section',
          type: 'string',
          required: true,
        },
        {
          key: 'number',
          name: 'Number',
          type: 'string',
          required: true,
        },
        {
          key: 'revision',
          name: 'Revision',
          type: 'string',
          required: true,
        },
        {
          key: 'date',
          name: 'Date',
          type: 'string',
          required: true,
        },
        {
          key: 'action',
          name: 'Action',
          type: 'string',
          required: true,
          options: {
            source: 'actions',
            key: 'key',
            name: 'name',
            allowUserInput: false,
          },
        },
      ],
      calculatedFields: [
        {
          key: 'actionName',
          name: 'Action Name',
          template: '{{action.key}}',
          required: true,
          lookup: {
            source: 'actions',
            matchProperty: 'key',
            resultProperty: 'name',
          },
        },
      ],
      optionSources: {
        actions: {
          provider: 'document_log',
          properties: ['key', 'name'],
        },
      },
    },
    documentLogSchema: {
      provider: 'google_sheets',
      target: {
        sheetName: 'Submittal Arch',
        rangeName: 'Log_Submittal_Arch',
        extentMarker: '<--->',
        groupDividerMarker: '---',
      },
      grouping: {
        groupBy: 'idGroup',
        sortBy: 'id',
        rowSortOrder: 'asc',
        groupSortOrder: 'asc',
        duplicatePolicy: 'insert',
      },
      historyDisplay: {
        topLabel: '{{section}}-{{number}}',
        text: '{{date}} - {{action.name}}',
        bottomLabel: '{{revision}}',
      },
      columns: {
        Section: { template: '{{section}}' },
        Number: { template: '{{number}}' },
        Revision: { template: '{{revision}}' },
        Date: { template: '{{date}}' },
        Action: { template: '{{action.name}}' },
      },
      optionBindings: {
        actions: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Actions',
          endMarker: '---',
          columns: {
            Key: 'key',
            Name: 'name',
          },
        },
      },
    },
    documentUiSchema: {
      layout: ['section', 'number', 'revision', 'date', 'action'],
      events: {
        onSubmit: {
          catchAllWorkflow: 'onSubmit',
        },
      },
    },
    documentWorkflowConfig: {
      workflows: [
        {
          name: 'onSubmit',
          activitySequence: [
            {
              type: 'WRITE_LOG',
              id: 'writeLog',
              payload: {},
            },
          ],
        },
      ],
    },
  };

  return {
    getRawManifest: async () => rawManifest,
    readParsedSchema: async () => docTypeSchema,
    getDriveConfig: async () => rawManifest.configuration.drive,
    getMaxInMemoryFileBytes: async () => 25 * 1024 * 1024,
    getTemplatesConfig: async () => ({}),
    getWorkspaceConfig: async () => ({}),
    getSheetsConfig: async () => undefined,
  } as unknown as CompositeManifestProvider;
}

describe('LiveTestHarness.app (application/feature wiring facade)', () => {
  it('defaults lookupTimeoutMs to 25,000 ms, wires getOptionTablePort parity, and counts Sheets/Drive calls via apiTracker', async () => {
    expect(LiveTestHarness.app.DEFAULT_LIVE_LOOKUP_TIMEOUT_MS).toBe(25_000);

    const driveFilesGet = vi.fn();
    const driveFilesList = vi.fn();
    const driveApi = {
      files: {
        get: driveFilesGet,
        list: driveFilesList,
        create: vi.fn(),
        update: vi.fn(),
        copy: vi.fn(),
        export: vi.fn(),
      },
      drives: {
        list: vi.fn(),
      },
    } as unknown as drive_v3.Drive;

    const sheetsGet = vi.fn().mockImplementation(async () => ({
      data: {
        spreadsheetId: 'log-1',
        sheets: [
          { properties: { sheetId: 1, title: '_Config Submittal Arch' } },
          { properties: { sheetId: 2, title: 'Submittal Arch' } },
        ],
        namedRanges: [
          {
            name: 'Options_Submittal_Arch_Actions',
            range: {
              sheetId: 1,
              startRowIndex: 2,
              endRowIndex: 6,
              startColumnIndex: 0,
              endColumnIndex: 2,
            },
          },
          {
            name: 'Log_Submittal_Arch',
            range: {
              sheetId: 2,
              startRowIndex: 2,
              endRowIndex: 7,
              startColumnIndex: 0,
              endColumnIndex: 5,
            },
          },
        ],
      },
    }));

    const sheetsValuesBatchGet = vi.fn().mockImplementation(async (req: { ranges?: string[] }) => {
      const ranges = req.ranges ?? [];
      return {
        data: {
          valueRanges: ranges.map((range) => {
            if (range.includes('_Config Submittal Arch')) {
              return {
                range,
                values: [
                  ['Key', 'Name'],
                  ['REC', 'Received'],
                  ['---', ''],
                ],
              };
            }
            return { range, values: [] };
          }),
        },
      };
    });

    const sheetsValuesGet = vi.fn().mockResolvedValue({
      data: {
        values: [
          ['Section', 'Number', 'Revision', 'Date', 'Action'],
          ['<--->', '', '', '', ''],
          ['', '', '', '', ''],
          ['<--->', '', '', '', ''],
        ],
      },
    });

    const sheetsBatchUpdate = vi.fn().mockResolvedValue({ data: {} });

    const sheetsApi = {
      spreadsheets: {
        get: sheetsGet,
        batchUpdate: sheetsBatchUpdate,
        values: {
          get: sheetsValuesGet,
          batchGet: sheetsValuesBatchGet,
          update: vi.fn(),
        },
      },
    } as unknown as sheets_v4.Sheets;

    const wiring = await LiveTestHarness.app.createWiring({
      manifestProvider: createMinimalManifestProvider(),
      driveApi,
      sheetsApi,
    });

    expect(wiring.lookupTimeoutMs).toBe(25_000);

    const service = await wiring.documentServiceFactory({
      selectedLogId: 'log-1',
    });

    const measured = await wiring.apiTracker.measure(() =>
      service.processDocument(
        {
          type: 'submittal-arch',
          space: {
            id: 'space-folder-1',
            typeId: 'proposals',
            name: 'Harborview',
            abstractStorageId: 'space-folder-1',
          },
          data: {
            section: '071200',
            number: '001',
            revision: '0',
            date: '261104',
            action: 'REC',
          },
        },
        'onSubmit'
      )
    );

    expect(measured.result.success).toBe(true);
    if (measured.result.success) {
      expect(measured.result.activities.map((a) => a.type)).toEqual(['WRITE_LOG']);
    }
    // 0 Drive discovery calls when selectedLogId is valid
    expect(driveFilesGet).not.toHaveBeenCalled();
    expect(driveFilesList).not.toHaveBeenCalled();
    expect(measured.counts.drive.total).toBe(0);

    // `_Config` option tables are read exactly once (`values.batchGet` once) and shared across
    // dynamicValidator, getOptionTablePort, and WRITE_LOG via per-request memoization.
    expect(sheetsValuesBatchGet).toHaveBeenCalledTimes(1);
    expect(measured.counts.sheets.reads).toBe(4);
    expect(measured.counts.sheets.writes).toBe(1);
    expect(measured.counts.sheets.byMethod).toEqual({
      'spreadsheets.get': 2,
      'spreadsheets.values.batchGet': 1,
      'spreadsheets.values.get': 1,
      'spreadsheets.batchUpdate': 1,
    });
  });

  it('wires getDocumentSpaceService so stale selectedLogId with space-id-only context resolves space type and falls back to resolveLog', async () => {
    const driveFilesGet = vi.fn().mockImplementation(async (req: { fileId: string }) => {
      if (req.fileId === 'space-folder-1') {
        return {
          data: {
            id: 'space-folder-1',
            name: 'Harborview',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root-folder-1'],
          },
        };
      }
      return { data: { id: req.fileId, name: 'Unknown', parents: [] } };
    });

    const driveFilesList = vi.fn().mockImplementation(async (req: { q?: string }) => {
      const q = req.q ?? '';
      if (q.includes("'root-folder-1' in parents")) {
        return {
          data: {
            files: [{ id: 'space-folder-1', name: 'Harborview' }],
          },
        };
      }
      if (q.includes('Document Log')) {
        return {
          data: {
            files: [
              {
                id: 'fallback-log-2',
                name: 'Harborview Document Log',
                parents: ['space-folder-1'],
              },
            ],
          },
        };
      }
      return { data: { files: [] } };
    });

    const driveApi = {
      files: {
        get: driveFilesGet,
        list: driveFilesList,
        create: vi.fn(),
        update: vi.fn(),
        copy: vi.fn(),
        export: vi.fn(),
      },
      drives: { list: vi.fn() },
    } as unknown as drive_v3.Drive;

    const sheetsGet = vi.fn().mockImplementation(async (req: { spreadsheetId: string }) => {
      if (req.spreadsheetId === 'stale-log-404') {
        const err = new Error('File not found') as Error & { code?: number };
        err.code = 404;
        throw err;
      }
      return {
        data: {
          spreadsheetId: 'fallback-log-2',
          sheets: [{ properties: { sheetId: 1, title: '_Config Submittal Arch' } }],
          namedRanges: [
            {
              name: 'Options_Submittal_Arch_Actions',
              range: {
                sheetId: 1,
                startRowIndex: 2,
                endRowIndex: 6,
                startColumnIndex: 0,
                endColumnIndex: 2,
              },
            },
          ],
        },
      };
    });

    const sheetsValuesBatchGet = vi.fn().mockResolvedValue({
      data: {
        valueRanges: [
          {
            range: "'_Config Submittal Arch'!A3:B6",
            values: [
              ['Key', 'Name'],
              ['REC', 'Received'],
              ['---', ''],
            ],
          },
        ],
      },
    });

    const sheetsApi = {
      spreadsheets: {
        get: sheetsGet,
        batchUpdate: vi.fn(),
        values: {
          get: vi.fn(),
          batchGet: sheetsValuesBatchGet,
          update: vi.fn(),
        },
      },
    } as unknown as sheets_v4.Sheets;

    const wiring = await LiveTestHarness.app.createWiring({
      manifestProvider: createMinimalManifestProvider(),
      driveApi,
      sheetsApi,
      retryOptions: { maxRetries: 0, initialDelayMs: 1, backoffFactor: 1 },
    });

    const ctx = { selectedLogId: 'stale-log-404' };
    const optionTablePort = wiring.lookupOptionsWiring.createOptionTableResolver(ctx);
    const resolved = await optionTablePort.resolveOptionTables(['actions'], {
      spaceId: 'space-folder-1',
      documentTypeKey: 'submittal-arch',
      selectedLogId: 'stale-log-404',
    });

    expect(resolved.actions.status).toBe('ready');
    expect(resolved.actions.tuples).toEqual([{ key: 'REC', name: 'Received' }]);
    expect(sheetsGet).toHaveBeenCalledWith(
      expect.objectContaining({ spreadsheetId: 'fallback-log-2' }),
      expect.anything()
    );
  });

  it('propagates injectable lookupTimeoutMs to cancel slow lookup calls promptly', async () => {
    const sheetsGet = vi.fn().mockImplementation(
      (_req: unknown, opts?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Should have aborted earlier')), 5_000);
          opts?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              const abortErr = new Error('Aborted');
              abortErr.name = 'AbortError';
              reject(abortErr);
            },
            { once: true }
          );
        })
    );

    const driveApi = {
      files: { get: vi.fn(), list: vi.fn(), create: vi.fn(), update: vi.fn(), copy: vi.fn(), export: vi.fn() },
      drives: { list: vi.fn() },
    } as unknown as drive_v3.Drive;

    const sheetsApi = {
      spreadsheets: {
        get: sheetsGet,
        batchUpdate: vi.fn(),
        values: { get: vi.fn(), batchGet: vi.fn(), update: vi.fn() },
      },
    } as unknown as sheets_v4.Sheets;

    const wiring = await LiveTestHarness.app.createWiring({
      manifestProvider: createMinimalManifestProvider(),
      driveApi,
      sheetsApi,
      lookupTimeoutMs: 25,
    });

    expect(wiring.lookupTimeoutMs).toBe(25);

    const fetcher = wiring.lookupOptionsWiring.createOptionsFetcher({});
    const start = Date.now();
    const res = await fetcher.fetchOptions([{ sourceKey: 'actions' }], {
      documentTypeKey: 'submittal-arch',
      spaceId: 'space-folder-1',
      selectedLogId: 'log-1',
    });
    const elapsedMs = Date.now() - start;

    expect(res.actions.status).toBe('timeout');
    expect(elapsedMs).toBeLessThan(1_000);
  });
});

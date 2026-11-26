import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type AppInstance, type CompositeManifestProvider } from '../src/app/server';
import { wireDocumentServicesAndRoutes } from '../src/app/document.wiring';
import { createDocumentLogWiring } from '../src/app/document-log.wiring';
import { createHttpServer } from '../src/infrastructure/http';
import { CompiledSchemaRegistry } from '../src/features/document/adapters/compiled-schema-registry';
import { DocumentSchemaRegistryAdapter } from '../src/features/document/adapters/document-schema-registry';
import { HandlebarsAdapter } from '../src/infrastructure/template-engine/handlebars-adapter';
import { ensureEvaluationOrder } from '../src/infrastructure/validation/json-logic-graph';
import type {
  DocumentSchemaRegistryPort,
  ActivityDispatcherPort,
  DriveServicePort,
} from '../src/features/document/ports';
import type { DocumentType } from '../src/features/document/domain';
import { GoogleDriveClient } from '../src/infrastructure/drive/drive-client';
import { GoogleDocsClient, type GoogleDocsClientOptions } from '../src/infrastructure/docs';
import { GoogleSheetsClient, type GoogleSheetsClientOptions } from '../src/infrastructure/sheets';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';

function createArchOptionTablesSheetsMock(
  manifestPath: string,
  options?: {
    getTables?: (spreadsheetId: string) => {
      statuses: string[][];
      actions: string[][];
      contacts?: string[][];
      csiDivisions?: string[][];
    };
  }
): {
  sheetsClient: GoogleSheetsClient;
  getSpy: ReturnType<typeof vi.fn>;
  batchGetSpy: ReturnType<typeof vi.fn>;
} {
  const defaultStatuses = [['Status'], ['Open'], ['Closed'], ['Waiting'], ['Manager'], ['Billed'], ['---']];
  const defaultActions = [
    ['Action', 'Name', 'Suffix', 'Order'],
    ['REC', 'Received', '', '1'],
    ['REF', 'Referred', '_REF', '2'],
    ['NR', 'Not Reviewed', '_NR', '3'],
    ['REJ', 'Rejected', '_REJ', '4'],
    ['RR', 'Revise & Resubmit', '_RR', '5'],
    ['NOC', 'No Objections As Corrected', '_NOC', '6'],
    ['NET', 'No Exceptions Taken', '_NET', '7'],
    ['---', '', '', ''],
  ];
  const defaultContacts = [
    ['Contact', 'Name', 'Contact Type'],
    ['INC', 'INC Architecture and Design', 'INC'],
    ['PMG', 'Pavarini McGovern', 'Contractor'],
    ['---', '', ''],
  ];
  const defaultCsiDivisions = [
    ['Division Number', 'Division Folder'],
    ['01', '01 General Requirements'],
    ['07', '07 Thermal and Moisture Protection'],
    ['08', '08 Openings'],
    ['---', ''],
  ];

  const getSpy = vi.fn().mockImplementation(async ({ spreadsheetId }: { spreadsheetId: string }) => {
    const tables = options?.getTables?.(spreadsheetId) ?? {
      statuses: defaultStatuses,
      actions: defaultActions,
      contacts: defaultContacts,
      csiDivisions: defaultCsiDivisions,
    };
    const contacts = tables.contacts ?? defaultContacts;
    const csiDivisions = tables.csiDivisions ?? defaultCsiDivisions;
    return {
      data: {
        spreadsheetId,
        sheets: [
          { properties: { sheetId: 101, title: 'Submittal Arch' } },
          { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
        ],
        namedRanges: [
          {
            namedRangeId: 'nr-log',
            name: 'Log_Submittal_Arch',
            range: {
              sheetId: 101,
              startRowIndex: 2,
              endRowIndex: 10,
              startColumnIndex: 0,
              endColumnIndex: 10,
            },
          },
          {
            namedRangeId: 'nr-statuses',
            name: 'Options_Submittal_Arch_Statuses',
            range: {
              sheetId: 103,
              startRowIndex: 0,
              endRowIndex: tables.statuses.length,
              startColumnIndex: 0,
              endColumnIndex: 1,
            },
          },
          {
            namedRangeId: 'nr-actions',
            name: 'Options_Submittal_Arch_Actions',
            range: {
              sheetId: 103,
              startRowIndex: 0,
              endRowIndex: tables.actions.length,
              startColumnIndex: 2,
              endColumnIndex: 6,
            },
          },
          {
            namedRangeId: 'nr-contacts',
            name: 'Options_Submittal_Arch_Contacts',
            range: {
              sheetId: 103,
              startRowIndex: 0,
              endRowIndex: contacts.length,
              startColumnIndex: 7,
              endColumnIndex: 10,
            },
          },
          {
            namedRangeId: 'nr-csi-divisions',
            name: 'Options_Submittal_Arch_CSI_Divisions',
            range: {
              sheetId: 103,
              startRowIndex: 0,
              endRowIndex: csiDivisions.length,
              startColumnIndex: 11,
              endColumnIndex: 13,
            },
          },
        ],
      },
    };
  });

  const batchGetSpy = vi.fn().mockImplementation(
    async ({ spreadsheetId, ranges }: { spreadsheetId: string; ranges?: string[] }) => {
      const tables = options?.getTables?.(spreadsheetId) ?? {
        statuses: defaultStatuses,
        actions: defaultActions,
        contacts: defaultContacts,
        csiDivisions: defaultCsiDivisions,
      };
      const contacts = tables.contacts ?? defaultContacts;
      const csiDivisions = tables.csiDivisions ?? defaultCsiDivisions;
      return {
        data: {
          spreadsheetId,
          valueRanges: (ranges ?? []).map((r) => ({
            range: r,
            values: r.includes('A1:')
              ? tables.statuses
              : r.includes('C1:')
                ? tables.actions
                : r.includes('L1:')
                  ? csiDivisions
                  : contacts,
          })),
        },
      };
    }
  );

  const sheetsClient = new GoogleSheetsClient({
    sheets: {
      spreadsheets: {
        get: getSpy,
        batchUpdate: vi.fn().mockResolvedValue({ data: {} }),
        values: {
          get: vi.fn().mockResolvedValue({ data: { values: [] } }),
          batchGet: batchGetSpy,
          update: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    } as unknown as NonNullable<GoogleSheetsClientOptions['sheets']>,
    configProvider: new AppManifestProvider({ manifestPath }),
  });

  return { sheetsClient, getSpy, batchGetSpy };
}

function createFfeOptionTablesSheetsMock(manifestPath: string): {
  sheetsClient: GoogleSheetsClient;
} {
  const statuses = [['Status'], ['Open'], ['Closed'], ['Waiting'], ['Manager'], ['Billed'], ['---']];
  const actions = [
    ['Action', 'Name', 'Suffix', 'Order'],
    ['REC', 'Received', '', '1'],
    ['REF', 'Referred', '_REF', '2'],
    ['NR', 'Not Reviewed', '_NR', '3'],
    ['REJ', 'Rejected', '_REJ', '4'],
    ['RR', 'Revise & Resubmit', '_RR', '5'],
    ['NOC', 'No Objections As Corrected', '_NOC', '6'],
    ['NET', 'No Exceptions Taken', '_NET', '7'],
    ['---', '', '', ''],
  ];
  const contacts = [
    ['Contact', 'Name', 'Contact Type'],
    ['INC', 'INC Architecture & Design', 'INC'],
    ['BW', 'Benjamin West', 'Procurement'],
    ['---', '', ''],
  ];
  const vendors = [
    ['Vendor', 'Name', 'Vendor Type'],
    ['BM', 'Berman Falk', 'Casegoods'],
    ['AL', 'Ashley Lighting', 'Lighting'],
    ['---', '', ''],
  ];
  const specs = [
    ['Spec Tag', 'Spec Title'],
    ['AC102', 'HOOK'],
    ['CG104', 'BED - KING'],
    ['---', ''],
  ];

  const getSpy = vi.fn().mockImplementation(async ({ spreadsheetId }: { spreadsheetId: string }) => ({
    data: {
      spreadsheetId,
      sheets: [
        { properties: { sheetId: 102, title: 'Submittal FF&E' } },
        { properties: { sheetId: 104, title: '_Config Submittal FF&E' } },
      ],
      namedRanges: [
        {
          namedRangeId: 'nr-ffe-log',
          name: 'Log_Submittal_FFE',
          range: { sheetId: 102, startRowIndex: 2, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 11 },
        },
        {
          namedRangeId: 'nr-ffe-statuses',
          name: 'Options_Submittal_FFE_Statuses',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: statuses.length, startColumnIndex: 0, endColumnIndex: 1 },
        },
        {
          namedRangeId: 'nr-ffe-actions',
          name: 'Options_Submittal_FFE_Actions',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: actions.length, startColumnIndex: 2, endColumnIndex: 6 },
        },
        {
          namedRangeId: 'nr-ffe-contacts',
          name: 'Options_Submittal_FFE_Contacts',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: contacts.length, startColumnIndex: 7, endColumnIndex: 10 },
        },
        {
          namedRangeId: 'nr-ffe-vendors',
          name: 'Options_Submittal_FFE_Vendors',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: vendors.length, startColumnIndex: 11, endColumnIndex: 14 },
        },
        {
          namedRangeId: 'nr-ffe-specs',
          name: 'Options_Submittal_FFE_Specs',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: specs.length, startColumnIndex: 15, endColumnIndex: 17 },
        },
      ],
    },
  }));

  const batchGetSpy = vi.fn().mockImplementation(
    async ({ spreadsheetId, ranges }: { spreadsheetId: string; ranges?: string[] }) => ({
      data: {
        spreadsheetId,
        valueRanges: (ranges ?? []).map((r) => ({
          range: r,
          values: r.includes('A1:')
            ? statuses
            : r.includes('C1:')
              ? actions
              : r.includes('H1:')
                ? contacts
                : r.includes('P1:')
                  ? specs
                  : vendors,
        })),
      },
    })
  );

  const sheetsClient = new GoogleSheetsClient({
    sheets: {
      spreadsheets: {
        get: getSpy,
        batchUpdate: vi.fn().mockResolvedValue({ data: {} }),
        values: {
          get: vi.fn().mockResolvedValue({ data: { values: [] } }),
          batchGet: batchGetSpy,
          update: vi.fn().mockResolvedValue({ data: {} }),
        },
      },
    } as unknown as NonNullable<GoogleSheetsClientOptions['sheets']>,
    configProvider: new AppManifestProvider({ manifestPath }),
  });

  return { sheetsClient };
}

describe('App integration tests', () => {
  let app: AppInstance;
  let mockManifestRegistry: DocumentSchemaRegistryPort;
  let mockActivityEngine: ActivityDispatcherPort;
  let mockDocumentTypes: DocumentType[];

  beforeEach(async () => {
    mockDocumentTypes = [
      {
        key: 'communication-project',
        name: 'Communication Project',
        documentSchema: {
          fields: [
            {
              key: 'contact',
              name: 'Contact Person',
              type: 'string',
              required: true,
            },
          ],
        },
        documentUiSchema: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SubmitCommProject',
            },
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'SubmitCommProject',
              activitySequence: [
                {
                  type: 'LOG_DOCUMENT',
                  payload: { status: 'submitted' },
                },
              ],
            },
          ],
        },
        storageContextConfig: {
          rootFolder: 'CommunicationProjects',
        },
      },
    ];

    mockManifestRegistry = {
      loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
    };

    mockActivityEngine = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    };

    app = createApp({ skipSpaceValidation: true, 
      documentSchemaRegistry: mockManifestRegistry,
      activityEngine: mockActivityEngine,
    });

    await app.initialize();
  });

  describe('Route endpoints', () => {
    it('POST /documents?eventName=onSubmit should return 200 and dispatch activity for valid Document payload', async () => {
      const validDocument = {
        type: 'communication-project',
        data: {
          contact: 'Jane Doe',
        },
      };

      const response = await app.server.inject({
        method: 'POST',
        url: '/documents?eventName=onSubmit',
        payload: validDocument,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: true,
        data: validDocument,
        activities: [
          {
            type: 'LOG_DOCUMENT',
            payload: { status: 'submitted' },
          },
        ],
        outputs: [],
      });
      expect(mockActivityEngine.dispatch).toHaveBeenCalledWith(
        {
          type: 'LOG_DOCUMENT',
          payload: { status: 'submitted' },
        },
        {
          document: validDocument,
          files: [],
          stepOutputs: {},
          contextVariables: {},
        }
      );
    });

    it('POST /documents without eventName should return 200 with empty activities and not dispatch', async () => {
      const validDocument = {
        type: 'communication-project',
        data: {
          contact: 'Jane Doe',
        },
      };

      const response = await app.server.inject({
        method: 'POST',
        url: '/documents',
        payload: validDocument,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: true,
        data: validDocument,
        activities: [],
        outputs: [],
      });
      expect(mockActivityEngine.dispatch).not.toHaveBeenCalled();
    });

    it('POST /documents should return 400 for invalid Document payload', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/documents',
        payload: {
          invalid: 'Document payload',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: false,
        errors: expect.any(Array),
      });
      expect(mockActivityEngine.dispatch).not.toHaveBeenCalled();
    });

    it('POST /documents should return 400 when dynamic data payload fails schema validation', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/documents',
        payload: {
          type: 'communication-project',
          data: {},
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: false,
        errors: expect.any(Array),
      });
      expect(mockActivityEngine.dispatch).not.toHaveBeenCalled();
    });

    it('POST /documents should return 400 for unknown Document type', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/documents',
        payload: {
          type: 'unknown-type',
          data: { contact: 'Jane Doe' },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: false,
        errors: expect.arrayContaining(['Unknown document type: unknown-type']),
      });
      expect(mockActivityEngine.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('Fail-fast startup behavior', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inc-io-test-'));
      vi.unstubAllEnvs();
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    function createAppWithFailingRegistry(error: Error) {
      const failingRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockRejectedValue(error),
      };
      return createApp({ skipSpaceValidation: true,  documentSchemaRegistry: failingRegistry });
    }

    it('fails fast on createApp when neither options.manifestPath nor APP_MANIFEST_PATH is set and no documentSchemaRegistry is provided', () => {
      delete process.env.APP_MANIFEST_PATH;
      expect(() => createApp()).toThrow(
        /Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable./
      );
    });

    it('fails fast on start() when manifest path is not configured', async () => {
      delete process.env.APP_MANIFEST_PATH;
      await expect(async () => {
        const app = createApp();
        await app.start();
      }).rejects.toThrow(
        /Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable./
      );
    });

    it('fails fast on app initialization when DocumentSchemaRegistryPort throws an error', async () => {
      const failingApp = createAppWithFailingRegistry(
        new Error('Manifest file not found or corrupted')
      );

      await expect(failingApp.initialize()).rejects.toThrow('Manifest file not found or corrupted');
    });

    it('fails fast on app initialization when DocumentSchemaRegistryPort rejects with schema validation error', async () => {
      const failingApp = createAppWithFailingRegistry(
        new Error('Invalid DocumentType schema in "./schemas/invalid.json": /DocumentSchema/fields: Expected array')
      );

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid DocumentType schema/);
    });

    it('fails fast and halts startup before starting HTTP server when start() fails', async () => {
      const failingApp = createAppWithFailingRegistry(
        new Error('Fatal manifest discovery failure')
      );

      await expect(failingApp.start()).rejects.toThrow('Fatal manifest discovery failure');
    });

    it('fails fast during startup when manifest file is missing via options.manifestPath', async () => {
      const nonExistentManifestPath = path.join(tempDir, 'non-existent-manifest.json');
      const failingApp = createApp({ skipSpaceValidation: true,  manifestPath: nonExistentManifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/ENOENT|no such file/i);
    });

    it('fails fast during startup when manifest file is missing via APP_MANIFEST_PATH env var', async () => {
      const nonExistentManifestPath = path.join(tempDir, 'non-existent-manifest.json');
      vi.stubEnv('APP_MANIFEST_PATH', nonExistentManifestPath);
      const failingApp = createApp();

      await expect(failingApp.initialize()).rejects.toThrow(/ENOENT|no such file/i);
      await expect(failingApp.start()).rejects.toThrow(/ENOENT|no such file/i);
    });

    it('fails fast during startup when manifest file contains corrupted JSON', async () => {
      const corruptedManifestPath = path.join(tempDir, 'corrupted-manifest.json');
      await fs.writeFile(corruptedManifestPath, '{ invalid json');
      const failingApp = createApp({ skipSpaceValidation: true,  manifestPath: corruptedManifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid JSON in manifest file/);
    });

    it('fails fast during startup when manifest file schema is invalid', async () => {
      const invalidManifestPath = path.join(tempDir, 'invalid-manifest.json');
      await fs.writeFile(invalidManifestPath, JSON.stringify({ documentTypes: 'not-an-array' }));
      const failingApp = createApp({ skipSpaceValidation: true,  manifestPath: invalidManifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid manifest file structure/);
    });

    it('fails fast during startup when a referenced DocumentType file is missing', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ documentTypes: ['./missing-Document-type.json'] })
      );
      const failingApp = createApp({ skipSpaceValidation: true,  manifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/ENOENT|no such file/i);
    });

    it('fails fast during startup when a referenced DocumentType file contains corrupted JSON', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const documentTypePath = path.join(tempDir, 'corrupted-Document.json');
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: ['./corrupted-Document.json'] }));
      await fs.writeFile(documentTypePath, '{ invalid json');
      const failingApp = createApp({ skipSpaceValidation: true,  manifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid JSON in DocumentType file/);
    });

    it('fails fast during startup when a referenced DocumentType file fails schema validation', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const documentTypePath = path.join(tempDir, 'invalid-Document.json');
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: ['./invalid-Document.json'] }));
      await fs.writeFile(
        documentTypePath,
        JSON.stringify({ key: 'invalid', name: 'Invalid', documentSchema: { fields: 'not-an-array' } })
      );
      const failingApp = createApp({ skipSpaceValidation: true,  manifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid DocumentType schema/);
    });

    it('fails fast during startup when a DocumentType contains an unsupported field type', async () => {
      const unsupportedDocumentTypes: DocumentType[] = [
        {
          key: 'unsupported-field-Document',
          name: 'Unsupported Field Document',
          documentSchema: {
            fields: [
              {
                key: 'BadField',
                name: 'Bad Field',
                type: 'unknown',
                required: true,
              },
            ],
          },
        },
      ];
      const customRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(unsupportedDocumentTypes),
      };
      const failingApp = createApp({ skipSpaceValidation: true,  documentSchemaRegistry: customRegistry });

      await expect(failingApp.initialize()).rejects.toThrow(/Unsupported field type 'unknown'/);
    });
  });

  describe('ManifestRegistry wiring in createApp', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inc-io-manifest-test-'));
      vi.unstubAllEnvs();
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('resolves manifest strictly from options.manifestPath', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const documentTypePath = path.join(tempDir, 'custom-Document.json');
      const customDocument = {
        key: 'custom-Document-key',
        name: 'Custom Document Name',
        documentSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
      };
      await fs.writeFile(documentTypePath, JSON.stringify(customDocument));
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: ['./custom-Document.json'] }));

      const appInstance = createApp({ skipSpaceValidation: true,  manifestPath });
      await appInstance.initialize();
      const docTypes = await appInstance.documentSchemaRegistry.loadAll();

      expect(docTypes).toHaveLength(1);
      expect(docTypes[0].key).toBe('custom-Document-key');
      expect(docTypes[0].name).toBe('Custom Document Name');
    });

    it('resolves manifest strictly from APP_MANIFEST_PATH environment variable', async () => {
      const manifestPath = path.join(tempDir, 'env-manifest.json');
      const documentTypePath = path.join(tempDir, 'env-Document.json');
      const customDocument = {
        key: 'env-Document-key',
        name: 'Env Document Name',
        documentSchema: { fields: [{ key: 'code', name: 'Code', type: 'string', required: true }] },
      };
      await fs.writeFile(documentTypePath, JSON.stringify(customDocument));
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: ['./env-Document.json'] }));

      vi.stubEnv('APP_MANIFEST_PATH', manifestPath);

      const appInstance = createApp();
      await appInstance.initialize();
      const docTypes = await appInstance.documentSchemaRegistry.loadAll();

      expect(docTypes).toHaveLength(1);
      expect(docTypes[0].key).toBe('env-Document-key');
      expect(docTypes[0].name).toBe('Env Document Name');
    });

    it('prefers options.manifestPath over APP_MANIFEST_PATH environment variable', async () => {
      const optManifestPath = path.join(tempDir, 'opt-manifest.json');
      const optDocumentTypePath = path.join(tempDir, 'opt-Document.json');
      await fs.writeFile(
        optDocumentTypePath,
        JSON.stringify({
          key: 'option-key',
          name: 'Option Name',
          documentSchema: { fields: [] },
        })
      );
      await fs.writeFile(optManifestPath, JSON.stringify({ documentTypes: ['./opt-Document.json'] }));

      const envManifestPath = path.join(tempDir, 'env-manifest.json');
      const envDocumentTypePath = path.join(tempDir, 'env-Document.json');
      await fs.writeFile(
        envDocumentTypePath,
        JSON.stringify({
          key: 'env-key',
          name: 'Env Name',
          documentSchema: { fields: [] },
        })
      );
      await fs.writeFile(envManifestPath, JSON.stringify({ documentTypes: ['./env-Document.json'] }));

      vi.stubEnv('APP_MANIFEST_PATH', envManifestPath);

      const appInstance = createApp({ skipSpaceValidation: true,  manifestPath: optManifestPath });
      await appInstance.initialize();
      const docTypes = await appInstance.documentSchemaRegistry.loadAll();

      expect(docTypes).toHaveLength(1);
      expect(docTypes[0].key).toBe('option-key');
    });
  });

  describe('End-to-End Calculated Fields and Identity Properties Resolution', () => {
    it('resolves identity properties (id, idDocument, idGroup) from communication-proposal.json and enriches payload before dispatching activity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const prodApp = createApp({ skipSpaceValidation: true, 
        manifestPath,
        activityEngine: mockDispatcher,
      });

      await prodApp.initialize();

      const listFoldersSpy = vi.spyOn(GoogleDriveClient.prototype, 'listFolders').mockImplementation(async (options) => {
        if (options?.parentFolderId === 'space-folder-proposal-id') {
          return { folders: [{ id: 'comm-folder-id', name: 'Communications' }] };
        }
        if (options?.parentFolderId === 'comm-folder-id') {
          return { folders: [{ id: 'contact-folder-id', name: 'Jane Doe' }] };
        }
        return { folders: [] };
      });

      const basePayload = {
        type: 'communication-proposal',
        space: {
          id: 'space-folder-proposal-id',
          name: 'Proposal Alpha',
          typeId: 'proposals',
          abstractStorageId: 'space-folder-proposal-id',
        },
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'IN',
          description: 'Quarterly review discussion',
        },
      };

      const expectedIdentityValue = 'Jane Doe-260825-IN-Quarterly review discussion';
      const expectedGroupId = 'Jane Doe';

      const expectedEnrichedData = {
        ...basePayload.data,
        contact: {
          key: 'Jane Doe',
          name: 'Jane Doe',
        },
        direction: {
          key: 'IN',
          name: 'Incoming',
        },
      };

      const expectedDocument = {
        type: 'communication-proposal',
        space: basePayload.space,
        id: expectedIdentityValue,
        idDocument: expectedIdentityValue,
        idGroup: expectedGroupId,
        data: expectedEnrichedData,
        calculated: {
          commFolderName: '260825 IN - Quarterly review discussion',
        },
      };

      const response = await prodApp.server.inject({
        method: 'POST',
        url: '/documents?eventName=onSubmit',
        payload: basePayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(expectedDocument);
      expect('aliases' in (body.data.data.direction as Record<string, unknown>)).toBe(false);
      expect(body.activities).toEqual([
        {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'space-folder-proposal-id',
            parentPath: 'Communications',
            folderName: 'Jane Doe/260825 IN - Quarterly review discussion',
          },
        },
      ]);

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'space-folder-proposal-id',
            parentPath: 'Communications',
            folderName: 'Jane Doe/260825 IN - Quarterly review discussion',
          },
        },
        {
          document: expectedDocument,
          files: [],
          stepOutputs: {},
          contextVariables: {},
        }
      );

      listFoldersSpy.mockRestore();
    });

    it('submits submittal-arch Document resolving identity, calculated fields, and workflow activity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const { sheetsClient } = createArchOptionTablesSheetsMock(manifestPath);
      const searchSpy = vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
        {
          id: 'arch-log-app-1',
          name: 'Active Projects Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]);

      const prodApp = createApp({
        skipSpaceValidation: true,
        manifestPath,
        activityEngine: mockDispatcher,
        sheetsClient,
      });

      await prodApp.initialize();

      const archPayload = {
        type: 'submittal-arch',
        space: {
          id: 'space-projects-1',
          name: 'Active Projects',
          typeId: 'projects',
          abstractStorageId: 'space-projects-1',
        },
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: 'A',
          title: 'Waterproofing Specs',
          date: '261020',
          contact: 'PMG',
          action: 'REC',
        },
      };

      try {
        const response = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: archPayload,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(body.data.id).toBe('071200-001-A-261020-1');
        expect(body.data.idDocument).toBe('071200-001-A');
        expect(body.data.idGroup).toBe('071200-001');
        expect(body.data.calculated.fileName).toBe('071200-001-A Waterproofing Specs - 261020 PMG');
        expect(body.data.calculated.csiDivisionFolder).toBe('07 Thermal and Moisture Protection');
        expect(body.activities).toEqual([
          {
            id: 'moveOriginal',
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'space-projects-1',
              parentPath: '6 Construction',
              folderName: 'Submittals/Closed/07 Thermal and Moisture Protection',
              fileName: '071200-001-A Waterproofing Specs - 261020 PMG',
            },
          },
          {
            id: 'writeLog',
            type: 'WRITE_LOG',
            payload: {},
          },
        ]);
        expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
          1,
          {
            id: 'moveOriginal',
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'space-projects-1',
              parentPath: '6 Construction',
              folderName: 'Submittals/Closed/07 Thermal and Moisture Protection',
              fileName: '071200-001-A Waterproofing Specs - 261020 PMG',
            },
          },
          {
            document: body.data,
            files: [],
            stepOutputs: {},
            contextVariables: {},
          }
        );
        expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
          2,
          {
            id: 'writeLog',
            type: 'WRITE_LOG',
            payload: {},
          },
          {
            document: body.data,
            files: [],
            stepOutputs: {},
            contextVariables: {},
          }
        );
      } finally {
        searchSpy.mockRestore();
      }
    });

    it('POST /documents enforces maxSourceFiles: 1, resolves Drive shortcuts, and rejects folders before Drive mutations on submittal-arch (#373)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue({ success: true }),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const { sheetsClient } = createArchOptionTablesSheetsMock(manifestPath);
      const searchSpy = vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
        {
          id: 'arch-log-app-guard',
          name: 'Active Projects Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]);
      const getFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(
        async (fileId: string) => {
          if (fileId === 'folder-submittal') {
            return {
              id: 'folder-submittal',
              name: 'Some Folder',
              mimeType: 'application/vnd.google-apps.folder',
            };
          }
          if (fileId === 'shortcut-to-folder') {
            return {
              id: 'shortcut-to-folder',
              name: 'Shortcut to Folder',
              mimeType: 'application/vnd.google-apps.shortcut',
              shortcutDetails: {
                targetId: 'folder-submittal',
                targetMimeType: 'application/vnd.google-apps.folder',
              },
            };
          }
          if (fileId === 'shortcut-to-pdf') {
            return {
              id: 'shortcut-to-pdf',
              name: 'Shortcut to Submittal.pdf',
              mimeType: 'application/vnd.google-apps.shortcut',
              shortcutDetails: {
                targetId: 'real-submittal-pdf',
                targetMimeType: 'application/pdf',
              },
            };
          }
          return {
            id: fileId,
            name: 'Submittal.pdf',
            mimeType: 'application/pdf',
          };
        }
      );

      const prodApp = createApp({
        skipSpaceValidation: true,
        manifestPath,
        activityEngine: mockDispatcher,
        sheetsClient,
      });
      await prodApp.initialize();

      const basePayload = {
        type: 'submittal-arch',
        space: {
          id: 'space-projects-1',
          name: 'Active Projects',
          typeId: 'projects',
          abstractStorageId: 'space-projects-1',
        },
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: 'A',
          title: 'Waterproofing Specs',
          date: '261020',
          contact: 'PMG',
          action: 'REC',
        },
      };

      try {
        // 1. > maxSourceFiles rejected with HTTP 400 before Drive lookups or mutations
        const multiRes = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            ...basePayload,
            sourceFiles: [{ id: 'file-1' }, { id: 'file-2' }],
          },
        });
        expect(multiRes.statusCode).toBe(400);
        expect(JSON.parse(multiRes.payload).success).toBe(false);
        expect(getFileSpy).not.toHaveBeenCalled();
        expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

        // 2. Folder rejected with HTTP 400 before Drive mutations
        const folderRes = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            ...basePayload,
            sourceFiles: [{ id: 'folder-submittal' }],
          },
        });
        expect(folderRes.statusCode).toBe(400);
        expect(JSON.parse(folderRes.payload).success).toBe(false);
        expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

        // 3. Shortcut pointing to folder rejected with HTTP 400 before Drive mutations
        const shortcutFolderRes = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            ...basePayload,
            sourceFiles: [{ id: 'shortcut-to-folder' }],
          },
        });
        expect(shortcutFolderRes.statusCode).toBe(400);
        expect(JSON.parse(shortcutFolderRes.payload).success).toBe(false);
        expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

        // 4. Shortcut pointing to valid PDF resolves target and succeeds
        const shortcutFileRes = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            ...basePayload,
            sourceFiles: [{ id: 'shortcut-to-pdf' }],
          },
        });
        expect(shortcutFileRes.statusCode).toBe(200);
        const shortcutFileBody = JSON.parse(shortcutFileRes.payload);
        expect(shortcutFileBody.success).toBe(true);
        expect(shortcutFileBody.data.sourceFiles).toEqual([
          { id: 'real-submittal-pdf', name: 'Submittal.pdf', mimeType: 'application/pdf' },
        ]);
        expect(mockDispatcher.dispatch).toHaveBeenCalled();
      } finally {
        searchSpy.mockRestore();
        getFileSpy.mockRestore();
      }
    });

    it('submits submittal-ffe Document resolving identity, calculated fields, and workflow activity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const { sheetsClient } = createFfeOptionTablesSheetsMock(manifestPath);
      const searchSpy = vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
        {
          id: 'ffe-log-app-1',
          name: 'Active Projects Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]);

      const prodApp = createApp({
        skipSpaceValidation: true,
        manifestPath,
        activityEngine: mockDispatcher,
        sheetsClient,
      });

      await prodApp.initialize();

      const ffePayload = {
        type: 'submittal-ffe',
        space: {
          id: 'space-projects-1',
          name: 'Active Projects',
          typeId: 'projects',
          abstractStorageId: 'space-projects-1',
        },
        data: {
          status: 'Open',
          specTag: 'CG104',
          revision: 'A',
          specTitle: 'BED - KING',
          vendor: 'BM',
          date: '261021',
          contact: 'INC',
          action: 'REC',
        },
      };

      try {
        const response = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: ffePayload,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.success).toBe(true);
        expect(body.data.id).toBe('CG104-A-261021-1');
        expect(body.data.idDocument).toBe('CG104-A');
        expect(body.data.idGroup).toBe('CG104');
        expect(body.data.calculated.fileName).toBe('CG104-A Berman Falk - 261021 INC');
        expect(body.data.calculated.specTagGroup).toBe('CG');
        expect(body.activities).toEqual([
          {
            id: 'moveOriginal',
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'space-projects-1',
              parentPath: '3 FFE',
              folderName: '05 Submittals/Closed/CG/CG104',
              fileName: 'CG104-A Berman Falk - 261021 INC',
            },
          },
          {
            id: 'writeLog',
            type: 'WRITE_LOG',
            payload: {},
          },
        ]);
        expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
          1,
          {
            id: 'moveOriginal',
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'space-projects-1',
              parentPath: '3 FFE',
              folderName: '05 Submittals/Closed/CG/CG104',
              fileName: 'CG104-A Berman Falk - 261021 INC',
            },
          },
          {
            document: body.data,
            files: [],
            stepOutputs: {},
            contextVariables: {},
          }
        );
        expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(
          2,
          {
            id: 'writeLog',
            type: 'WRITE_LOG',
            payload: {},
          },
          {
            document: body.data,
            files: [],
            stepOutputs: {},
            contextVariables: {},
          }
        );
      } finally {
        searchSpy.mockRestore();
      }
    });

    it('rejects payload with 400 when lookup field has an invalid option value', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const prodApp = createApp({ skipSpaceValidation: true, 
        manifestPath,
        activityEngine: mockDispatcher,
      });

      await prodApp.initialize();

      const invalidPayload = {
        type: 'communication-project',
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'INVALID_DIRECTION',
          description: 'Quarterly review discussion',
        },
      };

      const response = await prodApp.server.inject({
        method: 'POST',
        url: '/documents',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(false);
      expect(body.errors.some((err: string) => err.includes('/direction:'))).toBe(true);
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('accepts arbitrary string inputs when a Document schema defines a combo-box with allowUserInput: true', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customDocumentTypes: DocumentType[] = [
        {
          key: 'combobox-Document',
          name: 'Combobox Document',
          documentSchema: {
            fields: [
              {
                key: 'category',
                name: 'Category',
                type: 'string',
                required: true,
                options: {
                  source: 'categories',
                  key: 'key',
                  name: 'name',
                  allowUserInput: true,
                },
              },
            ],
            options: {
              categories: [
                { key: 'CAT_A', name: 'Category A' },
                { key: 'CAT_B', name: 'Category B' },
              ],
            },
          },
          documentUiSchema: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'SubmitCombobox',
              },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'SubmitCombobox',
                activitySequence: [
                  {
                    type: 'LOG_DOCUMENT',
                    payload: { status: 'combobox_handled' },
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(customDocumentTypes),
      };

      const customApp = createApp({ skipSpaceValidation: true, 
        documentSchemaRegistry: customRegistry,
        activityEngine: mockDispatcher,
      });

      await customApp.initialize();

      const customPayload = {
        type: 'combobox-Document',
        data: {
          category: 'NonStandardCategoryXYZ',
        },
      };

      const response = await customApp.server.inject({
        method: 'POST',
        url: '/documents?eventName=onSubmit',
        payload: customPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data.data.category).toEqual({
        key: 'NonStandardCategoryXYZ',
        name: 'NonStandardCategoryXYZ',
      });
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        {
          type: 'LOG_DOCUMENT',
          payload: {
            status: 'combobox_handled',
          },
        },
        {
          document: body.data,
          files: [],
          stepOutputs: {},
          contextVariables: {},
        }
      );
    });
  });

  describe('End-to-End Initialization Flow', () => {
    it('initializes app with real adapters using fixture manifest and loads DocumentTypes', async () => {
      const manifestPath = path.resolve(__dirname, 'fixtures/manifest.json');
      const e2eApp = createApp({ skipSpaceValidation: true,  manifestPath });

      await e2eApp.initialize();

      const docTypes = await e2eApp.documentSchemaRegistry.loadAll();
      expect(docTypes).toHaveLength(1);
      expect(docTypes[0].key).toBe('test-document');
      expect(docTypes[0].name).toBe('Test Document');
      expect(docTypes[0].documentSchema.fields[0].key).toBe('title');
      expect(docTypes[0].documentUiSchema?.events?.onSubmit?.catchAllWorkflow).toBe('SubmitTestWorkflow');
    });
  });

  describe('End-to-End Handlebars Activity Payload Resolution', () => {
    it('evaluates activity payload templates with real HandlebarsAdapter injecting Document and DocumentSchema context', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
            fields: [
              { key: 'contact', name: 'Contact Person', type: 'string', required: true },
              { key: 'description', name: 'Description', type: 'string', required: true },
            ],
            calculatedFields: [
              { key: 'summary', template: 'COMM: {{contact}} - {{description}}' },
            ],
            identity: {
              id: 'ID-{{contact}}',
              idDocument: 'IDREC-{{contact}}',
              idGroup: 'GRP-{{contact}}',
            },
          },
          documentUiSchema: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'HandleCommWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'HandleCommWorkflow',
                activitySequence: [
                  {
                    type: 'CONSOLE_LOG',
                    payload: {
                      documentId: '{{Document.id}}',
                      idDocument: '{{Document.idDocument}}',
                      idGroup: '{{Document.idGroup}}',
                      contactName: '{{Document.data.contact}}',
                      calculatedSummary: '{{Document.calculated.summary}}',
                      documentTypeName: '{{documentSchema.fields.[0].name}}',
                      nested: {
                        templateString: 'Target: {{Document.data.contact}}',
                        list: ['item-{{Document.data.contact}}', 'static-item'],
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(customDocumentTypes),
      };

      const appInstance = createApp({ skipSpaceValidation: true, 
        documentSchemaRegistry: customRegistry,
        activityEngine: mockDispatcher,
      });

      await appInstance.initialize();

      const response = await appInstance.server.inject({
        method: 'POST',
        url: '/documents?eventName=onSubmit',
        payload: {
          type: 'comm-project',
          data: {
            contact: 'Jane Doe',
            description: 'Design Review',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);

      const expectedResolvedPayload = {
        documentId: 'ID-Jane Doe',
        idDocument: 'IDREC-Jane Doe',
        idGroup: 'GRP-Jane Doe',
        contactName: 'Jane Doe',
        calculatedSummary: 'COMM: Jane Doe - Design Review',
        documentTypeName: 'Contact Person',
        nested: {
          templateString: 'Target: Jane Doe',
          list: ['item-Jane Doe', 'static-item'],
        },
      };

      expect(body.activities).toEqual([
        {
          type: 'CONSOLE_LOG',
          payload: expectedResolvedPayload,
        },
      ]);

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        {
          type: 'CONSOLE_LOG',
          payload: expectedResolvedPayload,
        },
        {
          document: body.data,
          files: [],
          stepOutputs: {},
          contextVariables: {},
        }
      );
    });
  });

  describe('End-to-End Manifest Configuration in createApp', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inc-io-app-config-test-'));
      vi.unstubAllEnvs();
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('propagates workspace configuration from manifest to /workspace/drive-items-selected', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const documentTypePath = path.join(tempDir, 'custom-Document.json');
      const customDocument = {
        key: 'configured-Document-type',
        name: 'Configured Document Type',
        documentSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
        documentUiSchema: {
          events: {
            onConfiguredSubmit: {
              catchAllWorkflow: 'ConfiguredWorkflow',
            },
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'ConfiguredWorkflow',
              activitySequence: [
                {
                  type: 'MOVE_FILE',
                  payload: {},
                },
              ],
            },
          ],
        },
      };

      await fs.writeFile(documentTypePath, JSON.stringify(customDocument));
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: ['./custom-Document.json'],
          configuration: {
            workspace: {
              defaultDocumentType: 'configured-Document-type',
            },
            drive: {
              defaultFolderName: '!CustomDestination',
            },
          },
        })
      );

      const mockDriveService = {
        getFile: vi.fn().mockResolvedValue({
          id: 'file-123',
          name: 'ImportantDocument.pdf',
          parents: ['folder-parent-1'],
        }),
        findOrCreateFolder: vi.fn().mockResolvedValue({
          id: 'custom-folder-id',
          name: '!CustomDestination',
          parents: ['folder-parent-1'],
        }),
        move: vi.fn().mockResolvedValue({
          id: 'file-123',
          name: 'ImportantDocument.pdf',
          parents: ['custom-folder-id'],
        }),
        rename: vi.fn().mockResolvedValue({
          id: 'file-123',
          name: 'ImportantDocument.pdf',
          parents: ['custom-folder-id'],
        }),
        duplicate: vi.fn().mockResolvedValue({
          id: 'file-copy-123',
          name: 'ImportantDocument.pdf',
          parents: ['custom-folder-id'],
        }),
        searchFiles: vi.fn().mockResolvedValue([]),
        resolveFolderPath: vi.fn(),
        downloadAsBuffer: vi.fn(),
        saveBuffer: vi.fn(),
        uploadStream: vi.fn(),
      };

      const mockAuthVerifier = {
        verifyToken: vi.fn().mockResolvedValue({
          isValid: true,
          payload: { email: 'user@example.com' },
        }),
      };

      const appInstance = createApp({ skipSpaceValidation: true, 
        manifestPath,
        driveService: mockDriveService,
        driveContextClient: {
          getFile: (fileId: string) => mockDriveService.getFile(fileId),
          listSharedDrives: vi.fn().mockResolvedValue({ drives: [] }),
        },
        authVerifier: mockAuthVerifier,
      });

      await appInstance.initialize();

      const res = await appInstance.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer token' },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.user-token',
          },
          drive: {
            selectedItems: [{ id: 'file-123', title: 'ImportantDocument.pdf' }],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.action.navigations[0].pushCard.header.title).toBe('INC-IO Engine');
      expect(body.action.navigations[0].pushCard.sections[0].header).toBe('Document Type');
    });

  });

  describe('DocumentSpaceService wiring', () => {
    it('exposes documentSpaceService on AppInstance and initializes it', () => {
      expect(app.documentSpaceService).toBeDefined();
      expect(typeof app.documentSpaceService.getAllTypes).toBe('function');
      expect(typeof app.documentSpaceService.getCollection).toBe('function');
    });

    it('allows injecting a custom documentSpaceService via AppOptions', async () => {
      const mockCustomSpaceService = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getAllTypes: vi.fn().mockReturnValue([]),
        getType: vi.fn(),
        hasType: vi.fn().mockReturnValue(false),
        getCollection: vi.fn().mockResolvedValue({
          type: { id: 'custom', displayName: 'Custom', spaceSchema: { allowedDocumentTypes: [] }, storageConfig: {} },
          spaces: [],
        }),
      };

      const customApp = createApp({ skipSpaceValidation: true, 
        documentSchemaRegistry: mockManifestRegistry,
        activityEngine: mockActivityEngine,
        documentSpaceService: mockCustomSpaceService as unknown as AppInstance['documentSpaceService'],
      });

      await customApp.initialize();

      expect(customApp.documentSpaceService).toBe(mockCustomSpaceService);
      expect(mockCustomSpaceService.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('DocumentSpace validation startup behavior', () => {
    let failingSpaceService: AppInstance['documentSpaceService'];

    beforeEach(() => {
      failingSpaceService = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getAllTypes: vi.fn().mockReturnValue([{ id: 'unreachable-space' }]),
        getType: vi.fn(),
        hasType: vi.fn().mockReturnValue(true),
        getCollection: vi.fn().mockRejectedValue(new Error('Drive API network error')),
        validateEndToEnd: vi.fn().mockResolvedValue([
          'DocumentSpaceType "unreachable-space" failed end-to-end validation: Drive API network error',
        ]),
      } as unknown as AppInstance['documentSpaceService'];
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('fails fast on initialize() when space validation fails and skipSpaceValidation is not set', async () => {
      const failingApp = createApp({
        documentSchemaRegistry: mockManifestRegistry,
        activityEngine: mockActivityEngine,
        documentSpaceService: failingSpaceService,
      });

      await expect(failingApp.initialize()).rejects.toThrow(
        /Failed to validate DocumentSpaceTypes/
      );
    });

    it('skips validation on initialize() when SKIP_SPACE_VALIDATION=true env var is set', async () => {
      vi.stubEnv('SKIP_SPACE_VALIDATION', 'true');

      const appInstance = createApp({
        documentSchemaRegistry: mockManifestRegistry,
        activityEngine: mockActivityEngine,
        documentSpaceService: failingSpaceService,
      });

      await expect(appInstance.initialize()).resolves.toBeUndefined();
    });

    it('skips validation on initialize() when NODE_ENV=production env var is set', async () => {
      vi.stubEnv('NODE_ENV', 'production');

      const appInstance = createApp({
        documentSchemaRegistry: mockManifestRegistry,
        activityEngine: mockActivityEngine,
        documentSpaceService: failingSpaceService,
      });

      await expect(appInstance.initialize()).resolves.toBeUndefined();
    });

    it('runs validation when skipSpaceValidation: false even if SKIP_SPACE_VALIDATION=true or NODE_ENV=production', async () => {
      vi.stubEnv('SKIP_SPACE_VALIDATION', 'true');
      vi.stubEnv('NODE_ENV', 'production');

      const appInstance = createApp({
        skipSpaceValidation: false,
        documentSchemaRegistry: mockManifestRegistry,
        activityEngine: mockActivityEngine,
        documentSpaceService: failingSpaceService,
      });

      await expect(appInstance.initialize()).rejects.toThrow(
        /Failed to validate DocumentSpaceTypes/
      );
    });
  });

  describe('appBaseUrl dependency injection', () => {
    it('accepts appBaseUrl in AppOptions and wires it to workspace addon routes', async () => {
      const appInstance = createApp({
        skipSpaceValidation: true,
        documentSchemaRegistry: mockManifestRegistry,
        activityEngine: mockActivityEngine,
        appBaseUrl: 'https://custom-domain.example.com',
      });

      expect(appInstance).toBeDefined();
    });

    it('falls back to process.env.APP_BASE_URL when appBaseUrl is omitted from AppOptions', async () => {
      vi.stubEnv('APP_BASE_URL', 'https://env-domain.example.com');
      const appInstance = createApp({
        skipSpaceValidation: true,
        documentSchemaRegistry: mockManifestRegistry,
        activityEngine: mockActivityEngine,
      });

      expect(appInstance).toBeDefined();
    });
  });

  describe('DocumentParseSchema fail-fast startup validation', () => {
    it('fails fast on createApp().initialize() if a documentParseSchema targets an unknown field', async () => {
      const mockManifestProvider = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./types/bad-parse.json'],
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'bad-parse',
          documentSchema: {
            fields: [{ key: 'date', type: 'string' }],
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'gmail',
                fields: {
                  unknownField: { from: 'email.date' },
                },
              },
            ],
          },
        }),
        getDriveConfig: vi.fn().mockResolvedValue(undefined),
        getWorkspaceConfig: vi.fn().mockResolvedValue(undefined),
        getSheetsConfig: vi.fn().mockResolvedValue(undefined),
      };

      const appInstance = createApp({
        manifestProvider: mockManifestProvider as unknown as CompositeManifestProvider,
        skipSpaceValidation: true,
      });

      await expect(appInstance.initialize()).rejects.toThrow(
        'targets unknown field "unknownField"'
      );
    });

    it('fails fast on createApp().initialize() if lookup: true targets a field without options', async () => {
      const mockManifestProvider = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./types/bad-lookup.json'],
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'bad-lookup',
          documentSchema: {
            fields: [{ key: 'date', type: 'string' }],
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'gmail',
                fields: {
                  date: { from: 'email.date', lookup: true },
                },
              },
            ],
          },
        }),
        getDriveConfig: vi.fn().mockResolvedValue(undefined),
        getWorkspaceConfig: vi.fn().mockResolvedValue(undefined),
        getSheetsConfig: vi.fn().mockResolvedValue(undefined),
      };

      const appInstance = createApp({
        manifestProvider: mockManifestProvider as unknown as CompositeManifestProvider,
        skipSpaceValidation: true,
      });

      await expect(appInstance.initialize()).rejects.toThrow(
        'specifies lookup: true for field "date" which does not have options'
      );
    });

    it('fails fast on createApp().initialize() if excludePattern contains invalid regex', async () => {
      const mockManifestProvider = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./types/bad-regex.json'],
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'bad-regex',
          documentSchema: {
            fields: [
              {
                key: 'contact',
                type: 'string',
                options: { source: 'contacts', key: 'key', name: 'name' },
              },
            ],
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'gmail',
                fields: {
                  contact: { from: 'email.to', excludePattern: '(?+invalid', lookup: true },
                },
              },
            ],
          },
        }),
        getDriveConfig: vi.fn().mockResolvedValue(undefined),
        getWorkspaceConfig: vi.fn().mockResolvedValue(undefined),
        getSheetsConfig: vi.fn().mockResolvedValue(undefined),
      };

      const appInstance = createApp({
        manifestProvider: mockManifestProvider as unknown as CompositeManifestProvider,
        skipSpaceValidation: true,
      });

      await expect(appInstance.initialize()).rejects.toThrow(/invalid excludePattern/i);
    });

    it('fails fast on createApp().initialize() if Tier 1 aliases contain duplicate normalized alias across keys', async () => {
      const mockManifestProvider = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./types/dup-alias.json'],
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'dup-alias',
          documentSchema: {
            fields: [
              {
                key: 'direction',
                type: 'string',
                options: { source: 'direction', key: 'key', name: 'name' },
              },
            ],
            options: {
              direction: [
                { key: 'IN', name: 'Incoming', aliases: ['inbound'] },
                { key: 'OT', name: 'Outgoing', aliases: ['INBOUND'] },
              ],
            },
          },
        }),
        getDriveConfig: vi.fn().mockResolvedValue(undefined),
        getWorkspaceConfig: vi.fn().mockResolvedValue(undefined),
        getSheetsConfig: vi.fn().mockResolvedValue(undefined),
      };

      const appInstance = createApp({
        manifestProvider: mockManifestProvider as unknown as CompositeManifestProvider,
        skipSpaceValidation: true,
      });

      await expect(appInstance.initialize()).rejects.toThrow(/Duplicate alias "INBOUND"/i);
    });

    it('fails fast on createApp().initialize() if Tier 3 shared AliasDictionary contains empty/whitespace alias', async () => {
      const mockManifestProvider = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: [],
          aliases: {
            contacts: './aliases/contacts.json',
          },
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          source: 'contacts',
          mappings: {
            c1: ['   '],
          },
        }),
        getDriveConfig: vi.fn().mockResolvedValue(undefined),
        getWorkspaceConfig: vi.fn().mockResolvedValue(undefined),
        getSheetsConfig: vi.fn().mockResolvedValue(undefined),
      };

      const appInstance = createApp({
        manifestProvider: mockManifestProvider as unknown as CompositeManifestProvider,
        skipSpaceValidation: true,
      });

      await expect(appInstance.initialize()).rejects.toThrow(/Empty or whitespace-only alias/i);
    });

    it('fails fast on createApp().initialize() when configuration.workspace.timeZone is invalid even with empty documentTypes (#307)', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-tz-test-'));
      try {
        const badTzManifestPath = path.join(tempDir, 'manifest.json');
        await fs.writeFile(
          badTzManifestPath,
          JSON.stringify({
            documentTypes: [],
            configuration: {
              workspace: {
                timeZone: 'Invalid/Zone_Name',
              },
            },
          }),
          'utf-8'
        );

        const appInstance = createApp({
          manifestPath: badTzManifestPath,
          skipSpaceValidation: true,
        });

        await expect(appInstance.initialize()).rejects.toThrow(/timeZone/i);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('accepts optional docsClient in createApp() and forwards it through initialize() and workspace routes (#321)', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          documentId: 'gdoc-app-321',
          body: null,
          tabs: [
            {
              documentTab: {
                body: {
                  content: [
                    {
                      table: {
                        rows: 1,
                        columns: 2,
                        tableRows: [
                          {
                            tableCells: [
                              {
                                content: [
                                  { paragraph: { elements: [{ textRun: { content: 'Submittal No.\n' } }] } },
                                ],
                              },
                              {
                                content: [
                                  { paragraph: { elements: [{ textRun: { content: '071200-001-1\n' } }] } },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      });
      const customDocsClient = new GoogleDocsClient({
        docs: { documents: { get: mockGet } } as unknown as NonNullable<
          GoogleDocsClientOptions['docs']
        >,
      });

      const mockManifestProvider = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./types/submittal-arch.json'],
          DocumentSpaceTypes: [
            {
              id: 'projects',
              displayName: 'Projects',
              spaceSchema: {
                allowedDocumentTypes: ['submittal-arch'],
                defaultDocumentType: 'submittal-arch',
              },
              storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
            },
          ],
          configuration: {
            workspace: {
              defaultDocumentSpaceType: 'projects',
              defaultDocumentType: 'submittal-arch',
            },
          },
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'submittal-arch',
          name: 'Submittal Arch',
          documentSchema: {
            fields: [
              { key: 'section', name: 'Section', type: 'string', required: true, pattern: '^\\d{6}$' },
              { key: 'number', name: 'Number', type: 'string', required: true, pattern: '^\\d{3,}$' },
              { key: 'revision', name: 'Revision', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$' },
            ],
          },
          documentUiSchema: {
            layout: ['section', 'number', 'revision'],
            fields: {
              section: { widget: 'textInput', label: 'Section' },
              number: { widget: 'textInput', label: 'Number' },
              revision: { widget: 'textInput', label: 'Revision' },
            },
            events: {
              onSubmit: { catchAllWorkflow: 'FileSubmittalArch' },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'FileSubmittalArch',
                activitySequence: [{ type: 'LOG_DOCUMENT', payload: {} }],
              },
            ],
          },
          documentFormSchema: {
            fields: {
              'Submittal No': {
                template: '{{section}}-{{number}}-{{revision}}',
              },
            },
          },
          documentParseSchema: {
            extractors: [{ source: 'form' }],
          },
        }),
        getDriveConfig: vi.fn().mockResolvedValue(undefined),
        getWorkspaceConfig: vi.fn().mockResolvedValue({
          defaultDocumentSpaceType: 'projects',
          defaultDocumentType: 'submittal-arch',
        }),
        getSheetsConfig: vi.fn().mockResolvedValue(undefined),
      };

      const storageAdapter = {
        fetchSpaces: vi.fn().mockResolvedValue([
          {
            id: 'projects-shared-drive-001',
            typeId: 'projects',
            name: 'Projects Shared Drive 001',
            abstractStorageId: 'projects-shared-drive-001',
          },
        ]),
        resolveStorageLocation: vi.fn().mockResolvedValue({
          provider: 'google_drive',
          abstractStorageId: 'projects-shared-drive-001',
        }),
      };

      const driveContextClient = {
        getFile: vi.fn().mockResolvedValue({
          id: 'gdoc-app-321',
          name: 'Waterproofing_Stamped',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
        }),
        listSharedDrives: vi.fn().mockResolvedValue({
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        }),
      };

      const authVerifier = {
        verifyToken: vi.fn().mockResolvedValue({
          isValid: true,
          payload: { email: 'user@inc.nyc', sub: 'user-1' },
        }),
      };

      const appInstance = createApp({
        skipSpaceValidation: true,
        manifestProvider: mockManifestProvider as unknown as CompositeManifestProvider,
        activityEngine: mockActivityEngine,
        storageAdapter,
        driveContextClient,
        authVerifier,
        docsClient: customDocsClient,
      });

      await expect(appInstance.initialize()).resolves.toBeUndefined();

      const res = await appInstance.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid' },
        payload: {
          hostApp: 'DRIVE',
          drive: {
            selectedItems: [{ id: 'gdoc-app-321', title: 'Waterproofing_Stamped' }],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockGet).toHaveBeenCalledWith(
        {
          documentId: 'gdoc-app-321',
          includeTabsContent: true,
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        },
        { timeout: 10_000 }
      );

      const body = JSON.parse(res.payload);
      const docDataSec = body.action?.navigations?.[0]?.pushCard?.sections?.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      const readText = (fieldKey: string) =>
        docDataSec?.widgets?.find(
          (w: { textInput?: { name?: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
        )?.textInput?.value;

      expect(readText('section')).toBe('071200');
      expect(readText('number')).toBe('001');
      expect(readText('revision')).toBe('1');
    });

    it('POST /documents uses fresh per-request LookupOptions (zero cross-request Drive caching) and key-then-name enrichment (#357)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const prodApp = createApp({
        skipSpaceValidation: true,
        manifestPath,
        activityEngine: mockDispatcher,
      });

      await prodApp.initialize();

      let callPhase = 1;
      const listFoldersSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'listFolders')
        .mockImplementation(async (options) => {
          if (options?.parentFolderId === 'space-folder-proj-id') {
            return { folders: [{ id: 'admin-folder-id', name: '1 Admin' }] };
          }
          if (options?.parentFolderId === 'admin-folder-id') {
            return { folders: [{ id: 'comm-folder-id', name: 'Communication' }] };
          }
          if (options?.parentFolderId === 'comm-folder-id') {
            return callPhase === 1
              ? { folders: [{ id: 'c1', name: 'Jane Doe' }] }
              : {
                  folders: [
                    { id: 'c1', name: 'Jane Doe' },
                    { id: 'c1-dup', name: 'Jane Doe' },
                  ],
                };
          }
          return { folders: [] };
        });

      const payload = {
        type: 'communication-project',
        space: {
          id: 'space-folder-proj-id',
          name: 'Project Alpha',
          typeId: 'projects',
          abstractStorageId: 'space-folder-proj-id',
        },
        data: {
          contact: '  jane doe  ',
          date: '260825',
          direction: 'OT',
          description: 'Status check',
        },
      };

      const firstRes = await prodApp.server.inject({
        method: 'POST',
        url: '/documents?eventName=onSubmit',
        payload,
      });
      expect(firstRes.statusCode).toBe(200);
      const firstBody = JSON.parse(firstRes.payload);
      expect(firstBody.success).toBe(true);
      expect(firstBody.data.data.contact).toEqual({ key: 'Jane Doe', name: 'Jane Doe' });
      expect(firstBody.data.data.direction).toEqual({ key: 'OT', name: 'Outgoing' });

      // Second POST /documents must NOT reuse cached Drive response from request 1
      callPhase = 2;
      const secondRes = await prodApp.server.inject({
        method: 'POST',
        url: '/documents?eventName=onSubmit',
        payload,
      });
      expect(secondRes.statusCode).toBe(400);
      const secondBody = JSON.parse(secondRes.payload);
      expect(secondBody.success).toBe(false);
      expect(secondBody.errors).toEqual([
        'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.',
      ]);

      listFoldersSpy.mockRestore();
    });

    it('POST /documents validates submittal-arch against batched _Config reads, preserves raw punctuation, rejects invalid restricted options, and avoids cross-request Sheets caching (#358)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      let phase = 1;
      const { sheetsClient, getSpy, batchGetSpy } = createArchOptionTablesSheetsMock(manifestPath, {
        getTables: () => ({
          statuses: phase === 1 ? [['Status'], ['Open'], ['---']] : [['Status'], ['Closed'], ['---']],
          actions: [
            ['Name', 'Order', 'Action', 'Suffix'],
            ['No Objections As Corrected', '6', 'NOC', '_NOC'],
            ['---', '', '', ''],
          ],
        }),
      });
      const searchSpy = vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
        {
          id: 'arch-log-358',
          name: 'Active Projects Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]);

      const prodApp = createApp({
        skipSpaceValidation: true,
        manifestPath,
        activityEngine: mockDispatcher,
        sheetsClient,
      });
      await prodApp.initialize();

      try {
        // 1. Valid dynamic option (order-independent Row 0 headers + enrichment + raw punctuation preserved)
        const validRes = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            type: 'submittal-arch',
            space: {
              id: 'space-projects-1',
              name: 'Active Projects',
              typeId: 'projects',
              abstractStorageId: 'space-projects-1',
            },
            data: {
              status: 'open',
              section: '071200',
              number: '002',
              revision: 'A',
              title: 'Sheet / Membrane: Waterproofing',
              date: '261020',
              contact: 'PMG',
              action: 'NOC',
              notes: 'Check "quoted" & slash/note',
            },
          },
        });

        expect(validRes.statusCode).toBe(200);
        const validBody = JSON.parse(validRes.payload);
        expect(validBody.data.data.status).toEqual({ key: 'Open' });
        expect(validBody.data.data.action).toEqual({
          key: 'NOC',
          name: 'No Objections As Corrected',
          suffix: '_NOC',
          order: '6',
        });
        expect(validBody.data.id).toBe('071200-002-A-261020-6');
        expect(validBody.data.calculated.fileName).toBe(
          '071200-002-A Sheet / Membrane: Waterproofing - 261020 PMG_NOC'
        );
        expect(validBody.data.data.title).toBe('Sheet / Membrane: Waterproofing');
        expect(validBody.data.data.notes).toBe('Check "quoted" & slash/note');
        // Batched Sheets read: exactly 1 spreadsheets.get + 1 values:batchGet (FORMATTED_VALUE)
        expect(getSpy).toHaveBeenCalledTimes(1);
        expect(batchGetSpy).toHaveBeenCalledTimes(1);
        expect(batchGetSpy.mock.calls[0][0].valueRenderOption).toBe('FORMATTED_VALUE');

        // 2. Next request sees fresh _Config options (zero cross-request caching): "Open" now invalid
        phase = 2;
        const rejectedRes = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            type: 'submittal-arch',
            space: {
              id: 'space-projects-1',
              name: 'Active Projects',
              typeId: 'projects',
              abstractStorageId: 'space-projects-1',
            },
            data: {
              status: 'Open',
              section: '071200',
              number: '002',
              revision: 'A',
              title: 'Waterproofing',
              date: '261020',
              contact: 'PMG',
              action: 'NOC',
            },
          },
        });
        expect(rejectedRes.statusCode).toBe(400);
        const rejectedBody = JSON.parse(rejectedRes.payload);
        expect(rejectedBody.success).toBe(false);
        expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2); // only request 1 dispatched MOVE_FILE + WRITE_LOG

        // 3. Unknown or unnormalized CSI division in submittal-arch -> HTTP 400 with zero activities dispatched
        const missingDivRes = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            type: 'submittal-arch',
            space: {
              id: 'space-projects-1',
              name: 'Active Projects',
              typeId: 'projects',
              abstractStorageId: 'space-projects-1',
            },
            data: {
              status: 'Closed',
              section: '990000',
              number: '002',
              revision: 'A',
              title: 'Unknown Division',
              date: '261020',
              contact: 'PMG',
              action: 'NOC',
            },
          },
        });
        expect(missingDivRes.statusCode).toBe(400);
        const missingDivBody = JSON.parse(missingDivRes.payload);
        expect(missingDivBody.success).toBe(false);
        expect(JSON.stringify(missingDivBody.errors)).toContain('csiDivisionFolder');
        expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
      } finally {
        searchSpy.mockRestore();
      }
    });

    it('POST /documents returns HTTP 400 when _Config Submittal Arch CSI division key is unnormalized ("1" vs "01") (#374)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const { sheetsClient } = createArchOptionTablesSheetsMock(manifestPath, {
        getTables: () => ({
          statuses: [['Status'], ['Open'], ['---']],
          actions: [
            ['Action', 'Name', 'Suffix', 'Order'],
            ['REC', 'Received', '', '1'],
            ['---', '', '', ''],
          ],
          csiDivisions: [
            ['Division Number', 'Division Folder'],
            ['1', '01 General Requirements'],
            ['---', ''],
          ],
        }),
      });
      const searchSpy = vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
        {
          id: 'arch-log-unnorm',
          name: 'Active Projects Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]);

      const prodApp = createApp({
        skipSpaceValidation: true,
        manifestPath,
        activityEngine: mockDispatcher,
        sheetsClient,
      });
      await prodApp.initialize();

      try {
        const res = await prodApp.server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            type: 'submittal-arch',
            space: {
              id: 'space-projects-1',
              name: 'Active Projects',
              typeId: 'projects',
              abstractStorageId: 'space-projects-1',
            },
            data: {
              status: 'Open',
              section: '011000',
              number: '001',
              revision: '0',
              title: 'Submittal Procedures',
              date: '261020',
              contact: 'PMG',
              action: 'REC',
            },
          },
        });
        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(false);
        expect(JSON.stringify(body.errors)).toContain('csiDivisionFolder');
        expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
      } finally {
        searchSpy.mockRestore();
      }
    });

    it('POST /documents on ambiguous DocumentSpace resolves option validation from candidates[0] while WRITE_LOG still rejects ambiguous_log (#358)', async () => {
      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const { sheetsClient } = createArchOptionTablesSheetsMock(manifestPath, {
        getTables: (spreadsheetId) =>
          spreadsheetId === 'log-candidate-0'
            ? {
                statuses: [['Status'], ['Open'], ['---']],
                actions: [
                  ['Action', 'Name', 'Suffix', 'Order'],
                  ['REC', 'Received', '', '1'],
                  ['---', '', '', ''],
                ],
              }
            : {
                statuses: [['Status'], ['Closed'], ['---']],
                actions: [
                  ['Action', 'Name', 'Suffix', 'Order'],
                  ['NET', 'No Exceptions Taken', '_NET', '7'],
                  ['---', '', '', ''],
                ],
              },
      });
      const searchSpy = vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
        {
          id: 'log-candidate-0',
          name: 'Active Projects Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        {
          id: 'log-candidate-1',
          name: 'Active Projects Document Log (Old)',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]);
      const folderSpy = vi.spyOn(GoogleDriveClient.prototype, 'findOrCreateFolder').mockResolvedValue({
        id: 'folder-submittals',
        name: 'Submittals',
      });
      const resolveFolderSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'resolveFolderPath')
        .mockResolvedValue({ id: 'folder-admin', name: '1 Admin' });
      const getFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'folder-parent',
        name: '1 Admin',
        mimeType: 'application/vnd.google-apps.folder',
      });

      const appManifest = new AppManifestProvider({ manifestPath });
      const handlebars = new HandlebarsAdapter();
      const docRegistry = new DocumentSchemaRegistryAdapter(
        appManifest,
        handlebars,
        ensureEvaluationOrder
      );
      const compiledRegistry = new CompiledSchemaRegistry(docRegistry);
      await compiledRegistry.initialize();

      const driveClient = new GoogleDriveClient({ configProvider: appManifest });
      const docLogWiring = createDocumentLogWiring({
        manifestProvider: appManifest,
        driveClient,
        sheetsClient,
        configProvider: appManifest,
        templateEvaluator: handlebars,
      });

      const mockDriveService: DriveServicePort = {
        getFile: vi.fn().mockResolvedValue({ id: 'doc-file-ambig', name: 'Waterproofing.pdf' }),
        findOrCreateFolder: vi.fn().mockResolvedValue({ id: 'folder-submittals', name: 'Submittals' }),
        resolveFolderPath: vi.fn().mockResolvedValue({ id: 'folder-admin', name: '1 Admin' }),
        move: vi.fn().mockResolvedValue({ id: 'doc-file-ambig', webViewLink: 'https://drive.google.com/file/d/doc-file-ambig/view' }),
        rename: vi.fn().mockResolvedValue({ id: 'doc-file-ambig', name: 'Waterproofing.pdf' }),
        duplicate: vi.fn(),
        searchFiles: vi.fn().mockResolvedValue([]),
        downloadAsBuffer: vi.fn(),
        saveBuffer: vi.fn(),
        uploadStream: vi.fn(),
      };

      const server = createHttpServer();
      const docService = wireDocumentServicesAndRoutes({
        server,
        driveClient,
        driveService: mockDriveService,
        configProvider: appManifest,
        manifestProvider: appManifest,
        documentSchemaRegistry: docRegistry,
        templateEvaluator: handlebars,
        compiledSchemaRegistry: compiledRegistry,
        primaryTargetId: 'doc-file-ambig',
        documentLogService: docLogWiring.documentLogService,
        getDocumentLogService: (ctx) => docLogWiring.getPerRequestService(ctx),
        ensureDocumentLogInitialized: () => docLogWiring.logSchemaRegistry.initialize(),
        additionalActivityHandlers: [docLogWiring.createActivityHandler()],
        createAdditionalActivityHandlers: (lookupOptions, requestContext) => [
          docLogWiring.createPerRequestActivityHandler(requestContext, {
            onWriteLogSuccess: () => lookupOptions.invalidate(),
          }),
        ],
      });
      if ('initialize' in docService && typeof docService.initialize === 'function') {
        await docService.initialize();
      }

      try {
        // Validation passes using candidates[0] ("Open" + "REC"), MOVE_FILE succeeds,
        // and WRITE_LOG strictly rejects ambiguous_log.
        const res = await server.inject({
          method: 'POST',
          url: '/documents?eventName=onSubmit',
          payload: {
            type: 'submittal-arch',
            space: {
              id: 'space-projects-1',
              name: 'Active Projects',
              typeId: 'projects',
              abstractStorageId: 'space-projects-1',
            },
            data: {
              status: 'Open',
              section: '071200',
              number: '002',
              revision: 'A',
              title: 'Waterproofing',
              date: '261020',
              contact: 'PMG',
              action: 'REC',
            },
          },
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(false);
        expect(JSON.stringify(body.errors ?? '')).toContain('Multiple DocumentLog');
        expect(JSON.stringify(body.errors ?? '')).not.toContain('not a valid option');
        expect(mockDriveService.move).toHaveBeenCalledTimes(1);
        // candidates[0] used for validation; WRITE_LOG reused per-request resolveLog (1 search total)
        expect(searchSpy).toHaveBeenCalledTimes(1);
      } finally {
        searchSpy.mockRestore();
        folderSpy.mockRestore();
        resolveFolderSpy.mockRestore();
        getFileSpy.mockRestore();
      }
    });
  });
});







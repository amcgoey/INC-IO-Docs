import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createApp, type AppInstance } from '../src/app/server';
import type { ManifestRegistryPort, ActivityDispatcherPort } from '../src/features/document/ports';
import { FormSchemaType, type DocumentType } from '../src/features/document/domain';

describe('App integration tests', () => {
  let app: AppInstance;
  let mockManifestRegistry: ManifestRegistryPort;
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
        documentUiConfig: {
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

    app = createApp({
      manifestRegistry: mockManifestRegistry,
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
      expect(mockActivityEngine.dispatch).toHaveBeenCalledWith({
        type: 'LOG_DOCUMENT',
        payload: { status: 'submitted' },
      });
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

    it('GET /forms should return 200 with FormSchema list mapped from ManifestRegistryPort without backend configs', async () => {
      const response = await app.server.inject({
        method: 'GET',
        url: '/forms',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0]).toEqual({
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
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SubmitCommProject',
            },
          },
        },
      });

      // Verify strict contract validation against FormSchemaType
      expect(Value.Check(FormSchemaType, body[0])).toBe(true);

      // Verify backend-only and undeclared properties are not present
      expect(body[0]).not.toHaveProperty('documentWorkflowConfig');
      expect(body[0]).not.toHaveProperty('storageContextConfig');
      expect(Object.keys(body[0]).sort()).toEqual(['key', 'name', 'documentSchema', 'documentUiConfig'].sort());

      expect(mockManifestRegistry.loadAll).toHaveBeenCalledTimes(1);
    });

    it('GET /forms should return valid FormSchemas when APP_MANIFEST_PATH points to production manifest', async () => {
      vi.stubEnv('APP_MANIFEST_PATH', path.resolve(__dirname, '../assets/manifest.json'));
      const defaultApp = createApp();
      await defaultApp.initialize();

      const response = await defaultApp.server.inject({
        method: 'GET',
        url: '/forms',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      for (const form of body) {
        expect(Value.Check(FormSchemaType, form)).toBe(true);
        expect(form).not.toHaveProperty('documentWorkflowConfig');
        expect(form).not.toHaveProperty('storageContextConfig');
      }
      vi.unstubAllEnvs();
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
      const failingRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockRejectedValue(error),
      };
      return createApp({ manifestRegistry: failingRegistry });
    }

    it('fails fast on createApp when neither options.manifestPath nor APP_MANIFEST_PATH is set and no manifestRegistry is provided', () => {
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

    it('fails fast on app initialization when ManifestRegistryPort throws an error', async () => {
      const failingApp = createAppWithFailingRegistry(
        new Error('Manifest file not found or corrupted')
      );

      await expect(failingApp.initialize()).rejects.toThrow('Manifest file not found or corrupted');
    });

    it('fails fast on app initialization when ManifestRegistryPort rejects with schema validation error', async () => {
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
      const failingApp = createApp({ manifestPath: nonExistentManifestPath });

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
      const failingApp = createApp({ manifestPath: corruptedManifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid JSON in manifest file/);
    });

    it('fails fast during startup when manifest file schema is invalid', async () => {
      const invalidManifestPath = path.join(tempDir, 'invalid-manifest.json');
      await fs.writeFile(invalidManifestPath, JSON.stringify({ documentTypes: 'not-an-array' }));
      const failingApp = createApp({ manifestPath: invalidManifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid manifest file structure/);
    });

    it('fails fast during startup when a referenced DocumentType file is missing', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ documentTypes: ['./missing-Document-type.json'] })
      );
      const failingApp = createApp({ manifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/ENOENT|no such file/i);
    });

    it('fails fast during startup when a referenced DocumentType file contains corrupted JSON', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const documentTypePath = path.join(tempDir, 'corrupted-Document.json');
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: ['./corrupted-Document.json'] }));
      await fs.writeFile(documentTypePath, '{ invalid json');
      const failingApp = createApp({ manifestPath });

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
      const failingApp = createApp({ manifestPath });

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
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(unsupportedDocumentTypes),
      };
      const failingApp = createApp({ manifestRegistry: customRegistry });

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

      const appInstance = createApp({ manifestPath });
      await appInstance.initialize();
      const forms = await appInstance.documentService.getForms();

      expect(forms).toHaveLength(1);
      expect(forms[0].key).toBe('custom-Document-key');
      expect(forms[0].name).toBe('Custom Document Name');
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
      const forms = await appInstance.documentService.getForms();

      expect(forms).toHaveLength(1);
      expect(forms[0].key).toBe('env-Document-key');
      expect(forms[0].name).toBe('Env Document Name');

      const response = await appInstance.server.inject({
        method: 'GET',
        url: '/forms',
      });
      expect(response.statusCode).toBe(200);
      const responseBody = JSON.parse(response.payload);
      expect(responseBody).toHaveLength(1);
      expect(responseBody[0].key).toBe('env-Document-key');
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

      const appInstance = createApp({ manifestPath: optManifestPath });
      await appInstance.initialize();
      const forms = await appInstance.documentService.getForms();

      expect(forms).toHaveLength(1);
      expect(forms[0].key).toBe('option-key');
    });
  });

  describe('End-to-End Calculated Fields and Identity Properties Resolution', () => {
    it('resolves identity properties (id, idDocument, idGroup) from communication-project.json and enriches payload before dispatching activity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const prodApp = createApp({
        manifestPath,
        activityEngine: mockDispatcher,
      });

      await prodApp.initialize();

      const basePayload = {
        type: 'communication-project',
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
        direction: {
          key: 'IN',
          name: 'Incoming',
        },
      };

      const expectedDocument = {
        type: 'communication-project',
        id: expectedIdentityValue,
        idDocument: expectedIdentityValue,
        idGroup: expectedGroupId,
        data: expectedEnrichedData,
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
      expect(body.activities).toEqual([
        {
          type: 'LOG_DOCUMENT',
          payload: {
            status: 'filed',
          },
        },
      ]);

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_DOCUMENT',
        payload: {
          status: 'filed',
        },
      });
    });

    it('rejects payload with 400 when lookup field has an invalid option value', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
      const prodApp = createApp({
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
          documentUiConfig: {
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

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(customDocumentTypes),
      };

      const customApp = createApp({
        manifestRegistry: customRegistry,
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
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_DOCUMENT',
        payload: {
          status: 'combobox_handled',
        },
      });
    });
  });

  describe('End-to-End Initialization Flow', () => {
    it('initializes app with real adapters using fixture manifest and returns stripped FormSchemas via GET /forms', async () => {
      const manifestPath = path.resolve(__dirname, 'fixtures/manifest.json');
      const e2eApp = createApp({ manifestPath });

      await e2eApp.initialize();

      const response = await e2eApp.server.inject({
        method: 'GET',
        url: '/forms',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);

      const expectedForm = {
        key: 'test-document',
        name: 'Test Document',
        documentSchema: {
          fields: [
            {
              key: 'title',
              name: 'Title',
              type: 'string',
              required: true,
            },
          ],
        },
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SubmitTestWorkflow',
            },
          },
        },
      };

      expect(body[0]).toEqual(expectedForm);

      // Verify strict contract validation against FormSchemaType
      expect(Value.Check(FormSchemaType, body[0])).toBe(true);

      // Verify backend configurations are stripped out
      expect(body[0]).not.toHaveProperty('documentWorkflowConfig');
      expect(body[0]).not.toHaveProperty('storageContextConfig');
      expect(Object.keys(body[0]).sort()).toEqual(
        ['key', 'name', 'documentSchema', 'documentUiConfig'].sort()
      );
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
          documentUiConfig: {
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
                      calculatedSummary: '{{Document.data.summary}}',
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

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(customDocumentTypes),
      };

      const appInstance = createApp({
        manifestRegistry: customRegistry,
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

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'CONSOLE_LOG',
        payload: expectedResolvedPayload,
      });
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

    it('propagates workspace configuration from manifest to /workspace/homepage and /workspace/action', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const documentTypePath = path.join(tempDir, 'custom-Document.json');
      const customDocument = {
        key: 'configured-Document-type',
        name: 'Configured Document Type',
        documentSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
        documentUiConfig: {
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
                  type: 'MOVE_DRIVE_FILE',
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
              appTitle: 'Custom Enterprise Workspace',
              actionButtonText: 'File In Custom Folder',
              defaultDocumentType: 'configured-Document-type',
              defaultEventName: 'onConfiguredSubmit',
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
      };

      const mockAuthVerifier = {
        verifyToken: vi.fn().mockResolvedValue({
          isValid: true,
          payload: { email: 'user@example.com' },
        }),
      };

      const appInstance = createApp({
        manifestPath,
        driveService: mockDriveService,
        authVerifier: mockAuthVerifier,
      });

      await appInstance.initialize();

      // 1. Verify /workspace/homepage card includes configured title and button text
      const homepageRes = await appInstance.server.inject({
        method: 'POST',
        url: '/workspace/homepage',
        headers: { authorization: 'Bearer token' },
      });

      expect(homepageRes.statusCode).toBe(200);
      const homepageBody = JSON.parse(homepageRes.payload);
      expect(homepageBody.action.navigations[0].pushCard.header.title).toBe(
        'Custom Enterprise Workspace'
      );
      expect(
        homepageBody.action.navigations[0].pushCard.sections[0].widgets[0].buttonList.buttons[0]
          .text
      ).toBe('File In Custom Folder');

      // 2. Verify /workspace/action triggers DocumentService with defaultDocumentType & defaultEventName from config,
      // and DriveActivityHandler moves to !CustomDestination folder
      const actionRes = await appInstance.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.user-token',
          },
          drive: {
            selectedItems: [{ id: 'file-123', title: 'ImportantDocument.pdf' }],
          },
        },
      });

      expect(actionRes.statusCode).toBe(200);
      const actionBody = JSON.parse(actionRes.payload);
      expect(actionBody).toEqual({
        action: {
          notification: {
            text: "Moved 'ImportantDocument.pdf' to '!CustomDestination'",
          },
        },
      });

      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-1',
        '!CustomDestination',
        { auth: 'ya29.user-token' }
      );
    });
  });
});







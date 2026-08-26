import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createApp, type AppInstance } from '../src/app/server';
import type { ManifestRegistryPort, ActivityDispatcherPort } from '../src/features/record/ports';
import { FormSchemaType, type RecordType } from '../src/features/record/domain';

describe('App integration tests', () => {
  let app: AppInstance;
  let mockManifestRegistry: ManifestRegistryPort;
  let mockActivityEngine: ActivityDispatcherPort;
  let mockRecordTypes: RecordType[];

  beforeEach(async () => {
    mockRecordTypes = [
      {
        key: 'communication-project',
        name: 'Communication Project',
        recordSchema: {
          fields: [
            {
              key: 'contact',
              name: 'Contact Person',
              type: 'string',
              required: true,
            },
          ],
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SubmitCommProject',
            },
          },
        },
        recordWorkflowConfig: {
          workflows: [
            {
              name: 'SubmitCommProject',
              activitySequence: [
                {
                  type: 'LOG_RECORD',
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
      loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
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
    it('POST /records?eventName=onSubmit should return 200 and dispatch activity for valid record payload', async () => {
      const validRecord = {
        type: 'communication-project',
        data: {
          contact: 'Jane Doe',
        },
      };

      const response = await app.server.inject({
        method: 'POST',
        url: '/records?eventName=onSubmit',
        payload: validRecord,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: true,
        data: validRecord,
        activities: [
          {
            type: 'LOG_RECORD',
            payload: { status: 'submitted' },
          },
        ],
      });
      expect(mockActivityEngine.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
        payload: { status: 'submitted' },
      });
    });

    it('POST /records without eventName should return 200 with empty activities and not dispatch', async () => {
      const validRecord = {
        type: 'communication-project',
        data: {
          contact: 'Jane Doe',
        },
      };

      const response = await app.server.inject({
        method: 'POST',
        url: '/records',
        payload: validRecord,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: true,
        data: validRecord,
        activities: [],
      });
      expect(mockActivityEngine.dispatch).not.toHaveBeenCalled();
    });

    it('POST /records should return 400 for invalid record payload', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/records',
        payload: {
          invalid: 'record payload',
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

    it('POST /records should return 400 when dynamic data payload fails schema validation', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/records',
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

    it('POST /records should return 400 for unknown record type', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/records',
        payload: {
          type: 'unknown-type',
          data: { contact: 'Jane Doe' },
        },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        success: false,
        errors: expect.arrayContaining(['Unknown record type: unknown-type']),
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
        recordSchema: {
          fields: [
            {
              key: 'contact',
              name: 'Contact Person',
              type: 'string',
              required: true,
            },
          ],
        },
        recordUiConfig: {
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
      expect(body[0]).not.toHaveProperty('recordWorkflowConfig');
      expect(body[0]).not.toHaveProperty('storageContextConfig');
      expect(Object.keys(body[0]).sort()).toEqual(['key', 'name', 'recordSchema', 'recordUiConfig'].sort());

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
        expect(form).not.toHaveProperty('recordWorkflowConfig');
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
        new Error('Invalid RecordType schema in "./schemas/invalid.json": /recordSchema/fields: Expected array')
      );

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid RecordType schema/);
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
      await fs.writeFile(invalidManifestPath, JSON.stringify({ recordTypes: 'not-an-array' }));
      const failingApp = createApp({ manifestPath: invalidManifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid manifest file structure/);
    });

    it('fails fast during startup when a referenced RecordType file is missing', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ recordTypes: ['./missing-record-type.json'] })
      );
      const failingApp = createApp({ manifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/ENOENT|no such file/i);
    });

    it('fails fast during startup when a referenced RecordType file contains corrupted JSON', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const recordTypePath = path.join(tempDir, 'corrupted-record.json');
      await fs.writeFile(manifestPath, JSON.stringify({ recordTypes: ['./corrupted-record.json'] }));
      await fs.writeFile(recordTypePath, '{ invalid json');
      const failingApp = createApp({ manifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid JSON in RecordType file/);
    });

    it('fails fast during startup when a referenced RecordType file fails schema validation', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const recordTypePath = path.join(tempDir, 'invalid-record.json');
      await fs.writeFile(manifestPath, JSON.stringify({ recordTypes: ['./invalid-record.json'] }));
      await fs.writeFile(
        recordTypePath,
        JSON.stringify({ key: 'invalid', name: 'Invalid', recordSchema: { fields: 'not-an-array' } })
      );
      const failingApp = createApp({ manifestPath });

      await expect(failingApp.initialize()).rejects.toThrow(/Invalid RecordType schema/);
    });

    it('fails fast during startup when a RecordType contains an unsupported field type', async () => {
      const unsupportedRecordTypes: RecordType[] = [
        {
          key: 'unsupported-field-record',
          name: 'Unsupported Field Record',
          recordSchema: {
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
        loadAll: vi.fn().mockResolvedValue(unsupportedRecordTypes),
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
      const recordTypePath = path.join(tempDir, 'custom-record.json');
      const customRecord = {
        key: 'custom-record-key',
        name: 'Custom Record Name',
        recordSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
      };
      await fs.writeFile(recordTypePath, JSON.stringify(customRecord));
      await fs.writeFile(manifestPath, JSON.stringify({ recordTypes: ['./custom-record.json'] }));

      const appInstance = createApp({ manifestPath });
      await appInstance.initialize();
      const forms = await appInstance.recordService.getForms();

      expect(forms).toHaveLength(1);
      expect(forms[0].key).toBe('custom-record-key');
      expect(forms[0].name).toBe('Custom Record Name');
    });

    it('resolves manifest strictly from APP_MANIFEST_PATH environment variable', async () => {
      const manifestPath = path.join(tempDir, 'env-manifest.json');
      const recordTypePath = path.join(tempDir, 'env-record.json');
      const customRecord = {
        key: 'env-record-key',
        name: 'Env Record Name',
        recordSchema: { fields: [{ key: 'code', name: 'Code', type: 'string', required: true }] },
      };
      await fs.writeFile(recordTypePath, JSON.stringify(customRecord));
      await fs.writeFile(manifestPath, JSON.stringify({ recordTypes: ['./env-record.json'] }));

      vi.stubEnv('APP_MANIFEST_PATH', manifestPath);

      const appInstance = createApp();
      await appInstance.initialize();
      const forms = await appInstance.recordService.getForms();

      expect(forms).toHaveLength(1);
      expect(forms[0].key).toBe('env-record-key');
      expect(forms[0].name).toBe('Env Record Name');

      const response = await appInstance.server.inject({
        method: 'GET',
        url: '/forms',
      });
      expect(response.statusCode).toBe(200);
      const responseBody = JSON.parse(response.payload);
      expect(responseBody).toHaveLength(1);
      expect(responseBody[0].key).toBe('env-record-key');
    });

    it('prefers options.manifestPath over APP_MANIFEST_PATH environment variable', async () => {
      const optManifestPath = path.join(tempDir, 'opt-manifest.json');
      const optRecordTypePath = path.join(tempDir, 'opt-record.json');
      await fs.writeFile(
        optRecordTypePath,
        JSON.stringify({
          key: 'option-key',
          name: 'Option Name',
          recordSchema: { fields: [] },
        })
      );
      await fs.writeFile(optManifestPath, JSON.stringify({ recordTypes: ['./opt-record.json'] }));

      const envManifestPath = path.join(tempDir, 'env-manifest.json');
      const envRecordTypePath = path.join(tempDir, 'env-record.json');
      await fs.writeFile(
        envRecordTypePath,
        JSON.stringify({
          key: 'env-key',
          name: 'Env Name',
          recordSchema: { fields: [] },
        })
      );
      await fs.writeFile(envManifestPath, JSON.stringify({ recordTypes: ['./env-record.json'] }));

      vi.stubEnv('APP_MANIFEST_PATH', envManifestPath);

      const appInstance = createApp({ manifestPath: optManifestPath });
      await appInstance.initialize();
      const forms = await appInstance.recordService.getForms();

      expect(forms).toHaveLength(1);
      expect(forms[0].key).toBe('option-key');
    });
  });

  describe('End-to-End Calculated Fields and Identity Properties Resolution', () => {
    it('resolves testCalculatedField and identity properties (id, idRecord, idGroup) from communication-project.json and enriches payload before dispatching activity', async () => {
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

      const expectedCalculatedValue = '260825-IN-Jane Doe-Quarterly review discussion';
      const expectedIdentityValue = 'Jane Doe-260825-IN-Quarterly review discussion';
      const expectedGroupId = 'Jane Doe';

      const expectedEnrichedData = {
        ...basePayload.data,
        direction: {
          key: 'IN',
          name: 'Incoming',
        },
        testCalculatedField: expectedCalculatedValue,
      };

      const expectedRecord = {
        type: 'communication-project',
        id: expectedIdentityValue,
        idRecord: expectedIdentityValue,
        idGroup: expectedGroupId,
        data: expectedEnrichedData,
      };

      const response = await prodApp.server.inject({
        method: 'POST',
        url: '/records?eventName=onSubmit',
        payload: basePayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(expectedRecord);
      expect(body.activities).toEqual([
        {
          type: 'LOG_RECORD',
          payload: {
            status: 'filed',
          },
        },
      ]);

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
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
        url: '/records',
        payload: invalidPayload,
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(false);
      expect(body.errors.some((err: string) => err.includes('/direction:'))).toBe(true);
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('accepts arbitrary string inputs when a record schema defines a combo-box with allowUserInput: true', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customRecordTypes: RecordType[] = [
        {
          key: 'combobox-record',
          name: 'Combobox Record',
          recordSchema: {
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
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'SubmitCombobox',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'SubmitCombobox',
                activitySequence: [
                  {
                    type: 'LOG_RECORD',
                    payload: { status: 'combobox_handled' },
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(customRecordTypes),
      };

      const customApp = createApp({
        manifestRegistry: customRegistry,
        activityEngine: mockDispatcher,
      });

      await customApp.initialize();

      const customPayload = {
        type: 'combobox-record',
        data: {
          category: 'NonStandardCategoryXYZ',
        },
      };

      const response = await customApp.server.inject({
        method: 'POST',
        url: '/records?eventName=onSubmit',
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
        type: 'LOG_RECORD',
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
        key: 'test-record',
        name: 'Test Record',
        recordSchema: {
          fields: [
            {
              key: 'title',
              name: 'Title',
              type: 'string',
              required: true,
            },
          ],
        },
        recordUiConfig: {
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
      expect(body[0]).not.toHaveProperty('recordWorkflowConfig');
      expect(body[0]).not.toHaveProperty('storageContextConfig');
      expect(Object.keys(body[0]).sort()).toEqual(
        ['key', 'name', 'recordSchema', 'recordUiConfig'].sort()
      );
    });
  });
});





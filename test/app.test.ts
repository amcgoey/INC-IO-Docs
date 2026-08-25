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
              key: 'Contact',
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
          workflows: [{ name: 'SubmitCommProject' }],
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
    it('POST /records should return 200 and dispatch activity for valid record payload', async () => {
      const validRecord = {
        id: 'doc-001',
        type: 'submittal',
        title: 'Foundation Spec',
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
        activity: {
          type: 'LOG_RECORD',
          payload: { record: validRecord },
        },
      });
      expect(mockActivityEngine.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
        payload: { record: validRecord },
      });
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
              key: 'Contact',
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

    it('GET /forms should return valid FormSchemas with default production manifest and server wiring', async () => {
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
    });
  });

  describe('Fail-fast startup behavior', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inc-io-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    function createAppWithFailingRegistry(error: Error) {
      const failingRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockRejectedValue(error),
      };
      return createApp({ manifestRegistry: failingRegistry });
    }

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

    it('fails fast during startup when manifest file is missing', async () => {
      const nonExistentManifestPath = path.join(tempDir, 'non-existent-manifest.json');
      const failingApp = createApp({ manifestPath: nonExistentManifestPath });

      await expect(failingApp.initialize()).rejects.toThrow();
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

      await expect(failingApp.initialize()).rejects.toThrow();
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
  });

  describe('ManifestRegistry wiring in createApp', () => {
    it('initializes successfully with default manifest assets when no options are provided', async () => {
      const defaultAppInstance = createApp();
      await expect(defaultAppInstance.initialize()).resolves.toBeUndefined();
      const forms = await defaultAppInstance.recordService.getForms();
      expect(forms.length).toBeGreaterThan(0);
      expect(forms[0].key).toBe('communication-project');
    });
  });
});





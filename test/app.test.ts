import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, type AppInstance } from '../src/app/server';
import type { ManifestRegistryPort, ActivityDispatcherPort } from '../src/features/record/ports';
import type { RecordType } from '../src/features/record/domain';

// Mock the entire google-auth-library so we can bypass the token verification in route tests
vi.mock('google-auth-library', () => {
  return {
    OAuth2Client: class {
      verifyIdToken = vi.fn().mockResolvedValue({
        getPayload: vi.fn().mockReturnValue({ sub: 'user123', email: 'test@example.com' }),
      });
    },
  };
});

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
    it('POST /onDocsHomepage should return 200 with a valid token', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/onDocsHomepage',
        headers: {
          authorization: 'Bearer mocked-token-for-testing',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toHaveProperty('action');
      expect(body.action).toHaveProperty('navigations');
    });

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
      expect(body[0]).not.toHaveProperty('recordWorkflowConfig');
      expect(body[0]).not.toHaveProperty('storageContextConfig');
      expect(mockManifestRegistry.loadAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('Fail-fast startup behavior', () => {
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
  });
});





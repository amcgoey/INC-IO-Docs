import { describe, it, expect, vi } from 'vitest';
import { registerDocumentFeatureRoutes } from './api';
import type { DocumentServicePort, SchemaQueryPort } from '../ports';
import type { FormSchema } from '../domain';
import type { HttpServer, RouteDefinition, RouteSchema } from '../../../infrastructure/http';

function createMockRouter() {
  const registeredRoutes: RouteDefinition[] = [];
  const router: HttpServer = {
    registerRoute: vi.fn(<S extends RouteSchema = RouteSchema>(route: RouteDefinition<S>) => {
      registeredRoutes.push(route);
    }),
    start: vi.fn(),
    stop: vi.fn(),
    inject: vi.fn(),
  };
  return { router, registeredRoutes };
}

describe('Document Feature API driving adapter', () => {
  it('registers feature routes and handles requests', async () => {
    const mockForm: FormSchema = {
      key: 'test-form',
      name: 'Test Form',
      documentSchema: {
        fields: [
          {
            key: 'Field1',
            name: 'Field 1',
            type: 'string',
            required: true,
          },
        ],
      },
    };

    const mockSchemaQuery: SchemaQueryPort = {
      getForms: vi.fn().mockResolvedValue([mockForm]),
    };

    const mockService: DocumentServicePort = {
      processRecord: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' },
        activities: [
          {
            type: 'LOG_RECORD',
            payload: { document: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' } },
          },
        ],
      }),
    };

    const { router: mockRouter, registeredRoutes } = createMockRouter();

    registerDocumentFeatureRoutes(mockRouter, { service: mockService, schemaQuery: mockSchemaQuery });

    expect(mockRouter.registerRoute).toHaveBeenCalledTimes(2);
    
    const formsRoute = registeredRoutes.find(r => r.method === 'GET' && r.url === '/forms');
    expect(formsRoute).toBeDefined();

    const recordsRoute = registeredRoutes.find(r => r.method === 'POST' && r.url === '/documents');
    expect(recordsRoute).toBeDefined();

    // Test GET /forms
    const formsResponse = await formsRoute!.handler({});
    expect(formsResponse.status).toBe(200);
    expect(mockSchemaQuery.getForms).toHaveBeenCalled();
    expect(formsResponse.body).toEqual([mockForm]);

    // Test POST /documents success with eventName query parameter
    const validPayload = {
      id: 'rec-1',
      type: 'submittal',
      title: 'Structural Steel Spec',
    };
    const recordsResponse = await recordsRoute!.handler({
      body: validPayload,
      query: { eventName: 'onSubmit' },
    });
    expect(recordsResponse.status).toBe(200);
    expect(mockService.processRecord).toHaveBeenCalledWith(validPayload, 'onSubmit');
    expect(recordsResponse.body).toEqual({
      success: true,
      data: validPayload,
      activities: [
        {
          type: 'LOG_RECORD',
          payload: { document: validPayload },
        },
      ],
    });
  });

  it('POST /documents forwards undefined eventName when query parameter is omitted', async () => {
    const mockSchemaQuery: SchemaQueryPort = {
      getForms: vi.fn().mockResolvedValue([]),
    };

    const mockService: DocumentServicePort = {
      processRecord: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' },
        activities: [],
      }),
    };

    const { router: mockRouter, registeredRoutes } = createMockRouter();

    registerDocumentFeatureRoutes(mockRouter, { service: mockService, schemaQuery: mockSchemaQuery });

    const recordsRoute = registeredRoutes.find(r => r.method === 'POST' && r.url === '/documents');
    expect(recordsRoute).toBeDefined();

    const validPayload = { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' };
    const response = await recordsRoute!.handler({ body: validPayload });

    expect(response.status).toBe(200);
    expect(mockService.processRecord).toHaveBeenCalledWith(validPayload, undefined);
  });

  it('POST /documents returns 400 when service returns failure', async () => {
    const mockSchemaQuery: SchemaQueryPort = {
      getForms: vi.fn().mockResolvedValue([]),
    };

    const mockService: DocumentServicePort = {
      processRecord: vi.fn().mockResolvedValue({
        success: false,
        errors: ['id: Expected string'],
      }),
    };

    const { router: mockRouter, registeredRoutes } = createMockRouter();

    registerDocumentFeatureRoutes(mockRouter, { service: mockService, schemaQuery: mockSchemaQuery });

    const recordsRoute = registeredRoutes.find(r => r.method === 'POST' && r.url === '/documents');
    expect(recordsRoute).toBeDefined();

    const invalidPayload = { title: 123 };
    const response = await recordsRoute!.handler({ body: invalidPayload });

    expect(response.status).toBe(400);
    expect(mockService.processRecord).toHaveBeenCalledWith(invalidPayload, undefined);
    expect(response.body).toEqual({
      success: false,
      errors: ['id: Expected string'],
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { registerDocumentFeatureRoutes } from './api';
import type { DocumentServicePort } from '../ports';
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
    const mockService: DocumentServicePort = {
      processDocument: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' },
        activities: [
          {
            type: 'LOG_DOCUMENT',
            payload: { document: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' } },
          },
        ],
      }),
    };

    const { router: mockRouter, registeredRoutes } = createMockRouter();

    registerDocumentFeatureRoutes(mockRouter, { service: mockService });

    expect(mockRouter.registerRoute).toHaveBeenCalledTimes(1);

    const documentsRoute = registeredRoutes.find(r => r.method === 'POST' && r.url === '/documents');
    expect(documentsRoute).toBeDefined();

    // Test POST /documents success with eventName query parameter
    const validPayload = {
      id: 'rec-1',
      type: 'submittal',
      title: 'Structural Steel Spec',
    };
    const documentsResponse = await documentsRoute!.handler({
      body: validPayload,
      query: { eventName: 'onSubmit' },
    });
    expect(documentsResponse.status).toBe(200);
    expect(mockService.processDocument).toHaveBeenCalledWith(validPayload, 'onSubmit');
    expect(documentsResponse.body).toEqual({
      success: true,
      data: validPayload,
      activities: [
        {
          type: 'LOG_DOCUMENT',
          payload: { document: validPayload },
        },
      ],
    });
  });

  it('POST /documents forwards undefined eventName when query parameter is omitted', async () => {
    const mockService: DocumentServicePort = {
      processDocument: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' },
        activities: [],
      }),
    };

    const { router: mockRouter, registeredRoutes } = createMockRouter();

    registerDocumentFeatureRoutes(mockRouter, { service: mockService });

    const documentsRoute = registeredRoutes.find(r => r.method === 'POST' && r.url === '/documents');
    expect(documentsRoute).toBeDefined();

    const validPayload = { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' };
    const response = await documentsRoute!.handler({ body: validPayload });

    expect(response.status).toBe(200);
    expect(mockService.processDocument).toHaveBeenCalledWith(validPayload, undefined);
  });

  it('POST /documents returns 400 when service returns failure', async () => {
    const mockService: DocumentServicePort = {
      processDocument: vi.fn().mockResolvedValue({
        success: false,
        errors: ['id: Expected string'],
      }),
    };

    const { router: mockRouter, registeredRoutes } = createMockRouter();

    registerDocumentFeatureRoutes(mockRouter, { service: mockService });

    const documentsRoute = registeredRoutes.find(r => r.method === 'POST' && r.url === '/documents');
    expect(documentsRoute).toBeDefined();

    const invalidPayload = { title: 123 };
    const response = await documentsRoute!.handler({ body: invalidPayload });

    expect(response.status).toBe(400);
    expect(mockService.processDocument).toHaveBeenCalledWith(invalidPayload, undefined);
    expect(response.body).toEqual({
      success: false,
      errors: ['id: Expected string'],
    });
  });
});

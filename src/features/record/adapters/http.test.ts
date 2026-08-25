import { describe, it, expect, vi } from 'vitest';
import { registerRecordRoutes } from './http';
import type { HttpRouteDefinition, HttpRouterPort, RecordServicePort } from '../ports';

describe('Record HTTP driving adapter', () => {
  it('registers POST /records route and returns 200 when service succeeds', async () => {
    const mockService: RecordServicePort = {
      processRecord: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' },
        activity: {
          type: 'LOG_RECORD',
          payload: { record: { id: 'rec-1', type: 'submittal', title: 'Structural Steel Spec' } },
        },
      }),
    };

    let registeredRoute: HttpRouteDefinition | undefined;
    const mockRouter: HttpRouterPort = {
      registerRoute: vi.fn((route: HttpRouteDefinition) => {
        registeredRoute = route;
      }),
    };

    registerRecordRoutes(mockRouter, { service: mockService });

    expect(mockRouter.registerRoute).toHaveBeenCalledTimes(1);
    expect(registeredRoute).toBeDefined();
    expect(registeredRoute?.method).toBe('POST');
    expect(registeredRoute?.url).toBe('/records');

    const validPayload = {
      id: 'rec-1',
      type: 'submittal',
      title: 'Structural Steel Spec',
    };

    const response = await registeredRoute!.handler({ body: validPayload });

    expect(response.status).toBe(200);
    expect(mockService.processRecord).toHaveBeenCalledWith(validPayload);
    expect(response.body).toEqual({
      success: true,
      data: validPayload,
      activity: {
        type: 'LOG_RECORD',
        payload: { record: validPayload },
      },
    });
  });

  it('returns 400 when service returns failure', async () => {
    const mockService: RecordServicePort = {
      processRecord: vi.fn().mockResolvedValue({
        success: false,
        errors: ['id: Expected string'],
      }),
    };

    let registeredRoute: HttpRouteDefinition | undefined;
    const mockRouter: HttpRouterPort = {
      registerRoute: vi.fn((route: HttpRouteDefinition) => {
        registeredRoute = route;
      }),
    };

    registerRecordRoutes(mockRouter, { service: mockService });

    const invalidPayload = { title: 123 };
    const response = await registeredRoute!.handler({ body: invalidPayload });

    expect(response.status).toBe(400);
    expect(mockService.processRecord).toHaveBeenCalledWith(invalidPayload);
    expect(response.body).toEqual({
      success: false,
      errors: ['id: Expected string'],
    });
  });
});

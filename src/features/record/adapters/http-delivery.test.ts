import { describe, it, expect, vi } from 'vitest';
import { registerFormRoutes } from './http-delivery';
import type { HttpRouteDefinition, HttpRouterPort, SchemaQueryPort } from '../ports';
import type { FormSchema } from '../domain';

describe('HTTP Delivery driving adapter', () => {
  it('registers GET /forms route and returns 200 with forms from SchemaQueryPort', async () => {
    const mockForm: FormSchema = {
      key: 'test-form',
      name: 'Test Form',
      recordSchema: {
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

    let registeredRoute: HttpRouteDefinition | undefined;
    const mockRouter: HttpRouterPort = {
      registerRoute: vi.fn((route: HttpRouteDefinition) => {
        registeredRoute = route;
      }),
    };

    registerFormRoutes(mockRouter, { schemaQuery: mockSchemaQuery });

    expect(mockRouter.registerRoute).toHaveBeenCalledTimes(1);
    expect(registeredRoute).toBeDefined();
    expect(registeredRoute?.method).toBe('GET');
    expect(registeredRoute?.url).toBe('/forms');

    const response = await registeredRoute!.handler({});

    expect(response.status).toBe(200);
    expect(mockSchemaQuery.getForms).toHaveBeenCalled();
    expect(response.body).toEqual([mockForm]);
  });
});

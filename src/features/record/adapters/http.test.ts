import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { recordRoutes } from './http';

describe('Record HTTP driving adapter', () => {
  it('POST /records returns 200 for valid payload', async () => {
    const fastify = Fastify();
    await fastify.register(recordRoutes);

    const validPayload = {
      id: 'rec-1',
      type: 'submittal',
      title: 'Structural Steel Spec',
    };

    const response = await fastify.inject({
      method: 'POST',
      url: '/records',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: validPayload,
    });
  });

  it('POST /records returns 400 for invalid payload', async () => {
    const fastify = Fastify();
    await fastify.register(recordRoutes);

    const response = await fastify.inject({
      method: 'POST',
      url: '/records',
      payload: {
        invalid: 'data',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      success: false,
      errors: expect.any(Array),
    });
  });

  it('POST /records uses injected service port', async () => {
    const fastify = Fastify();
    const mockService = {
      processRecord: () => ({
        success: true as const,
        data: { id: 'mock-id', type: 'mock-type', title: 'Mock' },
      }),
    };

    await fastify.register(recordRoutes, { service: mockService });

    const response = await fastify.inject({
      method: 'POST',
      url: '/records',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      data: { id: 'mock-id', type: 'mock-type', title: 'Mock' },
    });
  });
});

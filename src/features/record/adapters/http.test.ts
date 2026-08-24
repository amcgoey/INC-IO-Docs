import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { recordRoutes } from './http';

describe('Record HTTP driving adapter', () => {
  it('POST /records returns 200 and success response from domain', async () => {
    const fastify = Fastify();
    await fastify.register(recordRoutes);

    const response = await fastify.inject({
      method: 'POST',
      url: '/records',
      payload: {
        test: 'data',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
  });
});

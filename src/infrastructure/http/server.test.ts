import { describe, it, expect } from 'vitest';
import { createHttpServer } from './index';

describe('HTTP Infrastructure Server', () => {
  it('registers and handles a GET route with custom status and body', async () => {
    const server = createHttpServer();

    server.registerRoute({
      method: 'GET',
      url: '/test-get',
      handler: async () => {
        return {
          status: 200,
          body: { message: 'hello world' },
        };
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/test-get',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'hello world' });
  });

  it('registers and handles a POST route receiving payload and query params', async () => {
    const server = createHttpServer();

    server.registerRoute({
      method: 'POST',
      url: '/test-post',
      handler: async (req) => {
        return {
          status: 201,
          body: {
            receivedBody: req.body,
            receivedQuery: req.query,
          },
        };
      },
    });

    const response = await server.inject({
      method: 'POST',
      url: '/test-post?filter=active',
      payload: { name: 'Item 1' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      receivedBody: { name: 'Item 1' },
      receivedQuery: { filter: 'active' },
    });
  });

  it('supports custom response headers', async () => {
    const server = createHttpServer();

    server.registerRoute({
      method: 'GET',
      url: '/test-headers',
      handler: async () => {
        return {
          status: 200,
          headers: { 'x-custom-header': 'custom-value' },
          body: { ok: true },
        };
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/test-headers',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-custom-header']).toBe('custom-value');
  });

  it('handles uncaught exceptions in route handlers with 500 error response', async () => {
    const server = createHttpServer();

    server.registerRoute({
      method: 'GET',
      url: '/test-error',
      handler: async () => {
        throw new Error('Something went wrong internally');
      },
    });

    const response = await server.inject({
      method: 'GET',
      url: '/test-error',
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Something went wrong internally',
    });
  });

  it('can start and stop the server', async () => {
    const server = createHttpServer();
    const address = await server.start(0, '127.0.0.1');
    expect(address).toBeDefined();
    await server.stop();
  });
});

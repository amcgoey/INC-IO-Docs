import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  injectWorkspaceRequest,
  DEFAULT_WORKSPACE_TEST_HOST,
  DEFAULT_WORKSPACE_TEST_PROTO,
  DEFAULT_WORKSPACE_BASE_URL,
  type WorkspaceRequestTarget,
} from './workspace-request';
import type { InjectOptions, InjectResult } from '../../../src/infrastructure/http';

describe('injectWorkspaceRequest Test Utility', () => {
  const originalEnv = process.env.APP_BASE_URL;

  beforeEach(() => {
    delete process.env.APP_BASE_URL;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.APP_BASE_URL = originalEnv;
    } else {
      delete process.env.APP_BASE_URL;
    }
  });

  it('exports expected defaults', () => {
    expect(DEFAULT_WORKSPACE_TEST_HOST).toBe('workspace-addon.test');
    expect(DEFAULT_WORKSPACE_TEST_PROTO).toBe('https');
    expect(DEFAULT_WORKSPACE_BASE_URL).toBe('https://workspace-addon.test');
  });

  it('injects default host and proto headers when no host or env variable is set', async () => {
    const mockInject = vi.fn().mockResolvedValue({
      statusCode: 200,
      payload: '{}',
      body: '{}',
      headers: {},
      json: () => ({}),
    } as InjectResult);

    const target: WorkspaceRequestTarget = {
      inject: mockInject,
    };

    const response = await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authorization: 'Bearer sample-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockInject).toHaveBeenCalledTimes(1);

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.headers).toMatchObject({
      authorization: 'Bearer sample-token',
      host: DEFAULT_WORKSPACE_TEST_HOST,
      'x-forwarded-proto': DEFAULT_WORKSPACE_TEST_PROTO,
    });
  });

  it('derives host and x-forwarded-proto from process.env.APP_BASE_URL when present', async () => {
    process.env.APP_BASE_URL = 'https://env-addon.internal.net';

    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/drive-items-selected',
    });

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.headers?.host).toBe('env-addon.internal.net');
    expect(passedOptions.headers?.['x-forwarded-proto']).toBe('https');
  });

  it('handles port and http protocol correctly from process.env.APP_BASE_URL', async () => {
    process.env.APP_BASE_URL = 'http://127.0.0.1:8080';

    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
    });

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.headers?.host).toBe('127.0.0.1:8080');
    expect(passedOptions.headers?.['x-forwarded-proto']).toBe('http');
  });

  it('allows overriding base URL via options.baseUrl', async () => {
    process.env.APP_BASE_URL = 'https://env-addon.internal.net';

    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
      baseUrl: 'https://custom-override.internal.app',
    });

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.headers?.host).toBe('custom-override.internal.app');
    expect(passedOptions.headers?.['x-forwarded-proto']).toBe('https');
  });

  it('preserves caller-specified host header without overwriting it', async () => {
    process.env.APP_BASE_URL = 'https://env-addon.internal.net';

    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        host: 'standalone-host.internal.app',
      },
    });

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.headers?.host).toBe('standalone-host.internal.app');
  });

  it('preserves caller-specified authority header without overwriting it', async () => {
    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authority: 'authority-host.internal.app',
      },
    });

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.headers?.authority).toBe('authority-host.internal.app');
    expect(passedOptions.headers?.host).toBeUndefined();
  });

  it('preserves caller-specified x-forwarded-host and x-forwarded-proto', async () => {
    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        'x-forwarded-host': 'proxy.example.com',
        'x-forwarded-proto': 'http',
      },
    });

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.headers?.['x-forwarded-host']).toBe('proxy.example.com');
    expect(passedOptions.headers?.['x-forwarded-proto']).toBe('http');
    expect(passedOptions.headers?.host).toBe(DEFAULT_WORKSPACE_TEST_HOST);
  });

  it('throws a descriptive error when baseUrl or APP_BASE_URL is invalid', async () => {
    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await expect(
      injectWorkspaceRequest(target, {
        method: 'POST',
        url: '/workspace/action',
        baseUrl: 'invalid-url-not-a-valid-uri',
      })
    ).rejects.toThrow('Invalid base URL provided for workspace request injection: "invalid-url-not-a-valid-uri"');

    process.env.APP_BASE_URL = 'http://:not-valid';
    await expect(
      injectWorkspaceRequest(target, {
        method: 'POST',
        url: '/workspace/action',
      })
    ).rejects.toThrow('Invalid base URL provided for workspace request injection: "http://:not-valid"');
  });

  it('does not mutate caller-provided headers object', async () => {
    const originalHeaders = {
      authorization: 'Bearer secret',
    };
    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
      headers: originalHeaders,
    });

    expect(originalHeaders).toEqual({
      authorization: 'Bearer secret',
    });
  });

  it('forwards payload, query, and other parameters unchanged', async () => {
    const mockInject = vi.fn().mockResolvedValue({ statusCode: 200 } as InjectResult);
    const target: WorkspaceRequestTarget = { inject: mockInject };

    const payload = { action: 'submit', data: { id: 1 } };
    const query = { debug: 'true' };

    await injectWorkspaceRequest(target, {
      method: 'POST',
      url: '/workspace/action',
      payload,
      query,
    });

    const passedOptions = mockInject.mock.calls[0][0] as InjectOptions;
    expect(passedOptions.method).toBe('POST');
    expect(passedOptions.url).toBe('/workspace/action');
    expect(passedOptions.payload).toEqual(payload);
    expect(passedOptions.query).toEqual(query);
  });
});

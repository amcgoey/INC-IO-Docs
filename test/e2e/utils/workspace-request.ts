import type { InjectOptions, InjectResult } from '../../../src/infrastructure/http';

export const DEFAULT_WORKSPACE_TEST_HOST = 'workspace-addon.test';
export const DEFAULT_WORKSPACE_TEST_PROTO = 'https';
export const DEFAULT_WORKSPACE_BASE_URL = `${DEFAULT_WORKSPACE_TEST_PROTO}://${DEFAULT_WORKSPACE_TEST_HOST}`;

export interface InjectableTarget {
  inject(options: InjectOptions): Promise<InjectResult>;
}

export type WorkspaceRequestTarget =
  | { server: InjectableTarget }
  | InjectableTarget;

export interface WorkspaceRequestOptions extends InjectOptions {
  /**
   * Optional explicit base URL to derive host and protocol from.
   * Overrides process.env.APP_BASE_URL and DEFAULT_WORKSPACE_BASE_URL.
   */
  baseUrl?: string;
}

function hasHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === target);
}

/**
 * Standardized test injection wrapper for Fastify HTTP requests in Google Workspace E2E tests.
 *
 * Automatically configures host and authority headers based on caller override,
 * process.env.APP_BASE_URL, or standard test defaults, preventing test reliance on
 * Fastify's implicit localhost:80 fallback.
 */
export async function injectWorkspaceRequest(
  target: WorkspaceRequestTarget,
  options: WorkspaceRequestOptions
): Promise<InjectResult> {
  const headers: Record<string, string | string[] | undefined> = {
    ...(options.headers ?? {}),
  };

  const hasHostOrAuthority =
    hasHeader(headers, 'host') || hasHeader(headers, 'authority');

  if (!hasHostOrAuthority) {
    let host = DEFAULT_WORKSPACE_TEST_HOST;
    let proto = DEFAULT_WORKSPACE_TEST_PROTO;

    const rawBaseUrl = options.baseUrl ?? process.env.APP_BASE_URL;
    if (rawBaseUrl && rawBaseUrl.trim() !== '') {
      try {
        const parsed = new URL(rawBaseUrl.trim());
        host = parsed.host;
        proto = parsed.protocol.replace(':', '');
      } catch {
        // Fallback to standard test defaults if invalid URL
      }
    }

    headers.host = host;
    if (!hasHeader(headers, 'x-forwarded-proto')) {
      headers['x-forwarded-proto'] = proto;
    }
  }

  const finalOptions: InjectOptions = {
    ...options,
    headers,
  };
  delete (finalOptions as { baseUrl?: string }).baseUrl;

  const server = 'server' in target ? target.server : target;
  return server.inject(finalOptions);
}

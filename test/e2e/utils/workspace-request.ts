import type { InjectOptions, InjectResult } from '../../../src/infrastructure/http';

export const DEFAULT_WORKSPACE_TEST_HOST = 'workspace-addon.test';
export const DEFAULT_WORKSPACE_TEST_PROTO = 'https';
export const DEFAULT_WORKSPACE_BASE_URL = `${DEFAULT_WORKSPACE_TEST_PROTO}://${DEFAULT_WORKSPACE_TEST_HOST}`;

export interface WorkspaceRequestTarget {
  inject(options: InjectOptions): Promise<InjectResult>;
}

export type InjectableTarget = WorkspaceRequestTarget;

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
  const { baseUrl, headers: originalHeaders, ...injectOptions } = options;

  const headers: Record<string, string | string[] | undefined> = {
    ...(originalHeaders ?? {}),
  };

  const hasHostOrAuthority =
    hasHeader(headers, 'host') || hasHeader(headers, 'authority');

  if (!hasHostOrAuthority) {
    let host = DEFAULT_WORKSPACE_TEST_HOST;
    let proto = DEFAULT_WORKSPACE_TEST_PROTO;

    const rawBaseUrl = baseUrl ?? process.env.APP_BASE_URL;
    if (rawBaseUrl && rawBaseUrl.trim() !== '') {
      try {
        const parsed = new URL(rawBaseUrl.trim());
        host = parsed.host;
        proto = parsed.protocol.replace(':', '');
      } catch (err) {
        throw new Error(
          `Invalid base URL provided for workspace request injection: "${rawBaseUrl}". Expected a valid URL (e.g. "https://example.com").`,
          { cause: err }
        );
      }
    }

    headers.host = host;
    if (!hasHeader(headers, 'x-forwarded-proto')) {
      headers['x-forwarded-proto'] = proto;
    }
  }

  return target.inject({
    ...injectOptions,
    headers,
  });
}

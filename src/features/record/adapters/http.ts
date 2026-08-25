import type { RecordServicePort } from '../ports';

export interface HttpRouter {
  registerRoute(route: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    url: string;
    handler: (request: {
      body?: unknown;
      headers?: Record<string, string | string[] | undefined>;
      query?: Record<string, unknown>;
      params?: Record<string, string | undefined>;
    }) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }> | { status: number; body?: unknown; headers?: Record<string, string> };
  }): void;
}

export interface RecordRoutesOptions {
  service: RecordServicePort;
}

export function registerRecordRoutes(server: HttpRouter, opts: RecordRoutesOptions): void {
  const service = opts.service;

  server.registerRoute({
    method: 'POST',
    url: '/records',
    handler: async (request) => {
      const result = await service.processRecord(request.body);
      if (!result.success) {
        return {
          status: 400,
          body: result,
        };
      }
      return {
        status: 200,
        body: result,
      };
    },
  });
}

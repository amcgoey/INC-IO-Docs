import type { HttpRouterPort, RecordServicePort } from '../ports';

export interface RecordRoutesOptions {
  service: RecordServicePort;
}

export function registerRecordRoutes(server: HttpRouterPort, opts: RecordRoutesOptions): void {
  const service = opts.service;

  server.registerRoute({
    method: 'POST',
    url: '/records',
    handler: async (request) => {
      const result = await service.processRecord(request.body);
      return {
        status: result.success ? 200 : 400,
        body: result,
      };
    },
  });
}

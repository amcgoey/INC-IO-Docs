import type { HttpRouterPort, RecordServicePort, SchemaQueryPort } from '../ports';

export interface RecordFeatureApiOptions {
  service: RecordServicePort;
  schemaQuery: SchemaQueryPort;
}

export function registerRecordFeatureRoutes(server: HttpRouterPort, opts: RecordFeatureApiOptions): void {
  const { service, schemaQuery } = opts;

  server.registerRoute({
    method: 'GET',
    url: '/forms',
    handler: async () => {
      const forms = await schemaQuery.getForms();
      return {
        status: 200,
        body: forms,
      };
    },
  });

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

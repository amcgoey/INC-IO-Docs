import type { HttpServer } from '../../../infrastructure/http';
import type { RecordServicePort, SchemaQueryPort } from '../ports';

export interface RecordFeatureApiOptions {
  service: RecordServicePort;
  schemaQuery: SchemaQueryPort;
}

export function registerRecordFeatureRoutes(router: HttpServer, opts: RecordFeatureApiOptions): void {
  const { service, schemaQuery } = opts;

  router.registerRoute({
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

  router.registerRoute({
    method: 'POST',
    url: '/records',
    handler: async (request) => {
      const query = request.query as Record<string, string | undefined> | undefined;
      const eventName = typeof query === 'object' && query !== null ? query.eventName : undefined;
      const result = await service.processRecord(request.body, eventName);
      return {
        status: result.success ? 200 : 400,
        body: result,
      };
    },
  });
}

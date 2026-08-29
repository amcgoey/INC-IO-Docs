import type { DocumentServicePort, SchemaQueryPort } from '../ports';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface HttpRequest {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined> | undefined;
  query?: unknown;
  params?: unknown;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteDefinition {
  method: HttpMethod;
  url: string;
  schema?: unknown;
  handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;
}

export interface HttpServer {
  registerRoute(route: RouteDefinition): void;
}

export interface DocumentFeatureApiOptions {
  service: DocumentServicePort;
  schemaQuery: SchemaQueryPort;
}

export function registerDocumentFeatureRoutes(router: HttpServer, opts: DocumentFeatureApiOptions): void {
  const { service, schemaQuery } = opts;

  router.registerRoute({
    method: 'GET',
    url: '/forms',
    handler: async () => {
      try {
        const forms = await schemaQuery.getForms();
        return {
          status: 200,
          body: forms,
        };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'Failed to retrieve forms',
          },
        };
      }
    },
  });

  router.registerRoute({
    method: 'POST',
    url: '/documents',
    handler: async (request) => {
      try {
        const query = request.query as Record<string, string | undefined> | undefined;
        const eventName = typeof query === 'object' && query !== null ? query.eventName : undefined;
        const result = await service.processRecord(request.body, eventName);
        return {
          status: result.success ? 200 : 400,
          body: result,
        };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'Failed to process document',
          },
        };
      }
    },
  });
}


import type { DocumentServicePort } from '../ports';

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
  service?: DocumentServicePort | undefined;
  createService?: (() => DocumentServicePort | Promise<DocumentServicePort>) | undefined;
}

function toInternalServerErrorResponse(error: unknown, fallbackMessage: string): HttpResponse {
  return {
    status: 500,
    body: {
      error: 'Internal Server Error',
      message: error instanceof Error ? error.message : fallbackMessage,
    },
  };
}

export function registerDocumentFeatureRoutes(router: HttpServer, opts: DocumentFeatureApiOptions): void {
  const { service, createService } = opts;

  router.registerRoute({
    method: 'POST',
    url: '/documents',
    handler: async (request) => {
      try {
        const query = request.query as Record<string, string | undefined> | undefined;
        const eventName = typeof query === 'object' && query !== null ? query.eventName : undefined;
        const targetService = createService ? await createService() : service;
        if (!targetService) {
          return toInternalServerErrorResponse(
            new Error('DocumentService is not configured'),
            'Failed to process document'
          );
        }
        const result = await targetService.processDocument(request.body, eventName);
        return {
          status: result.success ? 200 : 400,
          body: result,
        };
      } catch (error) {
        return toInternalServerErrorResponse(error, 'Failed to process document');
      }
    },
  });
}

import Fastify, { type FastifyInstance, type InjectOptions as FastifyInjectOptions } from 'fastify';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface HttpRequest {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  params?: Record<string, string | undefined>;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type HttpHandler = (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;

export interface RouteDefinition {
  method: HttpMethod;
  url: string;
  handler: HttpHandler;
}

export interface HttpServerOptions {
  logger?: boolean;
}

export interface InjectOptions {
  method: HttpMethod;
  url: string;
  payload?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

export interface InjectResult {
  statusCode: number;
  payload: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json<T = unknown>(): T;
}

export interface HttpServer {
  registerRoute(route: RouteDefinition): void;
  start(port: number, host?: string): Promise<string>;
  stop(): Promise<void>;
  inject(options: InjectOptions): Promise<InjectResult>;
}

class FastifyHttpServer implements HttpServer {
  private readonly app: FastifyInstance;

  constructor(options?: HttpServerOptions) {
    this.app = Fastify({
      logger: options?.logger ?? false,
    });
  }

  public registerRoute(route: RouteDefinition): void {
    this.app.route({
      method: route.method,
      url: route.url,
      handler: async (request, reply) => {
        try {
          const httpRequest: HttpRequest = {
            body: request.body,
            headers: request.headers as Record<string, string | string[] | undefined>,
            query: request.query as Record<string, unknown>,
            params: request.params as Record<string, string | undefined>,
          };
          const response = await route.handler(httpRequest);
          if (response.headers) {
            for (const [key, value] of Object.entries(response.headers)) {
              void reply.header(key, value);
            }
          }
          return reply.status(response.status).send(response.body);
        } catch (error) {
          return reply.status(500).send({
            statusCode: 500,
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'An unexpected error occurred',
          });
        }
      },
    });
  }

  public async start(port: number, host: string = '0.0.0.0'): Promise<string> {
    const address = await this.app.listen({ port, host });
    return address;
  }

  public async stop(): Promise<void> {
    await this.app.close();
  }

  public async inject(options: InjectOptions): Promise<InjectResult> {
    const injectOpts: FastifyInjectOptions = {
      method: options.method,
      url: options.url,
    };
    if (options.payload !== undefined) {
      injectOpts.payload = options.payload as NonNullable<FastifyInjectOptions['payload']>;
    }
    if (options.headers !== undefined) {
      injectOpts.headers = options.headers as NonNullable<FastifyInjectOptions['headers']>;
    }
    if (options.query !== undefined) {
      injectOpts.query = options.query as NonNullable<FastifyInjectOptions['query']>;
    }

    const response = await this.app.inject(injectOpts);
    return {
      statusCode: response.statusCode,
      payload: response.payload,
      body: response.body,
      headers: response.headers as Record<string, string | string[] | undefined>,
      json: <T = unknown>() => response.json() as T,
    };
  }
}

export function createHttpServer(options?: HttpServerOptions): HttpServer {
  return new FastifyHttpServer(options);
}

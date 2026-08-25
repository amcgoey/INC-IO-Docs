import Fastify, {
  type InjectOptions as FastifyInjectOptions,
  type FastifyRequest,
  type FastifyReply,
  type RouteOptions,
} from 'fastify';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { type TSchema, type Static } from '@sinclair/typebox';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface RouteSchema {
  body?: TSchema;
  querystring?: TSchema;
  params?: TSchema;
  headers?: TSchema;
  response?: Record<number, TSchema>;
}

export interface HttpRequest<S extends RouteSchema = RouteSchema> {
  body?: (S['body'] extends TSchema ? Static<S['body']> : unknown) | undefined;
  headers?: (S['headers'] extends TSchema ? Static<S['headers']> : Record<string, string | string[] | undefined>) | undefined;
  query?: (S['querystring'] extends TSchema ? Static<S['querystring']> : Record<string, unknown>) | undefined;
  params?: (S['params'] extends TSchema ? Static<S['params']> : Record<string, string | undefined>) | undefined;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type HttpHandler<S extends RouteSchema = RouteSchema> = (
  request: HttpRequest<S>
) => Promise<HttpResponse> | HttpResponse;

export interface RouteDefinition<S extends RouteSchema = RouteSchema> {
  method: HttpMethod;
  url: string;
  schema?: S;
  handler: HttpHandler<S>;
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
  registerRoute<S extends RouteSchema = RouteSchema>(route: RouteDefinition<S>): void;
  start(port: number, host?: string): Promise<string>;
  stop(): Promise<void>;
  inject(options: InjectOptions): Promise<InjectResult>;
}

class FastifyHttpServer implements HttpServer {
  private readonly app;

  constructor(options?: HttpServerOptions) {
    this.app = Fastify({
      logger: options?.logger ?? false,
    }).withTypeProvider<TypeBoxTypeProvider>();
  }

  public registerRoute<S extends RouteSchema = RouteSchema>(route: RouteDefinition<S>): void {
    const routeOptions: RouteOptions = {
      method: route.method,
      url: route.url,
      ...(route.schema !== undefined ? { schema: route.schema } : {}),
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const httpRequest: HttpRequest<S> = {
            body: request.body as HttpRequest<S>['body'],
            headers: request.headers as HttpRequest<S>['headers'],
            query: request.query as HttpRequest<S>['query'],
            params: request.params as HttpRequest<S>['params'],
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
    };
    this.app.route(routeOptions);
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

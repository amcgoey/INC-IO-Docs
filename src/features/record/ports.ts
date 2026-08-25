import type { Activity, FormSchema, ProcessRecordResult, RecordType } from './domain';


export interface ActivityDispatcherPort {
  dispatch(activity: Activity): Promise<void> | void;
}

export interface RecordServicePort {
  processRecord(payload?: unknown): Promise<ProcessRecordResult>;
}

export interface SchemaQueryPort {
  getForms(): Promise<FormSchema[]> | FormSchema[];
}

export interface ManifestRegistryPort {
  loadAll(): Promise<RecordType[]>;
}

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

export interface HttpRouterPort {
  registerRoute(route: RouteDefinition): void;
}


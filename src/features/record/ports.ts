import type { Activity, FormSchema, ProcessRecordResult } from './domain';

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

export interface HttpRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  url: string;
  handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;
}

export interface HttpRouterPort {
  registerRoute(route: HttpRouteDefinition): void;
}

export interface ActivityDispatcherPort {
  dispatch(activity: Activity): Promise<void> | void;
}

export interface RecordServicePort {
  processRecord(payload?: unknown): Promise<ProcessRecordResult>;
}

export interface SchemaQueryPort {
  getForms(): Promise<FormSchema[]> | FormSchema[];
}

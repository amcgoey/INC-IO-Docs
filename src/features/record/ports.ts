import type { Activity, FormSchema, ProcessRecordResult, RecordType } from './domain';


export interface ActivityDispatcherPort {
  dispatch(activity: Activity): Promise<void> | void;
}

export interface RecordServicePort {
  processRecord(payload?: unknown, eventName?: string): Promise<ProcessRecordResult>;
}

export interface SchemaQueryPort {
  getForms(): Promise<FormSchema[]> | FormSchema[];
}

export interface ManifestRegistryPort {
  loadAll(): Promise<RecordType[]>;
}

export type TemplateEvaluationContext = { [key: string]: unknown };

export interface TemplateEvaluatorPort {
  validate(template: string, allowedVariables: string[]): boolean;
  evaluate(template: string, context: TemplateEvaluationContext): string;
}




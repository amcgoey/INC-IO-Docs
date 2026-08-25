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



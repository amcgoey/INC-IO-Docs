import type { Activity, ProcessRecordResult } from './domain';
 
export interface ActivityDispatcherPort {
  dispatch(activity: Activity): Promise<void> | void;
}

export interface RecordServicePort {
  processRecord(payload?: unknown): ProcessRecordResult;
}

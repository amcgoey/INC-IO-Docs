import type { ProcessRecordResult } from './domain';

export interface RecordServicePort {
  processRecord(payload?: unknown): ProcessRecordResult;
}

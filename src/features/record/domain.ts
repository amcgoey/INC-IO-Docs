export interface ProcessRecordResult {
  success: boolean;
}

export function processRecord(payload?: unknown): ProcessRecordResult {
  void payload;
  return {
    success: true,
  };
}

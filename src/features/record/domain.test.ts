import { describe, it, expect } from 'vitest';
import { processRecord, RecordType, type Record } from './domain';

describe('Record domain', () => {
  it('should export RecordType schema', () => {
    expect(RecordType).toBeDefined();
  });

  it('processRecord returns success for valid Record payload', () => {
    const validRecord: Record = {
      id: 'rec-123',
      type: 'submittal',
      title: 'Foundation Plan',
    };

    const result = processRecord(validRecord);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validRecord);
    }
  });

  it('processRecord returns failure with errors for invalid payload', () => {
    const invalidRecord = {
      title: 123, // wrong type, missing id and type
    };

    const result = processRecord(invalidRecord);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('processRecord returns failure for undefined or null payload', () => {
    const resultUndefined = processRecord(undefined);
    expect(resultUndefined.success).toBe(false);

    const resultNull = processRecord(null);
    expect(resultNull.success).toBe(false);
  });
});

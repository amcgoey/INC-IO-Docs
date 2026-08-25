import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  RecordService,
  RecordType,
  ActivityType,
  FormSchemaType,
  RecordFieldType,
  STUB_FORM_SCHEMA,
  type Record,
} from './domain';
import type { ActivityDispatcherPort } from './ports';

describe('Record domain', () => {
  it('should export RecordType schema', () => {
    expect(RecordType).toBeDefined();
  });

  it('should export ActivityType schema', () => {
    expect(ActivityType).toBeDefined();
  });

  it('processRecord validates payload, dispatches Activity, and returns success result', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RecordService(mockDispatcher);

    const validRecord: Record = {
      id: 'rec-123',
      type: 'submittal',
      title: 'Foundation Plan',
    };

    const result = await service.processRecord(validRecord);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validRecord);
      expect(result.activity).toEqual({
        type: 'LOG_RECORD',
        payload: { record: validRecord },
      });
    }

    expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
      type: 'LOG_RECORD',
      payload: { record: validRecord },
    });
  });

  it('processRecord returns failure and does not dispatch activity for invalid payload', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new RecordService(mockDispatcher);

    const invalidRecord = {
      title: 123, // wrong type, missing id and type
    };

    const result = await service.processRecord(invalidRecord);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('processRecord returns failure for undefined or null payload', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new RecordService(mockDispatcher);

    const resultUndefined = await service.processRecord(undefined);
    expect(resultUndefined.success).toBe(false);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

    const resultNull = await service.processRecord(null);
    expect(resultNull.success).toBe(false);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('exports RecordFieldType and FormSchemaType schemas and validates STUB_FORM_SCHEMA', () => {
    expect(RecordFieldType).toBeDefined();
    expect(FormSchemaType).toBeDefined();
    expect(STUB_FORM_SCHEMA).toBeDefined();
    expect(Value.Check(FormSchemaType, STUB_FORM_SCHEMA)).toBe(true);
  });

  it('getForms returns FormSchema list from RecordService', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new RecordService(mockDispatcher);

    const forms = await service.getForms();
    expect(Array.isArray(forms)).toBe(true);
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(Value.Check(FormSchemaType, form)).toBe(true);
    }
  });
});

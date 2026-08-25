import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  RecordService,
  RecordModel,
  RecordTypeSchema,
  RecordFieldOptionType,
  FormSchemaType,
  ActivityType,
  type Record,
  type RecordType,
  type FormSchema,
} from './domain';
import type { ActivityDispatcherPort, ManifestRegistryPort } from './ports';



describe('Record domain', () => {
  const mockRegistry: ManifestRegistryPort = {
    loadAll: vi.fn().mockResolvedValue([]),
  };

  it('should export RecordModel schema', () => {
    expect(RecordModel).toBeDefined();
  });

  it('should export ActivityType schema', () => {
    expect(ActivityType).toBeDefined();
  });

  it('processRecord validates payload, dispatches Activity, and returns success result', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RecordService(mockDispatcher, mockRegistry);

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
    const service = new RecordService(mockDispatcher, mockRegistry);

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
    const service = new RecordService(mockDispatcher, mockRegistry);

    const resultUndefined = await service.processRecord(undefined);
    expect(resultUndefined.success).toBe(false);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

    const resultNull = await service.processRecord(null);
    expect(resultNull.success).toBe(false);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('exports RecordTypeSchema and validates valid RecordType definitions', () => {
    expect(RecordTypeSchema).toBeDefined();
    const validRecordType: RecordType = {
      key: 'submittal',
      name: 'Submittal Record',
      recordSchema: {
        fields: [
          {
            key: 'Title',
            name: 'Title',
            type: 'string',
            required: true,
          },
        ],
      },
      recordUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitSubmittal',
          },
        },
      },
    };
    expect(Value.Check(RecordTypeSchema, validRecordType)).toBe(true);
  });

  it('RecordFieldOptionType requires source, key, and name', () => {
    const validOption = {
      source: 'Direction',
      key: 'Key',
      name: 'Name',
    };
    expect(Value.Check(RecordFieldOptionType, validOption)).toBe(true);

    const missingSource = {
      key: 'Key',
      name: 'Name',
    };
    expect(Value.Check(RecordFieldOptionType, missingSource)).toBe(false);

    const missingKey = {
      source: 'Direction',
      name: 'Name',
    };
    expect(Value.Check(RecordFieldOptionType, missingKey)).toBe(false);

    const missingName = {
      source: 'Direction',
      key: 'Key',
    };
    expect(Value.Check(RecordFieldOptionType, missingName)).toBe(false);
  });

  it('RecordTypeSchema allows optional backend config stubs', () => {
    const recordTypeWithBackendConfigs: RecordType = {
      key: 'submittal',
      name: 'Submittal Record',
      recordSchema: {
        fields: [
          {
            key: 'Title',
            name: 'Title',
            type: 'string',
            required: true,
          },
        ],
      },
      recordUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitSubmittal',
          },
        },
      },
      recordWorkflowConfig: {
        workflows: [{ name: 'SubmitSubmittal', engine: 'temporal' }],
      },
      storageContextConfig: {
        rootFolder: 'Submittals',
      },
    };

    expect(Value.Check(RecordTypeSchema, recordTypeWithBackendConfigs)).toBe(true);
  });

  it('FormSchemaType validates FormSchema definitions', () => {
    expect(FormSchemaType).toBeDefined();
    const validFormSchema: FormSchema = {
      key: 'submittal',
      name: 'Submittal Record',
      recordSchema: {
        fields: [
          {
            key: 'Title',
            name: 'Title',
            type: 'string',
            required: true,
          },
        ],
      },
      recordUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitSubmittal',
          },
        },
      },
    };
    expect(Value.Check(FormSchemaType, validFormSchema)).toBe(true);
  });

  it('RecordService.initialize caches RecordTypes from ManifestRegistryPort and getForms strips backend configs', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const mockRecordTypes: RecordType[] = [
      {
        key: 'comm-proj',
        name: 'Communication Project',
        recordSchema: {
          fields: [
            {
              key: 'Subject',
              name: 'Subject',
              type: 'string',
              required: true,
            },
          ],
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'HandleComm',
            },
          },
        },
        recordWorkflowConfig: {
          workflows: [{ name: 'HandleComm' }],
        },
        storageContextConfig: {
          path: '/projects/comm',
        },
      },
      {
        key: 'simple-proj',
        name: 'Simple Project',
        recordSchema: {
          fields: [
            {
              key: 'Name',
              name: 'Name',
              type: 'string',
              required: true,
            },
          ],
        },
      },
    ];

    const customRegistry: ManifestRegistryPort = {
      loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
    };

    const service = new RecordService(mockDispatcher, customRegistry);

    // Before initialize, getForms returns empty list
    const initialForms = await service.getForms();
    expect(initialForms).toEqual([]);

    await service.initialize();

    expect(customRegistry.loadAll).toHaveBeenCalledTimes(1);

    const forms = await service.getForms();
    expect(forms).toEqual([
      {
        key: 'comm-proj',
        name: 'Communication Project',
        recordSchema: {
          fields: [
            {
              key: 'Subject',
              name: 'Subject',
              type: 'string',
              required: true,
            },
          ],
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'HandleComm',
            },
          },
        },
      },
      {
        key: 'simple-proj',
        name: 'Simple Project',
        recordSchema: {
          fields: [
            {
              key: 'Name',
              name: 'Name',
              type: 'string',
              required: true,
            },
          ],
        },
      },
    ]);

    for (const form of forms) {
      expect(Value.Check(FormSchemaType, form)).toBe(true);
      expect(form).not.toHaveProperty('recordWorkflowConfig');
      expect(form).not.toHaveProperty('storageContextConfig');
    }
  });
});





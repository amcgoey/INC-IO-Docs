import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  RecordService,
  RecordModel,
  RecordTypeSchema,
  RecordFieldOptionType,
  RecordFieldType,
  RecordSchemaType,
  RecordSchemaOptionTupleType,
  RecordIdentitySchemaType,
  UiEventRuleType,
  FormSchemaType,
  ActivityType,
  formatValidationErrors,
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

  describe('RecordSchemaOptionTupleType and RecordSchemaType.options', () => {
    it('validates RecordSchemaOptionTupleType as Record<string, unknown>', () => {
      expect(RecordSchemaOptionTupleType).toBeDefined();
      const validTuple = { Key: 'IN', Name: 'Incoming', extra: 123 };
      expect(Value.Check(RecordSchemaOptionTupleType, validTuple)).toBe(true);

      const invalidTuple = 'not-an-object';
      expect(Value.Check(RecordSchemaOptionTupleType, invalidTuple)).toBe(false);
    });

    it('validates RecordSchemaType.options as optional Record<string, RecordSchemaOptionTupleType[]>', () => {
      const validSchemaWithOptions = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        options: {
          Direction: [
            { Key: 'IN', Name: 'Incoming' },
            { Key: 'OT', Name: 'Outgoing' },
          ],
        },
      };
      expect(Value.Check(RecordSchemaType, validSchemaWithOptions)).toBe(true);

      const invalidSchemaWithOptions = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        options: {
          Direction: 'invalid-not-array',
        },
      };
      expect(Value.Check(RecordSchemaType, invalidSchemaWithOptions)).toBe(false);
    });
  });

  describe('RecordIdentitySchemaType', () => {
    it('validates Id, IdRecord, and IdGroup keys with extensible string properties', () => {
      expect(RecordIdentitySchemaType).toBeDefined();

      const validIdentity = {
        Id: '{{Key}}',
        IdRecord: '{{Key}}-{{Date}}',
        IdGroup: '{{Contact}}',
        customProperty: 'custom-value',
      };
      expect(Value.Check(RecordIdentitySchemaType, validIdentity)).toBe(true);

      const validPartialIdentity = {
        Id: '{{Key}}',
      };
      expect(Value.Check(RecordIdentitySchemaType, validPartialIdentity)).toBe(true);

      const emptyIdentity = {};
      expect(Value.Check(RecordIdentitySchemaType, emptyIdentity)).toBe(true);

      const invalidNonStringValue = {
        Id: 123,
      };
      expect(Value.Check(RecordIdentitySchemaType, invalidNonStringValue)).toBe(false);

      const invalidNonStringExtensibleValue = {
        Id: '{{Key}}',
        customField: 999,
      };
      expect(Value.Check(RecordIdentitySchemaType, invalidNonStringExtensibleValue)).toBe(false);
    });

    it('validates RecordSchemaType.identity with RecordIdentitySchemaType', () => {
      const schemaWithIdentity = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        identity: {
          Id: '{{Key}}',
          IdRecord: '{{Key}}-{{Date}}',
          IdGroup: '{{Contact}}',
        },
      };
      expect(Value.Check(RecordSchemaType, schemaWithIdentity)).toBe(true);

      const schemaWithInvalidIdentity = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        identity: {
          Id: 123,
        },
      };
      expect(Value.Check(RecordSchemaType, schemaWithInvalidIdentity)).toBe(false);
    });
  });

  describe('UiEventRuleType.matchFields', () => {
    it('accepts optional matchFields as Record<string, string>', () => {
      const validRule = {
        matchFields: {
          Direction: 'IN',
          Status: 'Active',
        },
        workflow: 'HandleIncoming',
      };
      expect(Value.Check(UiEventRuleType, validRule)).toBe(true);

      const ruleWithoutMatchFields = {
        workflow: 'HandleAll',
      };
      expect(Value.Check(UiEventRuleType, ruleWithoutMatchFields)).toBe(true);
    });

    it('rejects matchFields with non-string values', () => {
      const invalidRule = {
        matchFields: {
          Direction: 123,
        },
        workflow: 'HandleIncoming',
      };
      expect(Value.Check(UiEventRuleType, invalidRule)).toBe(false);
    });
  });

  describe('RecordFieldType.defaultValue', () => {
    it('accepts optional defaultValue as string', () => {
      const fieldWithDefault = {
        key: 'Status',
        name: 'Status',
        type: 'string',
        required: false,
        defaultValue: 'Draft',
      };
      expect(Value.Check(RecordFieldType, fieldWithDefault)).toBe(true);

      const fieldWithoutDefault = {
        key: 'Status',
        name: 'Status',
        type: 'string',
        required: false,
      };
      expect(Value.Check(RecordFieldType, fieldWithoutDefault)).toBe(true);
    });

    it('rejects non-string defaultValue', () => {
      const invalidField = {
        key: 'Status',
        name: 'Status',
        type: 'string',
        required: false,
        defaultValue: 123,
      };
      expect(Value.Check(RecordFieldType, invalidField)).toBe(false);
    });
  });

  describe('RecordFieldType.required', () => {
    it('allows omitting required property and defaults to valid schema', () => {
      const fieldWithoutRequired = {
        key: 'Description',
        name: 'Description',
        type: 'string',
      };
      expect(Value.Check(RecordFieldType, fieldWithoutRequired)).toBe(true);
    });

    it('accepts boolean required property when provided', () => {
      const fieldWithRequiredTrue = {
        key: 'Title',
        name: 'Title',
        type: 'string',
        required: true,
      };
      expect(Value.Check(RecordFieldType, fieldWithRequiredTrue)).toBe(true);

      const fieldWithRequiredFalse = {
        key: 'Notes',
        name: 'Notes',
        type: 'string',
        required: false,
      };
      expect(Value.Check(RecordFieldType, fieldWithRequiredFalse)).toBe(true);
    });

    it('rejects non-boolean required property', () => {
      const fieldWithInvalidRequired = {
        key: 'Title',
        name: 'Title',
        type: 'string',
        required: 'yes',
      };
      expect(Value.Check(RecordFieldType, fieldWithInvalidRequired)).toBe(false);
    });
  });

  describe('formatValidationErrors', () => {
    it('returns empty array when there are no errors', () => {
      const Schema = RecordModel;
      const validRecord = { id: 'rec-1', type: 'submittal', title: 'Submittal 1' };
      expect(formatValidationErrors(Schema, validRecord)).toEqual([]);
    });

    it('returns formatted error string array with path and message for invalid value', () => {
      const Schema = RecordModel;
      const invalidRecord = { id: 123, type: 'submittal' };
      const formatted = formatValidationErrors(Schema, invalidRecord);
      expect(formatted.some((e) => e.includes('/id:'))).toBe(true);
      expect(formatted.some((e) => e.includes('/title:'))).toBe(true);
    });
  });
});





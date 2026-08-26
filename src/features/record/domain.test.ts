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
  CalculatedFieldType,
  SystemContextSchema,
  UiEventRuleType,
  FormSchemaType,
  ActivityType,
  formatValidationErrors,
  type Record,
  type RecordType,
  type FormSchema,
} from './domain';
import type { ActivityDispatcherPort, ManifestRegistryPort, TemplateEvaluatorPort } from './ports';



describe('Record domain', () => {
  const mockRegistry: ManifestRegistryPort = {
    loadAll: vi.fn().mockResolvedValue([]),
  };

  const defaultEvaluator: TemplateEvaluatorPort = {
    validate: vi.fn().mockReturnValue(true),
    evaluate: vi.fn().mockReturnValue(''),
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
    const mockRecordTypes: RecordType[] = [
      {
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
            {
              key: 'Notes',
              name: 'Notes',
              type: 'string',
              required: false,
            },
          ],
        },
      },
    ];
    const registryWithSubmittal: ManifestRegistryPort = {
      loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
    };
    const service = new RecordService(mockDispatcher, registryWithSubmittal, defaultEvaluator);
    await service.initialize();

    const validRecord: Record = {
      id: 'rec-123',
      type: 'submittal',
      data: {
        Title: 'Foundation Plan',
      },
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

  it('processRecord returns failure when dynamic field validation fails against compiled schema', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const mockRecordTypes: RecordType[] = [
      {
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
      },
    ];
    const registryWithSubmittal: ManifestRegistryPort = {
      loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
    };
    const service = new RecordService(mockDispatcher, registryWithSubmittal, defaultEvaluator);
    await service.initialize();

    const missingRequiredField = {
      type: 'submittal',
      data: {},
    };

    const result = await service.processRecord(missingRequiredField);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('processRecord returns failure for unknown record type', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new RecordService(mockDispatcher, mockRegistry, defaultEvaluator);
    await service.initialize();

    const unknownTypeRecord = {
      type: 'unknown-type',
      data: { Title: 'Test' },
    };

    const result = await service.processRecord(unknownTypeRecord);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContain("Unknown record type: unknown-type");
    }
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('initialize throws fast-fail error if a RecordType has an unsupported field type', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const invalidRecordTypes: RecordType[] = [
      {
        key: 'invalid-type',
        name: 'Invalid Type',
        recordSchema: {
          fields: [
            {
              key: 'InvalidField',
              name: 'Invalid Field',
              type: 'unknown',
              required: true,
            },
          ],
        },
      },
    ];
    const registryWithInvalid: ManifestRegistryPort = {
      loadAll: vi.fn().mockResolvedValue(invalidRecordTypes),
    };
    const service = new RecordService(mockDispatcher, registryWithInvalid, defaultEvaluator);

    await expect(service.initialize()).rejects.toThrow(
      /Unsupported field type 'unknown'/
    );
  });

  it('processRecord returns failure and does not dispatch activity for invalid payload', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new RecordService(mockDispatcher, mockRegistry, defaultEvaluator);
    await service.initialize();

    const invalidRecord = {
      title: 123, // missing type and data
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
    const service = new RecordService(mockDispatcher, mockRegistry, defaultEvaluator);
    await service.initialize();

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

  it('RecordFieldOptionType accepts optional allowUserInput boolean', () => {
    const optionWithAllowUserInputTrue = {
      source: 'Direction',
      key: 'Key',
      name: 'Name',
      allowUserInput: true,
    };
    expect(Value.Check(RecordFieldOptionType, optionWithAllowUserInputTrue)).toBe(true);

    const optionWithAllowUserInputFalse = {
      source: 'Direction',
      key: 'Key',
      name: 'Name',
      allowUserInput: false,
    };
    expect(Value.Check(RecordFieldOptionType, optionWithAllowUserInputFalse)).toBe(true);

    const optionWithInvalidAllowUserInput = {
      source: 'Direction',
      key: 'Key',
      name: 'Name',
      allowUserInput: 'true',
    };
    expect(Value.Check(RecordFieldOptionType, optionWithInvalidAllowUserInput)).toBe(false);
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

    const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);

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
      const validRecord = { id: 'rec-1', type: 'submittal', data: { Subject: 'Submittal 1' } };
      expect(formatValidationErrors(Schema, validRecord)).toEqual([]);
    });

    it('returns formatted error string array with path and message for invalid value', () => {
      const Schema = RecordModel;
      const invalidRecord = { id: 123, type: 'submittal' }; // id not string, missing data
      const formatted = formatValidationErrors(Schema, invalidRecord);
      expect(formatted.some((e) => e.includes('/id:'))).toBe(true);
      expect(formatted.some((e) => e.includes('/data:'))).toBe(true);
    });
  });

  describe('CalculatedFieldType and SystemContextSchema', () => {
    it('validates CalculatedFieldType with key, template, and optional description', () => {
      expect(CalculatedFieldType).toBeDefined();
      const validCalcField = {
        key: 'Summary',
        template: '{{Title}} - {{Notes}}',
        description: 'Auto-generated summary',
      };
      expect(Value.Check(CalculatedFieldType, validCalcField)).toBe(true);

      const validWithoutDesc = {
        key: 'Summary',
        template: '{{Title}} - {{Notes}}',
      };
      expect(Value.Check(CalculatedFieldType, validWithoutDesc)).toBe(true);

      const missingTemplate = {
        key: 'Summary',
      };
      expect(Value.Check(CalculatedFieldType, missingTemplate)).toBe(false);

      const missingKey = {
        template: '{{Title}}',
      };
      expect(Value.Check(CalculatedFieldType, missingKey)).toBe(false);
    });

    it('exports SystemContextSchema stub', () => {
      expect(SystemContextSchema).toBeDefined();
      expect(Value.Check(SystemContextSchema, {})).toBe(true);
    });

    it('validates RecordSchemaType with optional calculatedFields', () => {
      const schemaWithCalcFields = {
        fields: [{ key: 'Title', name: 'Title', type: 'string', required: true }],
        calculatedFields: [
          {
            key: 'FullTitle',
            template: 'PREFIX-{{Title}}',
          },
        ],
      };
      expect(Value.Check(RecordSchemaType, schemaWithCalcFields)).toBe(true);

      const schemaWithInvalidCalcFields = {
        fields: [{ key: 'Title', name: 'Title', type: 'string', required: true }],
        calculatedFields: [
          {
            key: 'FullTitle',
            // missing template
          },
        ],
      };
      expect(Value.Check(RecordSchemaType, schemaWithInvalidCalcFields)).toBe(false);
    });
  });

  describe('RecordService calculatedFields evaluation', () => {
    it('evaluates calculatedFields against base payload and enriches record before dispatching activity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              { key: 'Contact', name: 'Contact', type: 'string', required: true },
              { key: 'Date', name: 'Date', type: 'string', required: true },
            ],
            calculatedFields: [
              {
                key: 'IdRecord',
                template: '{{Date}}-{{Contact}}',
              },
            ],
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template, ctx) => {
          if (template === '{{Date}}-{{Contact}}') {
            return `${ctx.Date}-${ctx.Contact}`;
          }
          return '';
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          Contact: 'Alice',
          Date: '260825',
        },
      };

      const result = await service.processRecord(inputRecord);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({
          Contact: 'Alice',
          Date: '260825',
          IdRecord: '260825-Alice',
        });
        expect(result.activity).toEqual({
          type: 'LOG_RECORD',
          payload: {
            record: {
              type: 'comm-project',
              data: {
                Contact: 'Alice',
                Date: '260825',
                IdRecord: '260825-Alice',
              },
            },
          },
        });
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
        payload: {
          record: {
            type: 'comm-project',
            data: {
              Contact: 'Alice',
              Date: '260825',
              IdRecord: '260825-Alice',
            },
          },
        },
      });
    });

    it('strictly isolates calculatedFields evaluation context from each other (ADR 0003)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'multi-calc',
          name: 'Multi Calc',
          recordSchema: {
            fields: [
              { key: 'Base1', name: 'Base 1', type: 'string', required: true },
            ],
            calculatedFields: [
              { key: 'Calc1', template: '{{Base1}}-CALC1' },
              { key: 'Calc2', template: '{{Calc1}}-CALC2' },
            ],
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };

      const evaluatedContexts: { [key: string]: unknown }[] = [];
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((_template, ctx) => {
          evaluatedContexts.push({ ...ctx });
          return 'result';
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      await service.processRecord({
        type: 'multi-calc',
        data: { Base1: 'val1' },
      });

      expect(evaluatedContexts).toHaveLength(2);
      // Both evaluations must receive ONLY base payload without Calc1
      expect(evaluatedContexts[0]).toEqual({ Base1: 'val1' });
      expect(evaluatedContexts[1]).toEqual({ Base1: 'val1' });
      expect(evaluatedContexts[1]).not.toHaveProperty('Calc1');
    });
  });

  describe('RecordService identity evaluation', () => {
    it('evaluates identity templates (Id -> id, IdRecord, IdGroup) and populates record before activity dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              { key: 'Contact', name: 'Contact', type: 'string', required: true },
              { key: 'Date', name: 'Date', type: 'string', required: true },
              { key: 'Direction', name: 'Direction', type: 'string', required: true },
              { key: 'Description', name: 'Description', type: 'string', required: true },
            ],
            identity: {
              Id: '{{Contact}}-{{Date}}-{{Direction}}-{{Description}}',
              IdRecord: '{{Contact}}-{{Date}}-{{Direction}}-{{Description}}',
              IdGroup: '{{Contact}}',
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template, ctx) => {
          if (template === '{{Contact}}-{{Date}}-{{Direction}}-{{Description}}') {
            return `${ctx.Contact}-${ctx.Date}-${ctx.Direction}-${ctx.Description}`;
          }
          if (template === '{{Contact}}') {
            return `${ctx.Contact}`;
          }
          return '';
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          Contact: 'Alice',
          Date: '260825',
          Direction: 'IN',
          Description: 'Project discussion',
        },
      };

      const result = await service.processRecord(inputRecord);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('Alice-260825-IN-Project discussion');
        expect(result.data.IdRecord).toBe('Alice-260825-IN-Project discussion');
        expect(result.data.IdGroup).toBe('Alice');
        expect(result.data.data).toEqual({
          Contact: 'Alice',
          Date: '260825',
          Direction: 'IN',
          Description: 'Project discussion',
        });
        expect(result.activity).toEqual({
          type: 'LOG_RECORD',
          payload: {
            record: {
              type: 'comm-project',
              id: 'Alice-260825-IN-Project discussion',
              IdRecord: 'Alice-260825-IN-Project discussion',
              IdGroup: 'Alice',
              data: {
                Contact: 'Alice',
                Date: '260825',
                Direction: 'IN',
                Description: 'Project discussion',
              },
            },
          },
        });
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
        payload: {
          record: {
            type: 'comm-project',
            id: 'Alice-260825-IN-Project discussion',
            IdRecord: 'Alice-260825-IN-Project discussion',
            IdGroup: 'Alice',
            data: {
              Contact: 'Alice',
              Date: '260825',
              Direction: 'IN',
              Description: 'Project discussion',
            },
          },
        },
      });
    });

    it('strictly isolates identity evaluation context from calculatedFields and each other', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'calc-and-identity',
          name: 'Calc and Identity',
          recordSchema: {
            fields: [
              { key: 'Contact', name: 'Contact', type: 'string', required: true },
            ],
            calculatedFields: [
              { key: 'DerivedField', template: '{{Contact}}-DERIVED' },
            ],
            identity: {
              Id: '{{Contact}}-ID',
              IdRecord: '{{DerivedField}}-RECORD',
              IdGroup: '{{Id}}-GROUP',
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };

      const evaluatedContexts: { template: string; ctx: { [key: string]: unknown } }[] = [];
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template, ctx) => {
          evaluatedContexts.push({ template, ctx: { ...ctx } });
          return 'eval-res';
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      await service.processRecord({
        type: 'calc-and-identity',
        data: { Contact: 'Bob' },
      });

      // Total evaluations: 1 calculated field + 3 identity templates = 4
      expect(evaluatedContexts).toHaveLength(4);

      // All evaluations must only see basePayload { Contact: 'Bob' }
      for (const item of evaluatedContexts) {
        expect(item.ctx).toEqual({ Contact: 'Bob' });
        expect(item.ctx).not.toHaveProperty('DerivedField');
        expect(item.ctx).not.toHaveProperty('Id');
        expect(item.ctx).not.toHaveProperty('id');
        expect(item.ctx).not.toHaveProperty('IdRecord');
        expect(item.ctx).not.toHaveProperty('IdGroup');
      }
    });
  });

  describe('RecordService LookupFields validation', () => {
    it('accepts valid string inputs matching option tuple key for lookup fields', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              {
                key: 'Direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'Direction',
                  key: 'Key',
                  name: 'Name',
                },
              },
            ],
            options: {
              Direction: [
                { Key: 'IN', Name: 'Incoming' },
                { Key: 'OT', Name: 'Outgoing' },
              ],
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const validRecord: Record = {
        type: 'comm-project',
        data: {
          Direction: 'IN',
        },
      };

      const result = await service.processRecord(validRecord);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({ Direction: 'IN' });
      }
      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid string inputs not matching any option tuple key for lookup fields', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              {
                key: 'Direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'Direction',
                  key: 'Key',
                  name: 'Name',
                },
              },
            ],
            options: {
              Direction: [
                { Key: 'IN', Name: 'Incoming' },
                { Key: 'OT', Name: 'Outgoing' },
              ],
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const invalidRecord = {
        type: 'comm-project',
        data: {
          Direction: 'INVALID_DIR',
        },
      };

      const result = await service.processRecord(invalidRecord);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((err) => err.includes('/Direction:'))).toBe(true);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('accepts optional lookup fields when omitted, but rejects invalid strings when provided', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              {
                key: 'Direction',
                name: 'Direction',
                type: 'string',
                required: false,
                options: {
                  source: 'Direction',
                  key: 'Key',
                  name: 'Name',
                },
              },
            ],
            options: {
              Direction: [
                { Key: 'IN', Name: 'Incoming' },
                { Key: 'OT', Name: 'Outgoing' },
              ],
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      // Omitting optional lookup field
      const emptyRecord: Record = {
        type: 'comm-project',
        data: {},
      };
      const emptyResult = await service.processRecord(emptyRecord);
      expect(emptyResult.success).toBe(true);

      // Providing valid option
      const validRecord: Record = {
        type: 'comm-project',
        data: {
          Direction: 'OT',
        },
      };
      const validResult = await service.processRecord(validRecord);
      expect(validResult.success).toBe(true);

      // Providing invalid option
      const invalidRecord = {
        type: 'comm-project',
        data: {
          Direction: 'UNKNOWN',
        },
      };
      const invalidResult = await service.processRecord(invalidRecord);
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        expect(invalidResult.errors.some((err) => err.includes('/Direction:'))).toBe(true);
      }
    });

    it('rejects inputs when lookup field options source is missing or empty', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              {
                key: 'Category',
                name: 'Category',
                type: 'string',
                required: true,
                options: {
                  source: 'MissingSource',
                  key: 'Key',
                  name: 'Name',
                },
              },
            ],
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const recordWithMissingSourceVal = {
        type: 'comm-project',
        data: {
          Category: 'AnyValue',
        },
      };
      const result = await service.processRecord(recordWithMissingSourceVal);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('/Category:'))).toBe(true);
      }
    });

    it('accepts arbitrary string inputs when lookup field has allowUserInput: true (combo-box)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              {
                key: 'Direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'Direction',
                  key: 'Key',
                  name: 'Name',
                  allowUserInput: true,
                },
              },
            ],
            options: {
              Direction: [
                { Key: 'IN', Name: 'Incoming' },
                { Key: 'OT', Name: 'Outgoing' },
              ],
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      // Accepts standard option from list
      const optionRecord: Record = {
        type: 'comm-project',
        data: {
          Direction: 'IN',
        },
      };
      const optionResult = await service.processRecord(optionRecord);
      expect(optionResult.success).toBe(true);

      // Accepts arbitrary custom text string outside option list
      const customRecord: Record = {
        type: 'comm-project',
        data: {
          Direction: 'Custom External Message',
        },
      };
      const customResult = await service.processRecord(customRecord);
      expect(customResult.success).toBe(true);
      if (customResult.success) {
        expect(customResult.data.data).toEqual({ Direction: 'Custom External Message' });
      }
      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
    });

    it('rejects non-string input when allowUserInput: true', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              {
                key: 'Direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'Direction',
                  key: 'Key',
                  name: 'Name',
                  allowUserInput: true,
                },
              },
            ],
            options: {
              Direction: [
                { Key: 'IN', Name: 'Incoming' },
                { Key: 'OT', Name: 'Outgoing' },
              ],
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const invalidTypeRecord = {
        type: 'comm-project',
        data: {
          Direction: 12345,
        },
      };
      const result = await service.processRecord(invalidTypeRecord);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('/Direction:'))).toBe(true);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('passes allowUserInput flag through FormSchema in getForms()', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn(),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              {
                key: 'Direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'Direction',
                  key: 'Key',
                  name: 'Name',
                  allowUserInput: true,
                },
              },
              {
                key: 'Category',
                name: 'Category',
                type: 'string',
                required: false,
                options: {
                  source: 'Category',
                  key: 'Key',
                  name: 'Name',
                },
              },
            ],
            options: {
              Direction: [{ Key: 'IN', Name: 'Incoming' }],
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };
      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const forms = await service.getForms();
      expect(forms).toHaveLength(1);
      expect(forms[0].recordSchema.fields[0].options?.allowUserInput).toBe(true);
      expect(forms[0].recordSchema.fields[1].options?.allowUserInput).toBeUndefined();
      expect(Value.Check(FormSchemaType, forms[0])).toBe(true);
    });
  });
});





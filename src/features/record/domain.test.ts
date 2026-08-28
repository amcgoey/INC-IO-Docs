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
  WorkflowType,
  RecordWorkflowConfigType,
  StorageContextConfigType,
  FormSchemaType,
  ActivityType,
  ActivityOutputType,
  FileLocatorType,
  formatValidationErrors,
  type Activity,
  type ActivityOutput,
  type FileLocator,
  type Record,
  type RecordType,
  type FormSchema,
  type StorageContextConfig,
} from './domain';
import type { ActivityDispatcherPort, ManifestRegistryPort, TemplateEvaluationContext, TemplateEvaluatorPort } from './ports';
import { StructuredLogActivity } from './adapters/structured-log-activity';



describe('Record domain', () => {
  const mockRegistry: ManifestRegistryPort = {
    loadAll: vi.fn().mockResolvedValue([]),
  };

  const defaultEvaluator: TemplateEvaluatorPort = {
    validate: vi.fn().mockReturnValue(true),
    evaluate: vi.fn().mockImplementation((template: string) => template),
  };

  it('should export RecordModel schema', () => {
    expect(RecordModel).toBeDefined();
  });

  it('should export ActivityType schema', () => {
    expect(ActivityType).toBeDefined();
  });

  it('should export FileLocatorType schema and validate valid and invalid file locators', () => {
    expect(FileLocatorType).toBeDefined();

    const fullFileLocator: FileLocator = {
      id: 'file-123',
      name: 'Report.pdf',
      parentName: 'DestinationFolder',
      mimeType: 'application/pdf',
      uri: 'https://drive.google.com/file/d/file-123/view',
    };
    expect(Value.Check(FileLocatorType, fullFileLocator)).toBe(true);

    const minimalFileLocator: FileLocator = {
      id: 'file-456',
      name: 'Summary.docx',
    };
    expect(Value.Check(FileLocatorType, minimalFileLocator)).toBe(true);

    const missingId = {
      name: 'Summary.docx',
    };
    expect(Value.Check(FileLocatorType, missingId)).toBe(false);

    const missingName = {
      id: 'file-456',
    };
    expect(Value.Check(FileLocatorType, missingName)).toBe(false);

    const invalidUriType = {
      id: 'file-456',
      name: 'Summary.docx',
      uri: 12345,
    };
    expect(Value.Check(FileLocatorType, invalidUriType)).toBe(false);
  });

  it('should export ActivityOutputType schema and validate valid and invalid outputs', () => {
    expect(ActivityOutputType).toBeDefined();
    const validOutput: ActivityOutput = {
      success: true,
      recordDataPatch: { newField: 'value' },
      contextVariables: { stepResult: 'success' },
      files: [
        {
          id: 'file-1',
          name: 'Doc.pdf',
          parentName: 'FolderA',
          mimeType: 'application/pdf',
          uri: 'https://drive.google.com/file/d/file-1/view',
        },
      ],
    };
    expect(Value.Check(ActivityOutputType, validOutput)).toBe(true);

    const emptyOutput: ActivityOutput = {};
    expect(Value.Check(ActivityOutputType, emptyOutput)).toBe(true);

    const invalidOutput = {
      success: 'not-a-boolean',
    };
    expect(Value.Check(ActivityOutputType, invalidOutput)).toBe(false);

    const invalidPatch = {
      recordDataPatch: 'not-an-object',
    };
    expect(Value.Check(ActivityOutputType, invalidPatch)).toBe(false);

    const invalidFiles = {
      files: [{ id: 'file-1' }], // missing name
    };
    expect(Value.Check(ActivityOutputType, invalidFiles)).toBe(false);
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
              key: 'title',
              name: 'Title',
              type: 'string',
              required: true,
            },
            {
              key: 'notes',
              name: 'Notes',
              type: 'string',
              required: false,
            },
          ],
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SubmitSubmittalWorkflow',
            },
          },
        },
        recordWorkflowConfig: {
          workflows: [
            {
              name: 'SubmitSubmittalWorkflow',
              activitySequence: [
                {
                  type: 'LOG_RECORD',
                  payload: { record: { title: 'Foundation Plan' } },
                },
              ],
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
        title: 'Foundation Plan',
      },
    };

    const result = await service.processRecord(validRecord, 'onSubmit');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validRecord);
      expect(result.activities).toEqual([
        {
          type: 'LOG_RECORD',
          payload: { record: { title: 'Foundation Plan' } },
        },
      ]);
    }

    expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
      type: 'LOG_RECORD',
      payload: { record: { title: 'Foundation Plan' } },
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
              key: 'title',
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
      data: { title: 'Test' },
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
              key: 'invalidField',
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
            key: 'title',
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
      source: 'direction',
      key: 'key',
      name: 'name',
    };
    expect(Value.Check(RecordFieldOptionType, validOption)).toBe(true);

    const missingSource = {
      key: 'key',
      name: 'name',
    };
    expect(Value.Check(RecordFieldOptionType, missingSource)).toBe(false);

    const missingKey = {
      source: 'direction',
      name: 'name',
    };
    expect(Value.Check(RecordFieldOptionType, missingKey)).toBe(false);

    const missingName = {
      source: 'direction',
      key: 'key',
    };
    expect(Value.Check(RecordFieldOptionType, missingName)).toBe(false);
  });

  it('RecordFieldOptionType accepts optional allowUserInput boolean', () => {
    const optionWithAllowUserInputTrue = {
      source: 'direction',
      key: 'key',
      name: 'name',
      allowUserInput: true,
    };
    expect(Value.Check(RecordFieldOptionType, optionWithAllowUserInputTrue)).toBe(true);

    const optionWithAllowUserInputFalse = {
      source: 'direction',
      key: 'key',
      name: 'name',
      allowUserInput: false,
    };
    expect(Value.Check(RecordFieldOptionType, optionWithAllowUserInputFalse)).toBe(true);

    const optionWithInvalidAllowUserInput = {
      source: 'direction',
      key: 'key',
      name: 'name',
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
            key: 'title',
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
        workflows: [{ name: 'SubmitSubmittal' }],
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
            key: 'title',
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
              key: 'subject',
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
              key: 'name',
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
              key: 'subject',
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
              key: 'name',
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
      const validTuple = { key: 'IN', name: 'Incoming', extra: 123 };
      expect(Value.Check(RecordSchemaOptionTupleType, validTuple)).toBe(true);

      const invalidTuple = 'not-an-object';
      expect(Value.Check(RecordSchemaOptionTupleType, invalidTuple)).toBe(false);
    });

    it('validates RecordSchemaType.options as optional Record<string, RecordSchemaOptionTupleType[]>', () => {
      const validSchemaWithOptions = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        options: {
          direction: [
            { key: 'IN', name: 'Incoming' },
            { key: 'OT', name: 'Outgoing' },
          ],
        },
      };
      expect(Value.Check(RecordSchemaType, validSchemaWithOptions)).toBe(true);

      const invalidSchemaWithOptions = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        options: {
          direction: 'invalid-not-array',
        },
      };
      expect(Value.Check(RecordSchemaType, invalidSchemaWithOptions)).toBe(false);
    });
  });

  describe('RecordIdentitySchemaType', () => {
    it('validates id, idRecord, and idGroup keys with extensible string properties', () => {
      expect(RecordIdentitySchemaType).toBeDefined();

      const validIdentity = {
        id: '{{key}}',
        idRecord: '{{key}}-{{date}}',
        idGroup: '{{contact}}',
        customProperty: 'custom-value',
      };
      expect(Value.Check(RecordIdentitySchemaType, validIdentity)).toBe(true);

      const validPartialIdentity = {
        id: '{{key}}',
      };
      expect(Value.Check(RecordIdentitySchemaType, validPartialIdentity)).toBe(true);

      const emptyIdentity = {};
      expect(Value.Check(RecordIdentitySchemaType, emptyIdentity)).toBe(true);

      const invalidNonStringValue = {
        id: 123,
      };
      expect(Value.Check(RecordIdentitySchemaType, invalidNonStringValue)).toBe(false);

      const invalidNonStringExtensibleValue = {
        id: '{{key}}',
        customField: 999,
      };
      expect(Value.Check(RecordIdentitySchemaType, invalidNonStringExtensibleValue)).toBe(false);
    });

    it('validates RecordSchemaType.identity with RecordIdentitySchemaType', () => {
      const schemaWithIdentity = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        identity: {
          id: '{{key}}',
          idRecord: '{{key}}-{{date}}',
          idGroup: '{{contact}}',
        },
      };
      expect(Value.Check(RecordSchemaType, schemaWithIdentity)).toBe(true);

      const schemaWithInvalidIdentity = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        identity: {
          id: 123,
        },
      };
      expect(Value.Check(RecordSchemaType, schemaWithInvalidIdentity)).toBe(false);
    });
  });

  describe('UiEventRuleType.matchFields', () => {
    it('accepts optional matchFields as Record<string, string>', () => {
      const validRule = {
        matchFields: {
          direction: 'IN',
          status: 'Active',
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
          direction: 123,
        },
        workflow: 'HandleIncoming',
      };
      expect(Value.Check(UiEventRuleType, invalidRule)).toBe(false);
    });
  });

  describe('RecordFieldType.defaultValue', () => {
    it('accepts optional defaultValue as string', () => {
      const fieldWithDefault = {
        key: 'status',
        name: 'Status',
        type: 'string',
        required: false,
        defaultValue: 'Draft',
      };
      expect(Value.Check(RecordFieldType, fieldWithDefault)).toBe(true);

      const fieldWithoutDefault = {
        key: 'status',
        name: 'Status',
        type: 'string',
        required: false,
      };
      expect(Value.Check(RecordFieldType, fieldWithoutDefault)).toBe(true);
    });

    it('rejects non-string defaultValue', () => {
      const invalidField = {
        key: 'status',
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
        key: 'description',
        name: 'Description',
        type: 'string',
      };
      expect(Value.Check(RecordFieldType, fieldWithoutRequired)).toBe(true);
    });

    it('accepts boolean required property when provided', () => {
      const fieldWithRequiredTrue = {
        key: 'title',
        name: 'Title',
        type: 'string',
        required: true,
      };
      expect(Value.Check(RecordFieldType, fieldWithRequiredTrue)).toBe(true);

      const fieldWithRequiredFalse = {
        key: 'notes',
        name: 'Notes',
        type: 'string',
        required: false,
      };
      expect(Value.Check(RecordFieldType, fieldWithRequiredFalse)).toBe(true);
    });

    it('rejects non-boolean required property', () => {
      const fieldWithInvalidRequired = {
        key: 'title',
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
      const validRecord = { id: 'rec-1', type: 'submittal', data: { subject: 'Submittal 1' } };
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
        key: 'summary',
        template: '{{title}} - {{notes}}',
        description: 'Auto-generated summary',
      };
      expect(Value.Check(CalculatedFieldType, validCalcField)).toBe(true);

      const validWithoutDesc = {
        key: 'summary',
        template: '{{title}} - {{notes}}',
      };
      expect(Value.Check(CalculatedFieldType, validWithoutDesc)).toBe(true);

      const missingTemplate = {
        key: 'summary',
      };
      expect(Value.Check(CalculatedFieldType, missingTemplate)).toBe(false);

      const missingKey = {
        template: '{{title}}',
      };
      expect(Value.Check(CalculatedFieldType, missingKey)).toBe(false);
    });

    it('exports SystemContextSchema stub', () => {
      expect(SystemContextSchema).toBeDefined();
      expect(Value.Check(SystemContextSchema, {})).toBe(true);
    });

    it('validates RecordSchemaType with optional calculatedFields', () => {
      const schemaWithCalcFields = {
        fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        calculatedFields: [
          {
            key: 'fullTitle',
            template: 'PREFIX-{{title}}',
          },
        ],
      };
      expect(Value.Check(RecordSchemaType, schemaWithCalcFields)).toBe(true);

      const schemaWithInvalidCalcFields = {
        fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        calculatedFields: [
          {
            key: 'fullTitle',
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
              { key: 'contact', name: 'Contact', type: 'string', required: true },
              { key: 'date', name: 'Date', type: 'string', required: true },
            ],
            calculatedFields: [
              {
                key: 'testCalculatedField',
                template: '{{date}}-{{contact}}',
              },
            ],
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'HandleCommWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'HandleCommWorkflow',
                activitySequence: [
                  {
                    type: 'LOG_RECORD',
                    payload: { status: 'calculated' },
                  },
                ],
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
          if (template === '{{date}}-{{contact}}') {
            return `${ctx.date}-${ctx.contact}`;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Alice',
          date: '260825',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({
          contact: 'Alice',
          date: '260825',
          testCalculatedField: '260825-Alice',
        });
        expect(result.activities).toEqual([
          {
            type: 'LOG_RECORD',
            payload: { status: 'calculated' },
          },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
        payload: { status: 'calculated' },
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
              { key: 'base1', name: 'Base 1', type: 'string', required: true },
            ],
            calculatedFields: [
              { key: 'calc1', template: '{{base1}}-CALC1' },
              { key: 'calc2', template: '{{calc1}}-CALC2' },
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
        data: { base1: 'val1' },
      });

      expect(evaluatedContexts).toHaveLength(2);
      // Both evaluations must receive ONLY base payload without Calc1
      expect(evaluatedContexts[0]).toEqual({ base1: 'val1' });
      expect(evaluatedContexts[1]).toEqual({ base1: 'val1' });
      expect(evaluatedContexts[1]).not.toHaveProperty('calc1');
    });
  });

  describe('RecordService identity evaluation', () => {
    it('evaluates identity templates (id, idRecord, idGroup) and populates record before activity dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              { key: 'contact', name: 'Contact', type: 'string', required: true },
              { key: 'date', name: 'Date', type: 'string', required: true },
              { key: 'direction', name: 'Direction', type: 'string', required: true },
              { key: 'description', name: 'Description', type: 'string', required: true },
            ],
            identity: {
              id: '{{contact}}-{{date}}-{{direction}}-{{description}}',
              idRecord: '{{contact}}-{{date}}-{{direction}}-{{description}}',
              idGroup: '{{contact}}',
            },
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'IdentityWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'IdentityWorkflow',
                activitySequence: [
                  {
                    type: 'LOG_RECORD',
                    payload: { status: 'identified' },
                  },
                ],
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
          if (template === '{{contact}}-{{date}}-{{direction}}-{{description}}') {
            return `${ctx.contact}-${ctx.date}-${ctx.direction}-${ctx.description}`;
          }
          if (template === '{{contact}}') {
            return `${ctx.contact}`;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Alice',
          date: '260825',
          direction: 'IN',
          description: 'Project discussion',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('Alice-260825-IN-Project discussion');
        expect(result.data.idRecord).toBe('Alice-260825-IN-Project discussion');
        expect(result.data.idGroup).toBe('Alice');
        expect(result.data.data).toEqual({
          contact: 'Alice',
          date: '260825',
          direction: 'IN',
          description: 'Project discussion',
        });
        expect(result.activities).toEqual([
          {
            type: 'LOG_RECORD',
            payload: { status: 'identified' },
          },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
        payload: { status: 'identified' },
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
              { key: 'contact', name: 'Contact', type: 'string', required: true },
            ],
            calculatedFields: [
              { key: 'derivedField', template: '{{contact}}-DERIVED' },
            ],
            identity: {
              id: '{{contact}}-ID',
              idRecord: '{{derivedField}}-RECORD',
              idGroup: '{{id}}-GROUP',
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
        data: { contact: 'Bob' },
      });

      // Total evaluations: 1 calculated field + 3 identity templates = 4
      expect(evaluatedContexts).toHaveLength(4);

      // All evaluations must only see basePayload { contact: 'Bob' }
      for (const item of evaluatedContexts) {
        expect(item.ctx).toEqual({ contact: 'Bob' });
        expect(item.ctx).not.toHaveProperty('derivedField');
        expect(item.ctx).not.toHaveProperty('id');
        expect(item.ctx).not.toHaveProperty('idRecord');
        expect(item.ctx).not.toHaveProperty('idGroup');
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
                key: 'direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'direction',
                  key: 'key',
                  name: 'name',
                },
              },
            ],
            options: {
              direction: [
                { key: 'IN', name: 'Incoming' },
                { key: 'OT', name: 'Outgoing' },
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
          direction: 'IN',
        },
      };

      const result = await service.processRecord(validRecord);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({ direction: { key: 'IN', name: 'Incoming' } });
        expect(result.activities).toEqual([]);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
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
                key: 'direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'direction',
                  key: 'key',
                  name: 'name',
                },
              },
            ],
            options: {
              direction: [
                { key: 'IN', name: 'Incoming' },
                { key: 'OT', name: 'Outgoing' },
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
          direction: 'INVALID_DIR',
        },
      };

      const result = await service.processRecord(invalidRecord);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some((err) => err.includes('/direction:'))).toBe(true);
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
                key: 'direction',
                name: 'Direction',
                type: 'string',
                required: false,
                options: {
                  source: 'direction',
                  key: 'key',
                  name: 'name',
                },
              },
            ],
            options: {
              direction: [
                { key: 'IN', name: 'Incoming' },
                { key: 'OT', name: 'Outgoing' },
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
      if (emptyResult.success) {
        expect(emptyResult.data.data).toEqual({});
      }

      // Providing valid option
      const validRecord: Record = {
        type: 'comm-project',
        data: {
          direction: 'OT',
        },
      };
      const validResult = await service.processRecord(validRecord);
      expect(validResult.success).toBe(true);
      if (validResult.success) {
        expect(validResult.data.data).toEqual({ direction: { key: 'OT', name: 'Outgoing' } });
      }

      // Providing invalid option
      const invalidRecord = {
        type: 'comm-project',
        data: {
          direction: 'UNKNOWN',
        },
      };
      const invalidResult = await service.processRecord(invalidRecord);
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        expect(invalidResult.errors.some((err) => err.includes('/direction:'))).toBe(true);
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
                key: 'category',
                name: 'Category',
                type: 'string',
                required: true,
                options: {
                  source: 'missingSource',
                  key: 'key',
                  name: 'name',
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
          category: 'AnyValue',
        },
      };
      const result = await service.processRecord(recordWithMissingSourceVal);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('/category:'))).toBe(true);
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
                key: 'direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'direction',
                  key: 'key',
                  name: 'name',
                  allowUserInput: true,
                },
              },
            ],
            options: {
              direction: [
                { key: 'IN', name: 'Incoming' },
                { key: 'OT', name: 'Outgoing' },
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

      // Accepts standard option from list and enriches to matched tuple
      const optionRecord: Record = {
        type: 'comm-project',
        data: {
          direction: 'IN',
        },
      };
      const optionResult = await service.processRecord(optionRecord);
      expect(optionResult.success).toBe(true);
      if (optionResult.success) {
        expect(optionResult.data.data).toEqual({ direction: { key: 'IN', name: 'Incoming' } });
        expect(optionResult.activities).toEqual([]);
      }

      // Accepts arbitrary custom text string outside option list and synthesizes fallback tuple
      const customRecord: Record = {
        type: 'comm-project',
        data: {
          direction: 'Custom External Message',
        },
      };
      const customResult = await service.processRecord(customRecord);
      expect(customResult.success).toBe(true);
      if (customResult.success) {
        expect(customResult.data.data).toEqual({
          direction: {
            key: 'Custom External Message',
            name: 'Custom External Message',
          },
        });
        expect(customResult.activities).toEqual([]);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
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
                key: 'direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'direction',
                  key: 'key',
                  name: 'name',
                  allowUserInput: true,
                },
              },
            ],
            options: {
              direction: [
                { key: 'IN', name: 'Incoming' },
                { key: 'OT', name: 'Outgoing' },
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
          direction: 12345,
        },
      };
      const result = await service.processRecord(invalidTypeRecord);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('/direction:'))).toBe(true);
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
                key: 'direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'direction',
                  key: 'key',
                  name: 'name',
                  allowUserInput: true,
                },
              },
              {
                key: 'category',
                name: 'Category',
                type: 'string',
                required: false,
                options: {
                  source: 'category',
                  key: 'key',
                  name: 'name',
                },
              },
            ],
            options: {
              direction: [{ key: 'IN', name: 'Incoming' }],
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

    it('enriches primitive string with entire source tuple including auxiliary properties before activity dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'submittal',
          name: 'Submittal Record',
          recordSchema: {
            fields: [
              { key: 'title', name: 'Title', type: 'string', required: true },
              {
                key: 'status',
                name: 'Status',
                type: 'string',
                required: true,
                options: {
                  source: 'statuses',
                  key: 'code',
                  name: 'label',
                },
              },
            ],
            options: {
              statuses: [
                {
                  code: 'APP',
                  label: 'Approved',
                  description: 'Fully approved without exceptions',
                  color: '#00FF00',
                  requiresSignature: true,
                },
                {
                  code: 'REJ',
                  label: 'Rejected',
                  description: 'Rejected by structural engineer',
                  color: '#FF0000',
                  requiresSignature: false,
                },
              ],
            },
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'SubmitWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'SubmitWorkflow',
                activitySequence: [
                  {
                    type: 'LOG_RECORD',
                    payload: { status: 'submittal_filed' },
                  },
                ],
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

      const inputRecord: Record = {
        id: 'rec-sub-1',
        type: 'submittal',
        data: {
          title: 'Foundation Plan Review',
          status: 'APP',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({
          title: 'Foundation Plan Review',
          status: {
            code: 'APP',
            label: 'Approved',
            description: 'Fully approved without exceptions',
            color: '#00FF00',
            requiresSignature: true,
          },
        });

        expect(result.activities).toEqual([
          {
            type: 'LOG_RECORD',
            payload: { status: 'submittal_filed' },
          },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_RECORD',
        payload: { status: 'submittal_filed' },
      });
    });

    it('synthesizes fallback tuple for combo-boxes mapping custom string to schema key and name', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'vendor-record',
          name: 'Vendor Record',
          recordSchema: {
            fields: [
              {
                key: 'supplierType',
                name: 'Supplier Type',
                type: 'string',
                required: true,
                options: {
                  source: 'supplierTypes',
                  key: 'typeCode',
                  name: 'typeDisplayName',
                  allowUserInput: true,
                },
              },
            ],
            options: {
              supplierTypes: [
                { typeCode: 'CON', typeDisplayName: 'Concrete Subcontractor' },
                { typeCode: 'STL', typeDisplayName: 'Steel Fabricator' },
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

      const inputRecord: Record = {
        type: 'vendor-record',
        data: {
          supplierType: 'Custom Acoustic Consultant',
        },
      };

      const result = await service.processRecord(inputRecord);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({
          supplierType: {
            typeCode: 'Custom Acoustic Consultant',
            typeDisplayName: 'Custom Acoustic Consultant',
          },
        });
      }
    });

    it('passes enriched tuple context seamlessly to Handlebars evaluator for calculatedFields and identity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockRecordTypes: RecordType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          recordSchema: {
            fields: [
              { key: 'contact', name: 'Contact', type: 'string', required: true },
              { key: 'date', name: 'Date', type: 'string', required: true },
              {
                key: 'direction',
                name: 'Direction',
                type: 'string',
                required: true,
                options: {
                  source: 'direction',
                  key: 'key',
                  name: 'name',
                },
              },
              {
                key: 'deliveryMethod',
                name: 'Delivery Method',
                type: 'string',
                required: true,
                options: {
                  source: 'deliveryMethods',
                  key: 'code',
                  name: 'title',
                  allowUserInput: true,
                },
              },
            ],
            calculatedFields: [
              {
                key: 'fullSummary',
                template: '{{direction.name}} from {{contact}} via {{deliveryMethod.title}}',
              },
            ],
            identity: {
              id: '{{contact}}-{{date}}-{{direction.key}}-{{deliveryMethod.code}}',
              idRecord: '{{contact}}-{{date}}-{{direction.key}}-{{deliveryMethod.code}}',
              idGroup: '{{contact}}',
            },
            options: {
              direction: [
                { key: 'IN', name: 'Incoming' },
                { key: 'OT', name: 'Outgoing' },
              ],
              deliveryMethods: [
                { code: 'EML', title: 'Email Delivery' },
                { code: 'FED', title: 'FedEx Courier' },
              ],
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
          evaluatedContexts.push({ template, ctx: JSON.parse(JSON.stringify(ctx)) });
          if (template === '{{direction.name}} from {{contact}} via {{deliveryMethod.title}}') {
            const dir = ctx.direction as { name: string };
            const del = ctx.deliveryMethod as { title: string };
            return `${dir.name} from ${ctx.contact} via ${del.title}`;
          }
          if (template === '{{contact}}-{{date}}-{{direction.key}}-{{deliveryMethod.code}}') {
            const dir = ctx.direction as { key: string };
            const del = ctx.deliveryMethod as { code: string };
            return `${ctx.contact}-${ctx.date}-${dir.key}-${del.code}`;
          }
          if (template === '{{contact}}') {
            return `${ctx.contact}`;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      // Test with matched direction tuple and synthesized deliveryMethod fallback tuple
      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Alice',
          date: '260825',
          direction: 'IN',
          deliveryMethod: 'Hand Carried Drone', // arbitrary combo-box input
        },
      };

      const result = await service.processRecord(inputRecord);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('Alice-260825-IN-Hand Carried Drone');
        expect(result.data.idRecord).toBe('Alice-260825-IN-Hand Carried Drone');
        expect(result.data.idGroup).toBe('Alice');
        expect(result.data.data).toEqual({
          contact: 'Alice',
          date: '260825',
          direction: {
            key: 'IN',
            name: 'Incoming',
          },
          deliveryMethod: {
            code: 'Hand Carried Drone',
            title: 'Hand Carried Drone',
          },
          fullSummary: 'Incoming from Alice via Hand Carried Drone',
        });
      }

      // Verify that all Handlebars evaluation calls received the enriched tuple objects in context
      for (const call of evaluatedContexts) {
        expect(call.ctx.direction).toEqual({ key: 'IN', name: 'Incoming' });
        expect(call.ctx.deliveryMethod).toEqual({
          code: 'Hand Carried Drone',
          title: 'Hand Carried Drone',
        });
      }
    });
  });

  describe('RecordWorkflowConfig and WorkflowType validation', () => {
    it('validates WorkflowType with name and optional activitySequence', () => {
      const validWorkflow = {
        name: 'ProcessSubmission',
        activitySequence: [
          {
            type: 'LOG_RECORD',
            payload: { key: 'value' },
          },
        ],
      };
      expect(Value.Check(WorkflowType, validWorkflow)).toBe(true);

      const workflowWithoutActivities = {
        name: 'EmptyWorkflow',
      };
      expect(Value.Check(WorkflowType, workflowWithoutActivities)).toBe(true);

      const invalidWorkflow = {
        // missing name
        activitySequence: [],
      };
      expect(Value.Check(WorkflowType, invalidWorkflow)).toBe(false);
    });

    it('validates RecordWorkflowConfigType with workflows array', () => {
      const validConfig = {
        workflows: [
          { name: 'Workflow1' },
          { name: 'Workflow2', activitySequence: [] },
        ],
      };
      expect(Value.Check(RecordWorkflowConfigType, validConfig)).toBe(true);

      const invalidConfig = {
        workflows: 'not-an-array',
      };
      expect(Value.Check(RecordWorkflowConfigType, invalidConfig)).toBe(false);
    });
  });

  describe('RecordService Event Routing & Workflow Dispatch', () => {
    const mockWorkflowRecordType: RecordType = {
      key: 'comm-project',
      name: 'Communication Project',
      recordSchema: {
        fields: [
          { key: 'contact', name: 'Contact', type: 'string', required: true },
          { key: 'date', name: 'Date', type: 'string', required: true },
          {
            key: 'direction',
            name: 'Direction',
            type: 'string',
            required: true,
            options: {
              source: 'direction',
              key: 'key',
              name: 'name',
            },
          },
          { key: 'description', name: 'Description', type: 'string', required: true },
        ],
        calculatedFields: [
          {
            key: 'testCalculatedField',
            template: '{{date}}-{{direction.key}}-{{contact}}-{{description}}',
          },
        ],
        identity: {
          id: '{{contact}}-{{date}}-{{direction.key}}-{{description}}',
          idRecord: '{{contact}}-{{date}}-{{direction.key}}-{{description}}',
          idGroup: '{{contact}}',
        },
        options: {
          direction: [
            { key: 'IN', name: 'Incoming' },
            { key: 'OT', name: 'Outgoing' },
          ],
        },
      },
      recordUiConfig: {
        events: {
          onSubmit: {
            rules: [
              {
                matchFields: {
                  direction: 'IN',
                },
                workflow: 'IncomingWorkflow',
              },
              {
                matchFields: {
                  direction: 'OT',
                  contact: '_Client - AAA',
                },
                workflow: 'ClientOutgoingWorkflow',
              },
            ],
            catchAllWorkflow: 'GeneralCommWorkflow',
          },
          onNoMatchEvent: {
            rules: [
              {
                matchFields: {
                  direction: 'NON_EXISTENT',
                },
                workflow: 'NeverMatchesWorkflow',
              },
            ],
          },
          onMissingWorkflowEvent: {
            catchAllWorkflow: 'NonExistentWorkflow',
          },
        },
      },
      recordWorkflowConfig: {
        workflows: [
          {
            name: 'IncomingWorkflow',
            activitySequence: [
              {
                type: 'LOG_RECORD',
                payload: { step: 1, action: 'log_incoming' },
              },
              {
                type: 'NOTIFY_TEAM',
                payload: { step: 2, channel: 'inbound-docs' },
              },
            ],
          },
          {
            name: 'ClientOutgoingWorkflow',
            activitySequence: [
              {
                type: 'CLIENT_ACTIVITY',
                payload: { step: 1, target: 'client' },
              },
            ],
          },
          {
            name: 'GeneralCommWorkflow',
            activitySequence: [
              {
                type: 'GENERAL_ACTIVITY',
                payload: { action: 'general' },
              },
            ],
          },
        ],
      },
    };

    const mockEvaluator: TemplateEvaluatorPort = {
      validate: vi.fn().mockReturnValue(true),
      evaluate: vi.fn().mockImplementation((template, ctx) => {
        if (template === '{{date}}-{{direction.key}}-{{contact}}-{{description}}') {
          const dir = ctx.direction as { key: string };
          return `${ctx.date}-${dir.key}-${ctx.contact}-${ctx.description}`;
        }
        if (template === '{{contact}}-{{date}}-{{direction.key}}-{{description}}') {
          const dir = ctx.direction as { key: string };
          return `${ctx.contact}-${ctx.date}-${dir.key}-${ctx.description}`;
        }
        if (template === '{{contact}}') {
          return `${ctx.contact}`;
        }
        return template;
      }),
    };

    it('matches first event rule against enriched lookup tuple and dispatches activity sequence', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([mockWorkflowRecordType]),
      };
      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'IN',
          description: 'Inbound message',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.activities).toHaveLength(2);
        expect(result.activities).toEqual([
          { type: 'LOG_RECORD', payload: { step: 1, action: 'log_incoming' } },
          { type: 'NOTIFY_TEAM', payload: { step: 2, channel: 'inbound-docs' } },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(1, {
        type: 'LOG_RECORD',
        payload: { step: 1, action: 'log_incoming' },
      });
      expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(2, {
        type: 'NOTIFY_TEAM',
        payload: { step: 2, channel: 'inbound-docs' },
      });
    });

    it('matches multi-field rule (contact + direction) and dispatches activity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([mockWorkflowRecordType]),
      };
      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: '_Client - AAA',
          date: '260826',
          direction: 'OT',
          description: 'ASR 06 Design Changes',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.activities).toEqual([
          { type: 'CLIENT_ACTIVITY', payload: { step: 1, target: 'client' } },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'CLIENT_ACTIVITY',
        payload: { step: 1, target: 'client' },
      });
    });

    it('falls back to catchAllWorkflow when no rules match', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([mockWorkflowRecordType]),
      };
      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Other Contractor',
          date: '260826',
          direction: 'OT',
          description: 'Outbound to other contractor',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.activities).toEqual([
          { type: 'GENERAL_ACTIVITY', payload: { action: 'general' } },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'GENERAL_ACTIVITY',
        payload: { action: 'general' },
      });
    });

    it('returns success with activities: [] when no rules match and no catch-all exists', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([mockWorkflowRecordType]),
      };
      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Anyone',
          date: '260826',
          direction: 'OT',
          description: 'Testing no match event',
        },
      };

      const result = await service.processRecord(inputRecord, 'onNoMatchEvent');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.activities).toEqual([]);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('returns success with activities: [] when eventName is omitted or not found in config', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([mockWorkflowRecordType]),
      };
      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'IN',
          description: 'Inbound message',
        },
      };

      // When eventName is undefined
      const resultNoEvent = await service.processRecord(inputRecord);
      expect(resultNoEvent.success).toBe(true);
      if (resultNoEvent.success) {
        expect(resultNoEvent.activities).toEqual([]);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

      // When eventName does not exist
      const resultUnknownEvent = await service.processRecord(inputRecord, 'onNonExistentEvent');
      expect(resultUnknownEvent.success).toBe(true);
      if (resultUnknownEvent.success) {
        expect(resultUnknownEvent.activities).toEqual([]);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('throws runtime error when matched workflow is missing from configuration', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([mockWorkflowRecordType]),
      };
      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'IN',
          description: 'Test message',
        },
      };

      await expect(service.processRecord(inputRecord, 'onMissingWorkflowEvent')).rejects.toThrow(
        /Workflow 'NonExistentWorkflow' not found in configuration for RecordType 'comm-project'/
      );
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('Activity payload Handlebars template resolution', () => {
    it('evaluates activity payload template strings using TemplateEvaluatorPort with context { Record, RecordSchema } before dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const recordTypeWithTemplates: RecordType = {
        key: 'comm-project',
        name: 'Communication Project',
        recordSchema: {
          fields: [
            { key: 'contact', name: 'Contact Person', type: 'string', required: true },
            { key: 'subject', name: 'Subject', type: 'string', required: true },
          ],
          calculatedFields: [
            { key: 'fullSubject', template: 'PROJ-{{subject}}' },
          ],
          identity: {
            id: 'REC-{{contact}}',
          },
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'DispatchActivityWorkflow',
            },
          },
        },
        recordWorkflowConfig: {
          workflows: [
            {
              name: 'DispatchActivityWorkflow',
              activitySequence: [
                {
                  type: 'NOTIFY_CLIENT',
                  payload: {
                    recipient: '{{Record.data.contact}}',
                    recordId: '{{Record.id}}',
                    subject: '{{Record.data.fullSubject}}',
                    schemaField: '{{RecordSchema.fields.[0].name}}',
                    staticNumber: 42,
                    staticBoolean: true,
                    nested: {
                      message: 'Hello {{Record.data.contact}}',
                      tags: ['tag-{{Record.data.contact}}', 'constant-tag'],
                    },
                  },
                },
              ],
            },
          ],
        },
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([recordTypeWithTemplates]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === 'PROJ-{{subject}}') {
            return `PROJ-${ctx.subject}`;
          }
          if (template === 'REC-{{contact}}') {
            return `REC-${ctx.contact}`;
          }
          if (template === '{{Record.data.contact}}') {
            const record = ctx.Record as Record;
            return record.data.contact as string;
          }
          if (template === '{{Record.id}}') {
            const record = ctx.Record as Record;
            return record.id as string;
          }
          if (template === '{{Record.data.fullSubject}}') {
            const record = ctx.Record as Record;
            return record.data.fullSubject as string;
          }
          if (template === '{{RecordSchema.fields.[0].name}}') {
            const schema = ctx.RecordSchema as RecordType['recordSchema'];
            return schema.fields[0].name;
          }
          if (template === 'Hello {{Record.data.contact}}') {
            const record = ctx.Record as Record;
            return `Hello ${record.data.contact}`;
          }
          if (template === 'tag-{{Record.data.contact}}') {
            const record = ctx.Record as Record;
            return `tag-${record.data.contact}`;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          subject: 'Review Meeting',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');

      expect(result.success).toBe(true);

      const expectedEnrichedRecord: Record = {
        type: 'comm-project',
        id: 'REC-Jane Doe',
        data: {
          contact: 'Jane Doe',
          subject: 'Review Meeting',
          fullSubject: 'PROJ-Review Meeting',
        },
      };

      const expectedResolvedPayload = {
        recipient: 'Jane Doe',
        recordId: 'REC-Jane Doe',
        subject: 'PROJ-Review Meeting',
        schemaField: 'Contact Person',
        staticNumber: 42,
        staticBoolean: true,
        nested: {
          message: 'Hello Jane Doe',
          tags: ['tag-Jane Doe', 'constant-tag'],
        },
      };

      const expectedActivity = {
        type: 'NOTIFY_CLIENT',
        payload: expectedResolvedPayload,
      };

      if (result.success) {
        expect(result.data).toEqual(expectedEnrichedRecord);
        expect(result.activities).toEqual([expectedActivity]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(expectedActivity);

      // Verify that mockEvaluator was called with the exact required context
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '{{Record.data.contact}}',
        expect.objectContaining({
          Record: expectedEnrichedRecord,
          RecordSchema: recordTypeWithTemplates.recordSchema,
        })
      );
    });
  });

  describe('Pre-evaluated Storage Context', () => {
    it('exports StorageContextConfigType and validates config object', () => {
      expect(StorageContextConfigType).toBeDefined();
      const validConfig: StorageContextConfig = {
        folder: '1Admin/Communication/{{Record.data.contact}}',
        root: 'Projects',
      };
      expect(Value.Check(StorageContextConfigType, validConfig)).toBe(true);
    });

    it('pre-evaluates storageContextConfig using { Record: enrichedRecord } and injects StorageContext into Activity evaluation context', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const recordTypeWithStorageContext: RecordType = {
        key: 'comm-project',
        name: 'Communication Project',
        recordSchema: {
          fields: [
            { key: 'contact', name: 'Contact Person', type: 'string', required: true },
            { key: 'date', name: 'Date', type: 'string', required: true },
            { key: 'direction', name: 'Direction', type: 'string', required: true },
            { key: 'description', name: 'Description', type: 'string', required: true },
          ],
          calculatedFields: [
            { key: 'summary', template: '{{date}} {{direction}} - {{description}}' },
          ],
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'StorageWorkflow',
            },
          },
        },
        storageContextConfig: {
          folder: '1Admin/Communication/{{Record.data.contact}}',
          subfolder: 'Archive/{{Record.data.direction}}',
        },
        recordWorkflowConfig: {
          workflows: [
            {
              name: 'StorageWorkflow',
              activitySequence: [
                {
                  type: 'CREATE_FILE',
                  payload: {
                    targetPath: '{{StorageContext.folder}}/{{Record.data.summary}}',
                    archivePath: '{{StorageContext.subfolder}}/{{Record.data.date}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([recordTypeWithStorageContext]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === '{{date}} {{direction}} - {{description}}') {
            return `${ctx.date} ${ctx.direction} - ${ctx.description}`;
          }
          if (template === '1Admin/Communication/{{Record.data.contact}}') {
            const record = ctx.Record as Record;
            return `1Admin/Communication/${record.data.contact}`;
          }
          if (template === 'Archive/{{Record.data.direction}}') {
            const record = ctx.Record as Record;
            return `Archive/${record.data.direction}`;
          }
          if (template === '{{StorageContext.folder}}/{{Record.data.summary}}') {
            const storageContext = ctx.StorageContext as { folder: string; subfolder: string };
            const record = ctx.Record as Record;
            return `${storageContext.folder}/${record.data.summary}`;
          }
          if (template === '{{StorageContext.subfolder}}/{{Record.data.date}}') {
            const storageContext = ctx.StorageContext as { folder: string; subfolder: string };
            const record = ctx.Record as Record;
            return `${storageContext.subfolder}/${record.data.date}`;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'comm-project',
        data: {
          contact: '_Client - AAA',
          date: '260826',
          direction: 'OT',
          description: 'ASR 06 Design Changes',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');

      expect(result.success).toBe(true);

      const expectedEnrichedRecord: Record = {
        type: 'comm-project',
        data: {
          contact: '_Client - AAA',
          date: '260826',
          direction: 'OT',
          description: 'ASR 06 Design Changes',
          summary: '260826 OT - ASR 06 Design Changes',
        },
      };

      const expectedStorageContext = {
        folder: '1Admin/Communication/_Client - AAA',
        subfolder: 'Archive/OT',
      };

      const expectedActivity: Activity = {
        type: 'CREATE_FILE',
        payload: {
          targetPath: '1Admin/Communication/_Client - AAA/260826 OT - ASR 06 Design Changes',
          archivePath: 'Archive/OT/260826',
        },
      };

      if (result.success) {
        expect(result.data).toEqual(expectedEnrichedRecord);
        expect(result.activities).toEqual([expectedActivity]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(expectedActivity);

      // Verify that storageContextConfig was pre-evaluated with { Record: enrichedRecord }
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '1Admin/Communication/{{Record.data.contact}}',
        { Record: expectedEnrichedRecord }
      );
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        'Archive/{{Record.data.direction}}',
        { Record: expectedEnrichedRecord }
      );

      // Verify that activity evaluation context received StorageContext
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '{{StorageContext.folder}}/{{Record.data.summary}}',
        expect.objectContaining({
          Record: expectedEnrichedRecord,
          RecordSchema: recordTypeWithStorageContext.recordSchema,
          StorageContext: expectedStorageContext,
        })
      );
    });

    it('pre-evaluates nested structures in storageContextConfig recursively against { Record: enrichedRecord }', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const recordTypeWithNestedStorage: RecordType = {
        key: 'project',
        name: 'Project',
        recordSchema: {
          fields: [
            { key: 'code', name: 'Code', type: 'string', required: true },
          ],
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'NestedStorageWorkflow',
            },
          },
        },
        storageContextConfig: {
          paths: {
            root: 'Projects/{{Record.data.code}}',
            subfolders: ['Drawings/{{Record.data.code}}', 'Specs'],
          },
        },
        recordWorkflowConfig: {
          workflows: [
            {
              name: 'NestedStorageWorkflow',
              activitySequence: [
                {
                  type: 'CREATE_STRUCTURE',
                  payload: {
                    rootPath: '{{StorageContext.paths.root}}',
                    drawingsPath: '{{StorageContext.paths.subfolders.[0]}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([recordTypeWithNestedStorage]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === 'Projects/{{Record.data.code}}') {
            const record = ctx.Record as Record;
            return `Projects/${record.data.code}`;
          }
          if (template === 'Drawings/{{Record.data.code}}') {
            const record = ctx.Record as Record;
            return `Drawings/${record.data.code}`;
          }
          if (template === '{{StorageContext.paths.root}}') {
            const storage = ctx.StorageContext as { paths: { root: string; subfolders: string[] } };
            return storage.paths.root;
          }
          if (template === '{{StorageContext.paths.subfolders.[0]}}') {
            const storage = ctx.StorageContext as { paths: { root: string; subfolders: string[] } };
            return storage.paths.subfolders[0];
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'project',
        data: {
          code: 'PRJ-100',
        },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);

      const expectedActivity: Activity = {
        type: 'CREATE_STRUCTURE',
        payload: {
          rootPath: 'Projects/PRJ-100',
          drawingsPath: 'Drawings/PRJ-100',
        },
      };

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(expectedActivity);
    });

    it('does not inject StorageContext into evaluation context when storageContextConfig is omitted', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const recordTypeWithoutStorage: RecordType = {
        key: 'simple',
        name: 'Simple',
        recordSchema: {
          fields: [{ key: 'name', name: 'Name', type: 'string', required: true }],
        },
        recordUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SimpleWorkflow',
            },
          },
        },
        recordWorkflowConfig: {
          workflows: [
            {
              name: 'SimpleWorkflow',
              activitySequence: [
                {
                  type: 'NOTIFY',
                  payload: {
                    name: '{{Record.data.name}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([recordTypeWithoutStorage]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === '{{Record.data.name}}') {
            const record = ctx.Record as Record;
            return record.data.name as string;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'simple',
        data: { name: 'Alice' },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);

      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '{{Record.data.name}}',
        expect.not.objectContaining({
          StorageContext: expect.anything(),
        })
      );
    });
  });

  describe('Generic Execution Context (TContext) Propagation & Isolation', () => {
    interface CustomExecutionContext {
      oauthToken: string;
      userId: string;
      traceId: string;
    }

    const testRecordType: RecordType = {
      key: 'secureRecord',
      name: 'Secure Record',
      recordSchema: {
        fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        calculatedFields: [
          {
            key: 'calculatedTitle',
            template: 'PREFIX-{{title}}',
          },
        ],
        identity: {
          id: 'ID-{{title}}',
        },
      },
      recordUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'ExecuteSecureAction',
          },
        },
      },
      storageContextConfig: {
        folder: 'DynamicFolder-{{Record.data.title}}',
      },
      recordWorkflowConfig: {
        workflows: [
          {
            name: 'ExecuteSecureAction',
            activitySequence: [
              {
                type: 'MOVE_FILE',
                payload: {
                  folder: '{{StorageContext.folder}}',
                  fileTitle: '{{Record.data.title}}',
                },
              },
            ],
          },
        ],
      },
    };

    it('forwards generic TContext to ActivityDispatcherPort.dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([testRecordType]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === 'PREFIX-{{title}}') return `PREFIX-${ctx.title}`;
          if (template === 'ID-{{title}}') return `ID-${ctx.title}`;
          if (template === 'DynamicFolder-{{Record.data.title}}') {
            const record = ctx.Record as Record;
            return `DynamicFolder-${record.data.title}`;
          }
          if (template === '{{StorageContext.folder}}') {
            const storageCtx = ctx.StorageContext as { folder: string };
            return storageCtx.folder;
          }
          if (template === '{{Record.data.title}}') {
            const record = ctx.Record as Record;
            return record.data.title as string;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'secureRecord',
        data: { title: 'SecretDoc' },
      };

      const executionContext: CustomExecutionContext = {
        oauthToken: 'ya29.sensitive-oauth-token',
        userId: 'user-12345',
        traceId: 'trace-abc-xyz',
      };

      const result = await service.processRecord<CustomExecutionContext>(
        inputRecord,
        'onSubmit',
        executionContext
      );

      expect(result.success).toBe(true);
      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
        {
          type: 'MOVE_FILE',
          payload: {
            folder: 'DynamicFolder-SecretDoc',
            fileTitle: 'SecretDoc',
          },
        },
        executionContext
      );
    });

    it('forwards undefined context to ActivityDispatcherPort.dispatch when no context is provided', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([testRecordType]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === 'PREFIX-{{title}}') return `PREFIX-${ctx.title}`;
          if (template === 'ID-{{title}}') return `ID-${ctx.title}`;
          if (template === 'DynamicFolder-{{Record.data.title}}') {
            const record = ctx.Record as Record;
            return `DynamicFolder-${record.data.title}`;
          }
          if (template === '{{StorageContext.folder}}') {
            const storageCtx = ctx.StorageContext as { folder: string };
            return storageCtx.folder;
          }
          if (template === '{{Record.data.title}}') {
            const record = ctx.Record as Record;
            return record.data.title as string;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'secureRecord',
        data: { title: 'PublicDoc' },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');

      expect(result.success).toBe(true);
      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'MOVE_FILE',
        payload: {
          folder: 'DynamicFolder-PublicDoc',
          fileTitle: 'PublicDoc',
        },
      });
    });

    it('strictly isolates TemplateEvaluatorPort evaluation context from TContext', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([testRecordType]),
      };

      const capturedContexts: Array<{ [key: string]: unknown }> = [];
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          capturedContexts.push({ ...ctx });
          if (template === 'PREFIX-{{title}}') return `PREFIX-${ctx.title}`;
          if (template === 'ID-{{title}}') return `ID-${ctx.title}`;
          if (template === 'DynamicFolder-{{Record.data.title}}') {
            const record = ctx.Record as Record;
            return `DynamicFolder-${record.data.title}`;
          }
          if (template === '{{StorageContext.folder}}') {
            const storageCtx = ctx.StorageContext as { folder: string };
            return storageCtx?.folder ?? '';
          }
          if (template === '{{Record.data.title}}') {
            const record = ctx.Record as Record;
            return (record?.data?.title as string) ?? '';
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'secureRecord',
        data: { title: 'SensitiveRecord' },
      };

      const sensitiveContext: CustomExecutionContext = {
        oauthToken: 'SUPER_SECRET_OAUTH_TOKEN_NEVER_EXPOSE',
        userId: 'admin-user',
        traceId: 'trace-999',
      };

      await service.processRecord<CustomExecutionContext>(
        inputRecord,
        'onSubmit',
        sensitiveContext
      );

      // Verify that none of the evaluation contexts passed to mockEvaluator.evaluate contain sensitiveContext keys or values
      expect(capturedContexts.length).toBeGreaterThan(0);
      for (const evalCtx of capturedContexts) {
        expect(evalCtx).not.toHaveProperty('oauthToken');
        expect(evalCtx).not.toHaveProperty('userId');
        expect(evalCtx).not.toHaveProperty('traceId');
        expect(JSON.stringify(evalCtx)).not.toContain('SUPER_SECRET_OAUTH_TOKEN_NEVER_EXPOSE');
      }
    });
  });

  describe('RecordService in-flight context merging', () => {
    it('merges recordDataPatch and contextVariables from previous activity into subsequent activity payload evaluation', async () => {
      const mockRecordTypes: RecordType[] = [
        {
          key: 'doc-process',
          name: 'Document Process',
          recordSchema: {
            fields: [
              { key: 'title', name: 'Title', type: 'string', required: true },
            ],
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'MultiStepWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'MultiStepWorkflow',
                activitySequence: [
                  {
                    type: 'STEP_ONE',
                    payload: { initial: '{{Record.data.title}}' },
                  },
                  {
                    type: 'STEP_TWO',
                    payload: {
                      fromPatch: '{{Record.data.generatedFileId}}',
                      fromContext: '{{stepOneStatus}}',
                    },
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };

      const capturedDispatches: Activity[] = [];
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockImplementation(async (activity: Activity) => {
          capturedDispatches.push(activity);
          if (activity.type === 'STEP_ONE') {
            return {
              success: true,
              recordDataPatch: { generatedFileId: 'file-xyz-987' },
              contextVariables: { stepOneStatus: 'COMPLETED_SUCCESS' },
            };
          }
          return { success: true };
        }),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: TemplateEvaluationContext) => {
          if (template === '{{Record.data.title}}') {
            return (ctx.Record as Record)?.data?.title as string;
          }
          if (template === '{{Record.data.generatedFileId}}') {
            return (ctx.Record as Record)?.data?.generatedFileId as string;
          }
          if (template === '{{stepOneStatus}}') {
            return ctx.stepOneStatus as string;
          }
          return template;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'doc-process',
        data: { title: 'Initial Document' },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Final returned record data contains patched fields
      expect(result.data.data).toEqual({
        title: 'Initial Document',
        generatedFileId: 'file-xyz-987',
      });

      // Step two received the resolved payload from in-flight merged context
      expect(capturedDispatches).toHaveLength(2);
      expect(capturedDispatches[0]).toEqual({
        type: 'STEP_ONE',
        payload: { initial: 'Initial Document' },
      });
      expect(capturedDispatches[1]).toEqual({
        type: 'STEP_TWO',
        payload: {
          fromPatch: 'file-xyz-987',
          fromContext: 'COMPLETED_SUCCESS',
        },
      });
    });

    it('accumulates patches across multiple chained activities', async () => {
      const mockRecordTypes: RecordType[] = [
        {
          key: 'multi-stage',
          name: 'Multi Stage',
          recordSchema: {
            fields: [
              { key: 'step0', name: 'Step 0', type: 'string', required: true },
            ],
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'ChainedWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'ChainedWorkflow',
                activitySequence: [
                  {
                    type: 'STAGE_A',
                    payload: {},
                  },
                  {
                    type: 'STAGE_B',
                    payload: {},
                  },
                  {
                    type: 'STAGE_C',
                    payload: {},
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };

      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockImplementation(async (activity: Activity) => {
          if (activity.type === 'STAGE_A') {
            return { recordDataPatch: { patchA: 'valA' } };
          }
          if (activity.type === 'STAGE_B') {
            return { recordDataPatch: { patchB: 'valB' } };
          }
          return undefined;
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'multi-stage',
        data: { step0: 'init' },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.data).toEqual({
        step0: 'init',
        patchA: 'valA',
        patchB: 'valB',
      });
    });

    it('works end-to-end with StructuredLogActivity emitting patch to subsequent activity', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockRecordTypes: RecordType[] = [
        {
          key: 'log-pipeline',
          name: 'Log Pipeline',
          recordSchema: {
            fields: [
              { key: 'inputMsg', name: 'Input Message', type: 'string', required: true },
            ],
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'LogWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'LogWorkflow',
                activitySequence: [
                  {
                    type: 'LOG_RECORD',
                    payload: {
                      message: 'First step',
                      recordDataPatch: { enrichedState: 'state-123' },
                    },
                  },
                  {
                    type: 'LOG_RECORD',
                    payload: {
                      message: 'Second step using enriched state',
                      receivedEnrichedState: '{{Record.data.enrichedState}}',
                    },
                  },
                ],
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
        evaluate: vi.fn().mockImplementation((template: string, ctx: TemplateEvaluationContext) => {
          if (template === '{{Record.data.enrichedState}}') {
            return (ctx.Record as Record)?.data?.enrichedState as string;
          }
          return template;
        }),
      };

      const structuredLogActivity = new StructuredLogActivity();
      const service = new RecordService(structuredLogActivity, customRegistry, mockEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'log-pipeline',
        data: { inputMsg: 'Hello' },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.data).toEqual({
        inputMsg: 'Hello',
        enrichedState: 'state-123',
      });

      expect(result.activities).toHaveLength(2);
      expect(result.activities[1].payload).toEqual({
        message: 'Second step using enriched state',
        receivedEnrichedState: 'state-123',
      });

      consoleSpy.mockRestore();
    });

    it('halts workflow execution and returns failure when activity returns success: false with error', async () => {
      const mockRecordTypes: RecordType[] = [
        {
          key: 'failing-doc',
          name: 'Failing Document',
          recordSchema: {
            fields: [
              { key: 'title', name: 'Title', type: 'string', required: true },
            ],
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'FailingWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'FailingWorkflow',
                activitySequence: [
                  {
                    type: 'STEP_FAIL',
                    payload: {},
                  },
                  {
                    type: 'STEP_NEVER_RUN',
                    payload: {},
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };

      const capturedActivities: string[] = [];
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockImplementation(async (activity: Activity) => {
          capturedActivities.push(activity.type);
          if (activity.type === 'STEP_FAIL') {
            return {
              success: false,
              error: 'Database connection dropped',
            };
          }
          return { success: true };
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'failing-doc',
        data: { title: 'Test Fail' },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.errors).toEqual(['Database connection dropped']);
      expect(capturedActivities).toEqual(['STEP_FAIL']);
    });

    it('collects activity outputs including FileLocators and exposes them in ProcessRecordResult.outputs', async () => {
      const mockRecordTypes: RecordType[] = [
        {
          key: 'multi-step-doc',
          name: 'Multi Step Document',
          recordSchema: {
            fields: [
              { key: 'title', name: 'Title', type: 'string', required: true },
            ],
          },
          recordUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'MultiStepWorkflow',
              },
            },
          },
          recordWorkflowConfig: {
            workflows: [
              {
                name: 'MultiStepWorkflow',
                activitySequence: [
                  {
                    type: 'STEP_1_FILE',
                    payload: {},
                  },
                  {
                    type: 'STEP_2_VOID',
                    payload: {},
                  },
                  {
                    type: 'STEP_3_FILE',
                    payload: {},
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockRecordTypes),
      };

      const file1: FileLocator = {
        id: 'file-step-1',
        name: 'Step1.pdf',
        parentName: 'Folder1',
        mimeType: 'application/pdf',
        uri: 'https://drive.google.com/file/d/file-step-1/view',
      };

      const file3: FileLocator = {
        id: 'file-step-3',
        name: 'FinalStep3.pdf',
        parentName: 'DestinationFolder',
        mimeType: 'application/pdf',
        uri: 'https://drive.google.com/file/d/file-step-3/view',
      };

      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockImplementation(async (activity: Activity) => {
          if (activity.type === 'STEP_1_FILE') {
            return {
              success: true,
              files: [file1],
            };
          }
          if (activity.type === 'STEP_2_VOID') {
            return undefined; // void return
          }
          if (activity.type === 'STEP_3_FILE') {
            return {
              success: true,
              files: [file3],
            };
          }
        }),
      };

      const service = new RecordService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputRecord: Record = {
        type: 'multi-step-doc',
        data: { title: 'Test Multi Step' },
      };

      const result = await service.processRecord(inputRecord, 'onSubmit');
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.outputs).toEqual([
        {
          success: true,
          files: [file1],
        },
        {
          success: true,
          files: [file3],
        },
      ]);
    });
  });
});







import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentService,
  DocumentModel,
  DocumentTypeSchema,
  DocumentFieldOptionType,
  DocumentFieldType,
  DocumentSchemaType,
  DocumentSchemaOptionTupleType,
  DocumentIdentitySchemaType,
  CalculatedFieldType,
  SystemContextSchema,
  UiEventRuleType,
  WorkflowType,
  DocumentWorkflowConfigType,
  StorageContextConfigType,
  FormSchemaType,
  ActivityType,
  ActivityOutputType,
  FileLocatorType,
  ExecutionContextSchema,
  formatValidationErrors,
  validateManifestTemplates,
  walkTemplates,
  type Activity,
  type ActivityOutput,
  type FileLocator,
  type Document,
  type DocumentType,
  type FormSchema,
  type StorageContextConfig,
} from './domain';
import {
  DriveServiceError,
  AmbiguousPathSpecError,
  AmbiguousFileError,
  FileNotFoundError,
  type ActivityDispatcherPort,
  type ExecutionContext,
  type ManifestRegistryPort,
  type TemplateEvaluationContext,
  type TemplateEvaluatorPort,
} from './ports';



describe('Document domain', () => {
  const mockRegistry: ManifestRegistryPort = {
    loadAll: vi.fn().mockResolvedValue([]),
  };

  const defaultEvaluator: TemplateEvaluatorPort = {
    validate: vi.fn().mockReturnValue(true),
    evaluate: vi.fn().mockImplementation((template: string) => template),
  };

  it('should export DocumentModel schema', () => {
    expect(DocumentModel).toBeDefined();
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
      documentDataPatch: { newField: 'value' },
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
      documentDataPatch: 'not-an-object',
    };
    expect(Value.Check(ActivityOutputType, invalidPatch)).toBe(false);

    const invalidFiles = {
      files: [{ id: 'file-1' }], // missing name
    };
    expect(Value.Check(ActivityOutputType, invalidFiles)).toBe(false);
  });

  it('should export ExecutionContextSchema and validate valid and invalid execution contexts', () => {
    expect(ExecutionContextSchema).toBeDefined();
    const validContext: ExecutionContext = {
      credentials: { oauthToken: 'ya29.sample-token' },
      resources: { primaryTargetId: 'file-123' },
    };
    expect(Value.Check(ExecutionContextSchema, validContext)).toBe(true);

    const emptyContext: ExecutionContext = {};
    expect(Value.Check(ExecutionContextSchema, emptyContext)).toBe(true);

    const invalidCreds = {
      credentials: 'invalid-string',
    };
    expect(Value.Check(ExecutionContextSchema, invalidCreds)).toBe(false);

    const invalidResources = {
      resources: { primaryTargetId: 12345 },
    };
    expect(Value.Check(ExecutionContextSchema, invalidResources)).toBe(false);
  });

  it('processDocument validates payload, dispatches Activity, and returns success result', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const mockDocumentTypes: DocumentType[] = [
      {
        key: 'submittal',
        name: 'Submittal Document',
        documentSchema: {
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
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SubmitSubmittalWorkflow',
            },
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'SubmitSubmittalWorkflow',
              activitySequence: [
                {
                  type: 'LOG_DOCUMENT',
                  payload: { document: { title: 'Foundation Plan' } },
                },
              ],
            },
          ],
        },
      },
    ];
    const registryWithSubmittal: ManifestRegistryPort = {
      loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
    };
    const service = new DocumentService(mockDispatcher, registryWithSubmittal, defaultEvaluator);
    await service.initialize();

    const validDocument: Document = {
      id: 'rec-123',
      type: 'submittal',
      data: {
        title: 'Foundation Plan',
      },
    };

    const result = await service.processDocument(validDocument, 'onSubmit');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validDocument);
      expect(result.activities).toEqual([
        {
          type: 'LOG_DOCUMENT',
          payload: { document: { title: 'Foundation Plan' } },
        },
      ]);
    }

    expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
      type: 'LOG_DOCUMENT',
      payload: { document: { title: 'Foundation Plan' } },
    });
  });

  it('processDocument returns failure when dynamic field validation fails against compiled schema', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const mockDocumentTypes: DocumentType[] = [
      {
        key: 'submittal',
        name: 'Submittal Document',
        documentSchema: {
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
      loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
    };
    const service = new DocumentService(mockDispatcher, registryWithSubmittal, defaultEvaluator);
    await service.initialize();

    const missingRequiredField = {
      type: 'submittal',
      data: {},
    };

    const result = await service.processDocument(missingRequiredField);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('processDocument returns failure for unknown document type', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new DocumentService(mockDispatcher, mockRegistry, defaultEvaluator);
    await service.initialize();

    const unknownTypeDocument = {
      type: 'unknown-type',
      data: { title: 'Test' },
    };

    const result = await service.processDocument(unknownTypeDocument);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContain("Unknown document type: unknown-type");
    }
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('initialize throws fast-fail error if a DocumentType has an unsupported field type', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const invalidDocumentTypes: DocumentType[] = [
      {
        key: 'invalid-type',
        name: 'Invalid Type',
        documentSchema: {
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
      loadAll: vi.fn().mockResolvedValue(invalidDocumentTypes),
    };
    const service = new DocumentService(mockDispatcher, registryWithInvalid, defaultEvaluator);

    await expect(service.initialize()).rejects.toThrow(
      /Unsupported field type 'unknown'/
    );
  });

  it('processDocument returns failure and does not dispatch activity for invalid payload', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new DocumentService(mockDispatcher, mockRegistry, defaultEvaluator);
    await service.initialize();

    const invalidDocument = {
      title: 123, // missing type and data
    };

    const result = await service.processDocument(invalidDocument);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('processDocument returns failure for undefined or null payload', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const service = new DocumentService(mockDispatcher, mockRegistry, defaultEvaluator);
    await service.initialize();

    const resultUndefined = await service.processDocument(undefined);
    expect(resultUndefined.success).toBe(false);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

    const resultNull = await service.processDocument(null);
    expect(resultNull.success).toBe(false);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('exports DocumentTypeSchema and validates valid DocumentType definitions', () => {
    expect(DocumentTypeSchema).toBeDefined();
    const validDocumentType: DocumentType = {
      key: 'submittal',
      name: 'Submittal Document',
      documentSchema: {
        fields: [
          {
            key: 'title',
            name: 'Title',
            type: 'string',
            required: true,
          },
        ],
      },
      documentUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitSubmittal',
          },
        },
      },
    };
    expect(Value.Check(DocumentTypeSchema, validDocumentType)).toBe(true);
  });

  it('DocumentFieldOptionType requires source, key, and name', () => {
    const validOption = {
      source: 'direction',
      key: 'key',
      name: 'name',
    };
    expect(Value.Check(DocumentFieldOptionType, validOption)).toBe(true);

    const missingSource = {
      key: 'key',
      name: 'name',
    };
    expect(Value.Check(DocumentFieldOptionType, missingSource)).toBe(false);

    const missingKey = {
      source: 'direction',
      name: 'name',
    };
    expect(Value.Check(DocumentFieldOptionType, missingKey)).toBe(false);

    const missingName = {
      source: 'direction',
      key: 'key',
    };
    expect(Value.Check(DocumentFieldOptionType, missingName)).toBe(false);
  });

  it('DocumentFieldOptionType accepts optional allowUserInput boolean', () => {
    const optionWithAllowUserInputTrue = {
      source: 'direction',
      key: 'key',
      name: 'name',
      allowUserInput: true,
    };
    expect(Value.Check(DocumentFieldOptionType, optionWithAllowUserInputTrue)).toBe(true);

    const optionWithAllowUserInputFalse = {
      source: 'direction',
      key: 'key',
      name: 'name',
      allowUserInput: false,
    };
    expect(Value.Check(DocumentFieldOptionType, optionWithAllowUserInputFalse)).toBe(true);

    const optionWithInvalidAllowUserInput = {
      source: 'direction',
      key: 'key',
      name: 'name',
      allowUserInput: 'true',
    };
    expect(Value.Check(DocumentFieldOptionType, optionWithInvalidAllowUserInput)).toBe(false);
  });

  it('DocumentTypeSchema allows optional backend config stubs', () => {
    const documentTypeWithBackendConfigs: DocumentType = {
      key: 'submittal',
      name: 'Submittal Document',
      documentSchema: {
        fields: [
          {
            key: 'title',
            name: 'Title',
            type: 'string',
            required: true,
          },
        ],
      },
      documentUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitSubmittal',
          },
        },
      },
      documentWorkflowConfig: {
        workflows: [{ name: 'SubmitSubmittal' }],
      },
      storageContextConfig: {
        rootFolder: 'Submittals',
      },
    };

    expect(Value.Check(DocumentTypeSchema, documentTypeWithBackendConfigs)).toBe(true);
  });

  it('FormSchemaType validates FormSchema definitions', () => {
    expect(FormSchemaType).toBeDefined();
    const validFormSchema: FormSchema = {
      key: 'submittal',
      name: 'Submittal Document',
      documentSchema: {
        fields: [
          {
            key: 'title',
            name: 'Title',
            type: 'string',
            required: true,
          },
        ],
      },
      documentUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitSubmittal',
          },
        },
      },
    };
    expect(Value.Check(FormSchemaType, validFormSchema)).toBe(true);
  });

  it('DocumentService.initialize caches DocumentTypes from ManifestRegistryPort and getForms strips backend configs', async () => {
    const mockDispatcher: ActivityDispatcherPort = {
      dispatch: vi.fn(),
    };
    const mockDocumentTypes: DocumentType[] = [
      {
        key: 'comm-proj',
        name: 'Communication Project',
        documentSchema: {
          fields: [
            {
              key: 'subject',
              name: 'Subject',
              type: 'string',
              required: true,
            },
          ],
        },
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'HandleComm',
            },
          },
        },
        documentWorkflowConfig: {
          workflows: [{ name: 'HandleComm' }],
        },
        storageContextConfig: {
          path: '/projects/comm',
        },
      },
      {
        key: 'simple-proj',
        name: 'Simple Project',
        documentSchema: {
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
      loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
    };

    const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);

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
        documentSchema: {
          fields: [
            {
              key: 'subject',
              name: 'Subject',
              type: 'string',
              required: true,
            },
          ],
        },
        documentUiConfig: {
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
        documentSchema: {
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
      expect(form).not.toHaveProperty('documentWorkflowConfig');
      expect(form).not.toHaveProperty('storageContextConfig');
    }
  });

  describe('DocumentSchemaOptionTupleType and DocumentSchemaType.options', () => {
    it('validates DocumentSchemaOptionTupleType as Record<string, unknown>', () => {
      expect(DocumentSchemaOptionTupleType).toBeDefined();
      const validTuple = { key: 'IN', name: 'Incoming', extra: 123 };
      expect(Value.Check(DocumentSchemaOptionTupleType, validTuple)).toBe(true);

      const invalidTuple = 'not-an-object';
      expect(Value.Check(DocumentSchemaOptionTupleType, invalidTuple)).toBe(false);
    });

    it('validates DocumentSchemaType.options as optional Record<string, DocumentSchemaOptionTupleType[]>', () => {
      const validSchemaWithOptions = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        options: {
          direction: [
            { key: 'IN', name: 'Incoming' },
            { key: 'OT', name: 'Outgoing' },
          ],
        },
      };
      expect(Value.Check(DocumentSchemaType, validSchemaWithOptions)).toBe(true);

      const invalidSchemaWithOptions = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        options: {
          direction: 'invalid-not-array',
        },
      };
      expect(Value.Check(DocumentSchemaType, invalidSchemaWithOptions)).toBe(false);
    });
  });

  describe('DocumentIdentitySchemaType', () => {
    it('validates id, idDocument, and idGroup keys with extensible string properties', () => {
      expect(DocumentIdentitySchemaType).toBeDefined();

      const validIdentity = {
        id: '{{key}}',
        idDocument: '{{key}}-{{date}}',
        idGroup: '{{contact}}',
        customProperty: 'custom-value',
      };
      expect(Value.Check(DocumentIdentitySchemaType, validIdentity)).toBe(true);

      const validPartialIdentity = {
        id: '{{key}}',
      };
      expect(Value.Check(DocumentIdentitySchemaType, validPartialIdentity)).toBe(true);

      const emptyIdentity = {};
      expect(Value.Check(DocumentIdentitySchemaType, emptyIdentity)).toBe(true);

      const invalidNonStringValue = {
        id: 123,
      };
      expect(Value.Check(DocumentIdentitySchemaType, invalidNonStringValue)).toBe(false);

      const invalidNonStringExtensibleValue = {
        id: '{{key}}',
        customField: 999,
      };
      expect(Value.Check(DocumentIdentitySchemaType, invalidNonStringExtensibleValue)).toBe(false);
    });

    it('validates DocumentSchemaType.identity with DocumentIdentitySchemaType', () => {
      const schemaWithIdentity = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        identity: {
          id: '{{key}}',
          idDocument: '{{key}}-{{date}}',
          idGroup: '{{contact}}',
        },
      };
      expect(Value.Check(DocumentSchemaType, schemaWithIdentity)).toBe(true);

      const schemaWithInvalidIdentity = {
        fields: [{ key: 'f1', name: 'Field 1', type: 'string', required: true }],
        identity: {
          id: 123,
        },
      };
      expect(Value.Check(DocumentSchemaType, schemaWithInvalidIdentity)).toBe(false);
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

  describe('DocumentFieldType.defaultValue', () => {
    it('accepts optional defaultValue as string', () => {
      const fieldWithDefault = {
        key: 'status',
        name: 'Status',
        type: 'string',
        required: false,
        defaultValue: 'Draft',
      };
      expect(Value.Check(DocumentFieldType, fieldWithDefault)).toBe(true);

      const fieldWithoutDefault = {
        key: 'status',
        name: 'Status',
        type: 'string',
        required: false,
      };
      expect(Value.Check(DocumentFieldType, fieldWithoutDefault)).toBe(true);
    });

    it('rejects non-string defaultValue', () => {
      const invalidField = {
        key: 'status',
        name: 'Status',
        type: 'string',
        required: false,
        defaultValue: 123,
      };
      expect(Value.Check(DocumentFieldType, invalidField)).toBe(false);
    });
  });

  describe('DocumentFieldType.required', () => {
    it('allows omitting required property and defaults to valid schema', () => {
      const fieldWithoutRequired = {
        key: 'description',
        name: 'Description',
        type: 'string',
      };
      expect(Value.Check(DocumentFieldType, fieldWithoutRequired)).toBe(true);
    });

    it('accepts boolean required property when provided', () => {
      const fieldWithRequiredTrue = {
        key: 'title',
        name: 'Title',
        type: 'string',
        required: true,
      };
      expect(Value.Check(DocumentFieldType, fieldWithRequiredTrue)).toBe(true);

      const fieldWithRequiredFalse = {
        key: 'notes',
        name: 'Notes',
        type: 'string',
        required: false,
      };
      expect(Value.Check(DocumentFieldType, fieldWithRequiredFalse)).toBe(true);
    });

    it('rejects non-boolean required property', () => {
      const fieldWithInvalidRequired = {
        key: 'title',
        name: 'Title',
        type: 'string',
        required: 'yes',
      };
      expect(Value.Check(DocumentFieldType, fieldWithInvalidRequired)).toBe(false);
    });
  });

  describe('formatValidationErrors', () => {
    it('returns empty array when there are no errors', () => {
      const Schema = DocumentModel;
      const validDocument = { id: 'rec-1', type: 'submittal', data: { subject: 'Submittal 1' } };
      expect(formatValidationErrors(Schema, validDocument)).toEqual([]);
    });

    it('returns formatted error string array with path and message for invalid value', () => {
      const Schema = DocumentModel;
      const invalidDocument = { id: 123, type: 'submittal' }; // id not string, missing data
      const formatted = formatValidationErrors(Schema, invalidDocument);
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

    it('validates DocumentSchemaType with optional calculatedFields', () => {
      const schemaWithCalcFields = {
        fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        calculatedFields: [
          {
            key: 'fullTitle',
            template: 'PREFIX-{{title}}',
          },
        ],
      };
      expect(Value.Check(DocumentSchemaType, schemaWithCalcFields)).toBe(true);

      const schemaWithInvalidCalcFields = {
        fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        calculatedFields: [
          {
            key: 'fullTitle',
            // missing template
          },
        ],
      };
      expect(Value.Check(DocumentSchemaType, schemaWithInvalidCalcFields)).toBe(false);
    });
  });

  describe('DocumentService calculatedFields evaluation', () => {
    it('evaluates calculatedFields against base payload and enriches document before dispatching activity', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'HandleCommWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'HandleCommWorkflow',
                activitySequence: [
                  {
                    type: 'LOG_DOCUMENT',
                    payload: { status: 'calculated' },
                  },
                ],
              },
            ],
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
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

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Alice',
          date: '260825',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.data).toEqual({
          contact: 'Alice',
          date: '260825',
          testCalculatedField: '260825-Alice',
        });
        expect(result.activities).toEqual([
          {
            type: 'LOG_DOCUMENT',
            payload: { status: 'calculated' },
          },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_DOCUMENT',
        payload: { status: 'calculated' },
      });
    });

    it('strictly isolates calculatedFields evaluation context from each other (ADR 0003)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'multi-calc',
          name: 'Multi Calc',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };

      const evaluatedContexts: { [key: string]: unknown }[] = [];
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((_template, ctx) => {
          evaluatedContexts.push({ ...ctx });
          return 'result';
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      await service.processDocument({
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

  describe('DocumentService identity evaluation', () => {
    it('evaluates identity templates (id, idDocument, idGroup) and populates document before activity dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
            fields: [
              { key: 'contact', name: 'Contact', type: 'string', required: true },
              { key: 'date', name: 'Date', type: 'string', required: true },
              { key: 'direction', name: 'Direction', type: 'string', required: true },
              { key: 'description', name: 'Description', type: 'string', required: true },
            ],
            identity: {
              id: '{{contact}}-{{date}}-{{direction}}-{{description}}',
              idDocument: '{{contact}}-{{date}}-{{direction}}-{{description}}',
              idGroup: '{{contact}}',
            },
          },
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'IdentityWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'IdentityWorkflow',
                activitySequence: [
                  {
                    type: 'LOG_DOCUMENT',
                    payload: { status: 'identified' },
                  },
                ],
              },
            ],
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
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

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Alice',
          date: '260825',
          direction: 'IN',
          description: 'Project discussion',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('Alice-260825-IN-Project discussion');
        expect(result.data.idDocument).toBe('Alice-260825-IN-Project discussion');
        expect(result.data.idGroup).toBe('Alice');
        expect(result.data.data).toEqual({
          contact: 'Alice',
          date: '260825',
          direction: 'IN',
          description: 'Project discussion',
        });
        expect(result.activities).toEqual([
          {
            type: 'LOG_DOCUMENT',
            payload: { status: 'identified' },
          },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_DOCUMENT',
        payload: { status: 'identified' },
      });
    });

    it('strictly isolates identity evaluation context from calculatedFields and each other', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'calc-and-identity',
          name: 'Calc and Identity',
          documentSchema: {
            fields: [
              { key: 'contact', name: 'Contact', type: 'string', required: true },
            ],
            calculatedFields: [
              { key: 'derivedField', template: '{{contact}}-DERIVED' },
            ],
            identity: {
              id: '{{contact}}-ID',
              idDocument: '{{derivedField}}-DOCUMENT',
              idGroup: '{{id}}-GROUP',
            },
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };

      const evaluatedContexts: { template: string; ctx: { [key: string]: unknown } }[] = [];
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template, ctx) => {
          evaluatedContexts.push({ template, ctx: { ...ctx } });
          return 'eval-res';
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      await service.processDocument({
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
        expect(item.ctx).not.toHaveProperty('idDocument');
        expect(item.ctx).not.toHaveProperty('idGroup');
      }
    });
  });

  describe('DocumentService LookupFields validation', () => {
    it('accepts valid string inputs matching option tuple key for lookup fields', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const validDocument: Document = {
        type: 'comm-project',
        data: {
          direction: 'IN',
        },
      };

      const result = await service.processDocument(validDocument);
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
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const invalidDocument = {
        type: 'comm-project',
        data: {
          direction: 'INVALID_DIR',
        },
      };

      const result = await service.processDocument(invalidDocument);
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
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      // Omitting optional lookup field
      const emptyDocument: Document = {
        type: 'comm-project',
        data: {},
      };
      const emptyResult = await service.processDocument(emptyDocument);
      expect(emptyResult.success).toBe(true);
      if (emptyResult.success) {
        expect(emptyResult.data.data).toEqual({});
      }

      // Providing valid option
      const validDocument: Document = {
        type: 'comm-project',
        data: {
          direction: 'OT',
        },
      };
      const validResult = await service.processDocument(validDocument);
      expect(validResult.success).toBe(true);
      if (validResult.success) {
        expect(validResult.data.data).toEqual({ direction: { key: 'OT', name: 'Outgoing' } });
      }

      // Providing invalid option
      const invalidDocument = {
        type: 'comm-project',
        data: {
          direction: 'UNKNOWN',
        },
      };
      const invalidResult = await service.processDocument(invalidDocument);
      expect(invalidResult.success).toBe(false);
      if (!invalidResult.success) {
        expect(invalidResult.errors.some((err) => err.includes('/direction:'))).toBe(true);
      }
    });

    it('rejects inputs when lookup field options source is missing or empty', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const documentWithMissingSourceVal = {
        type: 'comm-project',
        data: {
          category: 'AnyValue',
        },
      };
      const result = await service.processDocument(documentWithMissingSourceVal);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.some((err) => err.includes('/category:'))).toBe(true);
      }
    });

    it('accepts arbitrary string inputs when lookup field has allowUserInput: true (combo-box)', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      // Accepts standard option from list and enriches to matched tuple
      const optionDocument: Document = {
        type: 'comm-project',
        data: {
          direction: 'IN',
        },
      };
      const optionResult = await service.processDocument(optionDocument);
      expect(optionResult.success).toBe(true);
      if (optionResult.success) {
        expect(optionResult.data.data).toEqual({ direction: { key: 'IN', name: 'Incoming' } });
        expect(optionResult.activities).toEqual([]);
      }

      // Accepts arbitrary custom text string outside option list and synthesizes fallback tuple
      const customDocument: Document = {
        type: 'comm-project',
        data: {
          direction: 'Custom External Message',
        },
      };
      const customResult = await service.processDocument(customDocument);
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
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const invalidTypeDocument = {
        type: 'comm-project',
        data: {
          direction: 12345,
        },
      };
      const result = await service.processDocument(invalidTypeDocument);
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
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const forms = await service.getForms();
      expect(forms).toHaveLength(1);
      expect(forms[0].documentSchema.fields[0].options?.allowUserInput).toBe(true);
      expect(forms[0].documentSchema.fields[1].options?.allowUserInput).toBeUndefined();
      expect(Value.Check(FormSchemaType, forms[0])).toBe(true);
    });

    it('enriches primitive string with entire source tuple including auxiliary properties before activity dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'submittal',
          name: 'Submittal Document',
          documentSchema: {
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
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'SubmitWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'SubmitWorkflow',
                activitySequence: [
                  {
                    type: 'LOG_DOCUMENT',
                    payload: { status: 'submittal_filed' },
                  },
                ],
              },
            ],
          },
        },
      ];
      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        id: 'rec-sub-1',
        type: 'submittal',
        data: {
          title: 'Foundation Plan Review',
          status: 'APP',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
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
            type: 'LOG_DOCUMENT',
            payload: { status: 'submittal_filed' },
          },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith({
        type: 'LOG_DOCUMENT',
        payload: { status: 'submittal_filed' },
      });
    });

    it('synthesizes fallback tuple for combo-boxes mapping custom string to schema key and name', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'vendor-document',
          name: 'Vendor Document',
          documentSchema: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'vendor-document',
        data: {
          supplierType: 'Custom Acoustic Consultant',
        },
      };

      const result = await service.processDocument(inputDocument);
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
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'comm-project',
          name: 'Communication Project',
          documentSchema: {
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
              idDocument: '{{contact}}-{{date}}-{{direction.key}}-{{deliveryMethod.code}}',
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
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

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      // Test with matched direction tuple and synthesized deliveryMethod fallback tuple
      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Alice',
          date: '260825',
          direction: 'IN',
          deliveryMethod: 'Hand Carried Drone', // arbitrary combo-box input
        },
      };

      const result = await service.processDocument(inputDocument);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('Alice-260825-IN-Hand Carried Drone');
        expect(result.data.idDocument).toBe('Alice-260825-IN-Hand Carried Drone');
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

  describe('documentWorkflowConfig and WorkflowType validation', () => {
    it('validates WorkflowType with name and optional activitySequence', () => {
      const validWorkflow = {
        name: 'ProcessSubmission',
        activitySequence: [
          {
            type: 'LOG_DOCUMENT',
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

    it('validates DocumentWorkflowConfigType with workflows array', () => {
      const validConfig = {
        workflows: [
          { name: 'Workflow1' },
          { name: 'Workflow2', activitySequence: [] },
        ],
      };
      expect(Value.Check(DocumentWorkflowConfigType, validConfig)).toBe(true);

      const invalidConfig = {
        workflows: 'not-an-array',
      };
      expect(Value.Check(DocumentWorkflowConfigType, invalidConfig)).toBe(false);
    });
  });

  describe('DocumentService Event Routing & Workflow Dispatch', () => {
    const mockWorkflowDocumentType: DocumentType = {
      key: 'comm-project',
      name: 'Communication Project',
      documentSchema: {
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
          idDocument: '{{contact}}-{{date}}-{{direction.key}}-{{description}}',
          idGroup: '{{contact}}',
        },
        options: {
          direction: [
            { key: 'IN', name: 'Incoming' },
            { key: 'OT', name: 'Outgoing' },
          ],
        },
      },
      documentUiConfig: {
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
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'IncomingWorkflow',
            activitySequence: [
              {
                type: 'LOG_DOCUMENT',
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
        loadAll: vi.fn().mockResolvedValue([mockWorkflowDocumentType]),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'IN',
          description: 'Inbound message',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.activities).toHaveLength(2);
        expect(result.activities).toEqual([
          { type: 'LOG_DOCUMENT', payload: { step: 1, action: 'log_incoming' } },
          { type: 'NOTIFY_TEAM', payload: { step: 2, channel: 'inbound-docs' } },
        ]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(mockDispatcher.dispatch).toHaveBeenNthCalledWith(1, {
        type: 'LOG_DOCUMENT',
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
        loadAll: vi.fn().mockResolvedValue([mockWorkflowDocumentType]),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: '_Client - AAA',
          date: '260826',
          direction: 'OT',
          description: 'ASR 06 Design Changes',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
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
        loadAll: vi.fn().mockResolvedValue([mockWorkflowDocumentType]),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Other Contractor',
          date: '260826',
          direction: 'OT',
          description: 'Outbound to other contractor',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
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
        loadAll: vi.fn().mockResolvedValue([mockWorkflowDocumentType]),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Anyone',
          date: '260826',
          direction: 'OT',
          description: 'Testing no match event',
        },
      };

      const result = await service.processDocument(inputDocument, 'onNoMatchEvent');
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
        loadAll: vi.fn().mockResolvedValue([mockWorkflowDocumentType]),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'IN',
          description: 'Inbound message',
        },
      };

      // When eventName is undefined
      const resultNoEvent = await service.processDocument(inputDocument);
      expect(resultNoEvent.success).toBe(true);
      if (resultNoEvent.success) {
        expect(resultNoEvent.activities).toEqual([]);
      }
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();

      // When eventName does not exist
      const resultUnknownEvent = await service.processDocument(inputDocument, 'onNonExistentEvent');
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
        loadAll: vi.fn().mockResolvedValue([mockWorkflowDocumentType]),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          date: '260825',
          direction: 'IN',
          description: 'Test message',
        },
      };

      await expect(service.processDocument(inputDocument, 'onMissingWorkflowEvent')).rejects.toThrow(
        /Workflow 'NonExistentWorkflow' not found in configuration for DocumentType 'comm-project'/
      );
      expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('Activity payload Handlebars template resolution', () => {
    it('evaluates activity payload template strings using TemplateEvaluatorPort with context { Document, documentSchema } before dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const documentTypeWithTemplates: DocumentType = {
        key: 'comm-project',
        name: 'Communication Project',
        documentSchema: {
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
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'DispatchActivityWorkflow',
            },
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'DispatchActivityWorkflow',
              activitySequence: [
                {
                  type: 'NOTIFY_CLIENT',
                  payload: {
                    recipient: '{{Document.data.contact}}',
                    documentId: '{{Document.id}}',
                    subject: '{{Document.data.fullSubject}}',
                    schemaField: '{{documentSchema.fields.[0].name}}',
                    staticNumber: 42,
                    staticBoolean: true,
                    nested: {
                      message: 'Hello {{Document.data.contact}}',
                      tags: ['tag-{{Document.data.contact}}', 'constant-tag'],
                    },
                  },
                },
              ],
            },
          ],
        },
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([documentTypeWithTemplates]),
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
          if (template === '{{Document.data.contact}}') {
            const document = ctx.Document as Document;
            return document.data.contact as string;
          }
          if (template === '{{Document.id}}') {
            const document = ctx.Document as Document;
            return document.id as string;
          }
          if (template === '{{Document.data.fullSubject}}') {
            const document = ctx.Document as Document;
            return document.data.fullSubject as string;
          }
          if (template === '{{documentSchema.fields.[0].name}}') {
            const schema = ctx.documentSchema as DocumentType['documentSchema'];
            return schema.fields[0].name;
          }
          if (template === 'Hello {{Document.data.contact}}') {
            const document = ctx.Document as Document;
            return `Hello ${document.data.contact}`;
          }
          if (template === 'tag-{{Document.data.contact}}') {
            const document = ctx.Document as Document;
            return `tag-${document.data.contact}`;
          }
          return template;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: 'Jane Doe',
          subject: 'Review Meeting',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');

      expect(result.success).toBe(true);

      const expectedEnrichedDocument: Document = {
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
        documentId: 'REC-Jane Doe',
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
        expect(result.data).toEqual(expectedEnrichedDocument);
        expect(result.activities).toEqual([expectedActivity]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(expectedActivity);

      // Verify that mockEvaluator was called with the exact required context
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '{{Document.data.contact}}',
        expect.objectContaining({
          Document: expectedEnrichedDocument,
          documentSchema: documentTypeWithTemplates.documentSchema,
        })
      );
    });
  });

  describe('Pre-evaluated Storage Context', () => {
    it('exports StorageContextConfigType and validates config object', () => {
      expect(StorageContextConfigType).toBeDefined();
      const validConfig: StorageContextConfig = {
        folder: '1Admin/Communication/{{Document.data.contact}}',
        root: 'Projects',
      };
      expect(Value.Check(StorageContextConfigType, validConfig)).toBe(true);
    });

    it('pre-evaluates storageContextConfig using { Document: enrichedDocument } and injects StorageContext into Activity evaluation context', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const documentTypeWithStorageContext: DocumentType = {
        key: 'comm-project',
        name: 'Communication Project',
        documentSchema: {
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
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'StorageWorkflow',
            },
          },
        },
        storageContextConfig: {
          folder: '1Admin/Communication/{{Document.data.contact}}',
          subfolder: 'Archive/{{Document.data.direction}}',
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'StorageWorkflow',
              activitySequence: [
                {
                  type: 'CREATE_FILE',
                  payload: {
                    targetPath: '{{StorageContext.folder}}/{{Document.data.summary}}',
                    archivePath: '{{StorageContext.subfolder}}/{{Document.data.date}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([documentTypeWithStorageContext]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === '{{date}} {{direction}} - {{description}}') {
            return `${ctx.date} ${ctx.direction} - ${ctx.description}`;
          }
          if (template === '1Admin/Communication/{{Document.data.contact}}') {
            const document = ctx.Document as Document;
            return `1Admin/Communication/${document.data.contact}`;
          }
          if (template === 'Archive/{{Document.data.direction}}') {
            const document = ctx.Document as Document;
            return `Archive/${document.data.direction}`;
          }
          if (template === '{{StorageContext.folder}}/{{Document.data.summary}}') {
            const storageContext = ctx.StorageContext as { folder: string; subfolder: string };
            const document = ctx.Document as Document;
            return `${storageContext.folder}/${document.data.summary}`;
          }
          if (template === '{{StorageContext.subfolder}}/{{Document.data.date}}') {
            const storageContext = ctx.StorageContext as { folder: string; subfolder: string };
            const document = ctx.Document as Document;
            return `${storageContext.subfolder}/${document.data.date}`;
          }
          return template;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'comm-project',
        data: {
          contact: '_Client - AAA',
          date: '260826',
          direction: 'OT',
          description: 'ASR 06 Design Changes',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');

      expect(result.success).toBe(true);

      const expectedEnrichedDocument: Document = {
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
        expect(result.data).toEqual(expectedEnrichedDocument);
        expect(result.activities).toEqual([expectedActivity]);
      }

      expect(mockDispatcher.dispatch).toHaveBeenCalledWith(expectedActivity);

      // Verify that storageContextConfig was pre-evaluated with { Document: enrichedDocument }
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '1Admin/Communication/{{Document.data.contact}}',
        { Document: expectedEnrichedDocument }
      );
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        'Archive/{{Document.data.direction}}',
        { Document: expectedEnrichedDocument }
      );

      // Verify that activity evaluation context received StorageContext
      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '{{StorageContext.folder}}/{{Document.data.summary}}',
        expect.objectContaining({
          Document: expectedEnrichedDocument,
          documentSchema: documentTypeWithStorageContext.documentSchema,
          StorageContext: expectedStorageContext,
        })
      );
    });

    it('pre-evaluates nested structures in storageContextConfig recursively against { Document: enrichedDocument }', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const documentTypeWithNestedStorage: DocumentType = {
        key: 'project',
        name: 'Project',
        documentSchema: {
          fields: [
            { key: 'code', name: 'Code', type: 'string', required: true },
          ],
        },
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'NestedStorageWorkflow',
            },
          },
        },
        storageContextConfig: {
          paths: {
            root: 'Projects/{{Document.data.code}}',
            subfolders: ['Drawings/{{Document.data.code}}', 'Specs'],
          },
        },
        documentWorkflowConfig: {
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
        loadAll: vi.fn().mockResolvedValue([documentTypeWithNestedStorage]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === 'Projects/{{Document.data.code}}') {
            const document = ctx.Document as Document;
            return `Projects/${document.data.code}`;
          }
          if (template === 'Drawings/{{Document.data.code}}') {
            const document = ctx.Document as Document;
            return `Drawings/${document.data.code}`;
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

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'project',
        data: {
          code: 'PRJ-100',
        },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
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

      const documentTypeWithoutStorage: DocumentType = {
        key: 'simple',
        name: 'Simple',
        documentSchema: {
          fields: [{ key: 'name', name: 'Name', type: 'string', required: true }],
        },
        documentUiConfig: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'SimpleWorkflow',
            },
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'SimpleWorkflow',
              activitySequence: [
                {
                  type: 'NOTIFY',
                  payload: {
                    name: '{{Document.data.name}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([documentTypeWithoutStorage]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === '{{Document.data.name}}') {
            const document = ctx.Document as Document;
            return document.data.name as string;
          }
          return template;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'simple',
        data: { name: 'Alice' },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
      expect(result.success).toBe(true);

      expect(mockEvaluator.evaluate).toHaveBeenCalledWith(
        '{{Document.data.name}}',
        expect.not.objectContaining({
          StorageContext: expect.anything(),
        })
      );
    });
  });

  describe('Execution Context (ExecutionContext) Propagation & Isolation', () => {
    const testDocumentType: DocumentType = {
      key: 'secureDocument',
      name: 'Secure Document',
      documentSchema: {
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
      documentUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'ExecuteSecureAction',
          },
        },
      },
      storageContextConfig: {
        folder: 'DynamicFolder-{{Document.data.title}}',
      },
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'ExecuteSecureAction',
            activitySequence: [
              {
                type: 'MOVE_FILE',
                payload: {
                  folder: '{{StorageContext.folder}}',
                  fileTitle: '{{Document.data.title}}',
                },
              },
            ],
          },
        ],
      },
    };

    it('forwards ExecutionContext to ActivityDispatcherPort.dispatch', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([testDocumentType]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === 'PREFIX-{{title}}') return `PREFIX-${ctx.title}`;
          if (template === 'ID-{{title}}') return `ID-${ctx.title}`;
          if (template === 'DynamicFolder-{{Document.data.title}}') {
            const document = ctx.Document as Document;
            return `DynamicFolder-${document.data.title}`;
          }
          if (template === '{{StorageContext.folder}}') {
            const storageCtx = ctx.StorageContext as { folder: string };
            return storageCtx.folder;
          }
          if (template === '{{Document.data.title}}') {
            const document = ctx.Document as Document;
            return document.data.title as string;
          }
          return template;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'secureDocument',
        data: { title: 'SecretDoc' },
      };

      const executionContext: ExecutionContext = {
        credentials: {
          oauthToken: 'ya29.sensitive-oauth-token',
        },
        resources: {
          primaryTargetId: 'user-12345',
        },
      };

      const result = await service.processDocument(
        inputDocument,
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
        loadAll: vi.fn().mockResolvedValue([testDocumentType]),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          if (template === 'PREFIX-{{title}}') return `PREFIX-${ctx.title}`;
          if (template === 'ID-{{title}}') return `ID-${ctx.title}`;
          if (template === 'DynamicFolder-{{Document.data.title}}') {
            const document = ctx.Document as Document;
            return `DynamicFolder-${document.data.title}`;
          }
          if (template === '{{StorageContext.folder}}') {
            const storageCtx = ctx.StorageContext as { folder: string };
            return storageCtx.folder;
          }
          if (template === '{{Document.data.title}}') {
            const document = ctx.Document as Document;
            return document.data.title as string;
          }
          return template;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'secureDocument',
        data: { title: 'PublicDoc' },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');

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

    it('strictly isolates TemplateEvaluatorPort evaluation context from ExecutionContext', async () => {
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockResolvedValue(undefined),
      };

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([testDocumentType]),
      };

      const capturedContexts: Array<{ [key: string]: unknown }> = [];
      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: { [key: string]: unknown }) => {
          capturedContexts.push({ ...ctx });
          if (template === 'PREFIX-{{title}}') return `PREFIX-${ctx.title}`;
          if (template === 'ID-{{title}}') return `ID-${ctx.title}`;
          if (template === 'DynamicFolder-{{Document.data.title}}') {
            const document = ctx.Document as Document;
            return `DynamicFolder-${document.data.title}`;
          }
          if (template === '{{StorageContext.folder}}') {
            const storageCtx = ctx.StorageContext as { folder: string };
            return storageCtx?.folder ?? '';
          }
          if (template === '{{Document.data.title}}') {
            const document = ctx.Document as Document;
            return (document?.data?.title as string) ?? '';
          }
          return template;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'secureDocument',
        data: { title: 'SensitiveDocument' },
      };

      const sensitiveContext: ExecutionContext = {
        credentials: {
          oauthToken: 'SUPER_SECRET_OAUTH_TOKEN_NEVER_EXPOSE',
        },
      };

      await service.processDocument(
        inputDocument,
        'onSubmit',
        sensitiveContext
      );

      // Verify that none of the evaluation contexts passed to mockEvaluator.evaluate contain sensitiveContext keys or values
      expect(capturedContexts.length).toBeGreaterThan(0);
      for (const evalCtx of capturedContexts) {
        expect(evalCtx).not.toHaveProperty('credentials');
        expect(evalCtx).not.toHaveProperty('resources');
        expect(JSON.stringify(evalCtx)).not.toContain('SUPER_SECRET_OAUTH_TOKEN_NEVER_EXPOSE');
      }
    });
  });

  describe('DocumentService in-flight context merging', () => {
    it('merges documentDataPatch and contextVariables from previous activity into subsequent activity payload evaluation', async () => {
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'doc-process',
          name: 'Document Process',
          documentSchema: {
            fields: [
              { key: 'title', name: 'Title', type: 'string', required: true },
            ],
          },
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'MultiStepWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'MultiStepWorkflow',
                activitySequence: [
                  {
                    type: 'STEP_ONE',
                    payload: { initial: '{{Document.data.title}}' },
                  },
                  {
                    type: 'STEP_TWO',
                    payload: {
                      fromPatch: '{{Document.data.generatedFileId}}',
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };

      const capturedDispatches: Activity[] = [];
      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockImplementation(async (activity: Activity) => {
          capturedDispatches.push(activity);
          if (activity.type === 'STEP_ONE') {
            return {
              success: true,
              documentDataPatch: { generatedFileId: 'file-xyz-987' },
              contextVariables: { stepOneStatus: 'COMPLETED_SUCCESS' },
            };
          }
          return { success: true };
        }),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: TemplateEvaluationContext) => {
          if (template === '{{Document.data.title}}') {
            return (ctx.Document as Document)?.data?.title as string;
          }
          if (template === '{{Document.data.generatedFileId}}') {
            return (ctx.Document as Document)?.data?.generatedFileId as string;
          }
          if (template === '{{stepOneStatus}}') {
            return ctx.stepOneStatus as string;
          }
          return template;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'doc-process',
        data: { title: 'Initial Document' },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Final returned document data contains patched fields
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
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'multi-stage',
          name: 'Multi Stage',
          documentSchema: {
            fields: [
              { key: 'step0', name: 'Step 0', type: 'string', required: true },
            ],
          },
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'ChainedWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };

      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockImplementation(async (activity: Activity) => {
          if (activity.type === 'STAGE_A') {
            return { documentDataPatch: { patchA: 'valA' } };
          }
          if (activity.type === 'STAGE_B') {
            return { documentDataPatch: { patchB: 'valB' } };
          }
          return undefined;
        }),
      };

      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'multi-stage',
        data: { step0: 'init' },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.data).toEqual({
        step0: 'init',
        patchA: 'valA',
        patchB: 'valB',
      });
    });

    it('propagates documentDataPatch from activity output to subsequent activity in sequence', async () => {
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'log-pipeline',
          name: 'Log Pipeline',
          documentSchema: {
            fields: [
              { key: 'inputMsg', name: 'Input Message', type: 'string', required: true },
            ],
          },
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'LogWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
            workflows: [
              {
                name: 'LogWorkflow',
                activitySequence: [
                  {
                    type: 'STEP_ONE',
                    payload: {
                      message: 'First step',
                    },
                  },
                  {
                    type: 'STEP_TWO',
                    payload: {
                      message: 'Second step using enriched state',
                      receivedEnrichedState: '{{Document.data.enrichedState}}',
                    },
                  },
                ],
              },
            ],
          },
        },
      ];

      const customRegistry: ManifestRegistryPort = {
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
      };

      const mockEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockImplementation((template: string, ctx: TemplateEvaluationContext) => {
          if (template === '{{Document.data.enrichedState}}') {
            return (ctx.Document as Document)?.data?.enrichedState as string;
          }
          return template;
        }),
      };

      const mockDispatcher: ActivityDispatcherPort = {
        dispatch: vi.fn().mockImplementation((activity: Activity) => {
          if (activity.type === 'STEP_ONE') {
            return {
              success: true,
              documentDataPatch: { enrichedState: 'state-123' },
            };
          }
          return undefined;
        }),
      };
      const service = new DocumentService(mockDispatcher, customRegistry, mockEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'log-pipeline',
        data: { inputMsg: 'Hello' },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
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
    });

    it('halts workflow execution and returns failure when activity returns success: false with error', async () => {
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'failing-doc',
          name: 'Failing Document',
          documentSchema: {
            fields: [
              { key: 'title', name: 'Title', type: 'string', required: true },
            ],
          },
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'FailingWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
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

      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'failing-doc',
        data: { title: 'Test Fail' },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.errors).toEqual(['Database connection dropped']);
      expect(capturedActivities).toEqual(['STEP_FAIL']);
    });

    it('collects activity outputs including FileLocators and exposes them in ProcessDocumentResult.outputs', async () => {
      const mockDocumentTypes: DocumentType[] = [
        {
          key: 'multi-step-doc',
          name: 'Multi Step Document',
          documentSchema: {
            fields: [
              { key: 'title', name: 'Title', type: 'string', required: true },
            ],
          },
          documentUiConfig: {
            events: {
              onSubmit: {
                catchAllWorkflow: 'MultiStepWorkflow',
              },
            },
          },
          documentWorkflowConfig: {
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
        loadAll: vi.fn().mockResolvedValue(mockDocumentTypes),
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

      const service = new DocumentService(mockDispatcher, customRegistry, defaultEvaluator);
      await service.initialize();

      const inputDocument: Document = {
        type: 'multi-step-doc',
        data: { title: 'Test Multi Step' },
      };

      const result = await service.processDocument(inputDocument, 'onSubmit');
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

  describe('walkTemplates', () => {
    it('recursively finds and visits all string templates with correct dot and array index paths', () => {
      const visited: Array<{ path: string; template: string }> = [];
      const testObj = {
        title: 'Simple Title',
        nested: {
          path: '/path/{{Document.data.id}}',
          deep: {
            item: 'deep-val',
          },
        },
        list: [
          'first-item',
          {
            payload: {
              target: 'target-{{val}}',
            },
          },
        ],
        nullValue: null,
        numValue: 123,
        boolValue: true,
      };

      walkTemplates(testObj, 'root', (path, template) => {
        visited.push({ path, template });
      });

      expect(visited).toEqual([
        { path: 'root.title', template: 'Simple Title' },
        { path: 'root.nested.path', template: '/path/{{Document.data.id}}' },
        { path: 'root.nested.deep.item', template: 'deep-val' },
        { path: 'root.list[0]', template: 'first-item' },
        { path: 'root.list[1].payload.target', template: 'target-{{val}}' },
      ]);
    });

    it('gracefully handles null, undefined, or primitive root objects', () => {
      const visited: Array<{ path: string; template: string }> = [];
      walkTemplates(null, 'root', (path, template) => visited.push({ path, template }));
      walkTemplates(undefined, 'root', (path, template) => visited.push({ path, template }));
      expect(visited).toEqual([]);

      walkTemplates('direct-string', 'direct', (path, template) => visited.push({ path, template }));
      expect(visited).toEqual([{ path: 'direct', template: 'direct-string' }]);
    });
  });

  describe('validateManifestTemplates', () => {
    const createEvaluator = (): TemplateEvaluatorPort => ({
      validate: vi.fn().mockImplementation((template: string, allowedVars: string[]) => {
        const matches = Array.from(template.matchAll(/\{\{\{?\s*([a-zA-Z0-9_$.-]+)\s*\}?\}\}/g)).map((m) => m[1]);
        const allowed = new Set(allowedVars);
        const hasCatchAll = allowed.has('*');
        const wildcardPrefixes = allowedVars
          .filter((p) => p.endsWith('.*') || (p.endsWith('*') && p !== '*'))
          .map((p) => (p.endsWith('.*') ? p.slice(0, -2) : p.slice(0, -1)));
        return matches.every((v) => {
          if (hasCatchAll || allowed.has(v)) return true;
          return wildcardPrefixes.some((prefix) => v === prefix || v.startsWith(`${prefix}.`));
        });
      }),
      evaluate: vi.fn().mockImplementation((tpl: string) => tpl),
    });

    it('returns empty error array for a completely valid DocumentType manifest', () => {
      const evaluator = createEvaluator();
      const validManifest: DocumentType = {
        key: 'communication-project',
        name: 'Communication Project',
        documentSchema: {
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
              key: 'summary',
              template: '{{date}} {{direction.key}} - {{description}}',
            },
            {
              key: 'testCalculatedField',
              template: '{{date}}-{{direction.key}}-{{contact}}-{{description}}',
            },
          ],
          identity: {
            id: '{{contact}}-{{date}}-{{direction.key}}-{{description}}',
            idDocument: '{{contact}}-{{date}}-{{direction.key}}-{{description}}',
            idGroup: '{{contact}}',
          },
          options: {
            direction: [
              { key: 'IN', name: 'Incoming' },
              { key: 'OT', name: 'Outgoing' },
            ],
          },
        },
        storageContextConfig: {
          folder: '1Admin/Communication/{{Document.data.contact}}',
          subfolder: 'Archive/{{Document.data.direction.key}}',
          deep: {
            nestedFolder: 'Deep/{{Document.data.summary}}',
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'OutgoingCommWorkflow',
              activitySequence: [
                {
                  type: 'LOG_DOCUMENT',
                  payload: {
                    targetPath: '{{StorageContext.folder}}/{{Document.data.summary}}',
                    archivePath: '{{StorageContext.subfolder}}/{{Document.data.testCalculatedField}}',
                    deepPath: '{{StorageContext.deep.nestedFolder}}',
                    documentId: '{{Document.id}}',
                    documentType: '{{Document.type}}',
                    schemaIdentityId: '{{documentSchema.identity.id}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const errors = validateManifestTemplates(validManifest, evaluator);
      expect(errors).toEqual([]);
    });

    it('expands option properties and option tuples in base and execution variables', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'option-test',
        name: 'Option Test',
        documentSchema: {
          fields: [
            {
              key: 'category',
              name: 'Category',
              type: 'string',
              options: {
                source: 'categorySource',
                key: 'code',
                name: 'label',
              },
            },
          ],
          options: {
            categorySource: [
              { code: 'CAT_A', label: 'Category A', customTupleProp: 'extra' },
            ],
          },
          calculatedFields: [
            {
              key: 'fullLabel',
              template: '{{category.code}}-{{category.label}}-{{category.customTupleProp}}',
            },
          ],
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                {
                  type: 'ACT_1',
                  payload: {
                    code: '{{Document.data.category.code}}',
                    label: '{{Document.data.category.label}}',
                    customProp: '{{Document.data.category.customTupleProp}}',
                    calc: '{{Document.data.fullLabel}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([]);
    });

    it('recursively expands deeply nested option tuple properties in base variables', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'nested-option-test',
        name: 'Nested Option Test',
        documentSchema: {
          fields: [
            {
              key: 'department',
              name: 'Department',
              type: 'string',
              options: {
                source: 'departmentSource',
                key: 'code',
                name: 'title',
              },
            },
          ],
          options: {
            departmentSource: [
              {
                code: 'ENG',
                title: 'Engineering',
                metadata: {
                  division: {
                    id: 'DIV-10',
                    tag: 'Core',
                  },
                },
              },
            ],
          },
          calculatedFields: [
            {
              key: 'divisionTag',
              template: '{{department.metadata.division.id}}-{{department.metadata.division.tag}}',
            },
          ],
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                {
                  type: 'ACT_1',
                  payload: {
                    divTag: '{{Document.data.department.metadata.division.tag}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([]);
    });

    it('whitelists dynamic Context.* and Context variables in workflow activities', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'context-test',
        name: 'Context Test',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string' }],
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'DynamicWorkflow',
              activitySequence: [
                {
                  type: 'CREATE_FOLDER',
                  payload: {
                    name: '{{Document.data.title}}',
                  },
                },
                {
                  type: 'MOVE_FILE',
                  payload: {
                    parentFolderId: '{{Context.generatedFolderId}}',
                    nestedOutput: '{{Context.stepResults.destinationPath}}',
                    fullContext: '{{Context}}',
                    validDocumentTitle: '{{Document.data.title}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([]);
    });

    it('returns exact error path for invalid calculatedFields templates', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'bad-calc',
        name: 'Bad Calc',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string' }],
          calculatedFields: [
            {
              key: 'validCalc',
              template: '{{title}}',
            },
            {
              key: 'badCalc',
              template: '{{title}}-{{unknownField}}',
            },
          ],
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([
        'Invalid template at "documentSchema.calculatedFields[1].template": references unknown fields or is malformed.',
      ]);
    });

    it('returns exact error path for invalid identity templates', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'bad-identity',
        name: 'Bad Identity',
        documentSchema: {
          fields: [{ key: 'contact', name: 'Contact', type: 'string' }],
          identity: {
            id: '{{contact}}',
            idDocument: '{{contact}}-{{nonExistent}}',
          },
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([
        'Invalid template at "documentSchema.identity.idDocument": references unknown fields or is malformed.',
      ]);
    });

    it('returns exact error path for invalid storageContextConfig templates', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'bad-storage',
        name: 'Bad Storage',
        documentSchema: {
          fields: [{ key: 'folderName', name: 'Folder Name', type: 'string' }],
        },
        storageContextConfig: {
          folder: '{{Document.data.folderName}}',
          subfolder: '{{Document.data.invalidStorageVar}}',
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([
        'Invalid template at "storageContextConfig.subfolder": references unknown fields or is malformed.',
      ]);
    });

    it('returns exact error path for invalid workflow activity payload templates', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'bad-workflow',
        name: 'Bad Workflow',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string' }],
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                {
                  type: 'ACT_1',
                  payload: {
                    folder: '{{Document.data.unknownActivityVar}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([
        'Invalid template at "documentWorkflowConfig.workflows[0].activitySequence[0].payload.folder": references unknown fields or is malformed.',
      ]);
    });

    it('collects and returns multiple validation errors across different manifest sections', () => {
      const evaluator = createEvaluator();
      const manifest: DocumentType = {
        key: 'multi-error',
        name: 'Multi Error',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string' }],
          calculatedFields: [
            { key: 'calc1', template: '{{missing1}}' },
          ],
          identity: {
            id: '{{missing2}}',
          },
        },
        storageContextConfig: {
          base: '{{Document.data.missing3}}',
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                {
                  type: 'ACT_1',
                  payload: {
                    badPayload: '{{Document.data.missing4}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const errors = validateManifestTemplates(manifest, evaluator);
      expect(errors).toEqual([
        'Invalid template at "documentSchema.calculatedFields[0].template": references unknown fields or is malformed.',
        'Invalid template at "documentSchema.identity.id": references unknown fields or is malformed.',
        'Invalid template at "storageContextConfig.base": references unknown fields or is malformed.',
        'Invalid template at "documentWorkflowConfig.workflows[0].activitySequence[0].payload.badPayload": references unknown fields or is malformed.',
      ]);
    });

    it('fails when evaluator reports syntax error or malformed template', () => {
      const syntaxErrorEvaluator: TemplateEvaluatorPort = {
        validate: vi.fn().mockReturnValue(false),
        evaluate: vi.fn(),
      };
      const manifest: DocumentType = {
        key: 'malformed-template',
        name: 'Malformed Template',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string' }],
          calculatedFields: [
            { key: 'broken', template: '{{#if title}}malformed{{/if}}' },
          ],
        },
      };

      const errors = validateManifestTemplates(manifest, syntaxErrorEvaluator);
      expect(errors).toEqual([
        'Invalid template at "documentSchema.calculatedFields[0].template": references unknown fields or is malformed.',
      ]);
    });

    it('strictly enforces Document.id and Document.type in execution variables, rejecting Document.idDocument and Document.idGroup', () => {
      const evaluator = createEvaluator();
      const manifestWithScopeCreepVars: DocumentType = {
        key: 'scope-creep-document',
        name: 'Scope Creep Document',
        documentSchema: {
          fields: [{ key: 'contact', name: 'Contact', type: 'string' }],
          identity: {
            id: 'ID-{{contact}}',
            idDocument: 'REC-{{contact}}',
            idGroup: 'GRP-{{contact}}',
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                {
                  type: 'ACT_1',
                  payload: {
                    validId: '{{Document.id}}',
                    validType: '{{Document.type}}',
                    invalidIdDocument: '{{Document.idDocument}}',
                    invalidIdGroup: '{{Document.idGroup}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const errors = validateManifestTemplates(manifestWithScopeCreepVars, evaluator);
      expect(errors).toEqual([
        'Invalid template at "documentWorkflowConfig.workflows[0].activitySequence[0].payload.invalidIdDocument": references unknown fields or is malformed.',
        'Invalid template at "documentWorkflowConfig.workflows[0].activitySequence[0].payload.invalidIdGroup": references unknown fields or is malformed.',
      ]);
    });
  });

  describe('Drive Core Exceptions', () => {
    it('DriveServiceError has correct name and inheritance', () => {
      const error = new DriveServiceError('Drive error');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DriveServiceError);
      expect(error.name).toBe('DriveServiceError');
      expect(error.message).toBe('Drive error');
    });

    it('AmbiguousPathSpecError inherits from DriveServiceError', () => {
      const error = new AmbiguousPathSpecError('Too many matches');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DriveServiceError);
      expect(error).toBeInstanceOf(AmbiguousPathSpecError);
      expect(error.name).toBe('AmbiguousPathSpecError');
      expect(error.message).toBe('Too many matches');
    });

    it('AmbiguousFileError inherits from DriveServiceError', () => {
      const error = new AmbiguousFileError('Multiple files found');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DriveServiceError);
      expect(error).toBeInstanceOf(AmbiguousFileError);
      expect(error.name).toBe('AmbiguousFileError');
      expect(error.message).toBe('Multiple files found');
    });

    it('FileNotFoundError inherits from DriveServiceError', () => {
      const error = new FileNotFoundError('File not found');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DriveServiceError);
      expect(error).toBeInstanceOf(FileNotFoundError);
      expect(error.name).toBe('FileNotFoundError');
      expect(error.message).toBe('File not found');
    });
  });
});









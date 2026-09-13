import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { DocumentSchemaRegistryAdapter } from './document-schema-registry';
import { FormSchemaType, type RawManifestProviderPort, type TemplateEvaluatorPort } from '../ports';

describe('DocumentSchemaRegistryAdapter', () => {
  let mockEvaluator: TemplateEvaluatorPort;

  function createMockEvaluator(
    validateImpl: boolean | ((template: string, allowedVariables: string[]) => boolean) = true
  ): TemplateEvaluatorPort {
    return {
      validate:
        typeof validateImpl === 'function'
          ? vi.fn().mockImplementation(validateImpl)
          : vi.fn().mockReturnValue(validateImpl),
      evaluate: vi.fn(),
    };
  }

  beforeEach(() => {
    mockEvaluator = createMockEvaluator(true);
  });

  function createMockManifestProvider(
    schemas: unknown[] | Record<string, unknown> = []
  ): RawManifestProviderPort {
    const entries: [string, unknown][] = Array.isArray(schemas)
      ? schemas.map((s, i) => [`./schemas/type-${i}.json`, s])
      : Object.entries(schemas);
    const paths = entries.map(([relPath]) => relPath);
    const schemaMap = new Map(entries);

    return {
      getRawManifest: vi.fn(async () => ({ documentTypes: paths })),
      readParsedSchema: vi.fn(async (relPath: string) => {
        const schema = schemaMap.get(relPath);
        if (schema === undefined) {
          throw new Error(`Failed to read DocumentType file "${relPath}"`);
        }
        return schema;
      }),
    };
  }

  it('propagates error when getRawManifest rejects', async () => {
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockRejectedValue(new Error('Failed to load raw manifest')),
      readParsedSchema: vi.fn(),
    };
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    await expect(adapter.loadAll()).rejects.toThrow(/failed to load raw manifest/i);
  });

  it('propagates error when readParsedSchema rejects', async () => {
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./schemas/missing-type.json'] }),
      readParsedSchema: vi.fn().mockRejectedValue(new Error('Failed to read DocumentType file')),
    };
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    await expect(adapter.loadAll()).rejects.toThrow(/failed to read documenttype file/i);
  });

  it('returns empty array when documentTypes is empty or undefined', async () => {
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: async () => ({}),
      readParsedSchema: vi.fn(),
    };
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    const result = await adapter.loadAll();
    expect(result).toEqual([]);
    expect(mockProvider.readParsedSchema).not.toHaveBeenCalled();
  });

  it('anti-corruption layer: rejects document type JSON missing required fields', async () => {
    const mockProvider = createMockManifestProvider({
      './schemas/invalid-type.json': {
        name: 'Invalid Document Type',
        documentSchema: {},
      },
    });
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    await expect(adapter.loadAll()).rejects.toThrow(/invalid DocumentType schema/i);
  });

  it('anti-corruption layer: rejects document type JSON with invalid field definitions', async () => {
    const mockProvider = createMockManifestProvider({
      './schemas/invalid-field.json': {
        key: 'invalid-field-type',
        name: 'Invalid Field Type',
        documentSchema: {
          fields: [
            {
              key: 'BadField',
            },
          ],
        },
      },
    });
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    await expect(adapter.loadAll()).rejects.toThrow(/invalid DocumentType schema/i);
  });

  it('loads and returns validated DocumentType objects for valid schema files', async () => {
    const commSchema = {
      key: 'comm-project',
      name: 'Communication Project',
      documentSchema: {
        fields: [
          {
            key: 'Contact',
            name: 'Contact',
            type: 'string',
            required: true,
          },
        ],
      },
      documentUiSchema: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitComm',
          },
        },
      },
    };

    const submittalSchema = {
      key: 'submittal',
      name: 'Submittal',
      documentSchema: {
        fields: [
          {
            key: 'SpecNumber',
            name: 'Spec Number',
            type: 'string',
            required: true,
          },
        ],
      },
    };

    const mockProvider = createMockManifestProvider({
      './schemas/comm.json': commSchema,
      './schemas/submittal.json': submittalSchema,
    });
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    const result = await adapter.loadAll();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(commSchema);
    expect(result[1]).toEqual(submittalSchema);
  });

  it('loads DocumentType with DocumentField omitting required property', async () => {
    const optionalFieldSchema = {
      key: 'document-with-optional-field',
      name: 'Document With Optional Field',
      documentSchema: {
        fields: [
          {
            key: 'FieldWithoutReq',
            name: 'Field Without Req',
            type: 'string',
          },
        ],
      },
    };

    const mockProvider = createMockManifestProvider({
      './schemas/optional-field.json': optionalFieldSchema,
    });
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    const result = await adapter.loadAll();

    expect(result).toHaveLength(1);
    expect(result[0].documentSchema.fields[0].required).toBeUndefined();
    expect(result[0]).toEqual(optionalFieldSchema);
  });

  it('anti-corruption layer: strips unmapped and undeclared raw JSON properties on loadAll', async () => {
    const rawSchemaWithExtraProps = {
      key: 'extra-props-type',
      name: 'Extra Props Type',
      unknownTopLevelProp: 'to-be-stripped',
      anotherSecretKey: 9999,
      documentSchema: {
        fields: [
          {
            key: 'FieldOne',
            name: 'Field One',
            type: 'string',
            required: true,
            undeclaredFieldProp: 'strip-me',
            extraObj: { foo: 'bar' },
          },
        ],
        undeclaredSchemaProp: 'should-also-be-stripped',
      },
      documentUiSchema: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitExtra',
            extraUiProp: 123,
          },
        },
        bogusUiProp: true,
      },
    };

    const mockProvider = createMockManifestProvider({
      './schemas/extra.json': rawSchemaWithExtraProps,
    });
    const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
    const result = await adapter.loadAll();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      key: 'extra-props-type',
      name: 'Extra Props Type',
      documentSchema: {
        fields: [
          {
            key: 'FieldOne',
            name: 'Field One',
            type: 'string',
            required: true,
          },
        ],
      },
      documentUiSchema: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitExtra',
          },
        },
      },
    });

    expect(result[0]).not.toHaveProperty('unknownTopLevelProp');
    expect(result[0]).not.toHaveProperty('anotherSecretKey');
    expect(result[0].documentSchema).not.toHaveProperty('undeclaredSchemaProp');
    expect(result[0].documentSchema.fields[0]).not.toHaveProperty('undeclaredFieldProp');
    expect(result[0].documentSchema.fields[0]).not.toHaveProperty('extraObj');
    expect(result[0].documentUiSchema).not.toHaveProperty('bogusUiProp');
    expect(result[0].documentUiSchema?.events?.onSubmit).not.toHaveProperty('extraUiProp');
  });

  describe('calculatedFields template validation on loadAll', () => {
    it('successfully loads document types with valid calculatedFields templates when templateEvaluator is provided', async () => {
      const documentType = {
        key: 'calc-valid',
        name: 'Calc Valid',
        documentSchema: {
          fields: [
            { key: 'Title', name: 'Title', type: 'string', required: true },
            { key: 'Category', name: 'Category', type: 'string', required: true },
          ],
          calculatedFields: [
            {
              key: 'FullCode',
              template: '{{Category}}-{{Title}}',
            },
          ],
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/calc-valid.json': documentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);

      const result = await adapter.loadAll();
      expect(result).toHaveLength(1);
      expect(result[0].documentSchema.calculatedFields).toEqual([
        {
          key: 'FullCode',
          template: '{{Category}}-{{Title}}',
        },
      ]);
      expect(mockEvaluator.validate).toHaveBeenCalledWith(
        '{{Category}}-{{Title}}',
        expect.arrayContaining(['Title', 'Category'])
      );
    });

    it('includes lookup field tuple properties in allowedVariables for template validation', async () => {
      const documentType = {
        key: 'calc-lookup',
        name: 'Calc Lookup',
        documentSchema: {
          fields: [
            { key: 'Title', name: 'Title', type: 'string', required: true },
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
          calculatedFields: [
            {
              key: 'FullCode',
              template: '{{Direction.Name}}-{{Direction.Key}}-{{Title}}',
            },
          ],
          options: {
            Direction: [
              { Key: 'IN', Name: 'Incoming', Description: 'Inbound item' },
            ],
          },
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/calc-lookup.json': documentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);

      const result = await adapter.loadAll();
      expect(result).toHaveLength(1);
      expect(mockEvaluator.validate).toHaveBeenCalledWith(
        '{{Direction.Name}}-{{Direction.Key}}-{{Title}}',
        expect.arrayContaining([
          'Title',
          'Direction',
          'Direction.Key',
          'Direction.Name',
          'Direction.Description',
        ])
      );
    });

    it('throws explicit fatal domain error if a calculatedFields template references a missing field', async () => {
      const documentType = {
        key: 'calc-invalid',
        name: 'Calc Invalid',
        documentSchema: {
          fields: [
            { key: 'Title', name: 'Title', type: 'string', required: true },
          ],
          calculatedFields: [
            {
              key: 'BadCalc',
              template: '{{Title}}-{{DoesNotExist}}',
            },
          ],
        },
      };

      const evaluator = createMockEvaluator(false);
      const mockProvider = createMockManifestProvider({
        './schemas/calc-invalid.json': documentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, evaluator);

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid template in "calc-invalid": Invalid template at "documentSchema\.calculatedFields\[0\]\.template": references unknown fields or is malformed\./
      );
      expect(evaluator.validate).toHaveBeenCalledWith(
        '{{Title}}-{{DoesNotExist}}',
        expect.arrayContaining(['Title'])
      );
    });
  });

  describe('identity template validation on loadAll', () => {
    it('successfully loads document types with valid identity templates when templateEvaluator is provided', async () => {
      const documentType = {
        key: 'identity-valid',
        name: 'Identity Valid',
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
      };

      const mockProvider = createMockManifestProvider({
        './schemas/identity-valid.json': documentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);

      const result = await adapter.loadAll();
      expect(result).toHaveLength(1);
      expect(result[0].documentSchema.identity).toEqual({
        id: '{{contact}}-{{date}}-{{direction}}-{{description}}',
        idDocument: '{{contact}}-{{date}}-{{direction}}-{{description}}',
        idGroup: '{{contact}}',
      });
      expect(mockEvaluator.validate).toHaveBeenCalledWith(
        '{{contact}}-{{date}}-{{direction}}-{{description}}',
        expect.arrayContaining(['contact', 'date', 'direction', 'description'])
      );
      expect(mockEvaluator.validate).toHaveBeenCalledWith(
        '{{contact}}',
        expect.arrayContaining(['contact', 'date', 'direction', 'description'])
      );
    });

    it('throws explicit fatal domain error if an identity template references an unknown field or is malformed', async () => {
      const documentType = {
        key: 'identity-invalid',
        name: 'Identity Invalid',
        documentSchema: {
          fields: [
            { key: 'contact', name: 'Contact', type: 'string', required: true },
          ],
          identity: {
            id: '{{contact}}-{{unknownField}}',
          },
        },
      };

      const evaluator = createMockEvaluator((tpl: string) => !tpl.includes('unknownField'));
      const mockProvider = createMockManifestProvider({
        './schemas/identity-invalid.json': documentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, evaluator);

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid template in "identity-invalid": Invalid template at "documentSchema\.identity\.id": references unknown fields or is malformed\./
      );
    });
  });

  describe('workflow and storageContext template validation on loadAll', () => {
    it('throws explicit fatal domain error if a workflow activity template is invalid', async () => {
      const documentType = {
        key: 'workflow-invalid',
        name: 'Workflow Invalid',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'TestWorkflow',
              activitySequence: [
                {
                  type: 'LOG_DOCUMENT',
                  payload: {
                    folder: '{{Document.data.title}}-{{InvalidField}}',
                  },
                },
              ],
            },
          ],
        },
      };

      const evaluator = createMockEvaluator((tpl: string) => !tpl.includes('InvalidField'));
      const mockProvider = createMockManifestProvider({
        './schemas/workflow-invalid.json': documentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, evaluator);

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid template in "workflow-invalid": Invalid template at "documentWorkflowConfig\.workflows\[0\]\.activitySequence\[0\]\.payload\.folder": references unknown fields or is malformed\./
      );
    });

    it('throws explicit fatal domain error if a storageContextConfig template is invalid', async () => {
      const documentType = {
        key: 'storage-invalid',
        name: 'Storage Invalid',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        },
        storageContextConfig: {
          targetFolder: '{{Document.data.unknownStorageField}}',
        },
      };

      const evaluator = createMockEvaluator((tpl: string) => !tpl.includes('unknownStorageField'));
      const mockProvider = createMockManifestProvider({
        './schemas/storage-invalid.json': documentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, evaluator);

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid template in "storage-invalid": Invalid template at "storageContextConfig\.targetFolder": references unknown fields or is malformed\./
      );
    });
  });

  describe('SchemaQueryPort (getForms)', () => {
    it('returns FormSchema array stripping backend configs and validates against FormSchemaType', async () => {
      const mockDocumentType = {
        key: 'comm-proj',
        name: 'Communication Project',
        documentSchema: {
          fields: [
            {
              key: 'subject',
              name: 'Subject',
              type: 'string',
              required: true,
              options: {
                source: 'subjects',
                key: 'key',
                name: 'name',
                allowUserInput: true,
              },
            },
          ],
        },
        documentUiSchema: {
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
      };

      const mockProvider = createMockManifestProvider({
        './schemas/comm-proj.json': mockDocumentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);

      const forms = await adapter.getForms();
      expect(forms).toHaveLength(1);
      expect(forms[0]).toEqual({
        key: 'comm-proj',
        name: 'Communication Project',
        documentSchema: {
          fields: [
            {
              key: 'subject',
              name: 'Subject',
              type: 'string',
              required: true,
              options: {
                source: 'subjects',
                key: 'key',
                name: 'name',
                allowUserInput: true,
              },
            },
          ],
        },
        documentUiSchema: {
          events: {
            onSubmit: {
              catchAllWorkflow: 'HandleComm',
            },
          },
        },
      });

      expect(Value.Check(FormSchemaType, forms[0])).toBe(true);
      expect(forms[0]).not.toHaveProperty('documentWorkflowConfig');
      expect(forms[0]).not.toHaveProperty('storageContextConfig');
      expect(forms[0].documentSchema.fields[0].options?.allowUserInput).toBe(true);
    });

    it('returns cached forms on subsequent getForms calls without re-reading manifest', async () => {
      const mockDocumentType = {
        key: 'simple-doc',
        name: 'Simple Document',
        documentSchema: {
          fields: [{ key: 'name', name: 'Name', type: 'string', required: true }],
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/simple.json': mockDocumentType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);

      const firstCall = await adapter.getForms();
      const secondCall = await adapter.getForms();

      expect(firstCall).toEqual(secondCall);
      expect(mockProvider.getRawManifest).toHaveBeenCalledTimes(1);
      expect(mockProvider.readParsedSchema).toHaveBeenCalledTimes(1);
    });

    it('computes evaluationOrder on documentUiSchema during loadAll and attaches to FormSchema', async () => {
      const mockDocumentType = {
        key: 'invoice-doc',
        name: 'Invoice Document',
        documentSchema: {
          fields: [
            { key: 'unitPrice', name: 'Unit Price', type: 'number', required: true },
            { key: 'quantity', name: 'Quantity', type: 'number', required: true },
            { key: 'total', name: 'Total', type: 'number', required: true },
          ],
        },
        documentUiSchema: {
          fields: {
            unitPrice: { label: 'Unit Price' },
            quantity: { label: 'Quantity' },
            total: {
              label: 'Total',
              computeValue: {
                and: [{ var: 'data.unitPrice' }, { var: 'data.quantity' }],
              },
            },
          },
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/invoice.json': mockDocumentType,
      });
      const mockEnsurer = vi.fn().mockImplementation((ui) => ({
        ...ui,
        evaluationOrder: ['unitPrice', 'quantity', 'total'],
      }));
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator, mockEnsurer);

      const documentTypes = await adapter.loadAll();
      expect(
        (documentTypes[0].documentUiSchema as { evaluationOrder?: string[] })?.evaluationOrder
      ).toEqual(['unitPrice', 'quantity', 'total']);

      const forms = await adapter.getForms();
      expect(forms[0].documentUiSchema?.evaluationOrder).toEqual([
        'unitPrice',
        'quantity',
        'total',
      ]);
    });

    it('runs evaluationOrderEnsurer during loadAll when documentUiSchema defines layout without fields', async () => {
      const mockDocumentType = {
        key: 'layout-only-doc',
        name: 'Layout Only Document',
        documentSchema: {
          fields: [
            { key: 'colA', name: 'Column A', type: 'string', required: true },
            { key: 'colB', name: 'Column B', type: 'string', required: true },
          ],
        },
        documentUiSchema: {
          layout: ['colA', 'colB'],
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/layout-only.json': mockDocumentType,
      });
      const mockEnsurer = vi.fn().mockImplementation((ui) => ({
        ...ui,
        evaluationOrder: ['colA', 'colB'],
      }));
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator, mockEnsurer);

      const documentTypes = await adapter.loadAll();
      expect(mockEnsurer).toHaveBeenCalledTimes(1);
      expect(
        (documentTypes[0].documentUiSchema as { evaluationOrder?: string[] })?.evaluationOrder
      ).toEqual(['colA', 'colB']);
    });

    it('fails loudly during loadAll when circular dependencies exist in computeValue', async () => {
      const mockCircularDocType = {
        key: 'circular-doc',
        name: 'Circular Document',
        documentSchema: {
          fields: [
            { key: 'fieldA', name: 'Field A', type: 'string', required: true },
            { key: 'fieldB', name: 'Field B', type: 'string', required: true },
          ],
        },
        documentUiSchema: {
          fields: {
            fieldA: {
              computeValue: { var: 'data.fieldB' },
            },
            fieldB: {
              computeValue: { var: 'data.fieldA' },
            },
          },
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/circular.json': mockCircularDocType,
      });
      const mockEnsurer = vi.fn().mockImplementation(() => {
        throw new Error('Circular dependency detected in computeValue rules: fieldA, fieldB');
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator, mockEnsurer);

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid DocumentType UI schema "circular-doc": Circular dependency detected in computeValue rules/i
      );
    });

    it('fails loudly during loadAll when documentUiSchema fails schema validation', async () => {
      const mockInvalidUiDocType = {
        key: 'invalid-ui-doc',
        name: 'Invalid UI Doc',
        documentSchema: {
          fields: [{ key: 'fieldA', name: 'Field A', type: 'string', required: true }],
        },
        documentUiSchema: {
          fields: 'not-an-object',
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/invalid-ui.json': mockInvalidUiDocType,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid DocumentType.*schema.*invalid-ui-doc/i
      );
    });
  });
});

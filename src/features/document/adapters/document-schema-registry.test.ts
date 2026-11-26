import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DocumentSchemaRegistryAdapter, stripOptionAliases } from './document-schema-registry';
import { type RawManifestProviderPort, type TemplateEvaluatorPort } from '../ports';
import { HandlebarsAdapter } from '../../../infrastructure/template-engine/handlebars-adapter';

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

    it('fails fast on loadAll when Activity.id is invalid, duplicated in a workflow, or WRITE_LOG fileSourceStepId is invalid', async () => {
      const invalidIdDoc = {
        key: 'invalid-step-id',
        name: 'Invalid Step Id',
        documentSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [{ id: '9invalid', type: 'MOVE_FILE', payload: {} }],
            },
          ],
        },
      };
      const duplicateIdDoc = {
        key: 'duplicate-step-id',
        name: 'Duplicate Step Id',
        documentSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                { id: 'moveStep', type: 'MOVE_FILE', payload: {} },
                { id: 'moveStep', type: 'DUPLICATE_FILE', payload: {} },
              ],
            },
          ],
        },
      };
      const badFileSourceDoc = {
        key: 'bad-file-source',
        name: 'Bad File Source',
        documentSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                { type: 'WRITE_LOG', payload: { fileSourceStepId: 'moveStep' } },
                { id: 'moveStep', type: 'MOVE_FILE', payload: {} },
              ],
            },
          ],
        },
      };

      const invalidIdAdapter = new DocumentSchemaRegistryAdapter(
        createMockManifestProvider({ './schemas/invalid-id.json': invalidIdDoc }),
        mockEvaluator
      );
      await expect(invalidIdAdapter.loadAll()).rejects.toThrow(/Invalid DocumentType schema/i);

      const dupIdAdapter = new DocumentSchemaRegistryAdapter(
        createMockManifestProvider({ './schemas/dup-id.json': duplicateIdDoc }),
        mockEvaluator
      );
      await expect(dupIdAdapter.loadAll()).rejects.toThrow(/Duplicate Activity id "moveStep"/i);

      const badSourceAdapter = new DocumentSchemaRegistryAdapter(
        createMockManifestProvider({ './schemas/bad-source.json': badFileSourceDoc }),
        mockEvaluator
      );
      await expect(badSourceAdapter.loadAll()).rejects.toThrow(/fileSourceStepId/i);
    });

    it('preserves valid Activity.id and WRITE_LOG fileSourceStepId during loadAll', async () => {
      const validWorkflowDoc = {
        key: 'valid-chained-workflow',
        name: 'Valid Chained Workflow',
        documentSchema: { fields: [{ key: 'title', name: 'Title', type: 'string', required: true }] },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'W1',
              activitySequence: [
                { id: 'moveStep', type: 'MOVE_FILE', payload: {} },
                { id: 'logStep', type: 'WRITE_LOG', payload: { fileSourceStepId: 'moveStep' } },
              ],
            },
          ],
        },
      };

      const adapter = new DocumentSchemaRegistryAdapter(
        createMockManifestProvider({ './schemas/valid-chained.json': validWorkflowDoc }),
        mockEvaluator
      );
      const loaded = await adapter.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].documentWorkflowConfig?.workflows[0].activitySequence).toEqual([
        { id: 'moveStep', type: 'MOVE_FILE', payload: {} },
        { id: 'logStep', type: 'WRITE_LOG', payload: { fileSourceStepId: 'moveStep' } },
      ]);
    });
  });

  describe('loadAll evaluationOrder and validation', () => {
    it('computes evaluationOrder on documentUiSchema during loadAll', async () => {
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

    it('strips aliases from option tuples during loadAll via stripOptionAliases', async () => {
      const rawSchema = {
        key: 'comm-project',
        name: 'Communication Project',
        documentSchema: {
          fields: [
            {
              key: 'direction',
              name: 'Direction',
              type: 'string',
              options: { source: 'direction', key: 'key', name: 'name' },
            },
          ],
          options: {
            direction: [
              { key: 'IN', name: 'Incoming', aliases: ['inbound', 'received'] },
              { key: 'OT', name: 'Outgoing', aliases: ['outbound', 'sent'] },
            ],
          },
        },
      };
      const mockProvider = createMockManifestProvider({
        './schemas/comm.json': rawSchema,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
      const result = await adapter.loadAll();
      expect(result).toHaveLength(1);
      expect(result[0].documentSchema.options?.direction).toEqual([
        { key: 'IN', name: 'Incoming' },
        { key: 'OT', name: 'Outgoing' },
      ]);
      expect('aliases' in (result[0].documentSchema.options!.direction[0] as Record<string, unknown>)).toBe(false);
      expect('aliases' in (result[0].documentSchema.options!.direction[1] as Record<string, unknown>)).toBe(false);
    });

    it('stripOptionAliases removes aliases from option tuples while preserving other properties', () => {
      const docType = {
        key: 'test',
        name: 'Test',
        documentSchema: {
          fields: [],
          options: {
            vendors: [
              { key: 'v1', name: 'Vendor 1', aliases: ['v-one'], customProp: 'hello' } as Record<string, unknown>,
            ],
          },
        },
      };
      const stripped = stripOptionAliases(docType as unknown as import('../domain').DocumentType);
      expect(stripped.documentSchema.options?.vendors).toEqual([
        { key: 'v1', name: 'Vendor 1', customProp: 'hello' },
      ]);
    });

    it('fails fast in loadAll when LookupField references unknown OptionSource or template/linkedField references undeclared property', async () => {
      const unknownSourceDoc = {
        key: 'bad-option-source',
        name: 'Bad Option Source',
        documentSchema: {
          fields: [
            {
              key: 'status',
              name: 'Status',
              type: 'string',
              required: true,
              options: { source: 'missingSource', key: 'key' },
            },
          ],
        },
      };
      const badAdapter = new DocumentSchemaRegistryAdapter(
        createMockManifestProvider({ './schemas/bad-source.json': unknownSourceDoc }),
        mockEvaluator
      );
      await expect(badAdapter.loadAll()).rejects.toThrow(/unknown OptionSource "missingSource"/i);
    });
  });

  describe('DocumentUiSuccessViewSchema & loadAll memoization (#385)', () => {
    it('retains valid documentUiSchema.successView through Value.Clean while stripping unknown keys', async () => {
      const schemaWithSuccessView = {
        key: 'submittal-test',
        name: 'Submittal Test',
        documentSchema: {
          fields: [
            { key: 'title', name: 'Title', type: 'string', required: true },
          ],
        },
        documentUiSchema: {
          layout: ['title'],
          fields: {
            title: { widget: 'textInput', label: 'Title' },
          },
          extraUiProp: 'strip-me',
          successView: {
            extraSuccessViewProp: 'strip-me-too',
            summary: {
              topLabel: 'Summary',
              text: '<b>{{title}}</b>',
              bottomLabel: '{{title}}',
              extraSummaryProp: 123,
            },
            artifacts: [
              {
                stepId: 'moveOriginal',
                label: 'Filed Original',
                whenWorkflow: { MainFlow: 'Archived Original' },
                fallbackLabel: 'Fallback Copy',
                extraArtifactProp: true,
              },
            ],
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'MainFlow',
              activitySequence: [
                { id: 'moveOriginal', type: 'MOVE_FILE', payload: {} },
              ],
            },
          ],
        },
      };

      const mockProvider = createMockManifestProvider({
        './schemas/submittal-test.json': schemaWithSuccessView,
      });
      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);
      const result = await adapter.loadAll();

      expect(result).toHaveLength(1);
      expect(result[0].documentUiSchema).toEqual({
        layout: ['title'],
        fields: {
          title: { widget: 'textInput', label: 'Title' },
        },
        successView: {
          summary: {
            topLabel: 'Summary',
            text: '<b>{{title}}</b>',
            bottomLabel: '{{title}}',
          },
          artifacts: [
            {
              stepId: 'moveOriginal',
              label: 'Filed Original',
              whenWorkflow: { MainFlow: 'Archived Original' },
              fallbackLabel: 'Fallback Copy',
            },
          ],
        },
      });
    });

    it('memoizes loadAll() after startup and retries if an earlier loadAll() rejected', async () => {
      let shouldFail = true;
      const docType = {
        key: 'memo-doc',
        name: 'Memo Doc',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        },
      };
      const mockProvider: RawManifestProviderPort = {
        getRawManifest: vi.fn(async () => {
          if (shouldFail) {
            throw new Error('transient manifest read error');
          }
          return { documentTypes: ['./schemas/memo-doc.json'] };
        }),
        readParsedSchema: vi.fn(async () => docType),
      };

      const adapter = new DocumentSchemaRegistryAdapter(mockProvider, mockEvaluator);

      await expect(adapter.loadAll()).rejects.toThrow(/transient manifest read error/i);

      shouldFail = false;
      const [first, second] = await Promise.all([adapter.loadAll(), adapter.loadAll()]);
      const third = await adapter.loadAll();

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(third).toHaveLength(1);
      // 1 failed call + 1 successful memoized call = 2 total getRawManifest calls
      expect(mockProvider.getRawManifest).toHaveBeenCalledTimes(2);
      expect(mockProvider.readParsedSchema).toHaveBeenCalledTimes(1);
    });

    it('accepts valid submittal-style successView including LinkedField and safe Card HTML with HandlebarsAdapter', async () => {
      const realEvaluator = new HandlebarsAdapter();
      const validDoc = {
        key: 'submittal-ffe-test',
        name: 'Submittal FF&E Test',
        documentSchema: {
          fields: [
            {
              key: 'specTag',
              name: 'Spec Tag',
              type: 'string',
              required: true,
              options: { source: 'specs', key: 'key', allowUserInput: true },
            },
            {
              key: 'specTitle',
              name: 'Spec Title',
              type: 'string',
              required: true,
              linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
            },
            {
              key: 'action',
              name: 'Action',
              type: 'string',
              required: true,
              options: { source: 'actions', key: 'key', name: 'name' },
            },
            { key: 'date', name: 'Date', type: 'string', required: true },
          ],
          calculatedFields: [{ key: 'fileName', template: '{{specTag.key}}-{{date}}' }],
          optionSources: {
            specs: { provider: 'document_log', properties: ['key', 'name'] },
            actions: { provider: 'document_log', properties: ['key', 'name'] },
          },
        },
        documentUiSchema: {
          successView: {
            summary: {
              topLabel: 'Spec {{specTag.key}} • {{action.key}}',
              text: '<b>{{action.name}}</b> • {{date}}',
              bottomLabel: '{{specTitle}}',
            },
            artifacts: [
              {
                stepId: 'insertCoverSheet',
                label: 'Review Copy (with Cover Sheet)',
                fallbackLabel: 'Transmittal Cover Sheet',
              },
              {
                stepId: 'moveOriginal',
                label: 'Filed Original',
                whenWorkflow: {
                  SubmittalReceived: 'Archived Original',
                  SubmittalSent: 'Filed Submittal',
                },
              },
            ],
          },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'SubmittalReceived',
              activitySequence: [
                { id: 'moveOriginal', type: 'MOVE_FILE', payload: {} },
                { id: 'insertCoverSheet', type: 'DUPLICATE_FILE', payload: {} },
              ],
            },
            {
              name: 'SubmittalSent',
              activitySequence: [
                { id: 'moveOriginal', type: 'MOVE_FILE', payload: {} },
              ],
            },
          ],
        },
      };

      const adapter = new DocumentSchemaRegistryAdapter(
        createMockManifestProvider({ './schemas/valid-sv.json': validDoc }),
        realEvaluator
      );
      const loaded = await adapter.loadAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].documentUiSchema?.successView?.summary?.text).toBe(
        '<b>{{action.name}}</b> • {{date}}'
      );
    });

    it('fails fast at startup on invalid successView Mustache templates, Stage-1 paths, unsafe HTML, HTML in topLabel/bottomLabel, and unknown stepId/whenWorkflow keys', async () => {
      const realEvaluator = new HandlebarsAdapter();
      const buildDoc = (successView: unknown) => ({
        key: 'sv-invalid',
        name: 'SV Invalid',
        documentSchema: {
          fields: [
            { key: 'title', name: 'Title', type: 'string', required: true },
            {
              key: 'action',
              name: 'Action',
              type: 'string',
              required: true,
              options: { source: 'actions', key: 'key', name: 'name' },
            },
          ],
          calculatedFields: [{ key: 'calcCode', template: '{{title}}' }],
          optionSources: {
            actions: { provider: 'document_log', properties: ['key', 'name'] },
          },
        },
        documentUiSchema: { successView },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'MainWorkflow',
              activitySequence: [{ id: 'moveOriginal', type: 'MOVE_FILE', payload: {} }],
            },
          ],
        },
      });

      const invalidCases: Array<{ label: string; successView: unknown }> = [
        {
          label: 'blank summary.text',
          successView: { summary: { text: '   ' } },
        },
        {
          label: 'blank summary.topLabel',
          successView: { summary: { topLabel: '  ', text: '{{title}}' } },
        },
        {
          label: 'blank summary.bottomLabel',
          successView: { summary: { text: '{{title}}', bottomLabel: '  ' } },
        },
        {
          label: 'logic block {{#if}} in summary.text',
          successView: { summary: { text: '{{#if title}}{{title}}{{/if}}' } },
        },
        {
          label: 'helper call in summary.topLabel',
          successView: { summary: { topLabel: '{{upper title}}', text: '{{title}}' } },
        },
        {
          label: 'triple-stache {{{title}}} in summary.text',
          successView: { summary: { text: '{{{title}}}' } },
        },
        {
          label: 'unknown field in summary.text',
          successView: { summary: { text: '{{doesNotExist}}' } },
        },
        {
          label: 'CalculatedField in summary.text',
          successView: { summary: { text: '{{calcCode}}' } },
        },
        {
          label: 'disallowed namespace Document.data in summary.text',
          successView: { summary: { text: '{{Document.data.title}}' } },
        },
        {
          label: 'disallowed space namespace in summary.topLabel',
          successView: { summary: { topLabel: '{{space.name}}', text: '{{title}}' } },
        },
        {
          label: 'property access on non-lookup field',
          successView: { summary: { text: '{{title.key}}' } },
        },
        {
          label: 'unknown lookup property on lookup field',
          successView: { summary: { text: '{{action.missingProp}}' } },
        },
        {
          label: 'unsafe <script> tag in summary.text',
          successView: { summary: { text: '<script>alert(1)</script>{{title}}' } },
        },
        {
          label: 'unclosed <b> tag in summary.text',
          successView: { summary: { text: '<b>{{title}}' } },
        },
        {
          label: 'attribute on <b> in summary.text',
          successView: { summary: { text: '<b onclick="x">{{title}}</b>' } },
        },
        {
          label: 'HTML <b> tag in summary.topLabel',
          successView: { summary: { topLabel: '<b>{{title}}</b>', text: '{{title}}' } },
        },
        {
          label: 'HTML <script> tag in summary.bottomLabel',
          successView: { summary: { text: '{{title}}', bottomLabel: '<script>x</script>' } },
        },
        {
          label: 'unknown stepId in artifacts',
          successView: { artifacts: [{ stepId: 'missingStep', label: 'Filed' }] },
        },
        {
          label: 'unknown whenWorkflow key in artifacts',
          successView: {
            artifacts: [
              {
                stepId: 'moveOriginal',
                label: 'Filed',
                whenWorkflow: { UnknownWorkflow: 'Archived' },
              },
            ],
          },
        },
        {
          label: 'blank artifact label',
          successView: { artifacts: [{ stepId: 'moveOriginal', label: '   ' }] },
        },
        {
          label: 'blank artifact fallbackLabel',
          successView: {
            artifacts: [{ stepId: 'moveOriginal', label: 'Filed', fallbackLabel: '   ' }],
          },
        },
      ];

      for (const testCase of invalidCases) {
        const adapter = new DocumentSchemaRegistryAdapter(
          createMockManifestProvider({ './schemas/invalid.json': buildDoc(testCase.successView) }),
          realEvaluator
        );
        await expect(
          adapter.loadAll(),
          `Expected failure for case: ${testCase.label}`
        ).rejects.toThrow(/Invalid template in "sv-invalid"/i);
      }
    });
  });
});

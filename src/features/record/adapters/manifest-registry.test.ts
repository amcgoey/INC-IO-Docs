import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ManifestRegistryAdapter } from './manifest-registry';

describe('ManifestRegistryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function createManifestFixture(
    dir: string,
    schemas: Record<string, unknown>,
    manifestOverrides?: Record<string, unknown>
  ): Promise<string> {
    const schemasDir = path.join(dir, 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });

    const recordTypePaths: string[] = [];
    for (const [filename, schema] of Object.entries(schemas)) {
      const filePath = path.join(schemasDir, filename);
      await fs.writeFile(filePath, typeof schema === 'string' ? schema : JSON.stringify(schema), 'utf-8');
      recordTypePaths.push(`./schemas/${filename}`);
    }

    const manifestPath = path.join(dir, 'manifest.json');
    const manifestContent = manifestOverrides ?? { recordTypes: recordTypePaths };
    await fs.writeFile(
      manifestPath,
      typeof manifestContent === 'string' ? manifestContent : JSON.stringify(manifestContent),
      'utf-8'
    );
    return manifestPath;
  }

  const mockEvaluator = {
    validate: vi.fn().mockReturnValue(true),
    evaluate: vi.fn(),
  };

  it('throws an error if no manifest path is provided in constructor', () => {
    expect(() => new ManifestRegistryAdapter({} as unknown as { manifestPath: string; templateEvaluator: typeof mockEvaluator })).toThrow(/manifest path is not defined/i);
    expect(() => new ManifestRegistryAdapter({ manifestPath: '', templateEvaluator: mockEvaluator })).toThrow(/manifest path is not defined/i);
  });

  it('throws an error if no template evaluator is provided in constructor', () => {
    expect(() => new ManifestRegistryAdapter({ manifestPath: 'manifest.json' } as unknown as { manifestPath: string; templateEvaluator: typeof mockEvaluator })).toThrow(/template evaluator is not defined/i);
  });

  it('throws an error if manifest file does not exist', async () => {
    const nonExistentPath = path.join(tempDir, 'missing-manifest.json');
    const adapter = new ManifestRegistryAdapter({ manifestPath: nonExistentPath, templateEvaluator: mockEvaluator });
    await expect(adapter.loadAll()).rejects.toThrow();
  });

  it('throws an error if manifest file contains malformed JSON', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, '{ malformed json: true }', 'utf-8');

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid json/i);
  });

  it('throws an error if manifest structure is invalid (missing recordTypes array)', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({ wrongField: [] }), 'utf-8');

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid manifest/i);
  });

  it('throws an error if a referenced record type file is missing', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ recordTypes: ['./missing-type.json'] }),
      'utf-8'
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    await expect(adapter.loadAll()).rejects.toThrow();
  });

  it('throws an error if a referenced record type file contains malformed JSON', async () => {
    const manifestPath = await createManifestFixture(
      tempDir,
      { 'invalid-json-type.json': '{ malformed record json }' }
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid json/i);
  });

  it('anti-corruption layer: rejects record type JSON missing required fields', async () => {
    // Missing 'key' and 'fields'
    const manifestPath = await createManifestFixture(
      tempDir,
      {
        'invalid-type.json': {
          name: 'Invalid Record Type',
          recordSchema: {},
        },
      }
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid RecordType schema/i);
  });

  it('anti-corruption layer: rejects record type JSON with invalid field definitions', async () => {
    // Field is missing 'type' and 'name'
    const manifestPath = await createManifestFixture(
      tempDir,
      {
        'invalid-field.json': {
          key: 'invalid-field-type',
          name: 'Invalid Field Type',
          recordSchema: {
            fields: [
              {
                key: 'BadField',
                // missing 'type' and 'name'
              },
            ],
          },
        },
      }
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid RecordType schema/i);
  });

  it('loads and returns validated RecordType objects for valid manifest and schema files', async () => {
    const commSchema = {
      key: 'comm-project',
      name: 'Communication Project',
      recordSchema: {
        fields: [
          {
            key: 'Contact',
            name: 'Contact',
            type: 'string',
            required: true,
          },
        ],
      },
      recordUiConfig: {
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
      recordSchema: {
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

    const manifestPath = await createManifestFixture(tempDir, {
      'comm.json': commSchema,
      'submittal.json': submittalSchema,
    });

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    const result = await adapter.loadAll();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(commSchema);
    expect(result[1]).toEqual(submittalSchema);
  });

  it('loads RecordType with RecordField omitting required property', async () => {
    const optionalFieldSchema = {
      key: 'record-with-optional-field',
      name: 'Record With Optional Field',
      recordSchema: {
        fields: [
          {
            key: 'FieldWithoutReq',
            name: 'Field Without Req',
            type: 'string',
          },
        ],
      },
    };

    const manifestPath = await createManifestFixture(tempDir, {
      'optional-field.json': optionalFieldSchema,
    });

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    const result = await adapter.loadAll();

    expect(result).toHaveLength(1);
    expect(result[0].recordSchema.fields[0].required).toBeUndefined();
    expect(result[0]).toEqual(optionalFieldSchema);
  });

  it('anti-corruption layer: strips unmapped and undeclared raw JSON properties on loadAll', async () => {
    const rawSchemaWithExtraProps = {
      key: 'extra-props-type',
      name: 'Extra Props Type',
      unknownTopLevelProp: 'to-be-stripped',
      anotherSecretKey: 9999,
      recordSchema: {
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
      recordUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitExtra',
            extraUiProp: 123,
          },
        },
        bogusUiProp: true,
      },
    };

    const manifestPath = await createManifestFixture(
      tempDir,
      { 'extra.json': rawSchemaWithExtraProps },
      {
        recordTypes: ['./schemas/extra.json'],
        extraManifestProp: 'remove-me',
      }
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath, templateEvaluator: mockEvaluator });
    const result = await adapter.loadAll();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      key: 'extra-props-type',
      name: 'Extra Props Type',
      recordSchema: {
        fields: [
          {
            key: 'FieldOne',
            name: 'Field One',
            type: 'string',
            required: true,
          },
        ],
      },
      recordUiConfig: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitExtra',
          },
        },
      },
    });

    expect(result[0]).not.toHaveProperty('unknownTopLevelProp');
    expect(result[0]).not.toHaveProperty('anotherSecretKey');
    expect(result[0].recordSchema).not.toHaveProperty('undeclaredSchemaProp');
    expect(result[0].recordSchema.fields[0]).not.toHaveProperty('undeclaredFieldProp');
    expect(result[0].recordSchema.fields[0]).not.toHaveProperty('extraObj');
    expect(result[0].recordUiConfig).not.toHaveProperty('bogusUiProp');
    expect(result[0].recordUiConfig?.events?.onSubmit).not.toHaveProperty('extraUiProp');
  });

  describe('calculatedFields template validation on loadAll', () => {
    it('successfully loads record types with valid calculatedFields templates when templateEvaluator is provided', async () => {
      const recordType = {
        key: 'calc-valid',
        name: 'Calc Valid',
        recordSchema: {
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

      const manifestPath = await createManifestFixture(tempDir, {
        'calc-valid.json': recordType,
      });

      const mockEvaluator = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn(),
      };

      const adapter = new ManifestRegistryAdapter({
        manifestPath,
        templateEvaluator: mockEvaluator,
      });

      const result = await adapter.loadAll();
      expect(result).toHaveLength(1);
      expect(result[0].recordSchema.calculatedFields).toEqual([
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
      const recordType = {
        key: 'calc-lookup',
        name: 'Calc Lookup',
        recordSchema: {
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

      const manifestPath = await createManifestFixture(tempDir, {
        'calc-lookup.json': recordType,
      });

      const mockEvaluator = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn(),
      };

      const adapter = new ManifestRegistryAdapter({
        manifestPath,
        templateEvaluator: mockEvaluator,
      });

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

    it('throws explicit fatal domain error if a calculatedFields template references a missing field (e.g. {{DoesNotExist}})', async () => {
      const recordType = {
        key: 'calc-invalid',
        name: 'Calc Invalid',
        recordSchema: {
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

      const manifestPath = await createManifestFixture(tempDir, {
        'calc-invalid.json': recordType,
      });

      const mockEvaluator = {
        validate: vi.fn().mockReturnValue(false),
        evaluate: vi.fn(),
      };

      const adapter = new ManifestRegistryAdapter({
        manifestPath,
        templateEvaluator: mockEvaluator,
      });

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid calculated field template in "\.\/schemas\/calc-invalid\.json" for field "BadCalc"/
      );
      expect(mockEvaluator.validate).toHaveBeenCalledWith(
        '{{Title}}-{{DoesNotExist}}',
        expect.arrayContaining(['Title'])
      );
    });
  });

  describe('identity template validation on loadAll', () => {
    it('successfully loads record types with valid identity templates when templateEvaluator is provided', async () => {
      const recordType = {
        key: 'identity-valid',
        name: 'Identity Valid',
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
      };

      const manifestPath = await createManifestFixture(tempDir, {
        'identity-valid.json': recordType,
      });

      const mockEvaluator = {
        validate: vi.fn().mockReturnValue(true),
        evaluate: vi.fn(),
      };

      const adapter = new ManifestRegistryAdapter({
        manifestPath,
        templateEvaluator: mockEvaluator,
      });

      const result = await adapter.loadAll();
      expect(result).toHaveLength(1);
      expect(result[0].recordSchema.identity).toEqual({
        id: '{{contact}}-{{date}}-{{direction}}-{{description}}',
        idRecord: '{{contact}}-{{date}}-{{direction}}-{{description}}',
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
      const recordType = {
        key: 'identity-invalid',
        name: 'Identity Invalid',
        recordSchema: {
          fields: [
            { key: 'contact', name: 'Contact', type: 'string', required: true },
          ],
          identity: {
            id: '{{contact}}-{{unknownField}}',
          },
        },
      };

      const manifestPath = await createManifestFixture(tempDir, {
        'identity-invalid.json': recordType,
      });

      const mockEvaluator = {
        validate: vi.fn().mockImplementation((tpl: string) => !tpl.includes('unknownField')),
        evaluate: vi.fn(),
      };

      const adapter = new ManifestRegistryAdapter({
        manifestPath,
        templateEvaluator: mockEvaluator,
      });

      await expect(adapter.loadAll()).rejects.toThrow(
        /Invalid identity template in "\.\/schemas\/identity-invalid\.json" for property "id": template "{{contact}}-{{unknownField}}" references unknown fields or is malformed\./
      );
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ManifestRegistryAdapter,
  ManifestSchema,
} from './manifest-registry';
import { Value } from '@sinclair/typebox/value';

describe('ManifestRegistryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('exports ManifestSchema', () => {
    expect(ManifestSchema).toBeDefined();
    expect(Value.Check(ManifestSchema, { recordTypes: ['a.json'] })).toBe(true);
  });

  it('throws an error if no manifest path is provided in constructor', () => {
    expect(() => new ManifestRegistryAdapter()).toThrow(/manifest path is not defined/i);
    expect(() => new ManifestRegistryAdapter({} as { manifestPath: string })).toThrow(/manifest path is not defined/i);
    expect(() => new ManifestRegistryAdapter({ manifestPath: '' })).toThrow(/manifest path is not defined/i);
  });

  it('throws an error if manifest file does not exist', async () => {
    const nonExistentPath = path.join(tempDir, 'missing-manifest.json');
    const adapter = new ManifestRegistryAdapter({ manifestPath: nonExistentPath });
    await expect(adapter.loadAll()).rejects.toThrow();
  });

  it('throws an error if manifest file contains malformed JSON', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, '{ malformed json: true }', 'utf-8');

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid json/i);
  });

  it('throws an error if manifest structure is invalid (missing recordTypes array)', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({ wrongField: [] }), 'utf-8');

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid manifest/i);
  });

  it('throws an error if a referenced record type file is missing', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ recordTypes: ['./missing-type.json'] }),
      'utf-8'
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    await expect(adapter.loadAll()).rejects.toThrow();
  });

  it('throws an error if a referenced record type file contains malformed JSON', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    const recordTypePath = path.join(tempDir, 'invalid-json-type.json');

    await fs.writeFile(
      manifestPath,
      JSON.stringify({ recordTypes: ['./invalid-json-type.json'] }),
      'utf-8'
    );
    await fs.writeFile(recordTypePath, '{ malformed record json }', 'utf-8');

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid json/i);
  });

  it('anti-corruption layer: rejects record type JSON missing required fields', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    const recordTypePath = path.join(tempDir, 'invalid-type.json');

    await fs.writeFile(
      manifestPath,
      JSON.stringify({ recordTypes: ['./invalid-type.json'] }),
      'utf-8'
    );

    // Missing 'key' and 'fields'
    await fs.writeFile(
      recordTypePath,
      JSON.stringify({
        name: 'Invalid Record Type',
        recordSchema: {},
      }),
      'utf-8'
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid RecordType schema/i);
  });

  it('anti-corruption layer: rejects record type JSON with invalid field definitions', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    const recordTypePath = path.join(tempDir, 'invalid-field.json');

    await fs.writeFile(
      manifestPath,
      JSON.stringify({ recordTypes: ['./invalid-field.json'] }),
      'utf-8'
    );

    // Field is missing 'type' and 'name'
    await fs.writeFile(
      recordTypePath,
      JSON.stringify({
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
      }),
      'utf-8'
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    await expect(adapter.loadAll()).rejects.toThrow(/invalid RecordType schema/i);
  });

  it('loads and returns validated RecordType objects for valid manifest and schema files', async () => {
    const schemasDir = path.join(tempDir, 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });

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

    await fs.writeFile(
      path.join(schemasDir, 'comm.json'),
      JSON.stringify(commSchema),
      'utf-8'
    );
    await fs.writeFile(
      path.join(schemasDir, 'submittal.json'),
      JSON.stringify(submittalSchema),
      'utf-8'
    );

    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        recordTypes: ['./schemas/comm.json', './schemas/submittal.json'],
      }),
      'utf-8'
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    const result = await adapter.loadAll();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(commSchema);
    expect(result[1]).toEqual(submittalSchema);
  });

  it('loads RecordType with RecordField omitting required property', async () => {
    const schemasDir = path.join(tempDir, 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });

    const optionalFieldSchema = {
      key: 'optional-req-doc',
      name: 'Optional Required Doc',
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

    await fs.writeFile(
      path.join(schemasDir, 'optional-req.json'),
      JSON.stringify(optionalFieldSchema),
      'utf-8'
    );

    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        recordTypes: ['./schemas/optional-req.json'],
      }),
      'utf-8'
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath });
    const result = await adapter.loadAll();

    expect(result).toHaveLength(1);
    expect(result[0].recordSchema.fields[0].required).toBeUndefined();
    expect(result[0]).toEqual(optionalFieldSchema);
  });

  it('anti-corruption layer: strips unmapped and undeclared raw JSON properties on loadAll', async () => {
    const schemasDir = path.join(tempDir, 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });

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

    const manifestWithExtraProps = {
      recordTypes: ['./schemas/extra.json'],
      extraManifestProp: 'remove-me',
    };

    await fs.writeFile(
      path.join(schemasDir, 'extra.json'),
      JSON.stringify(rawSchemaWithExtraProps),
      'utf-8'
    );

    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify(manifestWithExtraProps),
      'utf-8'
    );

    const adapter = new ManifestRegistryAdapter({ manifestPath });
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
});


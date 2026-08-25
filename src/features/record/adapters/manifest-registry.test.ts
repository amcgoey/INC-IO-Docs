import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Type } from '@sinclair/typebox';
import {
  ManifestRegistryAdapter,
  parseJson,
  validateAndCleanSchema,
} from './manifest-registry';
import { formatValidationErrors } from '../domain';


describe('ManifestRegistryAdapter', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('throws an error if no manifest path is provided in constructor', () => {
    expect(() => new ManifestRegistryAdapter()).toThrow(/manifest path is not defined/i);
    expect(() => new ManifestRegistryAdapter({} as any)).toThrow(/manifest path is not defined/i);
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

    // Field is missing 'required' and has invalid type
    await fs.writeFile(
      recordTypePath,
      JSON.stringify({
        key: 'invalid-field-type',
        name: 'Invalid Field Type',
        recordSchema: {
          fields: [
            {
              key: 'BadField',
              name: 'Bad Field',
              // missing 'type' and 'required'
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

describe('Helper functions', () => {
  describe('parseJson', () => {
    it('successfully parses valid JSON', () => {
      const data = parseJson('{"foo":"bar"}', 'test context');
      expect(data).toEqual({ foo: 'bar' });
    });

    it('throws formatted error with context and cause on invalid JSON', () => {
      expect(() => parseJson('{ invalid }', 'custom config at "/path/to/file"')).toThrowError(
        /^Invalid JSON in custom config at "\/path\/to\/file":/
      );
    });
  });

  describe('formatValidationErrors', () => {
    it('returns empty array when there are no errors', () => {
      const Schema = Type.Object({ name: Type.String() });
      const errors = formatValidationErrors(Schema, { name: 'test' });
      expect(errors).toEqual([]);
    });

    it('formats single and multiple schema errors with paths', () => {
      const Schema = Type.Object({
        name: Type.String(),
        count: Type.Number(),
      });
      const errors = formatValidationErrors(Schema, { name: 123, count: 'abc' });
      expect(errors.some((e) => e.includes('/name:'))).toBe(true);
      expect(errors.some((e) => e.includes('/count:'))).toBe(true);
    });
  });

  describe('validateAndCleanSchema', () => {
    it('returns cleaned object stripping undeclared properties when valid', () => {
      const Schema = Type.Object({
        id: Type.String(),
        nested: Type.Object({
          name: Type.String(),
        }),
      });

      const input = {
        id: '123',
        extraTop: 'ignore',
        nested: {
          name: 'test',
          extraNested: 456,
        },
      };

      const result = validateAndCleanSchema(Schema, input, 'Invalid object');
      expect(result).toEqual({
        id: '123',
        nested: {
          name: 'test',
        },
      });
      expect(result).not.toHaveProperty('extraTop');
      expect(result.nested).not.toHaveProperty('extraNested');
    });

    it('throws with prefix and error details when cleaned value fails validation', () => {
      const Schema = Type.Object({
        id: Type.String(),
        count: Type.Number(),
      });

      const invalidInput = {
        id: 123,
        count: 'invalid-number',
        extra: 'property',
      };

      expect(() =>
        validateAndCleanSchema(Schema, invalidInput, 'Invalid schema data')
      ).toThrowError(/^Invalid schema data: /);
    });
  });
});


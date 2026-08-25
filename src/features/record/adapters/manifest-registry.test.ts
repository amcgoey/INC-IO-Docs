import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Type } from '@sinclair/typebox';
import {
  ManifestRegistryAdapter,
  parseJson,
  validateSchema,
} from './manifest-registry';
import { formatValidationErrors } from '../domain';


describe('ManifestRegistryAdapter', () => {
  let tempDir: string;
  const originalEnv = process.env.APP_MANIFEST_PATH;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-test-'));
  });

  afterEach(async () => {
    process.env.APP_MANIFEST_PATH = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('throws an error if no manifest path is provided and APP_MANIFEST_PATH is unset', async () => {
    delete process.env.APP_MANIFEST_PATH;
    const adapter = new ManifestRegistryAdapter();
    await expect(adapter.loadAll()).rejects.toThrow(/manifest path is not defined/i);
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

  it('falls back to APP_MANIFEST_PATH environment variable if not passed in constructor', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    const typePath = path.join(tempDir, 'type.json');

    const validSchema = {
      key: 'env-test',
      name: 'Env Test',
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
    };

    await fs.writeFile(typePath, JSON.stringify(validSchema), 'utf-8');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ recordTypes: ['./type.json'] }),
      'utf-8'
    );

    process.env.APP_MANIFEST_PATH = manifestPath;

    const adapter = new ManifestRegistryAdapter();
    const result = await adapter.loadAll();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(validSchema);
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

  describe('validateSchema', () => {
    it('does not throw when value matches schema', () => {
      const Schema = Type.Object({ id: Type.String() });
      expect(() => validateSchema(Schema, { id: '123' }, 'Validation error')).not.toThrow();
    });

    it('throws with prefix and error details when value is invalid', () => {
      const Schema = Type.Object({ id: Type.String() });
      expect(() => validateSchema(Schema, { id: 123 }, 'Invalid item schema')).toThrowError(
        /^Invalid item schema: \/id: Expected string/
      );
    });
  });
});


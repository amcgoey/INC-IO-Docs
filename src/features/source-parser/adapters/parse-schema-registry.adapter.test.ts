import { describe, it, expect, vi } from 'vitest';
import {
  ParseSchemaRegistryAdapter,
  validateJsonLogicAst,
} from './parse-schema-registry.adapter';
import type { RawManifestProviderPort } from '../ports';

describe('ParseSchemaRegistryAdapter', () => {
  it('treats omitted manifestProvider as a safe no-op', async () => {
    const adapter = new ParseSchemaRegistryAdapter();
    await expect(adapter.initialize()).resolves.toBeUndefined();
    expect(adapter.getParseSchema('any')).toBeUndefined();
    expect(adapter.getTargetSchema('any')).toBeUndefined();
  });

  it('hydrates valid DocumentParseSchema and ParseTargetDocumentSchema', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        name: 'Test Doc',
        documentSchema: {
          fields: [
            { key: 'date', type: 'string' },
            {
              key: 'direction',
              type: 'string',
              options: { source: 'direction', key: 'key', name: 'name' },
            },
            { key: 'description', type: 'string' },
            { key: 'specTag', type: 'string' },
            {
              key: 'specTitle',
              type: 'string',
              linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
            },
          ],
          calculatedFields: [{ key: 'commFolderName', template: '{{date}}' }],
          options: {
            direction: [
              { key: 'IN', name: 'Incoming' },
              { key: 'OT', name: 'Outgoing' },
            ],
          },
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              name: 'Gmail Metadata',
              match: { '==': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
              fields: {
                date: { from: 'email.date' },
                direction: [
                  {
                    when: { in: ['SENT', { var: 'email.labels' }] },
                    set: 'OT',
                  },
                  { set: 'IN' },
                ],
                description: { from: 'email.subjectClean' },
              },
            },
            {
              source: 'drive',
              fields: {
                date: { custom: 'placeholder' },
              },
            },
          ],
          fallback: {
            strategy: 'ai',
            fields: ['description'],
          },
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await adapter.initialize();

    const parseSchema = adapter.getParseSchema('test-doc');
    expect(parseSchema).toBeDefined();
    expect(parseSchema?.extractors).toHaveLength(2);
    expect(parseSchema?.fallback?.strategy).toBe('ai');

    const targetSchema = adapter.getTargetSchema('test-doc');
    expect(targetSchema).toBeDefined();
    expect(targetSchema?.fields).toHaveLength(5);
    expect(targetSchema?.calculatedFields).toHaveLength(1);
    expect(targetSchema?.options?.direction).toHaveLength(2);
  });

  it('fails fast if documentParseSchema targets an unknown field', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [{ key: 'date', type: 'string' }],
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              fields: {
                unknownField: { from: 'email.subject' },
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'targets unknown field "unknownField"'
    );
  });

  it('fails fast if documentParseSchema targets a CalculatedField directly', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [{ key: 'date', type: 'string' }],
          calculatedFields: [{ key: 'commFolderName' }],
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              fields: {
                commFolderName: { from: 'email.subject' },
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'targets CalculatedField "commFolderName"'
    );
  });

  it('fails fast if documentParseSchema targets a direct LinkedField', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [
            { key: 'specTag', type: 'string' },
            {
              key: 'specTitle',
              type: 'string',
              linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
            },
          ],
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              fields: {
                specTitle: { from: 'email.subject' },
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'targets direct LinkedField "specTitle"'
    );
  });

  it('fails fast if documentParseSchema contains an invalid regex pattern', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [{ key: 'date', type: 'string' }],
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              fields: {
                date: {
                  from: 'email.date',
                  pattern: '[unclosed',
                },
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'invalid RegExp pattern "[unclosed"'
    );
  });

  it('fails fast if documentParseSchema contains an invalid JsonLogic AST', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [{ key: 'date', type: 'string' }],
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              match: { invalidOperatorXYZ: [1, 2] },
              fields: {
                date: { from: 'email.date' },
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'Invalid JsonLogic AST: Unrecognized operation invalidOperatorXYZ'
    );
  });

  it('fails fast if fallback.fields targets an unknown, calculated, or linked field', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [{ key: 'date', type: 'string' }],
        },
        documentParseSchema: {
          extractors: [],
          fallback: {
            strategy: 'ai',
            fields: ['unknownField'],
          },
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'DocumentParseSchema fallback in "./types/test-doc.json" targets unknown field "unknownField"'
    );
  });

  describe('validateJsonLogicAst', () => {
    it('accepts valid JsonLogic operations', () => {
      expect(() =>
        validateJsonLogicAst({ '==': [{ var: 'email.fromDomain' }, 'inc.nyc'] })
      ).not.toThrow();
      expect(() =>
        validateJsonLogicAst({
          or: [
            { in: ['SENT', { var: 'email.labels' }] },
            { '==': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
          ],
        })
      ).not.toThrow();
      expect(() => validateJsonLogicAst(true)).not.toThrow();
      expect(() => validateJsonLogicAst(null)).not.toThrow();
    });

    it('rejects objects with multiple operation keys', () => {
      expect(() =>
        validateJsonLogicAst({ '==': [1, 1], '!=': [2, 2] })
      ).toThrow('operation object must have exactly 1 key');
    });

    it('rejects empty operation objects', () => {
      expect(() => validateJsonLogicAst({})).toThrow(
        'operation object must have exactly 1 key'
      );
    });

    it('rejects unrecognized operators', () => {
      expect(() =>
        validateJsonLogicAst({ unknownOp: ['foo'] })
      ).toThrow('Unrecognized operation unknownOp');
    });
  });
});

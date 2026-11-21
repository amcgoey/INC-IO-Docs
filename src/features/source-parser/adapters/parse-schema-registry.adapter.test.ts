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
                date: [{ from: 'drive.modifiedTime' }, { from: 'drive.createdTime' }],
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

  it('fails fast if lookup: true targets a field without options', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        name: 'Test Doc',
        documentSchema: {
          fields: [{ key: 'date', type: 'string' }],
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              fields: {
                date: { from: 'email.date', lookup: true },
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'DocumentParseSchema in "./types/test-doc.json" specifies lookup: true for field "date" which does not have options'
    );
  });

  it('fails fast if lookup rule contains invalid excludePattern', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        name: 'Test Doc',
        documentSchema: {
          fields: [
            {
              key: 'contact',
              type: 'string',
              options: { source: 'contacts', key: 'key', name: 'name' },
            },
          ],
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              fields: {
                contact: { from: 'email.to', excludePattern: '(?+invalid[regex', lookup: true },
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(/contains invalid excludePattern/i);
  });

  it('fails fast if Tier 1 static options tuple contains empty or whitespace-only alias', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        name: 'Test Doc',
        documentSchema: {
          fields: [
            {
              key: 'direction',
              type: 'string',
              options: { source: 'direction', key: 'key', name: 'name' },
            },
          ],
          options: {
            direction: [
              { key: 'IN', name: 'Incoming', aliases: ['  '] },
            ],
          },
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'Empty or whitespace-only alias found in DocumentType "test-doc" options "direction" for key "IN"'
    );
  });

  it('fails fast if Tier 1 static options tuple contains duplicate case-insensitively normalized alias across two keys', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        name: 'Test Doc',
        documentSchema: {
          fields: [
            {
              key: 'direction',
              type: 'string',
              options: { source: 'direction', key: 'key', name: 'name' },
            },
          ],
          options: {
            direction: [
              { key: 'IN', name: 'Incoming', aliases: ['inbound', 'direct'] },
              { key: 'OT', name: 'Outgoing', aliases: ['outbound', 'INBOUND'] },
            ],
          },
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'Duplicate alias "INBOUND" (normalized "inbound") in DocumentType "test-doc" options "direction" between keys "IN" and "OT"'
    );
  });

  it('fails fast if Tier 3 shared AliasDictionary source does not match manifest sourceKey', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        aliases: {
          contacts: './aliases/contacts.json',
        },
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        source: 'mismatched-source',
        mappings: {
          c1: ['alias1'],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'AliasDictionary file "./aliases/contacts.json" specifies source "mismatched-source" but manifest expects "contacts"'
    );
  });

  it('fails fast if Tier 3 shared AliasDictionary contains empty or whitespace alias', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        aliases: {
          contacts: './aliases/contacts.json',
        },
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        source: 'contacts',
        mappings: {
          c1: ['   '],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'Empty or whitespace-only alias in AliasDictionary "./aliases/contacts.json" for key "c1"'
    );
  });

  it('fails fast if Tier 3 shared AliasDictionary contains duplicate case-insensitively normalized alias across two keys', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        aliases: {
          contacts: './aliases/contacts.json',
        },
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        source: 'contacts',
        mappings: {
          c1: ['@acme.com', 'Acme Corp'],
          c2: ['@ACME.COM', 'Beta Corp'],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'Duplicate alias "@ACME.COM" (normalized "@acme.com") in AliasDictionary "./aliases/contacts.json" between keys "c1" and "c2"'
    );
  });

  it('hydrates Tier 1 static options aliases and Tier 3 shared AliasDictionary successfully', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
        aliases: {
          contacts: './aliases/contacts.json',
        },
      }),
      readParsedSchema: vi.fn().mockImplementation(async (relPath: string) => {
        if (relPath === './types/test-doc.json') {
          return {
            key: 'test-doc',
            name: 'Test Doc',
            documentSchema: {
              fields: [
                {
                  key: 'direction',
                  type: 'string',
                  options: { source: 'direction', key: 'key', name: 'name' },
                },
                {
                  key: 'contact',
                  type: 'string',
                  options: {
                    source: 'contacts',
                    key: 'key',
                    name: 'name',
                    dynamicConfig: { provider: 'google_drive', relativePath: 'Contacts' },
                  },
                },
              ],
              options: {
                direction: [
                  { key: 'IN', name: 'Incoming', aliases: ['inbound'] },
                  { key: 'OT', name: 'Outgoing', aliases: ['outbound'] },
                ],
              },
            },
            documentParseSchema: {
              extractors: [
                {
                  source: 'gmail',
                  fields: {
                    contact: { from: 'email.to', excludePattern: '@inc\\.nyc', lookup: true },
                  },
                },
              ],
            },
          };
        }
        if (relPath === './aliases/contacts.json') {
          return {
            source: 'contacts',
            mappings: {
              pavarini: ['@pavarini.com', 'PCNE'],
              structureTone: ['@structuretone.com', 'STO'],
            },
          };
        }
        return undefined;
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await adapter.initialize();

    const targetSchema = adapter.getTargetSchema('test-doc');
    expect(targetSchema?.options?.direction[0].aliases).toEqual(['inbound']);
    expect(targetSchema?.fields.find((f) => f.key === 'contact')?.options?.dynamicConfig).toEqual({
      provider: 'google_drive',
      relativePath: 'Contacts',
    });

    const contactAliases = adapter.getAliasDictionary('contacts');
    expect(contactAliases).toBeDefined();
    expect(contactAliases?.source).toBe('contacts');
    expect(contactAliases?.mappings.pavarini).toEqual(['@pavarini.com', 'PCNE']);
  });

  it('fails fast if extractor.fields contains an empty rule array []', async () => {
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
                date: [],
              },
            },
          ],
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      /Invalid DocumentParseSchema structure/
    );
  });

  it('resolves configured options.key for Tier 1 duplicate-alias validation when options.key !== "key"', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [
            {
              key: 'specTag',
              type: 'string',
              options: { source: 'specItems', key: 'code', name: 'title' },
            },
          ],
          options: {
            specItems: [
              { code: '071200', title: 'Waterproofing', aliases: ['wp'] },
              { code: '092200', title: 'Drywall', aliases: ['WP'] },
            ],
          },
        },
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'Duplicate alias "WP" (normalized "wp") in DocumentType "test-doc" options "specItems" between keys "071200" and "092200"'
    );
  });

  it('preserves custom error message for non-array tuple.aliases and strips extra field properties via TypeBox cleaning', async () => {
    const nonArrayProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [{ key: 'contact', type: 'string', options: { source: 'contacts', key: 'key' } }],
          options: {
            contacts: [{ key: 'PMG', name: 'Pavarini', aliases: 'not-an-array' }],
          },
        },
      }),
    };
    const badAdapter = new ParseSchemaRegistryAdapter(nonArrayProvider);
    await expect(badAdapter.initialize()).rejects.toThrow(
      'Invalid aliases in option tuple for key "PMG" in DocumentType "test-doc": must be an array'
    );

    const extraPropsProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/test-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'test-doc',
        documentSchema: {
          fields: [
            {
              key: 'date',
              name: 'Date',
              type: 'string',
              description: 'Should be stripped',
              required: true,
              minLength: 6,
              pattern: '^\\d{6}$',
            },
          ],
          calculatedFields: [
            { key: 'calc', name: 'Calc', template: '{{date}}' },
          ],
        },
      }),
    };
    const cleanAdapter = new ParseSchemaRegistryAdapter(extraPropsProvider);
    await cleanAdapter.initialize();
    const targetSchema = cleanAdapter.getTargetSchema('test-doc');
    expect(targetSchema?.fields[0]).toEqual({
      key: 'date',
      name: 'Date',
      type: 'string',
      minLength: 6,
      pattern: '^\\d{6}$',
    });
    expect(targetSchema?.calculatedFields?.[0]).toEqual({
      key: 'calc',
      name: 'Calc',
    });
  });

  it('fails fast if AliasDictionary contains unknown properties (strict validation without Value.Clean)', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        aliases: {
          contacts: './aliases/contacts.json',
        },
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        source: 'contacts',
        mappings: {
          c1: ['@acme.com'],
        },
        extraKey: true,
      }),
    };

    const adapter = new ParseSchemaRegistryAdapter(mockManifestProvider);
    await expect(adapter.initialize()).rejects.toThrow(
      'Invalid AliasDictionary in "./aliases/contacts.json"'
    );
  });

  it('hydrates and validates AliasDictionary even when documentTypes is omitted or non-array', async () => {
    const validProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        aliases: {
          contacts: './aliases/contacts.json',
        },
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        source: 'contacts',
        mappings: {
          c1: ['@acme.com', 'ACME'],
        },
      }),
    };

    const validAdapter = new ParseSchemaRegistryAdapter(validProvider);
    await validAdapter.initialize();
    expect(validAdapter.getAliasDictionary('contacts')).toEqual({
      source: 'contacts',
      mappings: {
        c1: ['@acme.com', 'ACME'],
      },
    });

    const invalidProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: null,
        aliases: {
          contacts: './aliases/contacts.json',
        },
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        source: 'wrong-source',
        mappings: {
          c1: ['@acme.com'],
        },
      }),
    };

    const invalidAdapter = new ParseSchemaRegistryAdapter(invalidProvider);
    await expect(invalidAdapter.initialize()).rejects.toThrow(
      'AliasDictionary file "./aliases/contacts.json" specifies source "wrong-source" but manifest expects "contacts"'
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

  describe('DriveExtractorRule fail-fast validation (#307)', () => {
    it('rejects unknown from source in source: "drive" extractor', async () => {
      const adapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: { fields: [{ key: 'date', type: 'string' }] },
          documentParseSchema: {
            extractors: [
              {
                source: 'drive',
                fields: { date: { from: 'drive.unknownField' } },
              },
            ],
          },
        }),
      });
      await expect(adapter.initialize()).rejects.toThrow(/Invalid DocumentParseSchema structure/i);
    });

    it('rejects invalid regex, lookup on non-LookupField, and CalculatedField/LinkedField targets in source: "drive"', async () => {
      const badRegexAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: { fields: [{ key: 'date', type: 'string' }] },
          documentParseSchema: {
            extractors: [
              {
                source: 'drive',
                fields: { date: { from: 'drive.fileNameStem', pattern: '(?+bad' } },
              },
            ],
          },
        }),
      });
      await expect(badRegexAdapter.initialize()).rejects.toThrow(/invalid RegExp pattern/i);

      const badLookupAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: { fields: [{ key: 'date', type: 'string' }] },
          documentParseSchema: {
            extractors: [
              {
                source: 'drive',
                fields: { date: { from: 'drive.fileNameStem', lookup: true } },
              },
            ],
          },
        }),
      });
      await expect(badLookupAdapter.initialize()).rejects.toThrow(/does not have options/i);

      const badCalcAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: {
            fields: [
              { key: 'specTag', type: 'string' },
              { key: 'specTitle', type: 'string', linkedField: { sourceField: 'specTag', sourceProperty: 'name' } },
            ],
            calculatedFields: [{ key: 'fileName', template: '{{specTag}}' }],
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'drive',
                fields: { fileName: { from: 'drive.fileNameStem' } },
              },
            ],
          },
        }),
      });
      await expect(badCalcAdapter.initialize()).rejects.toThrow(/CalculatedField/i);

      const badLinkedAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: {
            fields: [
              { key: 'specTag', type: 'string' },
              { key: 'specTitle', type: 'string', linkedField: { sourceField: 'specTag', sourceProperty: 'name' } },
            ],
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'drive',
                fields: { specTitle: { from: 'drive.fileNameStem' } },
              },
            ],
          },
        }),
      });
      await expect(badLinkedAdapter.initialize()).rejects.toThrow(/LinkedField/i);
    });
  });

  describe('Ticket #308: FieldCandidateNormalizeSchema validation at ParseSchemaRegistryPort.initialize()', () => {
    it('accepts normalize: "yymmdd" on both gmail and drive extract and lookup rules and rejects unknown normalize modes or set rules with normalize', async () => {
      const validAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: {
            fields: [
              { key: 'date', type: 'string' },
              {
                key: 'contact',
                type: 'string',
                options: { source: 'contacts', key: 'key', name: 'name' },
              },
            ],
            options: {
              contacts: [{ key: 'ACM', name: 'Acme' }],
            },
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'gmail',
                fields: {
                  date: { from: 'email.subjectClean', normalize: 'yymmdd' },
                  contact: { from: 'email.subjectClean', normalize: 'yymmdd', lookup: true },
                },
              },
              {
                source: 'drive',
                fields: {
                  date: [
                    { from: 'drive.fileNameStem', normalize: 'yymmdd' },
                    { from: 'drive.modifiedTime' },
                  ],
                  contact: { from: 'drive.fileNameStem', normalize: 'yymmdd', lookup: true },
                },
              },
            ],
          },
        }),
      });
      await expect(validAdapter.initialize()).resolves.toBeUndefined();

      for (const badRule of [
        { source: 'drive', fields: { date: { from: 'drive.fileNameStem', normalize: 'invalidMode' } } },
        { source: 'gmail', fields: { date: { from: 'email.subjectClean', normalize: 'invalidMode' } } },
        { source: 'drive', fields: { contact: { from: 'drive.fileNameStem', normalize: 'invalidMode', lookup: true } } },
        { source: 'drive', fields: { date: { set: '261115', normalize: 'yymmdd' } } },
      ]) {
        const badAdapter = new ParseSchemaRegistryAdapter({
          getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
          readParsedSchema: vi.fn().mockResolvedValue({
            key: 'test-doc',
            documentSchema: {
              fields: [
                { key: 'date', type: 'string' },
                {
                  key: 'contact',
                  type: 'string',
                  options: { source: 'contacts', key: 'key', name: 'name' },
                },
              ],
            },
            documentParseSchema: {
              extractors: [badRule],
            },
          }),
        });
        await expect(badAdapter.initialize()).rejects.toThrow(/Invalid DocumentParseSchema structure/i);
      }
    });
  });

  describe('Ticket #310: Submittal normalizer modes (digits6, pad3, revision, cleanFilenameText) at ParseSchemaRegistryPort.initialize()', () => {
    it('accepts digits6, pad3, revision, and cleanFilenameText on gmail and drive rules and rejects unknown modes', async () => {
      const validAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: {
            fields: [
              { key: 'section', type: 'string' },
              { key: 'number', type: 'string' },
              { key: 'revision', type: 'string' },
              { key: 'title', type: 'string' },
            ],
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'gmail',
                fields: {
                  section: { from: 'attachmentName', pattern: '(\\d{2} \\d{2} \\d{2})', group: 1, normalize: 'digits6' },
                  number: { from: 'attachmentName', pattern: '(\\d{1,3})', group: 1, normalize: 'pad3' },
                  revision: { from: 'attachmentName', pattern: '(v\\d+)', group: 1, normalize: 'revision' },
                  title: { from: 'attachmentName', pattern: '(.+)', group: 1, normalize: 'cleanFilenameText' },
                },
              },
              {
                source: 'drive',
                fields: {
                  section: { from: 'drive.fileNameStem', pattern: '(\\d{2} \\d{2} \\d{2})', group: 1, normalize: 'digits6' },
                  number: { from: 'drive.fileNameStem', pattern: '(\\d{1,3})', group: 1, normalize: 'pad3' },
                  revision: { from: 'drive.fileNameStem', pattern: '(v\\d+)', group: 1, normalize: 'revision' },
                  title: { from: 'drive.fileNameStem', pattern: '(.+)', group: 1, normalize: 'cleanFilenameText' },
                },
              },
            ],
          },
        }),
      });
      await expect(validAdapter.initialize()).resolves.toBeUndefined();

      const badAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-doc',
          documentSchema: {
            fields: [{ key: 'section', type: 'string' }],
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'drive',
                fields: {
                  section: { from: 'drive.fileNameStem', normalize: 'unknownNormalizer' },
                },
              },
            ],
          },
        }),
      });
      await expect(badAdapter.initialize()).rejects.toThrow(/Invalid DocumentParseSchema structure/i);
    });
  });

  describe('Ticket #311: compactAlnum normalizer mode at ParseSchemaRegistryPort.initialize()', () => {
    it('accepts compactAlnum on gmail and drive lookup/extract rules', async () => {
      const validAdapter = new ParseSchemaRegistryAdapter({
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./types/test-ffe.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'test-ffe',
          documentSchema: {
            fields: [
              { key: 'specTag', type: 'string', options: { source: 'specs', key: 'key' } },
            ],
            options: {
              specs: [{ key: 'CG104', name: 'BED - KING' }],
            },
          },
          documentParseSchema: {
            extractors: [
              {
                source: 'gmail',
                fields: {
                  specTag: {
                    from: 'attachmentName',
                    pattern: '([A-Za-z]{2}[\\s._-]?\\d{3}[A-Za-z]?)',
                    group: 1,
                    normalize: 'compactAlnum',
                    lookup: true,
                  },
                },
              },
              {
                source: 'drive',
                fields: {
                  specTag: {
                    from: 'drive.fileNameStem',
                    pattern: '([A-Za-z]{2}[\\s._-]?\\d{3}[A-Za-z]?)',
                    group: 1,
                    normalize: 'compactAlnum',
                    lookup: true,
                  },
                },
              },
            ],
          },
        }),
      });
      await expect(validAdapter.initialize()).resolves.toBeUndefined();
    });
  });
});

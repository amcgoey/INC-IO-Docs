import { describe, it, expect, vi } from 'vitest';
import { ManifestUiAdapter, type RawManifestProviderPort } from './manifest.adapter';

describe('ManifestUiAdapter', () => {
  const mockManifest: RawManifestProviderPort = {
    getRawManifest: vi.fn().mockResolvedValue({
      documentTypes: ['./doc-a.json', './doc-b.json', './doc-linked.json'],
    }),
    readParsedSchema: vi.fn().mockImplementation(async (relPath: string) => {
      if (relPath === './doc-a.json') {
        return {
          key: 'doc-a',
          name: 'Doc A Name',
          documentSchema: {
            fields: [
              { key: 'field1', type: 'string' },
              { key: 'field2', type: 'number' },
            ],
          },
          documentUiSchema: {
            layout: ['field1', 'field2'],
            fields: {
              field1: { widget: 'textInput', label: 'Field One' },
            },
          },
        };
      }
      if (relPath === './doc-b.json') {
        return {
          key: 'doc-b',
          // invalid documentSchema (missing fields array)
          documentSchema: { invalid: true },
          // invalid documentUiSchema
          documentUiSchema: { fields: 'not-an-object' },
        };
      }
      if (relPath === './doc-linked.json') {
        return {
          key: 'doc-linked',
          name: 'Doc Linked Name',
          documentSchema: {
            fields: [
              { key: 'specTag', type: 'string', options: { source: 'specs', key: 'key' } },
              {
                key: 'specTitle',
                type: 'string',
                linkedField: {
                  sourceField: 'specTag',
                  sourceProperty: 'name',
                },
              },
            ],
          },
          documentUiSchema: {
            layout: ['specTag', 'specTitle'],
            fields: {
              specTag: { widget: 'textInput', label: 'Spec Tag' },
              specTitle: { widget: 'textInput', label: 'Spec Title' },
            },
          },
        };
      }
      return undefined;
    }),
  };

  it('retrieves and validates UiSchema for a known document type', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const uiSchema = await adapter.getUiSchema('doc-a');

    expect(uiSchema).toBeDefined();
    expect(uiSchema?.layout).toEqual(['field1', 'field2']);
    expect(uiSchema?.fields?.field1?.label).toBe('Field One');
  });

  it('returns undefined when document type key does not exist', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const uiSchema = await adapter.getUiSchema('non-existent');

    expect(uiSchema).toBeUndefined();
  });

  it('returns undefined when raw documentUiSchema is invalid', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const uiSchema = await adapter.getUiSchema('doc-b');

    expect(uiSchema).toBeUndefined();
  });

  it('applies evaluationOrderEnsurer when provided', async () => {
    const ensurer = vi.fn().mockImplementation((uiSchema) => ({
      ...uiSchema,
      evaluationOrder: ['field1', 'field2'],
    }));

    const adapter = new ManifestUiAdapter(mockManifest, ensurer);
    const uiSchema = await adapter.getUiSchema('doc-a');

    expect(ensurer).toHaveBeenCalled();
    expect(uiSchema?.evaluationOrder).toEqual(['field1', 'field2']);
  });

  it('retrieves and validates DocumentSchema for a known document type', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const docSchema = await adapter.getDocumentSchema('doc-a');

    expect(docSchema).toBeDefined();
    expect(docSchema?.fields).toHaveLength(2);
    expect(docSchema?.fields[0].key).toBe('field1');
  });

  it('preserves linkedField metadata when hydrating AbstractDataSchema', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const docSchema = await adapter.getDocumentSchema('doc-linked');

    expect(docSchema).toBeDefined();
    expect(docSchema?.fields).toHaveLength(2);
    const specTitleField = docSchema?.fields.find((f) => f.key === 'specTitle');
    expect(specTitleField).toBeDefined();
    expect((specTitleField as { linkedField?: unknown })?.linkedField).toEqual({
      sourceField: 'specTag',
      sourceProperty: 'name',
    });
  });

  it('returns undefined when raw documentSchema is invalid', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const docSchema = await adapter.getDocumentSchema('doc-b');

    expect(docSchema).toBeUndefined();
  });

  it('retrieves display name for known document type when name is provided', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const displayName = await adapter.getDisplayName?.('doc-a');

    expect(displayName).toBe('Doc A Name');
  });

  it('returns key as fallback if name is not provided', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const displayName = await adapter.getDisplayName?.('doc-b');

    expect(displayName).toBe('doc-b');
  });

  it('returns undefined for non-existent document type', async () => {
    const adapter = new ManifestUiAdapter(mockManifest);
    const displayName = await adapter.getDisplayName?.('non-existent');

    expect(displayName).toBeUndefined();
  });
});

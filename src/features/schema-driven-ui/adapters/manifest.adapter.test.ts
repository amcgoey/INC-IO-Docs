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

  it('retains valid documentUiSchema.successView through Value.Clean while stripping unknown keys (#385)', async () => {
    const manifestWithSuccessView: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./doc-sv.json', './doc-sv-invalid.json'],
      }),
      readParsedSchema: vi.fn().mockImplementation(async (relPath: string) => {
        if (relPath === './doc-sv.json') {
          return {
            key: 'doc-sv',
            name: 'Doc Success View',
            documentSchema: { fields: [{ key: 'title', type: 'string' }] },
            documentUiSchema: {
              layout: ['title'],
              extraRootProp: 'strip-me',
              successView: {
                extraSuccessProp: 'strip-me',
                summary: {
                  topLabel: 'Top',
                  text: '<b>{{title}}</b>',
                  bottomLabel: 'Bottom',
                  extraSummaryProp: 99,
                },
                artifacts: [
                  {
                    stepId: 'moveOriginal',
                    label: 'Filed Original',
                    whenWorkflow: { SubmittalReceived: 'Archived Original' },
                    fallbackLabel: 'Fallback',
                    extraArtifactProp: false,
                  },
                ],
              },
            },
          };
        }
        if (relPath === './doc-sv-invalid.json') {
          return {
            key: 'doc-sv-invalid',
            documentSchema: { fields: [{ key: 'title', type: 'string' }] },
            documentUiSchema: {
              successView: {
                summary: { text: 123 },
              },
            },
          };
        }
        return undefined;
      }),
    };

    const adapter = new ManifestUiAdapter(manifestWithSuccessView);
    const uiSchema = await adapter.getUiSchema('doc-sv');
    expect(uiSchema).toEqual({
      layout: ['title'],
      successView: {
        summary: {
          topLabel: 'Top',
          text: '<b>{{title}}</b>',
          bottomLabel: 'Bottom',
        },
        artifacts: [
          {
            stepId: 'moveOriginal',
            label: 'Filed Original',
            whenWorkflow: { SubmittalReceived: 'Archived Original' },
            fallbackLabel: 'Fallback',
          },
        ],
      },
    });

    expect(await adapter.getUiSchema('doc-sv-invalid')).toBeUndefined();
  });

  it('memoizes manifest reads, evaluationOrderEnsurer, and per-key schemas while isolating caller mutations', async () => {
    const getRawManifest = vi.fn().mockResolvedValue({
      documentTypes: ['./doc-a.json', './doc-b.json'],
    });
    const readParsedSchema = vi.fn().mockImplementation(async (relPath: string) => {
      if (relPath === './doc-a.json') {
        return {
          key: 'doc-a',
          name: 'Doc A Name',
          documentSchema: {
            fields: [{ key: 'field1', type: 'string' }],
          },
          documentUiSchema: {
            layout: ['field1'],
            fields: {
              field1: { widget: 'textInput', label: 'Field One' },
            },
          },
        };
      }
      if (relPath === './doc-b.json') {
        return {
          key: 'doc-b',
          name: 'Doc B Name',
          documentSchema: { fields: [] },
          documentUiSchema: { layout: [] },
        };
      }
      return undefined;
    });
    const ensurer = vi.fn().mockImplementation((uiSchema) => ({
      ...uiSchema,
      evaluationOrder: ['field1'],
    }));

    const adapter = new ManifestUiAdapter({ getRawManifest, readParsedSchema }, ensurer);

    const [uiA1, uiA2, docA1, nameA1] = await Promise.all([
      adapter.getUiSchema('doc-a'),
      adapter.getUiSchema('doc-a'),
      adapter.getDocumentSchema('doc-a'),
      adapter.getDisplayName('doc-a'),
    ]);

    const uiB = await adapter.getUiSchema('doc-b');
    const docA2 = await adapter.getDocumentSchema('doc-a');
    const nameA2 = await adapter.getDisplayName('doc-a');
    const missingUi = await adapter.getUiSchema('missing');

    expect(getRawManifest).toHaveBeenCalledTimes(1);
    expect(readParsedSchema).toHaveBeenCalledTimes(2);
    expect(ensurer).toHaveBeenCalledTimes(2);
    expect(nameA1).toBe('Doc A Name');
    expect(nameA2).toBe('Doc A Name');
    expect(uiB?.evaluationOrder).toEqual(['field1']);
    expect(missingUi).toBeUndefined();

    // Mutate returned objects and verify subsequent reads are unaffected
    uiA1!.layout!.push('mutated-field');
    docA1!.fields.push({ key: 'mutated', type: 'string' });

    const uiA3 = await adapter.getUiSchema('doc-a');
    const docA3 = await adapter.getDocumentSchema('doc-a');

    expect(uiA2?.layout).toEqual(['field1']);
    expect(uiA3?.layout).toEqual(['field1']);
    expect(docA2?.fields).toHaveLength(1);
    expect(docA3?.fields).toHaveLength(1);
    expect(ensurer).toHaveBeenCalledTimes(2);
  });

  it('clears cached manifest promise on transient rejection and does not cache evaluationOrderEnsurer throws', async () => {
    const getRawManifest = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient manifest error'))
      .mockResolvedValue({
        documentTypes: ['./doc-a.json'],
      });
    const readParsedSchema = vi.fn().mockResolvedValue({
      key: 'doc-a',
      name: 'Doc A Name',
      documentSchema: { fields: [{ key: 'field1', type: 'string' }] },
      documentUiSchema: { layout: ['field1'] },
    });
    const ensurer = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('transient ensurer error');
      })
      .mockImplementation((uiSchema) => ({
        ...uiSchema,
        evaluationOrder: ['field1'],
      }));

    const adapter = new ManifestUiAdapter({ getRawManifest, readParsedSchema }, ensurer);

    await expect(adapter.getUiSchema('doc-a')).rejects.toThrow('transient manifest error');
    await expect(adapter.getUiSchema('doc-a')).rejects.toThrow('transient ensurer error');

    const recovered = await adapter.getUiSchema('doc-a');
    expect(recovered?.evaluationOrder).toEqual(['field1']);
    expect(getRawManifest).toHaveBeenCalledTimes(2);
    expect(readParsedSchema).toHaveBeenCalledTimes(1);
    expect(ensurer).toHaveBeenCalledTimes(2);
  });
});

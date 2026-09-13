import { describe, it, expect, vi } from 'vitest';
import { DocumentUiSchemaQueryAdapter } from './document-ui-schema-query';
import type { RawManifestProviderPort } from '../ports';

describe('DocumentUiSchemaQueryAdapter', () => {
  it('returns undefined if manifest has no documentTypes', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({}),
      readParsedSchema: vi.fn(),
    };

    const adapter = new DocumentUiSchemaQueryAdapter(mockManifestProvider);
    const result = await adapter.getDocumentUiSchema('non-existent');

    expect(result).toBeUndefined();
    expect(mockManifestProvider.getRawManifest).toHaveBeenCalledOnce();
    expect(mockManifestProvider.readParsedSchema).not.toHaveBeenCalled();
  });

  it('fetches and returns validated DocumentUiSchema directly bypassing domain', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./doc1.json', './doc2.json'],
      }),
      readParsedSchema: vi.fn().mockImplementation(async (relPath: string) => {
        if (relPath === './doc1.json') {
          return {
            key: 'doc1',
            name: 'Doc 1',
            documentSchema: { fields: [] },
          };
        }
        if (relPath === './doc2.json') {
          return {
            key: 'doc2',
            name: 'Doc 2',
            documentSchema: { fields: [] },
            documentUiSchema: {
              layout: ['fieldA', 'fieldB'],
              fields: {
                fieldA: { widget: 'textInput', label: 'Field A' },
              },
              events: {
                onSubmit: { catchAllWorkflow: 'SubmitWorkflow' },
              },
            },
          };
        }
        throw new Error('Not found');
      }),
    };

    const adapter = new DocumentUiSchemaQueryAdapter(mockManifestProvider);
    const result = await adapter.getDocumentUiSchema('doc2');

    expect(result).toBeDefined();
    expect(result?.layout).toEqual(['fieldA', 'fieldB']);
    expect(result?.fields?.fieldA?.label).toBe('Field A');
    expect(result?.events?.onSubmit?.catchAllWorkflow).toBe('SubmitWorkflow');
  });

  it('ensures evaluationOrder on DocumentUiSchema when fields with computeValue are present', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./calc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'calc',
        name: 'Calc',
        documentSchema: {
          fields: [{ key: 'first' }, { key: 'last' }, { key: 'full' }],
        },
        documentUiSchema: {
          fields: {
            first: {},
            last: {},
            full: { computeValue: { cat: [{ var: 'data.first' }, ' ', { var: 'data.last' }] } },
          },
        },
      }),
    };

    const mockEnsurer = vi.fn().mockImplementation((ui) => {
      ui.evaluationOrder = ['first', 'last', 'full'];
      return ui;
    });

    const adapter = new DocumentUiSchemaQueryAdapter(mockManifestProvider, mockEnsurer);
    const result = await adapter.getDocumentUiSchema('calc');

    expect(result).toBeDefined();
    expect(mockEnsurer).toHaveBeenCalled();
    expect(result?.evaluationOrder).toEqual(['first', 'last', 'full']);
  });
});


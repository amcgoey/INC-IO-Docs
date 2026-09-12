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

  it('fetches and returns SpaceUiSchema from manifest DocumentSpaceTypes', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        DocumentSpaceTypes: [
          {
            id: 'space-alpha',
            displayName: 'Alpha Space',
            spaceUiSchema: {
              layout: ['spaceName'],
              fields: {
                spaceName: { widget: 'textInput', label: 'Custom Space Name' },
              },
            },
          },
        ],
      }),
      readParsedSchema: vi.fn(),
    };

    const adapter = new DocumentUiSchemaQueryAdapter(mockManifestProvider);
    const result = await adapter.getSpaceUiSchema('space-alpha');

    expect(result).toBeDefined();
    expect(result?.layout).toEqual(['spaceName']);
    expect(result?.fields?.spaceName?.label).toBe('Custom Space Name');
  });

  it('returns undefined if SpaceUiSchema is not present on space type', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        DocumentSpaceTypes: [
          {
            id: 'space-beta',
            displayName: 'Beta Space',
          },
        ],
      }),
      readParsedSchema: vi.fn(),
    };

    const adapter = new DocumentUiSchemaQueryAdapter(mockManifestProvider);
    const result = await adapter.getSpaceUiSchema('space-beta');

    expect(result).toBeUndefined();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { ManifestAdapter, type RawManifestProviderPort } from './manifest.adapter';

describe('ManifestAdapter', () => {
  it('resolves document type key when mapping exists in manifest array', async () => {
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['schemas/doc1.json', 'schemas/doc2.json'],
      }),
      readParsedSchema: vi.fn().mockImplementation(async (path: string) => {
        if (path === 'schemas/doc1.json') {
          return { key: 'comm-project', name: 'Communication Project', displayName: 'Comm Project' };
        }
        return { key: 'comm-proposal', name: 'Communication Proposal', displayName: 'Comm Proposal' };
      }),
    };

    const adapter = new ManifestAdapter(mockProvider);
    const resolvedByKey = await adapter.resolveDocumentTypeKey('comm-project');
    const resolvedByName = await adapter.resolveDocumentTypeKey('Communication Proposal');
    const resolvedByDisplayName = await adapter.resolveDocumentTypeKey('Comm Project');
    const unknownKey = await adapter.resolveDocumentTypeKey('non-existent');

    expect(resolvedByKey).toBe('comm-project');
    expect(resolvedByName).toBe('comm-proposal');
    expect(resolvedByDisplayName).toBe('comm-project');
    expect(unknownKey).toBe('non-existent');
  });

  it('resolves document type key when mapping is a record/dictionary', async () => {
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: {
          'invoice-key': { name: 'Invoice', displayName: 'Client Invoice' },
        },
      }),
      readParsedSchema: vi.fn(),
    };

    const adapter = new ManifestAdapter(mockProvider);
    const resolved = await adapter.resolveDocumentTypeKey('Client Invoice');
    expect(resolved).toBe('invoice-key');
  });

  it('caches document types across multiple calls', async () => {
    const getRawManifest = vi.fn().mockResolvedValue({
      documentTypes: {
        'doc-1': { name: 'Doc 1' },
      },
    });
    const mockProvider: RawManifestProviderPort = {
      getRawManifest,
      readParsedSchema: vi.fn(),
    };

    const adapter = new ManifestAdapter(mockProvider);
    await adapter.getAllDocumentTypes();
    await adapter.getAllDocumentTypes();

    expect(getRawManifest).toHaveBeenCalledTimes(1);
  });

  it('retrieves document and UI schemas from manifest record or array', async () => {
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['schemas/doc1.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'doc1',
        documentSchema: { title: 'Doc 1' },
        documentUiSchema: { fields: ['a'] },
      }),
    };

    const adapter = new ManifestAdapter(mockProvider);
    const schemas = await adapter.getDocumentTypeSchemas('doc1');

    expect(schemas.docSchema).toEqual({ title: 'Doc 1' });
    expect(schemas.uiSchema).toEqual({ fields: ['a'] });

    const empty = await adapter.getDocumentTypeSchemas('non-existent');
    expect(empty).toEqual({});
  });
});

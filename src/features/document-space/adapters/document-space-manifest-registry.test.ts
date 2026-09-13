import { describe, it, expect, vi } from 'vitest';
import { DocumentSpaceManifestRegistryAdapter } from './document-space-manifest-registry';
import type { RawManifestProviderPort } from '../ports';
import type { DocumentSpaceType } from '../domain';

describe('DocumentSpaceManifestRegistryAdapter', () => {
  const sampleProjectSpace: DocumentSpaceType = {
    id: 'project',
    displayName: 'Project Space',
    allowedDocumentTypes: ['communication-project'],
    storageConfig: {
      provider: 'google_drive',
      fetchMethod: 'shared_drives',
      paginationLimit: 500,
    },
  };

  const sampleProposalSpace: DocumentSpaceType = {
    id: 'proposal',
    displayName: 'Proposal Space',
    allowedDocumentTypes: ['proposal-doc'],
    storageConfig: {
      provider: 'google_drive',
      fetchMethod: 'folders',
      parentFolderId: 'root-proposal-folder',
      sharedDriveId: 'drive-456',
      paginationLimit: 250,
    },
  };

  function createMockManifestProvider(manifestData: unknown): RawManifestProviderPort {
    return {
      getRawManifest: vi.fn().mockResolvedValue(manifestData),
    };
  }

  it('hydrates and returns valid DocumentSpaceTypes from raw manifest', async () => {
    const mockProvider = createMockManifestProvider({
      DocumentSpaceTypes: [sampleProjectSpace, sampleProposalSpace],
    });

    const adapter = new DocumentSpaceManifestRegistryAdapter(mockProvider);
    const spaceTypes = await adapter.getDocumentSpaceTypes();

    expect(spaceTypes).toHaveLength(2);
    expect(spaceTypes[0]).toEqual(sampleProjectSpace);
    expect(spaceTypes[1]).toEqual(sampleProposalSpace);
  });

  it('returns empty array when DocumentSpaceTypes is not present in raw manifest', async () => {
    const mockProvider = createMockManifestProvider({
      documentTypes: [],
    });

    const adapter = new DocumentSpaceManifestRegistryAdapter(mockProvider);
    const spaceTypes = await adapter.getDocumentSpaceTypes();

    expect(spaceTypes).toEqual([]);
  });

  it('throws error when a space type does not conform to DocumentSpaceTypeSchema', async () => {
    const mockProvider = createMockManifestProvider({
      DocumentSpaceTypes: [
        {
          id: 'invalid-space',
          // missing displayName and allowedDocumentTypes
          storageConfig: {
            provider: 'google_drive',
            fetchMethod: 'invalid_fetch_method',
          },
        },
      ],
    });

    const adapter = new DocumentSpaceManifestRegistryAdapter(mockProvider);
    await expect(adapter.getDocumentSpaceTypes()).rejects.toThrow(
      /Invalid DocumentSpaceType schema/i
    );
  });

  it('hydrates evaluationOrder on spaceUiSchema when fields with computeValue are present', async () => {
    const rawSpace = {
      id: 'computed-space',
      displayName: 'Computed Space',
      allowedDocumentTypes: ['sample-doc'],
      storageConfig: { provider: 'google_drive' },
      spaceUiSchema: {
        layout: ['base', 'derived'],
        fields: {
          base: { label: 'Base' },
          derived: {
            label: 'Derived',
            computeValue: { cat: [{ var: 'data.base' }, ' extra'] },
          },
        },
      },
    };
    const mockProvider = createMockManifestProvider({
      DocumentSpaceTypes: [rawSpace],
    });

    const mockCalculator = vi.fn().mockReturnValue(['base', 'derived']);
    const adapter = new DocumentSpaceManifestRegistryAdapter(mockProvider, mockCalculator);
    const spaceTypes = await adapter.getDocumentSpaceTypes();

    expect(spaceTypes).toHaveLength(1);
    expect(
      (rawSpace.spaceUiSchema as { evaluationOrder?: string[] }).evaluationOrder
    ).toEqual(['base', 'derived']);
  });

  it('throws error when spaceUiSchema contains circular dependencies', async () => {
    const mockProvider = createMockManifestProvider({
      DocumentSpaceTypes: [
        {
          id: 'cyclic-space',
          displayName: 'Cyclic Space',
          allowedDocumentTypes: ['sample-doc'],
          storageConfig: { provider: 'google_drive' },
          spaceUiSchema: {
            fields: {
              f1: { computeValue: { var: 'data.f2' } },
              f2: { computeValue: { var: 'data.f1' } },
            },
          },
        },
      ],
    });

    const mockCalculator = vi.fn().mockImplementation(() => {
      throw new Error('Circular dependency detected');
    });
    const adapter = new DocumentSpaceManifestRegistryAdapter(mockProvider, mockCalculator);
    await expect(adapter.getDocumentSpaceTypes()).rejects.toThrow(
      /Invalid DocumentSpaceType UI schema "cyclic-space": Circular dependency detected/
    );
  });
});


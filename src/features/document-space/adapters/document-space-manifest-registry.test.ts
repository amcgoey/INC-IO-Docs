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
});

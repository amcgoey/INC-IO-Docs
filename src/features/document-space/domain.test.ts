import { describe, it, expect, beforeEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentSpaceTypeSchema,
  DocumentSpaceSchema,
  DocumentSpaceCollectionSchema,
  StorageContextConfigSchema,
  DocumentSpaceService,
  formatValidationErrors,
  type DocumentSpaceType,
  type DocumentSpace,
  type DocumentSpaceCollection,
} from './domain';
import type { DocumentSpaceManifestRegistryPort } from './ports';

describe('DocumentSpace Domain Schemas', () => {
  describe('StorageContextConfigSchema', () => {
    it('validates a valid shared_drives storage configuration', () => {
      const validConfig = {
        provider: 'google_drive',
        fetchMethod: 'shared_drives',
        paginationLimit: 500,
      };

      expect(Value.Check(StorageContextConfigSchema, validConfig)).toBe(true);
    });

    it('validates a valid folders storage configuration', () => {
      const validConfig = {
        provider: 'google_drive',
        fetchMethod: 'folders',
        parentFolderId: 'folder-abc',
        sharedDriveId: 'drive-xyz',
        paginationLimit: 250,
      };

      expect(Value.Check(StorageContextConfigSchema, validConfig)).toBe(true);
    });

    it('rejects an invalid fetchMethod', () => {
      const invalidConfig = {
        provider: 'google_drive',
        fetchMethod: 'unsupported_method',
      };

      expect(Value.Check(StorageContextConfigSchema, invalidConfig)).toBe(false);
    });

    it('rejects an empty provider string', () => {
      const invalidConfig = {
        provider: '',
        fetchMethod: 'shared_drives',
      };

      expect(Value.Check(StorageContextConfigSchema, invalidConfig)).toBe(false);
    });
  });

  describe('DocumentSpaceTypeSchema', () => {
    it('validates a complete DocumentSpaceType object', () => {
      const spaceType: DocumentSpaceType = {
        id: 'project',
        displayName: 'Project',
        allowedDocumentTypes: ['communication-project', 'proposal-doc'],
        storageConfig: {
          provider: 'google_drive',
          fetchMethod: 'shared_drives',
          paginationLimit: 500,
        },
      };

      expect(Value.Check(DocumentSpaceTypeSchema, spaceType)).toBe(true);
      expect(formatValidationErrors(DocumentSpaceTypeSchema, spaceType)).toEqual([]);
    });

    it('rejects DocumentSpaceType when id is missing or empty', () => {
      const invalid = {
        id: '',
        displayName: 'Project',
        allowedDocumentTypes: ['communication-project'],
        storageConfig: {
          provider: 'google_drive',
          fetchMethod: 'shared_drives',
        },
      };

      expect(Value.Check(DocumentSpaceTypeSchema, invalid)).toBe(false);
    });

    it('rejects DocumentSpaceType with invalid storageConfig', () => {
      const invalid = {
        id: 'project',
        displayName: 'Project',
        allowedDocumentTypes: ['communication-project'],
        storageConfig: {
          provider: 'google_drive',
          fetchMethod: 'unknown_fetch',
        },
      };

      expect(Value.Check(DocumentSpaceTypeSchema, invalid)).toBe(false);
    });
  });

  describe('DocumentSpaceSchema', () => {
    it('validates an active DocumentSpace instance', () => {
      const space: DocumentSpace = {
        id: 'space-123',
        typeId: 'project',
        name: '123 Main St Renovation',
        abstractStorageId: 'drive-folder-456',
      };

      expect(Value.Check(DocumentSpaceSchema, space)).toBe(true);
    });

    it('rejects DocumentSpace missing abstractStorageId', () => {
      const invalid = {
        id: 'space-123',
        typeId: 'project',
        name: '123 Main St Renovation',
      };

      expect(Value.Check(DocumentSpaceSchema, invalid)).toBe(false);
    });
  });

  describe('DocumentSpaceCollectionSchema', () => {
    it('validates a DocumentSpaceCollection aggregating spaces by type', () => {
      const collection: DocumentSpaceCollection = {
        type: {
          id: 'project',
          displayName: 'Project',
          allowedDocumentTypes: ['communication-project'],
          storageConfig: {
            provider: 'google_drive',
            fetchMethod: 'shared_drives',
            paginationLimit: 500,
          },
        },
        spaces: [
          {
            id: 'space-1',
            typeId: 'project',
            name: 'Project Alpha',
            abstractStorageId: 'drive-folder-1',
          },
          {
            id: 'space-2',
            typeId: 'project',
            name: 'Project Beta',
            abstractStorageId: 'drive-folder-2',
          },
        ],
      };

      expect(Value.Check(DocumentSpaceCollectionSchema, collection)).toBe(true);
    });
  });
});

describe('DocumentSpaceService', () => {
  const sampleProjectSpaceType: DocumentSpaceType = {
    id: 'project',
    displayName: 'Project',
    allowedDocumentTypes: ['communication-project'],
    storageConfig: {
      provider: 'google_drive',
      fetchMethod: 'shared_drives',
      paginationLimit: 500,
    },
  };

  const sampleProposalSpaceType: DocumentSpaceType = {
    id: 'proposal',
    displayName: 'Proposal',
    allowedDocumentTypes: ['proposal-doc'],
    storageConfig: {
      provider: 'google_drive',
      fetchMethod: 'folders',
      parentFolderId: 'root-proposal-folder',
      paginationLimit: 100,
    },
  };

  let mockManifestRegistry: DocumentSpaceManifestRegistryPort;

  beforeEach(() => {
    mockManifestRegistry = {
      getDocumentSpaceTypes: async () => [sampleProjectSpaceType, sampleProposalSpaceType],
    };
  });

  it('initializes and caches space types from the manifest registry port', async () => {
    const service = new DocumentSpaceService(mockManifestRegistry);
    await service.initialize();

    expect(service.hasType('project')).toBe(true);
    expect(service.hasType('proposal')).toBe(true);
    expect(service.hasType('unknown')).toBe(false);

    const projectType = service.getType('project');
    expect(projectType).toEqual(sampleProjectSpaceType);
    expect(projectType.displayName).toBe('Project');

    const allTypes = service.getAllTypes();
    expect(allTypes).toHaveLength(2);
    expect(allTypes.map((t) => t.id)).toEqual(['project', 'proposal']);
  });

  it('throws when getType is called for an unregistered space type', async () => {
    const service = new DocumentSpaceService(mockManifestRegistry);
    await service.initialize();

    expect(() => service.getType('non_existent')).toThrow(
      /DocumentSpaceType "non_existent" not found/i
    );
  });

  it('throws during initialize if manifest registry provides invalid space types', async () => {
    const invalidManifestRegistry: DocumentSpaceManifestRegistryPort = {
      getDocumentSpaceTypes: async () => [
        {
          id: 'invalid',
          displayName: 'Invalid',
          allowedDocumentTypes: [],
          storageConfig: {
            provider: 'google_drive',
            fetchMethod: 'bad_method' as unknown as 'shared_drives',
          },
        },
      ],
    };

    const service = new DocumentSpaceService(invalidManifestRegistry);
    await expect(service.initialize()).rejects.toThrow(/invalid documentspacetype/i);
  });
});





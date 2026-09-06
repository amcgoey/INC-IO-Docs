import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentSpaceTypeSchema,
  DocumentSpaceSchema,
  DocumentSpaceCollectionSchema,
  StorageContextConfigSchema,
  StorageLocationSchema,
  DocumentSpaceService,
  formatValidationErrors,
  type DocumentSpaceType,
  type DocumentSpace,
  type DocumentSpaceCollection,
  type StorageLocation,
} from './domain';
import type {
  DocumentSpaceManifestRegistryPort,
  DocumentSpaceStoragePort,
} from './ports';

describe('DocumentSpace Domain Schemas', () => {
  describe('StorageContextConfigSchema', () => {
    it('validates a record storage configuration', () => {
      const validConfig = {
        provider: 'google_drive',
        fetchMethod: 'shared_drives',
        paginationLimit: 500,
      };

      expect(Value.Check(StorageContextConfigSchema, validConfig)).toBe(true);
    });

    it('validates any arbitrary key-value storage configuration object', () => {
      const customConfig = {
        customKey: 'customValue',
        nested: { foo: 'bar' },
      };

      expect(Value.Check(StorageContextConfigSchema, customConfig)).toBe(true);
    });

    it('rejects a non-object configuration', () => {
      expect(Value.Check(StorageContextConfigSchema, 'string-config')).toBe(false);
      expect(Value.Check(StorageContextConfigSchema, 123)).toBe(false);
      expect(Value.Check(StorageContextConfigSchema, null)).toBe(false);
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

    it('rejects DocumentSpaceType with non-object storageConfig', () => {
      const invalid = {
        id: 'project',
        displayName: 'Project',
        allowedDocumentTypes: ['communication-project'],
        storageConfig: 'not-an-object',
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

  describe('StorageLocationSchema', () => {
    it('validates a valid StorageLocation with provider and abstractStorageId', () => {
      const location: StorageLocation = {
        provider: 'google_drive',
        abstractStorageId: 'drive-folder-123',
      };

      expect(Value.Check(StorageLocationSchema, location)).toBe(true);
    });

    it('rejects StorageLocation missing provider or abstractStorageId', () => {
      const missingProvider = {
        abstractStorageId: 'drive-folder-123',
      };
      const missingAbstractId = {
        provider: 'google_drive',
      };
      const emptyProvider = {
        provider: '',
        abstractStorageId: 'drive-folder-123',
      };

      expect(Value.Check(StorageLocationSchema, missingProvider)).toBe(false);
      expect(Value.Check(StorageLocationSchema, missingAbstractId)).toBe(false);
      expect(Value.Check(StorageLocationSchema, emptyProvider)).toBe(false);
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
  let mockStoragePort: DocumentSpaceStoragePort;

  beforeEach(() => {
    mockManifestRegistry = {
      getDocumentSpaceTypes: async () => [sampleProjectSpaceType, sampleProposalSpaceType],
    };
    mockStoragePort = {
      fetchSpaces: vi.fn(),
      resolveStorageLocation: vi.fn(),
    };
  });

  it('initializes and caches space types from the manifest registry port', async () => {
    const service = new DocumentSpaceService(mockManifestRegistry, mockStoragePort);
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
    const service = new DocumentSpaceService(mockManifestRegistry, mockStoragePort);
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
          storageConfig: 'not-an-object' as unknown as Record<string, unknown>,
        },
      ],
    };

    const service = new DocumentSpaceService(invalidManifestRegistry, mockStoragePort);
    await expect(service.initialize()).rejects.toThrow(/invalid documentspacetype/i);
  });

  describe('getCollection', () => {

    it('dynamically queries the storage port and returns a DocumentSpaceCollection', async () => {
      const mockSpaces: DocumentSpace[] = [
        {
          id: 'drive-101',
          typeId: 'project',
          name: 'Renovation Space',
          abstractStorageId: 'drive-101',
        },
      ];

      vi.mocked(mockStoragePort.fetchSpaces).mockResolvedValueOnce(mockSpaces);

      const service = new DocumentSpaceService(mockManifestRegistry, mockStoragePort);
      await service.initialize();

      const collection = await service.getCollection('project');

      expect(mockStoragePort.fetchSpaces).toHaveBeenCalledTimes(1);
      expect(mockStoragePort.fetchSpaces).toHaveBeenCalledWith(
        sampleProjectSpaceType.storageConfig,
        'project'
      );

      expect(collection).toEqual({
        type: sampleProjectSpaceType,
        spaces: mockSpaces,
      });
      expect(Value.Check(DocumentSpaceCollectionSchema, collection)).toBe(true);
    });

    it('queries storage port dynamically on each call without caching', async () => {
      const initialSpaces: DocumentSpace[] = [
        {
          id: 'drive-1',
          typeId: 'project',
          name: 'Drive 1',
          abstractStorageId: 'drive-1',
        },
      ];
      const updatedSpaces: DocumentSpace[] = [
        {
          id: 'drive-1',
          typeId: 'project',
          name: 'Drive 1',
          abstractStorageId: 'drive-1',
        },
        {
          id: 'drive-2',
          typeId: 'project',
          name: 'Drive 2',
          abstractStorageId: 'drive-2',
        },
      ];

      vi.mocked(mockStoragePort.fetchSpaces)
        .mockResolvedValueOnce(initialSpaces)
        .mockResolvedValueOnce(updatedSpaces);

      const service = new DocumentSpaceService(mockManifestRegistry, mockStoragePort);
      await service.initialize();

      const firstCall = await service.getCollection('project');
      expect(firstCall.spaces).toEqual(initialSpaces);

      const secondCall = await service.getCollection('project');
      expect(secondCall.spaces).toEqual(updatedSpaces);

      expect(mockStoragePort.fetchSpaces).toHaveBeenCalledTimes(2);
    });

    it('throws when getCollection is called for an unregistered space type', async () => {
      const service = new DocumentSpaceService(mockManifestRegistry, mockStoragePort);
      await service.initialize();

      await expect(service.getCollection('unregistered')).rejects.toThrow(
        /DocumentSpaceType "unregistered" not found/i
      );
      expect(mockStoragePort.fetchSpaces).not.toHaveBeenCalled();
    });

    it('propagates errors thrown by the storage port', async () => {
      vi.mocked(mockStoragePort.fetchSpaces).mockRejectedValueOnce(
        new Error('Drive network failure')
      );

      const service = new DocumentSpaceService(mockManifestRegistry, mockStoragePort);
      await service.initialize();

      await expect(service.getCollection('project')).rejects.toThrow(
        'Drive network failure'
      );
    });
  });
});





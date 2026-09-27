import { describe, it, expect, vi } from 'vitest';
import {
  createDocumentSpaceFeatureWiring,
  createDocumentSpaceServiceFactory,
} from './document-space.wiring';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type {
  RawManifestProviderPort,
  DocumentSpaceStoragePort,
} from '../features/document-space/ports';
import { DocumentSpaceService } from '../features/document-space/domain';
import { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';

describe('document-space.wiring', () => {
  const dummySpaceType = {
    id: 'projects',
    displayName: 'Projects',
    spaceSchema: { allowedDocumentTypes: ['doc-1'] },
    storageConfig: {
      provider: 'google_drive',
      fetchMethod: 'shared_drives',
    },
  };

  const mockManifestProvider: RawManifestProviderPort = {
    getRawManifest: vi.fn().mockResolvedValue({
      DocumentSpaceTypes: [dummySpaceType],
    }),
  };

  const mockStorageAdapter: DocumentSpaceStoragePort = {
    fetchSpaces: vi.fn().mockResolvedValue([]),
    resolveStorageLocation: vi.fn().mockResolvedValue({ provider: 'google_drive', abstractStorageId: 'abc' }),
  };

  describe('createDocumentSpaceFeatureWiring', () => {
    it('creates DocumentSpaceService and registry adapter', () => {
      const wiring = createDocumentSpaceFeatureWiring({
        rawManifestProvider: mockManifestProvider,
        storageAdapter: mockStorageAdapter,
      });

      expect(wiring.documentSpaceRegistry).toBeInstanceOf(DocumentSpaceManifestRegistryAdapter);
      expect(wiring.documentSpaceService).toBeInstanceOf(DocumentSpaceService);
      expect(wiring.documentSpaceUiSchemaQuery).toBeDefined();
    });
  });

  describe('createDocumentSpaceServiceFactory', () => {
    it('instantiates and initializes DocumentSpaceService per-request', async () => {
      const registry = new DocumentSpaceManifestRegistryAdapter(mockManifestProvider);

      const factory = createDocumentSpaceServiceFactory({
        documentSpaceRegistry: registry,
        storageAdapter: mockStorageAdapter,
      });

      const context: WorkspaceExecutionContext = {
        userOAuthToken: 'token-spaces-xyz',
      };

      const service = await factory(context);

      expect(service).toBeInstanceOf(DocumentSpaceService);
      // Verify initialized
      expect(service.getAllTypes()).toHaveLength(1);
      expect(service.getType('projects').displayName).toBe('Projects');
    });

    it('works when userOAuthToken is omitted by falling back to storageAdapter', async () => {
      const registry = new DocumentSpaceManifestRegistryAdapter(mockManifestProvider);

      const factory = createDocumentSpaceServiceFactory({
        documentSpaceRegistry: registry,
        storageAdapter: mockStorageAdapter,
      });

      const context: WorkspaceExecutionContext = {};

      const service = await factory(context);

      expect(service).toBeInstanceOf(DocumentSpaceService);
      expect(service.hasType('projects')).toBe(true);
    });
  });
});

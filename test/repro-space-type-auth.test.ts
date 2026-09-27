import { describe, it, expect, vi } from 'vitest';
import { GoogleDriveStorageAdapter, type DriveStorageClientPort } from '../src/features/document-space/adapters/google-drive-storage-adapter';
import { DocumentSpaceService } from '../src/features/document-space/domain';
import { createUiProcessManagerWiring } from '../src/app/ui-process-manager.wiring';

describe('Document Space Type Change - Auth Propagation via Request-Scoped Wiring', () => {
  it('instantiates pre-authenticated client and executes pure domain calls when space type changes', async () => {
    const listSharedDrivesMock = vi.fn().mockResolvedValue({
      drives: [{ id: 'drive-1', name: 'Project Drive 1' }],
      nextPageToken: undefined,
    });

    const createPreAuthenticatedDriveClient = vi.fn((token: string): DriveStorageClientPort => {
      expect(token).toBe('ya29.valid-user-oauth-token');
      return {
        listSharedDrives: listSharedDrivesMock,
        listFolders: vi.fn(),
      };
    });

    const manifestRegistryMock = {
      getDocumentSpaceTypes: vi.fn().mockResolvedValue([
        {
          id: 'projects',
          name: 'Projects',
          displayName: 'Projects',
          storageConfig: {
            provider: 'google_drive',
            fetchMethod: 'shared_drives',
          },
          spaceSchema: {
            allowedDocumentTypes: ['project-report'],
          },
        },
      ]),
      getManifest: vi.fn().mockResolvedValue({
        documentTypes: {
          'project-report': {
            displayName: 'Project Report',
            schema: {},
          },
        },
      }),
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: {
          'project-report': {
            displayName: 'Project Report',
            schema: {},
          },
        },
      }),
      readParsedSchema: vi.fn(),
    };

    const schemaDrivenUiServiceMock = {
      generateView: vi.fn().mockResolvedValue({
        id: 'card-1',
        sections: [{ widgets: [{ textParagraph: { text: 'Hello' } }] }],
      }),
    };

    const wiring = createUiProcessManagerWiring({
      manifestProvider: manifestRegistryMock,
      schemaDrivenUiService: schemaDrivenUiServiceMock as unknown as import('../src/features/schema-driven-ui/domain').SchemaDrivenUiService,
      createDocumentSpaceService: async (context) => {
        const driveClient = createPreAuthenticatedDriveClient(context.userOAuthToken!);
        const storageAdapter = new GoogleDriveStorageAdapter(driveClient);
        const svc = new DocumentSpaceService(manifestRegistryMock, storageAdapter);
        await svc.initialize();
        return svc;
      },
    });

    const result = await wiring.requestScopedWrapper({
      actionName: 'onSpaceTypeChange',
      userOAuthToken: 'ya29.valid-user-oauth-token',
      formData: {
        SelectDocumentSpaceType: 'projects',
      },
    });

    expect(createPreAuthenticatedDriveClient).toHaveBeenCalledWith('ya29.valid-user-oauth-token');
    expect(listSharedDrivesMock).toHaveBeenCalledWith({
      pageSize: 100,
      pageToken: undefined,
    });
    expect(result).toBeDefined();
  });
});

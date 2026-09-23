import { describe, it, expect, vi } from 'vitest';
import { WorkspaceAddonAdapter } from '../src/features/ui-process-manager/adapters/workspace-addon.adapter';
import { GoogleDriveStorageAdapter, type DriveStorageClientPort, type DriveAuthOptions } from '../src/features/document-space/adapters/google-drive-storage-adapter';
import { DocumentSpaceService } from '../src/features/document-space/domain';
import type { UiProcessSpaceProviderPort, UiProcessAuthOptions } from '../src/features/ui-process-manager/ports';
import { GoogleDriveApiError } from '../src/infrastructure/drive/drive-client';

describe('Document Space Type Change - Auth Propagation Reproduction', () => {
  it('forwards userOAuthToken to spaceProvider.getCollection and driveClient when space type changes', async () => {
    // Mock DriveStorageClientPort that enforces authentication like Google Drive in production
    const listSharedDrivesMock = vi.fn().mockImplementation((_options?: unknown, driveOptions?: DriveAuthOptions) => {
      if (!driveOptions?.auth) {
        throw new GoogleDriveApiError(
          'Google Drive API error in listSharedDrives: Request is missing required authentication credential.',
          { statusCode: 401 }
        );
      }
      return Promise.resolve({
        drives: [{ id: 'drive-1', name: 'Project Drive 1' }],
        nextPageToken: undefined,
      });
    });

    const mockDriveClient: DriveStorageClientPort = {
      listSharedDrives: listSharedDrivesMock,
      listFolders: vi.fn(),
    };

    const storageAdapter = new GoogleDriveStorageAdapter(mockDriveClient);

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
    };

    const documentSpaceService = new DocumentSpaceService(manifestRegistryMock, storageAdapter);
    await documentSpaceService.initialize();

    const spaceProvider: UiProcessSpaceProviderPort = {
      getAllTypes: () => documentSpaceService.getAllTypes(),
      getCollection: (typeId: string, options?: UiProcessAuthOptions) =>
        documentSpaceService.getCollection(typeId, options),
    };

    const adapter = new WorkspaceAddonAdapter({
      spaceProvider,
    });

    // Simulate Workspace Addon sending onSpaceTypeChange with userOAuthToken
    const result = await adapter.processUiEvent({
      actionName: 'onSpaceTypeChange',
      userOAuthToken: 'ya29.valid-user-oauth-token',
      formData: {
        SelectDocumentSpaceType: 'projects',
      },
    });

    // We expect listSharedDrives to have received the auth token
    expect(listSharedDrivesMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ auth: 'ya29.valid-user-oauth-token' })
    );

    // And generated intent selectionState should contain the retrieved spaces
    expect(result).toEqual(
      expect.objectContaining({
        type: 'render',
        selectionState: expect.objectContaining({
          spaces: ['Project Drive 1'],
        }),
      })
    );
  });
});

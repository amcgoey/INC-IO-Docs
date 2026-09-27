import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriveNameResolver } from './drive-name-resolver';
import type { DriveStorageClientPort } from './google-drive-storage-adapter';

describe('DriveNameResolver', () => {
  let mockDriveClient: DriveStorageClientPort;
  let resolver: DriveNameResolver;

  beforeEach(() => {
    mockDriveClient = {
      listSharedDrives: vi.fn(),
      listFolders: vi.fn(),
      searchFiles: vi.fn(),
    };
    resolver = new DriveNameResolver(mockDriveClient);
  });

  describe('resolveSharedDriveId', () => {
    it('returns drive id when found on the first page', async () => {
      vi.mocked(mockDriveClient.listSharedDrives).mockResolvedValueOnce({
        drives: [
          { id: 'drive-1', name: 'Other Drive' },
          { id: 'drive-2', name: 'Target Drive' },
        ],
      });

      const result = await resolver.resolveSharedDriveId('Target Drive');

      expect(result).toBe('drive-2');
      expect(mockDriveClient.listSharedDrives).toHaveBeenCalledWith({
        pageSize: 100,
        pageToken: undefined,
      });
    });

    it('paginates through multiple pages until found', async () => {
      vi.mocked(mockDriveClient.listSharedDrives)
        .mockResolvedValueOnce({
          drives: [{ id: 'drive-1', name: 'First Drive' }],
          nextPageToken: 'page-2-token',
        })
        .mockResolvedValueOnce({
          drives: [{ id: 'drive-2', name: 'Target Drive' }],
        });

      const result = await resolver.resolveSharedDriveId('Target Drive');

      expect(result).toBe('drive-2');
      expect(mockDriveClient.listSharedDrives).toHaveBeenCalledTimes(2);
      expect(mockDriveClient.listSharedDrives).toHaveBeenNthCalledWith(2, {
        pageSize: 100,
        pageToken: 'page-2-token',
      });
    });

    it('throws when shared drive is not found', async () => {
      vi.mocked(mockDriveClient.listSharedDrives).mockResolvedValueOnce({
        drives: [{ id: 'drive-1', name: 'Other Drive' }],
      });

      await expect(resolver.resolveSharedDriveId('NonExistent')).rejects.toThrow(
        'Shared drive not found with name: NonExistent'
      );
    });
  });

  describe('resolveParentFolderId', () => {
    it('returns folder id when exactly one matching folder is found', async () => {
      vi.mocked(mockDriveClient.searchFiles!).mockResolvedValueOnce([
        { id: 'folder-123', name: 'Proposals' },
      ]);

      const result = await resolver.resolveParentFolderId('Proposals', 'drive-1');

      expect(result).toBe('folder-123');
      expect(mockDriveClient.searchFiles).toHaveBeenCalledWith({
        targetName: 'Proposals',
        exactMatch: true,
        sharedDriveId: 'drive-1',
        mimeTypes: ['application/vnd.google-apps.folder'],
      });
    });

    it('throws error when searchFiles is not implemented on client', async () => {
      const clientWithoutSearch: DriveStorageClientPort = {
        listSharedDrives: vi.fn(),
        listFolders: vi.fn(),
      };
      const noSearchResolver = new DriveNameResolver(clientWithoutSearch);

      await expect(noSearchResolver.resolveParentFolderId('Proposals')).rejects.toThrow(
        'driveClient.searchFiles is not implemented on the provided DriveStorageClientPort'
      );
    });

    it('throws error when no folder is found', async () => {
      vi.mocked(mockDriveClient.searchFiles!).mockResolvedValueOnce([]);

      await expect(resolver.resolveParentFolderId('MissingFolder')).rejects.toThrow(
        'Parent folder not found with name: MissingFolder'
      );
    });

    it('throws error when multiple folders match the name', async () => {
      vi.mocked(mockDriveClient.searchFiles!).mockResolvedValueOnce([
        { id: 'folder-1', name: 'Duplicate' },
        { id: 'folder-2', name: 'Duplicate' },
      ]);

      await expect(resolver.resolveParentFolderId('Duplicate')).rejects.toThrow(
        'Multiple parent folders found with name: Duplicate'
      );
    });
  });
});

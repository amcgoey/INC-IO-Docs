import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  GoogleDriveStorageAdapter,
  type DriveStorageClientPort,
  type FoldersStorageConfig,
  type SharedDrivesStorageConfig,
} from './google-drive-storage-adapter';
import {
  DocumentSpaceSchema,
  StorageLocationSchema,
} from '../domain';

describe('GoogleDriveStorageAdapter', () => {
  let mockDriveClient: DriveStorageClientPort;
  let adapter: GoogleDriveStorageAdapter;

  beforeEach(() => {
    mockDriveClient = {
      listSharedDrives: vi.fn(),
      listFolders: vi.fn(),
    };
    adapter = new GoogleDriveStorageAdapter(mockDriveClient);
  });

  describe('fetchMethod: shared_drives', () => {
    const baseConfig: SharedDrivesStorageConfig = {
      provider: 'google_drive',
      fetchMethod: 'shared_drives',
    };

    it('retrieves and maps shared drives into pure DocumentSpace objects', async () => {
      vi.mocked(mockDriveClient.listSharedDrives).mockResolvedValueOnce({
        drives: [
          { id: 'drive-1', name: 'Alpha Project' },
          { id: 'drive-2', name: 'Beta Project' },
        ],
      });

      const spaces = await adapter.fetchSpaces(baseConfig, 'project');

      expect(mockDriveClient.listSharedDrives).toHaveBeenCalledTimes(1);
      expect(mockDriveClient.listSharedDrives).toHaveBeenCalledWith({
        pageSize: 100,
        pageToken: undefined,
      });

      expect(spaces).toHaveLength(2);
      expect(spaces).toEqual([
        {
          id: 'drive-1',
          typeId: 'project',
          name: 'Alpha Project',
          abstractStorageId: 'drive-1',
        },
        {
          id: 'drive-2',
          typeId: 'project',
          name: 'Beta Project',
          abstractStorageId: 'drive-2',
        },
      ]);

      for (const space of spaces) {
        expect(Value.Check(DocumentSpaceSchema, space)).toBe(true);
      }
    });

    it('paginates across multiple pages until nextPageToken is exhausted', async () => {
      vi.mocked(mockDriveClient.listSharedDrives)
        .mockResolvedValueOnce({
          drives: [{ id: 'd-1', name: 'Drive 1' }],
          nextPageToken: 'token-page-2',
        })
        .mockResolvedValueOnce({
          drives: [{ id: 'd-2', name: 'Drive 2' }],
        });

      const spaces = await adapter.fetchSpaces(baseConfig, 'project');

      expect(mockDriveClient.listSharedDrives).toHaveBeenCalledTimes(2);
      expect(mockDriveClient.listSharedDrives).toHaveBeenNthCalledWith(1, {
        pageSize: 100,
        pageToken: undefined,
      });
      expect(mockDriveClient.listSharedDrives).toHaveBeenNthCalledWith(2, {
        pageSize: 100,
        pageToken: 'token-page-2',
      });

      expect(spaces).toHaveLength(2);
      expect(spaces.map((s) => s.id)).toEqual(['d-1', 'd-2']);
    });

    it('enforces custom paginationLimit', async () => {
      const configWithLimit: SharedDrivesStorageConfig = {
        provider: 'google_drive',
        fetchMethod: 'shared_drives',
        paginationLimit: 150,
      };

      const page1Drives = Array.from({ length: 100 }, (_, i) => ({
        id: `d-${i}`,
        name: `Drive ${i}`,
      }));
      const page2Drives = Array.from({ length: 100 }, (_, i) => ({
        id: `d-${i + 100}`,
        name: `Drive ${i + 100}`,
      }));

      vi.mocked(mockDriveClient.listSharedDrives)
        .mockResolvedValueOnce({
          drives: page1Drives,
          nextPageToken: 'page-2',
        })
        .mockResolvedValueOnce({
          drives: page2Drives,
          nextPageToken: 'page-3',
        });

      const spaces = await adapter.fetchSpaces(configWithLimit, 'project');

      expect(spaces).toHaveLength(150);
      expect(mockDriveClient.listSharedDrives).toHaveBeenCalledTimes(2);
      expect(mockDriveClient.listSharedDrives).toHaveBeenNthCalledWith(1, {
        pageSize: 100,
        pageToken: undefined,
      });
      expect(mockDriveClient.listSharedDrives).toHaveBeenNthCalledWith(2, {
        pageSize: 50,
        pageToken: 'page-2',
      });
    });

    it('enforces default paginationLimit of 500 when not specified', async () => {
      const pageDrives = (start: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: `d-${start + i}`,
          name: `Drive ${start + i}`,
        }));

      vi.mocked(mockDriveClient.listSharedDrives)
        .mockResolvedValueOnce({ drives: pageDrives(0, 100), nextPageToken: 'p2' })
        .mockResolvedValueOnce({ drives: pageDrives(100, 100), nextPageToken: 'p3' })
        .mockResolvedValueOnce({ drives: pageDrives(200, 100), nextPageToken: 'p4' })
        .mockResolvedValueOnce({ drives: pageDrives(300, 100), nextPageToken: 'p5' })
        .mockResolvedValueOnce({ drives: pageDrives(400, 100), nextPageToken: 'p6' });

      const spaces = await adapter.fetchSpaces(baseConfig, 'project');

      expect(spaces).toHaveLength(500);
      expect(mockDriveClient.listSharedDrives).toHaveBeenCalledTimes(5);
    });

    it('returns empty array when paginationLimit is zero or negative', async () => {
      const spaces = await adapter.fetchSpaces(
        {
          provider: 'google_drive',
          fetchMethod: 'shared_drives',
          paginationLimit: 0,
        },
        'project'
      );

      expect(spaces).toEqual([]);
      expect(mockDriveClient.listSharedDrives).not.toHaveBeenCalled();
    });

    it('assigns the provided typeId to mapped spaces', async () => {
      vi.mocked(mockDriveClient.listSharedDrives).mockResolvedValueOnce({
        drives: [{ id: 'd-1', name: 'Drive 1' }],
      });

      const spaces = await adapter.fetchSpaces(baseConfig, 'custom-space-type');
      expect(spaces[0].typeId).toBe('custom-space-type');
    });
  });

  describe('fetchMethod: folders', () => {
    const baseConfig: FoldersStorageConfig = {
      provider: 'google_drive',
      fetchMethod: 'folders',
      parentFolderId: 'parent-folder-123',
      sharedDriveId: 'shared-drive-456',
    };

    it('retrieves and maps folders with parentFolderId and sharedDriveId', async () => {
      vi.mocked(mockDriveClient.listFolders).mockResolvedValueOnce({
        folders: [
          { id: 'f-1', name: 'Proposal Alpha' },
          { id: 'f-2', name: 'Proposal Beta' },
        ],
      });

      const spaces = await adapter.fetchSpaces(baseConfig, 'proposal');

      expect(mockDriveClient.listFolders).toHaveBeenCalledWith({
        parentFolderId: 'parent-folder-123',
        sharedDriveId: 'shared-drive-456',
        pageSize: 100,
        pageToken: undefined,
      });

      expect(spaces).toHaveLength(2);
      expect(spaces).toEqual([
        {
          id: 'f-1',
          typeId: 'proposal',
          name: 'Proposal Alpha',
          abstractStorageId: 'f-1',
        },
        {
          id: 'f-2',
          typeId: 'proposal',
          name: 'Proposal Beta',
          abstractStorageId: 'f-2',
        },
      ]);

      for (const space of spaces) {
        expect(Value.Check(DocumentSpaceSchema, space)).toBe(true);
      }
    });

    it('paginates folders and respects paginationLimit', async () => {
      vi.mocked(mockDriveClient.listFolders)
        .mockResolvedValueOnce({
          folders: [{ id: 'f-1', name: 'F1' }],
          nextPageToken: 'token-f2',
        })
        .mockResolvedValueOnce({
          folders: [{ id: 'f-2', name: 'F2' }],
        });

      const spaces = await adapter.fetchSpaces(
        {
          provider: 'google_drive',
          fetchMethod: 'folders',
          parentFolderId: 'parent-folder-123',
          paginationLimit: 10,
        },
        'proposal'
      );

      expect(mockDriveClient.listFolders).toHaveBeenCalledTimes(2);
      expect(mockDriveClient.listFolders).toHaveBeenNthCalledWith(1, {
        parentFolderId: 'parent-folder-123',
        sharedDriveId: undefined,
        pageSize: 10,
        pageToken: undefined,
      });
      expect(mockDriveClient.listFolders).toHaveBeenNthCalledWith(2, {
        parentFolderId: 'parent-folder-123',
        sharedDriveId: undefined,
        pageSize: 9,
        pageToken: 'token-f2',
      });
      expect(spaces).toHaveLength(2);
    });
  });

  describe('error handling and schema validation', () => {
    it('throws when fetchMethod is unsupported', async () => {
      const invalidConfig = {
        provider: 'google_drive',
        fetchMethod: 'unsupported_method',
      } as unknown as SharedDrivesStorageConfig;

      await expect(adapter.fetchSpaces(invalidConfig, 'project')).rejects.toThrow(
        /Unsupported fetchMethod: unsupported_method/
      );
    });

    it('throws when shared_drives config fails schema validation due to invalid provider', async () => {
      const invalidConfig = {
        provider: 'other_provider',
        fetchMethod: 'shared_drives',
      };

      await expect(adapter.fetchSpaces(invalidConfig, 'project')).rejects.toThrow(
        /Invalid Google Drive storage configuration/
      );
    });

    it('throws when shared_drives config fails schema validation due to invalid paginationLimit', async () => {
      const invalidConfig = {
        provider: 'google_drive',
        fetchMethod: 'shared_drives',
        paginationLimit: 'not-a-number' as unknown as number,
      };

      await expect(adapter.fetchSpaces(invalidConfig, 'project')).rejects.toThrow(
        /Invalid Google Drive storage configuration/
      );
    });

    it('throws when folders config fails schema validation due to invalid provider', async () => {
      const invalidConfig = {
        provider: 'dropbox',
        fetchMethod: 'folders',
      };

      await expect(adapter.fetchSpaces(invalidConfig, 'project')).rejects.toThrow(
        /Invalid Google Drive storage configuration/
      );
    });

    it('throws when folders config fails schema validation due to invalid paginationLimit', async () => {
      const invalidConfig = {
        provider: 'google_drive',
        fetchMethod: 'folders',
        paginationLimit: true as unknown as number,
      };

      await expect(adapter.fetchSpaces(invalidConfig, 'project')).rejects.toThrow(
        /Invalid Google Drive storage configuration/
      );
    });

    it('propagates client errors', async () => {
      vi.mocked(mockDriveClient.listSharedDrives).mockRejectedValueOnce(
        new Error('Drive network failure')
      );

      await expect(
        adapter.fetchSpaces(
          { provider: 'google_drive', fetchMethod: 'shared_drives' },
          'project'
        )
      ).rejects.toThrow('Drive network failure');
    });
  });

  describe('resolveStorageLocation', () => {
    it('resolves an abstractStorageId to a typed StorageLocation schema', async () => {
      const location = await adapter.resolveStorageLocation('drive-folder-abc-123');

      expect(location).toEqual({
        provider: 'google_drive',
        abstractStorageId: 'drive-folder-abc-123',
      });
      expect(Value.Check(StorageLocationSchema, location)).toBe(true);
    });

    it('rejects when abstractStorageId is empty or whitespace', async () => {
      await expect(adapter.resolveStorageLocation('')).rejects.toThrow(
        /abstractStorageId must be a non-empty string/
      );
      await expect(adapter.resolveStorageLocation('   ')).rejects.toThrow(
        /abstractStorageId must be a non-empty string/
      );
    });

    it('rejects when abstractStorageId is not a string', async () => {
      await expect(
        adapter.resolveStorageLocation(null as unknown as string)
      ).rejects.toThrow(/abstractStorageId must be a non-empty string/);
      await expect(
        adapter.resolveStorageLocation(undefined as unknown as string)
      ).rejects.toThrow(/abstractStorageId must be a non-empty string/);
    });
  });
});


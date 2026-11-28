import { describe, it, expect, vi } from 'vitest';
import {
  DriveOptionSourceAdapter,
  type DriveFolderListClient,
} from './drive-option-source.adapter';

function createMockDriveClient(
  overrides?: Partial<DriveFolderListClient>
): DriveFolderListClient {
  return {
    listFolders: vi.fn().mockResolvedValue({ folders: [] }),
    ...overrides,
  };
}

describe('DriveOptionSourceAdapter', () => {
  it('lists folders directly from spaceStorageId when relativePath is omitted', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockResolvedValue({
        folders: [
          { id: 'f-1', name: 'Acme Corp' },
          { id: 'f-2', name: 'Beta Inc' },
        ],
      }),
    });

    const adapter = new DriveOptionSourceAdapter(driveClient);
    const result = await adapter.listFoldersAtPath({ spaceStorageId: 'space-123' });

    expect(result).toEqual({
      status: 'ready',
      targetPath: 'root',
      items: [
        { key: 'Acme Corp', name: 'Acme Corp' },
        { key: 'Beta Inc', name: 'Beta Inc' },
      ],
    });
  });

  it('navigates relativePath segments including a literal "root" subfolder and normalizes slashes', async () => {
    const listFolders = vi.fn().mockImplementation(async (opts?: { parentFolderId?: string }) => {
      if (opts?.parentFolderId === 'space-1') {
        return { folders: [{ id: 'root-sub-id', name: 'root' }] };
      }
      if (opts?.parentFolderId === 'root-sub-id') {
        return { folders: [{ id: 'comm-id', name: 'Communication' }] };
      }
      if (opts?.parentFolderId === 'comm-id') {
        return { folders: [{ id: 'c-1', name: 'Pavarini' }] };
      }
      return { folders: [] };
    });

    const adapter = new DriveOptionSourceAdapter(createMockDriveClient({ listFolders }));
    const result = await adapter.listFoldersAtPath({
      spaceStorageId: 'space-1',
      relativePath: '/root//Communication/',
    });

    expect(result).toEqual({
      status: 'ready',
      targetPath: 'root//Communication',
      items: [{ key: 'Pavarini', name: 'Pavarini' }],
    });
  });

  it('short-circuits immediately to ambiguous_path when >= 2 folders match a path segment', async () => {
    const listFolders = vi.fn().mockImplementation(async (opts?: { pageToken?: string }) => {
      if (!opts?.pageToken) {
        return {
          folders: [{ id: 'a-1', name: '1 Admin' }],
          nextPageToken: 'page-2',
        };
      }
      return {
        folders: [{ id: 'a-2', name: '1 Admin' }],
        nextPageToken: 'page-3',
      };
    });

    const adapter = new DriveOptionSourceAdapter(createMockDriveClient({ listFolders }));
    const result = await adapter.listFoldersAtPath({
      spaceStorageId: 'space-1',
      relativePath: '1 Admin/Communication',
    });

    expect(result).toEqual({
      status: 'ambiguous_path',
      targetPath: '1 Admin/Communication',
      items: [],
    });
    expect(listFolders).toHaveBeenCalledTimes(2);
  });

  it('marks truncated: true when child folders exceed maxItems', async () => {
    const listFolders = vi.fn().mockResolvedValue({
      folders: [
        { id: '1', name: 'Folder 1' },
        { id: '2', name: 'Folder 2' },
        { id: '3', name: 'Folder 3' },
      ],
    });

    const adapter = new DriveOptionSourceAdapter(createMockDriveClient({ listFolders }));
    const result = await adapter.listFoldersAtPath({
      spaceStorageId: 'space-1',
      maxItems: 2,
    });

    expect(result).toEqual({
      status: 'ready',
      targetPath: 'root',
      items: [
        { key: 'Folder 1', name: 'Folder 1' },
        { key: 'Folder 2', name: 'Folder 2' },
      ],
      truncated: true,
    });
  });

  it('validates folder existence with ambiguous_option short-circuiting and allowUserInput handling', async () => {
    const listFolders = vi
      .fn()
      .mockResolvedValueOnce({
        folders: [{ id: 'dup-1', name: 'Dup' }],
        nextPageToken: 'p2',
      })
      .mockResolvedValueOnce({
        folders: [{ id: 'dup-2', name: 'Dup' }],
        nextPageToken: 'p3',
      });

    const adapter = new DriveOptionSourceAdapter(createMockDriveClient({ listFolders }));
    const dupRes = await adapter.validateFolderExistence({
      spaceStorageId: 'space-1',
      value: 'Dup',
      allowUserInput: true,
    });

    expect(dupRes).toEqual({
      isValid: false,
      status: 'ambiguous_option',
      targetPath: 'root',
    });
    expect(listFolders).toHaveBeenCalledTimes(2);
  });

  it('propagates AbortSignal to DriveFolderListClient and halts traversal/pagination immediately when aborted', async () => {
    const controller = new AbortController();
    const listFolders = vi.fn().mockImplementation(async () => {
      controller.abort();
      return {
        folders: [{ id: 'a-1', name: '1 Admin' }],
        nextPageToken: 'page-2',
      };
    });

    const adapter = new DriveOptionSourceAdapter(createMockDriveClient({ listFolders }));

    await expect(
      adapter.listFoldersAtPath({
        spaceStorageId: 'space-1',
        relativePath: '1 Admin/Communication',
        signal: controller.signal,
      })
    ).rejects.toThrow(/abort/i);

    expect(listFolders).toHaveBeenCalledTimes(1);
    expect(listFolders).toHaveBeenCalledWith(
      { parentFolderId: 'space-1', pageSize: 100 },
      { signal: controller.signal }
    );

    const controller2 = new AbortController();
    const listFoldersVal = vi.fn().mockImplementation(async () => {
      controller2.abort();
      return {
        folders: [{ id: 'f-1', name: 'Acme' }],
        nextPageToken: 'page-2',
      };
    });

    const adapter2 = new DriveOptionSourceAdapter(createMockDriveClient({ listFolders: listFoldersVal }));
    await expect(
      adapter2.validateFolderExistence({
        spaceStorageId: 'space-1',
        value: 'Acme',
        signal: controller2.signal,
      })
    ).rejects.toThrow(/abort/i);

    expect(listFoldersVal).toHaveBeenCalledTimes(1);
    expect(listFoldersVal).toHaveBeenCalledWith(
      { parentFolderId: 'space-1', name: 'Acme', pageSize: 100 },
      { signal: controller2.signal }
    );
  });
});

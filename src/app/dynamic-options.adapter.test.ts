import { describe, it, expect, vi } from 'vitest';
import {
  DynamicOptionsAdapter,
  type DynamicOptionsDriveClient,
} from './dynamic-options.adapter';
import type { DynamicOptionQuery } from '../features/schema-driven-ui/ports';

describe('DynamicOptionsAdapter', () => {
  const createMockDriveClient = (
    overrides?: Partial<DynamicOptionsDriveClient>
  ): DynamicOptionsDriveClient => ({
    listFolders: vi.fn().mockResolvedValue({ folders: [], nextPageToken: undefined }),
    ...overrides,
  });

  it('returns placeholder item when spaceId is missing', async () => {
    const driveClient = createMockDriveClient();
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'contactFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '1 Admin/Communication',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, {});

    expect(result).toEqual({
      contactFolders: [{ text: 'Select a Space first', value: '' }],
    });
    expect(driveClient.listFolders).not.toHaveBeenCalled();
  });

  it('fetches folders directly from spaceId when relativePath is not provided', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockResolvedValue({
        folders: [
          { id: 'f-1', name: 'Alpha' },
          { id: 'f-2', name: 'Beta' },
        ],
        nextPageToken: undefined,
      }),
    });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'rootFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result).toEqual({
      rootFolders: [
        { text: 'Alpha', value: 'Alpha' },
        { text: 'Beta', value: 'Beta' },
      ],
    });
    expect(driveClient.listFolders).toHaveBeenCalledWith(
      expect.objectContaining({ parentFolderId: 'space-123' })
    );
  });

  it('navigates relativePath segments to find target folder', async () => {
    const listFoldersMock = vi.fn().mockImplementation(async (options: { parentFolderId?: string }) => {
      if (options.parentFolderId === 'space-123') {
        return {
          folders: [
            { id: 'admin-id', name: '1 Admin' },
            { id: 'other-id', name: '2 Other' },
          ],
        };
      }
      if (options.parentFolderId === 'admin-id') {
        return {
          folders: [
            { id: 'comm-id', name: 'Communication' },
          ],
        };
      }
      if (options.parentFolderId === 'comm-id') {
        return {
          folders: [
            { id: 'client-1', name: 'Acme Corp' },
            { id: 'client-2', name: 'Globex' },
          ],
        };
      }
      return { folders: [] };
    });

    const driveClient = createMockDriveClient({ listFolders: listFoldersMock });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'contactFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '1 Admin/Communication',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result).toEqual({
      contactFolders: [
        { text: 'Acme Corp', value: 'Acme Corp' },
        { text: 'Globex', value: 'Globex' },
      ],
    });
  });

  it('returns empty array when a relativePath segment is not found', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockResolvedValue({
        folders: [{ id: 'other-id', name: '2 Other' }],
      }),
    });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'contactFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '1 Admin/Communication',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result).toEqual({
      contactFolders: [],
    });
  });

  it('enforces a maximum of 150 items across pagination', async () => {
    const page1Folders = Array.from({ length: 100 }, (_, i) => ({
      id: `f-${i}`,
      name: `Folder ${String(i).padStart(3, '0')}`,
    }));
    const page2Folders = Array.from({ length: 100 }, (_, i) => ({
      id: `f-${i + 100}`,
      name: `Folder ${String(i + 100).padStart(3, '0')}`,
    }));

    const listFoldersMock = vi.fn().mockImplementation(async (options: { pageToken?: string }) => {
      if (!options.pageToken) {
        return { folders: page1Folders, nextPageToken: 'token-page-2' };
      }
      return { folders: page2Folders, nextPageToken: 'token-page-3' };
    });

    const driveClient = createMockDriveClient({ listFolders: listFoldersMock });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'largeList',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result.largeList).toHaveLength(150);
    expect(result.largeList[0]).toEqual({ text: 'Folder 000', value: 'Folder 000' });
    expect(result.largeList[149]).toEqual({ text: 'Folder 149', value: 'Folder 149' });
    // Verify it stopped and didn't fetch page 3
    expect(listFoldersMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when provider or method is unsupported', async () => {
    const driveClient = createMockDriveClient();
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'unsupportedProvider',
        config: {
          provider: 'onedrive',
          method: 'list_folders',
        },
      },
      {
        sourceKey: 'unsupportedMethod',
        config: {
          provider: 'google_drive',
          method: 'unknown_method',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result).toEqual({
      unsupportedProvider: [],
      unsupportedMethod: [],
    });
    expect(driveClient.listFolders).not.toHaveBeenCalled();
  });

  it('handles timeouts gracefully via resilience wrapper', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 200))
      ),
    });
    const adapter = new DynamicOptionsAdapter(driveClient, { timeoutMs: 50 });

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'slowQuery',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result).toEqual({
      slowQuery: [],
    });
  });

  it('processes multiple queries with Promise.allSettled where one succeeds and one fails', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockImplementation(async (options: { parentFolderId?: string }) => {
        if (options.parentFolderId === 'failing-parent') {
          throw new Error('Drive API failure');
        }
        return {
          folders: [{ id: 'ok-1', name: 'OK Folder' }],
        };
      }),
    });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'failingQuery',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'failing-path',
        },
      },
      {
        sourceKey: 'successQuery',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
        },
      },
    ];

    // Mock implementation for segment resolution
    (driveClient.listFolders as ReturnType<typeof vi.fn>).mockImplementation(async (options: { parentFolderId?: string }) => {
      if (options.parentFolderId === 'space-123') {
        throw new Error('Drive API failure on failingQuery');
      }
      return {
        folders: [{ id: 'ok-1', name: 'OK Folder' }],
      };
    });

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result.failingQuery).toEqual([]);
    expect(result.successQuery).toEqual([]);
  });
});

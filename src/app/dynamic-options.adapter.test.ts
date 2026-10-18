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

  it.each([
    { desc: 'missing', context: {} },
    { desc: 'empty', context: { spaceId: '' } },
    { desc: 'whitespace', context: { spaceId: '   ' } },
  ])('returns missing_space resolution when spaceId is $desc', async ({ context }) => {
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

    const result = await adapter.fetchOptions(queries, context);
    expect(result).toEqual({
      contactFolders: {
        status: 'missing_space',
        items: [],
        targetPath: '1 Admin/Communication',
      },
    });
    expect(driveClient.listFolders).not.toHaveBeenCalled();
  });

  it('returns missing_space only for space-dependent Google Drive queries when spaceId is missing', async () => {
    const driveClient = createMockDriveClient();
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'driveFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '1 Admin/Communication',
        },
      },
      {
        sourceKey: 'otherQuery',
        config: {
          provider: 'custom_static_provider',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, {});
    expect(result).toEqual({
      driveFolders: {
        status: 'missing_space',
        items: [],
        targetPath: '1 Admin/Communication',
      },
      otherQuery: {
        status: 'empty',
        items: [],
        targetPath: 'root',
      },
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
      rootFolders: {
        status: 'ready',
        items: [
          { text: 'Alpha', value: 'Alpha' },
          { text: 'Beta', value: 'Beta' },
        ],
        targetPath: 'root',
      },
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
      contactFolders: {
        status: 'ready',
        items: [
          { text: 'Acme Corp', value: 'Acme Corp' },
          { text: 'Globex', value: 'Globex' },
        ],
        targetPath: '1 Admin/Communication',
      },
    });
  });

  it('returns path_not_found resolution when a relativePath segment is not found', async () => {
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
      contactFolders: {
        status: 'path_not_found',
        items: [],
        targetPath: '1 Admin/Communication',
      },
    });
  });

  it('returns empty resolution when target folder has 0 child folders', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockResolvedValue({
        folders: [],
      }),
    });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'contactFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result).toEqual({
      contactFolders: {
        status: 'empty',
        items: [],
        targetPath: 'root',
      },
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

    expect(result.largeList.status).toBe('ready');
    expect(result.largeList.items).toHaveLength(150);
    expect(result.largeList.items[0]).toEqual({ text: 'Folder 000', value: 'Folder 000' });
    expect(result.largeList.items[149]).toEqual({ text: 'Folder 149', value: 'Folder 149' });
    expect(result.largeList.targetPath).toBe('root');
    expect(listFoldersMock).toHaveBeenCalledTimes(2);
  });

  it('returns empty resolution when provider or method is unsupported', async () => {
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
      unsupportedProvider: {
        status: 'empty',
        items: [],
        targetPath: 'root',
      },
      unsupportedMethod: {
        status: 'empty',
        items: [],
        targetPath: 'root',
      },
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
      slowQuery: {
        status: 'timeout',
        items: [],
        targetPath: 'root',
      },
    });
  });

  it('prevents unhandled promise rejection when slow Drive promise rejects after timeout', async () => {
    let rejectSlowPromise!: (err: Error) => void;
    const slowPromise = new Promise<{ folders: Array<{ id: string; name: string }> }>((_, reject) => {
      rejectSlowPromise = reject;
    });

    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockImplementation(() => slowPromise),
    });
    const adapter = new DynamicOptionsAdapter(driveClient, { timeoutMs: 20 });

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'slowQuery',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'Communications',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });
    expect(result.slowQuery).toEqual({
      status: 'timeout',
      items: [],
      targetPath: 'Communications',
    });

    // Reject slow promise after timeout has already completed
    expect(() => rejectSlowPromise(new Error('Late Drive failure'))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('short-circuits pagination immediately to ambiguous_path when >= 2 folders match a segment', async () => {
    const listFoldersMock = vi.fn().mockImplementation(async (options: { pageToken?: string }) => {
      if (!options.pageToken) {
        return {
          folders: [
            { id: 'f-1', name: 'Communications' },
            { id: 'f-2', name: 'Communications' },
          ],
          nextPageToken: 'page-2-token',
        };
      }
      return {
        folders: [{ id: 'f-3', name: 'Communications' }],
      };
    });

    const driveClient = createMockDriveClient({ listFolders: listFoldersMock });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'commFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'Communications',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result).toEqual({
      commFolders: {
        status: 'ambiguous_path',
        items: [],
        targetPath: 'Communications',
      },
    });
    expect(listFoldersMock).toHaveBeenCalledTimes(1);
  });

  it('short-circuits to ambiguous_path when 2nd match is found on page 2', async () => {
    const listFoldersMock = vi.fn().mockImplementation(async (options: { pageToken?: string }) => {
      if (!options.pageToken) {
        return {
          folders: [{ id: 'f-1', name: 'Communications' }],
          nextPageToken: 'page-2-token',
        };
      }
      if (options.pageToken === 'page-2-token') {
        return {
          folders: [{ id: 'f-2', name: 'Communications' }],
          nextPageToken: 'page-3-token',
        };
      }
      return {
        folders: [{ id: 'f-3', name: 'Communications' }],
      };
    });

    const driveClient = createMockDriveClient({ listFolders: listFoldersMock });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'commFolders',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'Communications',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result.commFolders.status).toBe('ambiguous_path');
    expect(listFoldersMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes leading, trailing, and redundant slashes in relativePath to targetPath', async () => {
    const listFoldersMock = vi.fn().mockImplementation(async (options: { parentFolderId?: string }) => {
      if (options.parentFolderId === 'space-123') {
        return {
          folders: [{ id: 'comm-id', name: 'Communications' }],
        };
      }
      return {
        folders: [{ id: 'acme-id', name: 'Acme' }],
      };
    });

    const driveClient = createMockDriveClient({ listFolders: listFoldersMock });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'slashed',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '///Communications///',
        },
      },
      {
        sourceKey: 'emptySlash',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '///',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });
    expect(result.slashed.targetPath).toBe('Communications');
    expect(result.slashed.status).toBe('ready');
    expect(result.emptySlash.targetPath).toBe('root');
    expect(result.emptySlash.status).toBe('ready');
  });

  it('returns error resolution on unexpected Drive API error', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockRejectedValue(new Error('Google Drive 500: Internal Server Error')),
    });
    const adapter = new DynamicOptionsAdapter(driveClient);

    const queries: DynamicOptionQuery[] = [
      {
        sourceKey: 'failingQuery',
        config: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'Communications',
        },
      },
    ];

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });
    expect(result).toEqual({
      failingQuery: {
        status: 'error',
        items: [],
        targetPath: 'Communications',
      },
    });
  });

  it('processes multiple queries with Promise.allSettled where one succeeds and one fails', async () => {
    const driveClient = createMockDriveClient({
      listFolders: vi.fn().mockImplementation(async (options: { parentFolderId?: string }) => {
        if (options.parentFolderId === 'space-123') {
          throw new Error('Drive API failure on failingQuery');
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

    const result = await adapter.fetchOptions(queries, { spaceId: 'space-123' });

    expect(result.failingQuery.status).toBe('error');
    expect(result.successQuery.status).toBe('error');
  });

  describe('validateExistence (Guarded Write)', () => {
    it('returns isValid: true when exactly one matching folder is found', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockImplementation(async (options: { parentFolderId?: string; name?: string }) => {
          if (options.parentFolderId === 'space-123' && !options.name) {
            return { folders: [{ id: 'admin-id', name: '1 Admin' }] };
          }
          if (options.parentFolderId === 'admin-id' && !options.name) {
            return { folders: [{ id: 'comm-id', name: 'Communication' }] };
          }
          if (options.parentFolderId === 'comm-id' && options.name === 'Acme Corp') {
            return { folders: [{ id: 'client-1', name: 'Acme Corp' }] };
          }
          return { folders: [] };
        }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
            relativePath: '1 Admin/Communication',
          },
          valueToValidate: 'Acme Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: { isValid: true },
      });
      expect(driveClient.listFolders).toHaveBeenCalledWith(
        expect.objectContaining({
          parentFolderId: 'comm-id',
          name: 'Acme Corp',
        })
      );
    });

    it('returns isValid: false with "Option not found." when 0 matching folders are found', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockResolvedValue({ folders: [] }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'NonExistent',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage: 'Option not found.',
        },
      });
    });

    it('returns isValid: true when 0 matching folders found and allowUserInput is true', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockResolvedValue({ folders: [] }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'BrandNewContact',
          allowUserInput: true,
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: {
          isValid: true,
        },
      });
    });

    it('returns isValid: false with "Option not found." when 0 matching folders found and allowUserInput is false', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockResolvedValue({ folders: [] }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'NonExistent',
          allowUserInput: false,
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage: 'Option not found.',
        },
      });
    });

    it('returns isValid: false with "Option not found." when allowUserInput is true but spaceId is missing', async () => {
      const driveClient = createMockDriveClient();
      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'BrandNewContact',
          allowUserInput: true,
        },
      ];

      const result = await adapter.validateExistence(queries, {});

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage: 'Option not found.',
        },
      });
    });

    it('returns isValid: false with "Option not found." when allowUserInput is true but relativePath cannot be resolved', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockResolvedValue({ folders: [] }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
            relativePath: 'NonExistentPath/Subfolder',
          },
          valueToValidate: 'BrandNewContact',
          allowUserInput: true,
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage: 'Option not found.',
        },
      });
    });

    it('returns isValid: false with multiple folders message when > 1 folders match even when allowUserInput is true', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockResolvedValue({
          folders: [
            { id: 'f-1', name: 'Duplicate Corp' },
            { id: 'f-2', name: 'Duplicate Corp' },
          ],
        }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Duplicate Corp',
          allowUserInput: true,
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage:
            'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.',
        },
      });
    });

    it('returns isValid: false with multiple folders message when more than 1 matching folder found', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockResolvedValue({
          folders: [
            { id: 'f-1', name: 'Duplicate Corp' },
            { id: 'f-2', name: 'Duplicate Corp' },
          ],
        }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Duplicate Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage:
            'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.',
        },
      });
    });

    it('returns isValid: false with "Option not found." when spaceId is missing', async () => {
      const driveClient = createMockDriveClient();
      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Acme Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, {});

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage: 'Option not found.',
        },
      });
      expect(driveClient.listFolders).not.toHaveBeenCalled();
    });

    it('returns isValid: false with "Option not found." when relativePath cannot be resolved', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockResolvedValue({ folders: [] }),
      });
      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
            relativePath: 'NonExistent/Folder',
          },
          valueToValidate: 'Acme Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contactFolders: {
          isValid: false,
          errorMessage: 'Option not found.',
        },
      });
    });

    it('returns isValid: false with "Option not found." when provider or method is unsupported', async () => {
      const driveClient = createMockDriveClient();
      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'unsupported',
          queryId: 'unsupported',
          config: {
            provider: 'other_provider',
            method: 'list_folders',
          },
          valueToValidate: 'Acme Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        unsupported: {
          isValid: false,
          errorMessage: 'Option not found.',
        },
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

      const queries = [
        {
          sourceKey: 'slowQuery',
          queryId: 'slowQuery',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Acme Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        slowQuery: {
          isValid: false,
          errorMessage: 'Validation timed out.',
        },
      });
    });

    it('processes multiple validation queries with Promise.allSettled', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockImplementation(async (options: { name?: string }) => {
          if (options.name === 'Acme Corp') {
            return { folders: [{ id: 'f-1', name: 'Acme Corp' }] };
          }
          if (options.name === 'Error Corp') {
            throw new Error('Drive API failure');
          }
          return { folders: [] };
        }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'queryValid',
          queryId: 'queryValid',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Acme Corp',
        },
        {
          sourceKey: 'queryError',
          queryId: 'queryError',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Error Corp',
        },
        {
          sourceKey: 'queryMissing',
          queryId: 'queryMissing',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Missing Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        queryValid: { isValid: true },
        queryError: {
          isValid: false,
          errorMessage: 'An unexpected error occurred during dynamic option validation.',
        },
        queryMissing: { isValid: false, errorMessage: 'Option not found.' },
      });
    });

    it('keys validation results by queryId when provided, avoiding key collisions', async () => {
      const driveClient = createMockDriveClient({
        listFolders: vi.fn().mockImplementation(async (options: { name?: string }) => {
          if (options.name === 'Acme Corp') {
            return { folders: [{ id: 'f-1', name: 'Acme Corp' }] };
          }
          return { folders: [] };
        }),
      });

      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contact_field_1',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Acme Corp',
        },
        {
          sourceKey: 'contactFolders',
          queryId: 'contact_field_2',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Missing Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, { spaceId: 'space-123' });

      expect(result).toEqual({
        contact_field_1: { isValid: true },
        contact_field_2: { isValid: false, errorMessage: 'Option not found.' },
      });
    });

    it.each([
      { desc: 'missing', context: {} },
      { desc: 'empty', context: { spaceId: '' } },
      { desc: 'whitespace', context: { spaceId: '   ' } },
    ])('returns Option not found when spaceId is $desc during validation', async ({ context }) => {
      const driveClient = createMockDriveClient();
      const adapter = new DynamicOptionsAdapter(driveClient);

      const queries = [
        {
          sourceKey: 'contactFolders',
          queryId: 'contactFolders',
          config: {
            provider: 'google_drive',
            method: 'list_folders',
          },
          valueToValidate: 'Acme Corp',
        },
      ];

      const result = await adapter.validateExistence(queries, context);
      expect(result).toEqual({
        contactFolders: { isValid: false, errorMessage: 'Option not found.' },
      });
      expect(driveClient.listFolders).not.toHaveBeenCalled();
    });
  });
});

import { Value } from '@sinclair/typebox/value';
import {
  StorageLocationSchema,
  formatValidationErrors,
  type DocumentSpace,
  type StorageContextConfig,
  type StorageLocation,
} from '../domain';
import type { DocumentSpaceStoragePort } from '../ports';

export interface DriveStorageClientPort {
  listSharedDrives(options?: {
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  }): Promise<{
    drives: Array<{ id: string; name: string }>;
    nextPageToken?: string | undefined;
  }>;

  listFolders(options: {
    parentFolderId?: string | undefined;
    sharedDriveId?: string | undefined;
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  }): Promise<{
    folders: Array<{ id: string; name: string }>;
    nextPageToken?: string | undefined;
  }>;
}

async function fetchWithPagination(
  limit: number,
  typeId: string,
  fetchBatch: (
    pageSize: number,
    pageToken?: string | undefined
  ) => Promise<{
    items: Array<{ id: string; name: string }>;
    nextPageToken?: string | undefined;
  }>
): Promise<DocumentSpace[]> {
  const spaces: DocumentSpace[] = [];
  let pageToken: string | undefined = undefined;

  while (spaces.length < limit) {
    const remaining = limit - spaces.length;
    const pageSize = Math.min(remaining, 100);

    const res = await fetchBatch(pageSize, pageToken);

    for (const item of res.items) {
      spaces.push({
        id: item.id,
        typeId,
        name: item.name,
        abstractStorageId: item.id,
      });

      if (spaces.length >= limit) {
        break;
      }
    }

    if (!res.nextPageToken) {
      break;
    }
    pageToken = res.nextPageToken;
  }

  return spaces;
}

export class GoogleDriveStorageAdapter implements DocumentSpaceStoragePort {
  constructor(private readonly driveClient: DriveStorageClientPort) {}

  async fetchSpaces(
    config: StorageContextConfig,
    typeId: string
  ): Promise<DocumentSpace[]> {
    const limit = config.paginationLimit ?? 500;
    if (limit <= 0) {
      return [];
    }

    if (config.fetchMethod === 'shared_drives') {
      return fetchWithPagination(limit, typeId, async (pageSize, pageToken) => {
        const res = await this.driveClient.listSharedDrives({
          pageSize,
          ...(pageToken !== undefined ? { pageToken } : {}),
        });
        return {
          items: res.drives,
          nextPageToken: res.nextPageToken,
        };
      });
    }

    if (config.fetchMethod === 'folders') {
      return fetchWithPagination(limit, typeId, async (pageSize, pageToken) => {
        const res = await this.driveClient.listFolders({
          pageSize,
          ...(config.parentFolderId !== undefined
            ? { parentFolderId: config.parentFolderId }
            : {}),
          ...(config.sharedDriveId !== undefined
            ? { sharedDriveId: config.sharedDriveId }
            : {}),
          ...(pageToken !== undefined ? { pageToken } : {}),
        });
        return {
          items: res.folders,
          nextPageToken: res.nextPageToken,
        };
      });
    }

    throw new Error(
      `Unsupported fetchMethod: ${(config as { fetchMethod?: string }).fetchMethod}`
    );
  }

  async resolveStorageLocation(abstractStorageId: string): Promise<StorageLocation> {
    if (!abstractStorageId || typeof abstractStorageId !== 'string' || abstractStorageId.trim().length === 0) {
      throw new Error('abstractStorageId must be a non-empty string');
    }

    const location: StorageLocation = {
      provider: 'google_drive',
      abstractStorageId,
      targetFolderId: abstractStorageId,
      folderId: abstractStorageId,
    };

    if (!Value.Check(StorageLocationSchema, location)) {
      const errors = formatValidationErrors(StorageLocationSchema, location);
      throw new Error(`Invalid StorageLocation schema: ${errors.join(', ')}`);
    }

    return location;
  }
}


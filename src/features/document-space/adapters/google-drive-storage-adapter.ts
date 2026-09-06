import type {
  DocumentSpace,
  StorageContextConfig,
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

export class GoogleDriveStorageAdapter implements DocumentSpaceStoragePort {
  constructor(private readonly driveClient: DriveStorageClientPort) {}

  async fetchSpaces(
    config: StorageContextConfig,
    typeId?: string
  ): Promise<DocumentSpace[]> {
    const limit = config.paginationLimit ?? 500;
    if (limit <= 0) {
      return [];
    }

    const assignedTypeId = typeId ?? 'default';
    const spaces: DocumentSpace[] = [];
    let pageToken: string | undefined = undefined;

    if (config.fetchMethod === 'shared_drives') {
      while (spaces.length < limit) {
        const remaining = limit - spaces.length;
        const pageSize = Math.min(remaining, 100);

        const res = await this.driveClient.listSharedDrives({
          pageSize,
          ...(pageToken !== undefined ? { pageToken } : {}),
        });

        for (const drive of res.drives) {
          spaces.push({
            id: drive.id,
            typeId: assignedTypeId,
            name: drive.name,
            abstractStorageId: drive.id,
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

    if (config.fetchMethod === 'folders') {
      while (spaces.length < limit) {
        const remaining = limit - spaces.length;
        const pageSize = Math.min(remaining, 100);

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

        for (const folder of res.folders) {
          spaces.push({
            id: folder.id,
            typeId: assignedTypeId,
            name: folder.name,
            abstractStorageId: folder.id,
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

    throw new Error(
      `Unsupported fetchMethod: ${(config as { fetchMethod?: string }).fetchMethod}`
    );
  }
}

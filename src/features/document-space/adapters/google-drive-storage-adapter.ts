import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  StorageLocationSchema,
  formatValidationErrors,
  type DocumentSpace,
  type StorageContextConfig,
  type StorageLocation,
} from '../domain';
import type { DocumentSpaceStoragePort } from '../ports';
import { DriveNameResolver } from './drive-name-resolver';

export { DriveNameResolver };

export const SharedDrivesStorageConfigSchema = Type.Object({
  provider: Type.Literal('google_drive'),
  fetchMethod: Type.Literal('shared_drives'),
  paginationLimit: Type.Optional(Type.Number({ default: 500 })),
});

export type SharedDrivesStorageConfig = Static<typeof SharedDrivesStorageConfigSchema>;

export const FoldersStorageConfigSchema = Type.Object({
  provider: Type.Literal('google_drive'),
  fetchMethod: Type.Literal('folders'),
  parentFolderId: Type.Optional(Type.String()),
  sharedDriveId: Type.Optional(Type.String()),
  parentFolderName: Type.Optional(Type.String()),
  sharedDriveName: Type.Optional(Type.String()),
  paginationLimit: Type.Optional(Type.Number({ default: 500 })),
});

export type FoldersStorageConfig = Static<typeof FoldersStorageConfigSchema>;

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

  searchFiles?(
    query: {
      targetName: string;
      exactMatch?: boolean | undefined;
      sharedDriveId?: string | undefined;
      mimeTypes?: string[] | undefined;
      expectedParentPathNames?: string[] | undefined;
    },
    options?: { auth?: string | undefined }
  ): Promise<Array<{ id: string; name: string; mimeType?: string | undefined }>>;
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
  private readonly nameResolver: DriveNameResolver;

  constructor(
    private readonly driveClient: DriveStorageClientPort,
    nameResolver?: DriveNameResolver
  ) {
    this.nameResolver = nameResolver ?? new DriveNameResolver(driveClient);
  }

  async fetchSpaces(
    config: StorageContextConfig,
    typeId: string
  ): Promise<DocumentSpace[]> {
    if (config['fetchMethod'] === 'shared_drives') {
      if (!Value.Check(SharedDrivesStorageConfigSchema, config)) {
        const errors = formatValidationErrors(SharedDrivesStorageConfigSchema, config);
        throw new Error(`Invalid Google Drive storage configuration: ${errors.join(', ')}`);
      }
      const typedConfig = config as SharedDrivesStorageConfig;
      const limit = typedConfig.paginationLimit ?? 500;
      if (limit <= 0) {
        return [];
      }

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

    if (config['fetchMethod'] === 'folders') {
      if (!Value.Check(FoldersStorageConfigSchema, config)) {
        const errors = formatValidationErrors(FoldersStorageConfigSchema, config);
        throw new Error(`Invalid Google Drive storage configuration: ${errors.join(', ')}`);
      }
      const typedConfig = config as FoldersStorageConfig;
      const limit = typedConfig.paginationLimit ?? 500;
      if (limit <= 0) {
        return [];
      }

      let resolvedSharedDriveId = typedConfig.sharedDriveId;
      if (!resolvedSharedDriveId && typedConfig.sharedDriveName) {
        resolvedSharedDriveId = await this.nameResolver.resolveSharedDriveId(
          typedConfig.sharedDriveName
        );
      }

      let resolvedParentFolderId = typedConfig.parentFolderId;
      if (!resolvedParentFolderId && typedConfig.parentFolderName) {
        resolvedParentFolderId = await this.nameResolver.resolveParentFolderId(
          typedConfig.parentFolderName,
          resolvedSharedDriveId
        );
      }

      return fetchWithPagination(limit, typeId, async (pageSize, pageToken) => {
        const res = await this.driveClient.listFolders({
          pageSize,
          ...(resolvedParentFolderId !== undefined
            ? { parentFolderId: resolvedParentFolderId }
            : {}),
          ...(resolvedSharedDriveId !== undefined
            ? { sharedDriveId: resolvedSharedDriveId }
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
      `Unsupported fetchMethod: ${String(config['fetchMethod'])}`
    );
  }

  async resolveStorageLocation(abstractStorageId: string): Promise<StorageLocation> {
    if (!abstractStorageId || typeof abstractStorageId !== 'string' || abstractStorageId.trim().length === 0) {
      throw new Error('abstractStorageId must be a non-empty string');
    }

    const location: StorageLocation = {
      provider: 'google_drive',
      abstractStorageId,
    };

    if (!Value.Check(StorageLocationSchema, location)) {
      const errors = formatValidationErrors(StorageLocationSchema, location);
      throw new Error(`Invalid StorageLocation schema: ${errors.join(', ')}`);
    }

    return location;
  }
}


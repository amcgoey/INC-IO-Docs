import { google, type drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Type } from '@sinclair/typebox';

export interface DriveFileMetadata {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
  webViewLink?: string | undefined;
}

export const DriveFileMetadataSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  parents: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  webViewLink: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export interface DriveSearchParams {
  targetName: string;
  exactMatch?: boolean | undefined;
  sharedDriveId?: string | undefined;
  mimeTypes?: string[] | undefined;
  expectedParentPathNames?: string[] | undefined;
}

export class GoogleDriveApiError extends Error {
  readonly statusCode?: number | undefined;

  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GoogleDriveApiError';
    this.statusCode = options?.statusCode;
  }
}

export class GoogleDriveAmbiguousPathError extends GoogleDriveApiError {
  constructor(
    message: string,
    options?: { cause?: unknown; statusCode?: number | undefined }
  ) {
    super(message, options);
    this.name = 'GoogleDriveAmbiguousPathError';
  }
}

export interface DriveRetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DriveConfigProvider {
  getDriveConfig(): Promise<{
    maxRetries?: number | undefined;
    initialDelayMs?: number | undefined;
    backoffFactor?: number | undefined;
  } | undefined>;
}

export interface DriveOperationOptions {
  auth?: string | undefined;
}

export interface GoogleDriveClientOptions {
  auth?: OAuth2Client | string | undefined;
  drive?: drive_v3.Drive | undefined;
  retryOptions?: DriveRetryOptions | undefined;
  configProvider?: DriveConfigProvider | undefined;
}

function extractHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as { statusCode?: unknown; status?: unknown; code?: unknown; response?: { status?: unknown } };
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  if (typeof err.code === 'number') return err.code;
  return undefined;
}

function escapeDriveQuery(str: string): string {
  return str.replace(/'/g, "\\'");
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = extractHttpStatusCode(error);
  if (status === 429) return true;
  const err = error as Record<string, unknown>;
  return err.code === '429';
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export class GoogleDriveClient {
  private readonly defaultDrive: drive_v3.Drive;
  private readonly retryOptions: DriveRetryOptions;
  private readonly configProvider?: DriveConfigProvider | undefined;

  constructor(options: GoogleDriveClientOptions = {}) {
    this.retryOptions = options.retryOptions ?? {};
    this.configProvider = options.configProvider;

    if (options.drive) {
      this.defaultDrive = options.drive;
    } else if (typeof options.auth === 'string') {
      this.defaultDrive = this.createDriveClientFromToken(options.auth);
    } else if (options.auth) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.defaultDrive = google.drive({ version: 'v3', auth: options.auth as any });
    } else {
      this.defaultDrive = google.drive({ version: 'v3' });
    }
  }

  private createDriveClientFromToken(token: string): drive_v3.Drive {
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: token });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return google.drive({ version: 'v3', auth: oauth2Client as any });
  }

  private getDrive(auth?: string): drive_v3.Drive {
    if (!auth) return this.defaultDrive;
    return this.createDriveClientFromToken(auth);
  }

  private wrapApiError(methodName: string, error: unknown): never {
    if (error instanceof GoogleDriveApiError) {
      throw error;
    }
    if (
      error instanceof Error &&
      error.message.startsWith('Failed to ')
    ) {
      throw error;
    }
    const statusCode = extractHttpStatusCode(error);

    throw new GoogleDriveApiError(
      `Google Drive API error in ${methodName}: ${formatErrorMessage(error)}`,
      { cause: error, statusCode }
    );
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let dynamicConfig;
    if (this.configProvider) {
      try {
        dynamicConfig = await this.configProvider.getDriveConfig();
      } catch {
        dynamicConfig = undefined;
      }
    }
    const maxRetries = dynamicConfig?.maxRetries ?? this.retryOptions.maxRetries ?? 3;
    const initialDelayMs = dynamicConfig?.initialDelayMs ?? this.retryOptions.initialDelayMs ?? 1000;
    const backoffFactor = dynamicConfig?.backoffFactor ?? this.retryOptions.backoffFactor ?? 2;
    const sleep =
      this.retryOptions.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

    let attempt = 0;
    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (isRateLimitError(error) && attempt < maxRetries) {
          const delay = initialDelayMs * Math.pow(backoffFactor, attempt);
          attempt++;
          await sleep(delay);
          continue;
        }
        throw error;
      }
    }
  }

  private requireFileMetadata(
    file: { id?: string | null; name?: string | null } | undefined,
    errorMessage: string
  ): { id: string; name: string } {
    if (!file?.id || !file?.name) {
      throw new Error(errorMessage);
    }
    return { id: file.id, name: file.name };
  }

  async getFile(fileId: string, options?: DriveOperationOptions): Promise<DriveFileMetadata> {
    const drive = this.getDrive(options?.auth);
    try {
      const res = await this.executeWithRetry(() =>
        drive.files.get({
          fileId,
          fields: 'id, name, parents, mimeType, webViewLink',
          supportsAllDrives: true,
        })
      );

      const { id, name } = this.requireFileMetadata(
        res.data,
        `Failed to retrieve file metadata for fileId '${fileId}'`
      );

      return {
        id,
        name,
        parents: res.data.parents ?? [],
        mimeType: res.data.mimeType ?? undefined,
        webViewLink: res.data.webViewLink ?? undefined,
      };
    } catch (error) {
      this.wrapApiError('getFile', error);
    }
  }

  async findOrCreateFolder(
    parentId: string,
    folderName: string,
    options?: DriveOperationOptions
  ): Promise<DriveFileMetadata> {
    const drive = this.getDrive(options?.auth);
    try {
      const escapedName = escapeDriveQuery(folderName);
      const q = `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

      const res = await this.executeWithRetry(() =>
        drive.files.list({
          q,
          fields: 'files(id, name, parents, mimeType, webViewLink)',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        })
      );

      const existingFolder = res.data.files?.[0];
      if (existingFolder?.id && existingFolder?.name) {
        return {
          id: existingFolder.id,
          name: existingFolder.name,
          parents: existingFolder.parents ?? [parentId],
          mimeType: existingFolder.mimeType ?? 'application/vnd.google-apps.folder',
          webViewLink: existingFolder.webViewLink ?? undefined,
        };
      }

      const createRes = await this.executeWithRetry(() =>
        drive.files.create({
          requestBody: {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          },
          fields: 'id, name, parents, mimeType, webViewLink',
          supportsAllDrives: true,
        })
      );

      const { id, name } = this.requireFileMetadata(
        createRes.data,
        `Failed to create folder '${folderName}' in parent '${parentId}'`
      );

      return {
        id,
        name,
        parents: createRes.data.parents ?? [parentId],
        mimeType: createRes.data.mimeType ?? 'application/vnd.google-apps.folder',
        webViewLink: createRes.data.webViewLink ?? undefined,
      };
    } catch (error) {
      this.wrapApiError('findOrCreateFolder', error);
    }
  }

  async move(
    fileId: string,
    targetFolderId: string,
    options?: DriveOperationOptions
  ): Promise<DriveFileMetadata> {
    const drive = this.getDrive(options?.auth);
    try {
      const file = await this.getFile(fileId, options);
      const currentParents = file.parents ?? [];
      const removeParentsList = currentParents.filter(
        (parentId) => parentId !== targetFolderId
      );
      const removeParents =
        removeParentsList.length > 0 ? removeParentsList.join(',') : undefined;

      const res = await this.executeWithRetry(() =>
        drive.files.update({
          fileId,
          addParents: targetFolderId,
          ...(removeParents ? { removeParents } : {}),
          fields: 'id, name, parents, mimeType, webViewLink',
          supportsAllDrives: true,
        })
      );

      const { id, name } = this.requireFileMetadata(
        res.data,
        `Failed to move file '${fileId}' to folder '${targetFolderId}'`
      );

      return {
        id,
        name,
        parents: res.data.parents ?? [targetFolderId],
        mimeType: res.data.mimeType ?? undefined,
        webViewLink: res.data.webViewLink ?? undefined,
      };
    } catch (error) {
      this.wrapApiError('move', error);
    }
  }

  async rename(
    fileId: string,
    newName: string,
    options?: DriveOperationOptions
  ): Promise<DriveFileMetadata> {
    const drive = this.getDrive(options?.auth);
    try {
      const res = await this.executeWithRetry(() =>
        drive.files.update({
          fileId,
          requestBody: {
            name: newName,
          },
          fields: 'id, name, parents, mimeType, webViewLink',
          supportsAllDrives: true,
        })
      );

      const { id, name } = this.requireFileMetadata(
        res.data,
        `Failed to rename file '${fileId}' to '${newName}'`
      );

      return {
        id,
        name,
        parents: res.data.parents ?? undefined,
        mimeType: res.data.mimeType ?? undefined,
        webViewLink: res.data.webViewLink ?? undefined,
      };
    } catch (error) {
      this.wrapApiError('rename', error);
    }
  }

  async searchFiles(
    query: DriveSearchParams,
    options?: DriveOperationOptions
  ): Promise<DriveFileMetadata[]> {
    const drive = this.getDrive(options?.auth);
    try {
      let parentIds: string[] | undefined = undefined;

      if (query.expectedParentPathNames && query.expectedParentPathNames.length > 0) {
        let currentParentIds: string[] | undefined = undefined;

        const baseParentListParams: drive_v3.Params$Resource$Files$List = {
          pageSize: 21,
          fields: 'files(id, name)',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
          ...(query.sharedDriveId
            ? { corpora: 'drive', driveId: query.sharedDriveId }
            : { corpora: 'user', spaces: 'drive' }),
        };

        for (const parentFolderName of query.expectedParentPathNames) {
          const escapedParent = escapeDriveQuery(parentFolderName);
          const queryClauses = [`name = '${escapedParent}'`];

          if (currentParentIds !== undefined && currentParentIds.length > 0) {
            const parentsClause =
              currentParentIds.length === 1
                ? `'${currentParentIds[0]}' in parents`
                : `(${currentParentIds.map((id) => `'${id}' in parents`).join(' or ')})`;
            queryClauses.push(parentsClause);
          }

          queryClauses.push("mimeType = 'application/vnd.google-apps.folder'");
          queryClauses.push('trashed = false');

          const parentQuery = queryClauses.join(' and ');

          const parentListParams: drive_v3.Params$Resource$Files$List = {
            ...baseParentListParams,
            q: parentQuery,
          };

          const parentRes = await this.executeWithRetry(() => drive.files.list(parentListParams));
          const parentFiles = parentRes.data.files ?? [];

          if (parentFiles.length > 20) {
            throw new GoogleDriveAmbiguousPathError(
              `AmbiguousPathSpecError: Query for parent folder '${parentFolderName}' returned ${parentFiles.length} results, exceeding the threshold cap of 20 matches.`
            );
          }

          currentParentIds = parentFiles
            .map((f) => f.id)
            .filter((id): id is string => Boolean(id));

          if (currentParentIds.length === 0) {
            return [];
          }
        }

        parentIds = currentParentIds;
      }

      const escapedTarget = escapeDriveQuery(query.targetName);
      const targetMatchClause = query.exactMatch
        ? `name = '${escapedTarget}'`
        : `name contains '${escapedTarget}'`;

      const queryClauses = [targetMatchClause];

      if (parentIds !== undefined && parentIds.length > 0) {
        const parentsClause =
          parentIds.length === 1
            ? `'${parentIds[0]}' in parents`
            : `(${parentIds.map((id) => `'${id}' in parents`).join(' or ')})`;
        queryClauses.push(parentsClause);
      }

      queryClauses.push('trashed = false');

      if (query.mimeTypes && query.mimeTypes.length > 0) {
        const mimeClause =
          query.mimeTypes.length === 1
            ? `mimeType = '${query.mimeTypes[0]}'`
            : `(${query.mimeTypes.map((m) => `mimeType = '${m}'`).join(' or ')})`;
        queryClauses.push(mimeClause);
      }

      const q = queryClauses.join(' and ');

      const listParams: drive_v3.Params$Resource$Files$List = {
        q,
        fields: 'files(id, name, parents, mimeType, webViewLink)',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      };

      if (query.sharedDriveId) {
        listParams.corpora = 'drive';
        listParams.driveId = query.sharedDriveId;
      } else {
        listParams.corpora = 'user';
        listParams.spaces = 'drive';
      }

      const res = await this.executeWithRetry(() => drive.files.list(listParams));

      const files = res.data.files ?? [];
      return files
        .filter((file): file is typeof file & { id: string; name: string } =>
          Boolean(file.id && file.name)
        )
        .map((file) => ({
          id: file.id,
          name: file.name,
          parents: file.parents ?? undefined,
          mimeType: file.mimeType ?? undefined,
          webViewLink: file.webViewLink ?? undefined,
        }));
    } catch (error) {
      this.wrapApiError('searchFiles', error);
    }
  }
}



import { google, type drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface DriveFileMetadata {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
  webViewLink?: string | undefined;
}

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

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, unknown>;
  if (err.status === 429 || err.code === 429 || err.code === '429') return true;
  if (err.response && typeof err.response === 'object') {
    const res = err.response as Record<string, unknown>;
    if (res.status === 429) return true;
  }
  return false;
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
      (error.message.startsWith('Failed to ') ||
        error.message.startsWith('Parent path traversal is not yet implemented'))
    ) {
      throw error;
    }
    const statusCode =
      typeof error === 'object' && error !== null
        ? ((error as { status?: number; code?: number; response?: { status?: number } }).status ??
          (error as { status?: number; code?: number; response?: { status?: number } }).response
            ?.status ??
          (typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code?: number }).code
            : undefined))
        : undefined;

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
          fields: 'id, name, parents, mimeType',
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
      const escapedName = folderName.replace(/'/g, "\\'");
      const q = `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

      const res = await this.executeWithRetry(() =>
        drive.files.list({
          q,
          fields: 'files(id, name, parents, mimeType)',
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
        };
      }

      const createRes = await this.executeWithRetry(() =>
        drive.files.create({
          requestBody: {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
          },
          fields: 'id, name, parents, mimeType',
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
      };
    } catch (error) {
      this.wrapApiError('findOrCreateFolder', error);
    }
  }

  async moveFile(
    fileId: string,
    currentParentId: string,
    targetFolderId: string,
    options?: DriveOperationOptions
  ): Promise<DriveFileMetadata> {
    const drive = this.getDrive(options?.auth);
    try {
      const res = await this.executeWithRetry(() =>
        drive.files.update({
          fileId,
          addParents: targetFolderId,
          removeParents: currentParentId,
          fields: 'id, name, parents, mimeType',
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
      };
    } catch (error) {
      this.wrapApiError('moveFile', error);
    }
  }

  async searchFiles(
    query: DriveSearchParams,
    options?: DriveOperationOptions
  ): Promise<DriveFileMetadata[]> {
    if (query.expectedParentPathNames && query.expectedParentPathNames.length > 0) {
      throw new Error(
        'Parent path traversal is not yet implemented for searchFiles. Only unanchored searches (empty expectedParentPathNames) are currently supported.'
      );
    }

    const drive = this.getDrive(options?.auth);
    try {
      const escapedTarget = query.targetName.replace(/'/g, "\\'");
      const targetMatchClause = query.exactMatch
        ? `name = '${escapedTarget}'`
        : `name contains '${escapedTarget}'`;

      const queryClauses = [targetMatchClause, 'trashed = false'];

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



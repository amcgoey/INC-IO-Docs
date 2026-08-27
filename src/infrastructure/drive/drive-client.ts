import { google, type drive_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

export interface DriveFileMetadata {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
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
      const oauth2Client = new OAuth2Client();
      oauth2Client.setCredentials({ access_token: options.auth });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.defaultDrive = google.drive({ version: 'v3', auth: oauth2Client as any });
    } else if (options.auth) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.defaultDrive = google.drive({ version: 'v3', auth: options.auth as any });
    } else {
      this.defaultDrive = google.drive({ version: 'v3' });
    }
  }

  private getDrive(auth?: string): drive_v3.Drive {
    if (!auth) return this.defaultDrive;
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: auth });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return google.drive({ version: 'v3', auth: oauth2Client as any });
  }

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    const dynamicConfig = this.configProvider ? await this.configProvider.getDriveConfig() : undefined;
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

  async getFile(fileId: string, auth?: string): Promise<DriveFileMetadata> {
    const drive = this.getDrive(auth);
    try {
      const res = await this.executeWithRetry(() =>
        drive.files.get({
          fileId,
          fields: 'id, name, parents, mimeType',
          supportsAllDrives: true,
        })
      );

      if (!res.data.id || !res.data.name) {
        throw new Error(`Failed to retrieve file metadata for fileId '${fileId}'`);
      }

      return {
        id: res.data.id,
        name: res.data.name,
        parents: res.data.parents ?? [],
        mimeType: res.data.mimeType ?? undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to retrieve')) {
        throw error;
      }
      throw new Error(
        `Google Drive API error in getFile: ${formatErrorMessage(error)}`,
        { cause: error }
      );
    }
  }

  async findOrCreateFolder(
    parentId: string,
    folderName: string,
    auth?: string
  ): Promise<DriveFileMetadata> {
    const drive = this.getDrive(auth);
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

      if (!createRes.data.id || !createRes.data.name) {
        throw new Error(`Failed to create folder '${folderName}' in parent '${parentId}'`);
      }

      return {
        id: createRes.data.id,
        name: createRes.data.name,
        parents: createRes.data.parents ?? [parentId],
        mimeType: createRes.data.mimeType ?? 'application/vnd.google-apps.folder',
      };
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('Failed to create') ||
          error.message.includes('Google Drive API'))
      ) {
        throw error;
      }
      throw new Error(
        `Google Drive API error in findOrCreateFolder: ${formatErrorMessage(error)}`,
        { cause: error }
      );
    }
  }

  async moveFile(
    fileId: string,
    currentParentId: string,
    targetFolderId: string,
    auth?: string
  ): Promise<DriveFileMetadata> {
    const drive = this.getDrive(auth);
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

      if (!res.data.id || !res.data.name) {
        throw new Error(`Failed to move file '${fileId}' to folder '${targetFolderId}'`);
      }

      return {
        id: res.data.id,
        name: res.data.name,
        parents: res.data.parents ?? [targetFolderId],
        mimeType: res.data.mimeType ?? undefined,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Failed to move')) {
        throw error;
      }
      throw new Error(
        `Google Drive API error in moveFile: ${formatErrorMessage(error)}`,
        { cause: error }
      );
    }
  }
}


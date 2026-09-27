import {
  DriveServiceError,
  AmbiguousPathSpecError,
  type DriveContentSaveOptions,
  type DriveDuplicateOptions,
  type DriveFileResult,
  type DriveSearchQuery,
  type DriveServicePort,
} from '../ports';

export interface DriveClientFileMetadata {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
  webViewLink?: string | undefined;
}

export interface DriveClientSearchParams {
  targetName: string;
  exactMatch?: boolean | undefined;
  sharedDriveId?: string | undefined;
  mimeTypes?: string[] | undefined;
  expectedParentPathNames?: string[] | undefined;
}

export interface DriveClientDuplicateOptions {
  newName?: string | undefined;
  targetFolderId?: string | undefined;
}

export interface DriveClientCreateOptions {
  action: 'create';
  targetFolderId: string;
  name: string;
  mimeType?: string | undefined;
}

export interface DriveClientUpdateOptions {
  action: 'update';
  fileId: string;
  mimeType?: string | undefined;
}

export type DriveClientSaveOptions = DriveClientCreateOptions | DriveClientUpdateOptions;

export interface DriveClientPort {
  getFile(fileId: string): Promise<DriveClientFileMetadata>;
  findOrCreateFolder(
    parentId: string,
    folderName: string
  ): Promise<DriveClientFileMetadata>;
  move(
    fileId: string,
    targetFolderId: string
  ): Promise<DriveClientFileMetadata>;
  rename(
    fileId: string,
    newName: string
  ): Promise<DriveClientFileMetadata>;
  duplicate(
    fileId: string,
    duplicateOptions?: DriveClientDuplicateOptions
  ): Promise<DriveClientFileMetadata>;
  searchFiles(params: DriveClientSearchParams): Promise<DriveClientFileMetadata[]>;
  downloadAsBuffer(fileId: string): Promise<Uint8Array>;
  saveBuffer(
    content: Uint8Array,
    saveOptions: DriveClientSaveOptions
  ): Promise<DriveClientFileMetadata>;
  uploadStream(
    stream: ReadableStream<Uint8Array>,
    saveOptions: DriveClientSaveOptions
  ): Promise<DriveClientFileMetadata>;
}

function mapMetadataToResult(metadata: DriveClientFileMetadata): DriveFileResult {
  return {
    id: metadata.id,
    name: metadata.name,
    parents: metadata.parents,
    mimeType: metadata.mimeType,
    webViewLink: metadata.webViewLink,
  };
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

function extractErrorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name;
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name: unknown }).name === 'string'
  ) {
    return (error as { name: string }).name;
  }
  return undefined;
}

export class DriveServiceAdapter implements DriveServicePort {
  constructor(private readonly driveClient: DriveClientPort) {}

  private translateError(operation: string, error: unknown): never {
    if (error instanceof DriveServiceError) {
      throw error;
    }

    const errorName = extractErrorName(error);
    if (
      errorName === 'GoogleDriveAmbiguousPathError' ||
      errorName === 'AmbiguousPathSpecError'
    ) {
      const baseMessage =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: unknown }).message)
            : String(error);
      throw new AmbiguousPathSpecError(baseMessage, { cause: error });
    }

    const statusCode = extractHttpStatusCode(error);

    const baseMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error);

    const formattedMessage = statusCode
      ? `Drive service error (${statusCode}) in ${operation}: ${baseMessage}`
      : `Drive service error in ${operation}: ${baseMessage}`;

    throw new DriveServiceError(formattedMessage, {
      cause: error,
    });
  }

  async getFile(fileId: string): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.getFile(fileId);
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('getFile', error);
    }
  }

  async findOrCreateFolder(
    parentId: string,
    folderName: string
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.findOrCreateFolder(
        parentId,
        folderName
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('findOrCreateFolder', error);
    }
  }

  async move(
    fileId: string,
    targetFolderId: string
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.move(
        fileId,
        targetFolderId
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('move', error);
    }
  }

  async rename(
    fileId: string,
    newName: string
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.rename(
        fileId,
        newName
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('rename', error);
    }
  }

  async duplicate(
    fileId: string,
    duplicateOptions?: DriveDuplicateOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.duplicate(
        fileId,
        duplicateOptions
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('duplicate', error);
    }
  }

  async searchFiles(query: DriveSearchQuery): Promise<DriveFileResult[]> {
    try {
      const results = await this.driveClient.searchFiles(query);
      return results.map(mapMetadataToResult);
    } catch (error) {
      this.translateError('searchFiles', error);
    }
  }

  async downloadAsBuffer(fileId: string): Promise<Uint8Array> {
    try {
      return await this.driveClient.downloadAsBuffer(fileId);
    } catch (error) {
      this.translateError('downloadAsBuffer', error);
    }
  }

  async saveBuffer(
    content: Uint8Array,
    saveOptions: DriveContentSaveOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.saveBuffer(
        content,
        saveOptions
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('saveBuffer', error);
    }
  }

  async uploadStream(
    stream: ReadableStream<Uint8Array>,
    saveOptions: DriveContentSaveOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.uploadStream(
        stream,
        saveOptions
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('uploadStream', error);
    }
  }
}

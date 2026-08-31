import {
  DriveServiceError,
  AmbiguousPathSpecError,
  type DriveDuplicateOptions,
  type DriveFileResult,
  type DriveSearchQuery,
  type DriveServiceOptions,
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

export interface DriveClientOperationOptions {
  auth?: string | undefined;
}

export interface DriveClientPort {
  getFile(
    fileId: string,
    options?: DriveClientOperationOptions
  ): Promise<DriveClientFileMetadata>;
  findOrCreateFolder(
    parentId: string,
    folderName: string,
    options?: DriveClientOperationOptions
  ): Promise<DriveClientFileMetadata>;
  move(
    fileId: string,
    targetFolderId: string,
    options?: DriveClientOperationOptions
  ): Promise<DriveClientFileMetadata>;
  rename(
    fileId: string,
    newName: string,
    options?: DriveClientOperationOptions
  ): Promise<DriveClientFileMetadata>;
  duplicate(
    fileId: string,
    duplicateOptions?: DriveClientDuplicateOptions,
    options?: DriveClientOperationOptions
  ): Promise<DriveClientFileMetadata>;
  searchFiles(
    params: DriveClientSearchParams,
    options?: DriveClientOperationOptions
  ): Promise<DriveClientFileMetadata[]>;
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

  async getFile(
    fileId: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.getFile(fileId, options);
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('getFile', error);
    }
  }

  async findOrCreateFolder(
    parentId: string,
    folderName: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.findOrCreateFolder(
        parentId,
        folderName,
        options
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('findOrCreateFolder', error);
    }
  }

  async move(
    fileId: string,
    targetFolderId: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.move(
        fileId,
        targetFolderId,
        options
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('move', error);
    }
  }

  async rename(
    fileId: string,
    newName: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.rename(
        fileId,
        newName,
        options
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('rename', error);
    }
  }

  async duplicate(
    fileId: string,
    duplicateOptions?: DriveDuplicateOptions,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.duplicate(
        fileId,
        duplicateOptions,
        options
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('duplicate', error);
    }
  }

  async searchFiles(
    query: DriveSearchQuery,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult[]> {
    try {
      const results = await this.driveClient.searchFiles(query, options);
      return results.map(mapMetadataToResult);
    } catch (error) {
      this.translateError('searchFiles', error);
    }
  }
}

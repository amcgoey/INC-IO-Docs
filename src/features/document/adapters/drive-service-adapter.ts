import {
  DriveServiceError,
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
  moveFile(
    fileId: string,
    currentParentId: string,
    targetFolderId: string,
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

export class DriveServiceAdapter implements DriveServicePort {
  constructor(private readonly driveClient: DriveClientPort) {}

  private translateError(operation: string, error: unknown): never {
    if (error instanceof DriveServiceError) {
      throw error;
    }
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error);

    throw new DriveServiceError(`Drive service error in ${operation}: ${message}`, {
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

  async moveFile(
    fileId: string,
    currentParentId: string,
    targetFolderId: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult> {
    try {
      const metadata = await this.driveClient.moveFile(
        fileId,
        currentParentId,
        targetFolderId,
        options
      );
      return mapMetadataToResult(metadata);
    } catch (error) {
      this.translateError('moveFile', error);
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

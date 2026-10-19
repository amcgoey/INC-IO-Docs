import type { Activity, ActivityOutput, FileLocator, SourceFile } from '../domain';
import {
  AmbiguousFileError,
  AmbiguousPathSpecError,
  DriveServiceError,
  FileNotFoundError,
  validatePrimaryTargetId,
  type ActivityHandler,
  type AppConfigurationProviderPort,
  type DriveFileResult,
  type DriveSearchQuery,
  type DriveServicePort,
} from '../ports';

export interface DriveActivityHandlerOptions {
  defaultFolderName?: string | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  primaryTargetId?: string | undefined;
  sourceFiles?: SourceFile[] | undefined;
}

export function parsePathSegments(path: string): string[] {
  if (typeof path !== 'string') {
    throw new DriveServiceError('DriveActivityHandler: Resolved folder path segment must be a non-empty string');
  }
  const cleanPath = path.trim().replace(/^[/\\ ]+|[/\\ ]+$/g, '');
  if (cleanPath.length === 0) {
    throw new DriveServiceError('DriveActivityHandler: Resolved folder path segment must be a non-empty string');
  }
  const segments = cleanPath.split(/[/\\]+/).map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new DriveServiceError('DriveActivityHandler: Resolved folder path segment must be a non-empty string');
  }
  return segments;
}

function isAccessDeniedError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const err = error as { statusCode?: unknown; status?: unknown; code?: unknown; message?: unknown };
    if (err.statusCode === 403 || err.status === 403 || err.code === 403) {
      return true;
    }
    if (typeof err.message === 'string' && /403|insufficient permissions|access denied/i.test(err.message)) {
      return true;
    }
  }
  if (typeof error === 'string' && /403|insufficient permissions|access denied/i.test(error)) {
    return true;
  }
  return false;
}

function isFileNotFoundError(error: unknown): boolean {
  if (error instanceof FileNotFoundError) {
    return true;
  }
  if (typeof error === 'object' && error !== null) {
    const err = error as { name?: unknown; message?: unknown; statusCode?: unknown; status?: unknown };
    if (err.name === 'FileNotFoundError' || err.statusCode === 404 || err.status === 404) {
      return true;
    }
    if (typeof err.message === 'string' && (err.message.includes('FileNotFoundError') || /404|file not found/i.test(err.message))) {
      return true;
    }
  }
  return false;
}

export class DriveActivityHandler implements ActivityHandler {
  private readonly options: DriveActivityHandlerOptions;
  private readonly sourceFiles?: SourceFile[] | undefined;

  constructor(
    private readonly driveService: DriveServicePort,
    options?: DriveActivityHandlerOptions
  ) {
    const validatedTargetId = validatePrimaryTargetId(
      options?.primaryTargetId,
      'DriveActivityHandler'
    );
    this.options = {
      ...(options ?? {}),
      ...(validatedTargetId !== undefined ? { primaryTargetId: validatedTargetId } : {}),
    };
    if (options?.sourceFiles !== undefined) {
      this.sourceFiles = options.sourceFiles;
    } else if (validatedTargetId) {
      this.sourceFiles = [{ id: validatedTargetId }];
    } else {
      this.sourceFiles = undefined;
    }
  }

  canHandle(activity: Activity): boolean {
    return (
      activity.type === 'MOVE_FILE' ||
      activity.type === 'SEARCH_DRIVE_FILE' ||
      activity.type === 'FIND_DRIVE_FILE' ||
      activity.type === 'RESOLVE_DRIVE_FILE'
    );
  }

  private extractSearchQuery(payload: Record<string, unknown>): DriveSearchQuery | undefined {
    let targetName =
      typeof payload.targetName === 'string'
        ? payload.targetName
        : typeof payload.fileName === 'string'
          ? payload.fileName
          : typeof payload.name === 'string'
            ? payload.name
            : undefined;

    let expectedParentPathNames: string[] | undefined = undefined;

    if (Array.isArray(payload.expectedParentPathNames)) {
      expectedParentPathNames = payload.expectedParentPathNames.filter(
        (seg): seg is string => typeof seg === 'string' && seg.length > 0
      );
    } else if (typeof payload.parentPath === 'string') {
      expectedParentPathNames = payload.parentPath
        .split(/[/\\]+/)
        .filter((seg) => seg.length > 0);
    } else if (typeof payload.folderPath === 'string') {
      expectedParentPathNames = payload.folderPath
        .split(/[/\\]+/)
        .filter((seg) => seg.length > 0);
    }

    const fullPath =
      typeof payload.targetPath === 'string'
        ? payload.targetPath
        : typeof payload.filePath === 'string'
          ? payload.filePath
          : typeof payload.path === 'string'
            ? payload.path
            : undefined;

    if (fullPath && !targetName) {
      const segments = fullPath.split(/[/\\]+/).filter((seg) => seg.length > 0);
      if (segments.length > 0) {
        targetName = segments[segments.length - 1];
        if (!expectedParentPathNames && segments.length > 1) {
          expectedParentPathNames = segments.slice(0, segments.length - 1);
        }
      }
    }

    if (!targetName) {
      return undefined;
    }

    const sharedDriveId =
      typeof payload.sharedDriveId === 'string' ? payload.sharedDriveId : undefined;

    const mimeTypes = Array.isArray(payload.mimeTypes)
      ? payload.mimeTypes.filter((m): m is string => typeof m === 'string')
      : undefined;

    const exactMatch =
      typeof payload.exactMatch === 'boolean'
        ? payload.exactMatch
        : payload.matchType === 'exact'
          ? true
          : undefined;

    return {
      targetName,
      ...(expectedParentPathNames ? { expectedParentPathNames } : {}),
      ...(sharedDriveId ? { sharedDriveId } : {}),
      ...(mimeTypes ? { mimeTypes } : {}),
      ...(exactMatch !== undefined ? { exactMatch } : {}),
    };
  }

  async handle(
    activity: Activity
  ): Promise<ActivityOutput> {
    const payload = activity.payload ?? {};

    const isSearchActivity =
      activity.type === 'SEARCH_DRIVE_FILE' ||
      activity.type === 'FIND_DRIVE_FILE' ||
      activity.type === 'RESOLVE_DRIVE_FILE';

    if (isSearchActivity) {
      try {
        return await this.handleSearch(payload);
      } catch (error) {
        if (
          error instanceof AmbiguousPathSpecError ||
          error instanceof AmbiguousFileError ||
          error instanceof FileNotFoundError
        ) {
          return {
            success: false,
            error: error.message,
          };
        }

        if (error instanceof DriveServiceError) {
          throw error;
        }

        throw error instanceof Error
          ? error
          : new Error(`DriveActivityHandler failed: ${String(error)}`, { cause: error });
      }
    }

    try {
      return await this.handleMove(payload);
    } catch (error) {
      if (
        error instanceof DriveServiceError ||
        error instanceof AmbiguousPathSpecError ||
        error instanceof AmbiguousFileError ||
        error instanceof FileNotFoundError
      ) {
        return {
          success: false,
          error: error.message,
        };
      }

      throw new Error(
        `DriveActivityHandler failed to move file: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  private async handleSearch(
    payload: Record<string, unknown>
  ): Promise<ActivityOutput> {
    const query = this.extractSearchQuery(payload);
    if (!query) {
      throw new Error('DriveActivityHandler: No targetName or path found in activity payload for search');
    }

    try {
      const results = await this.driveService.searchFiles(query);

      if (results.length === 0) {
        throw new FileNotFoundError(`FileNotFoundError: File not found for target '${query.targetName}'`);
      }

      if (results.length > 1) {
        throw new AmbiguousFileError(
          `AmbiguousFileError: Query for target '${query.targetName}' returned ${results.length} matches and could not be uniquely resolved.`
        );
      }

      const matchedFile = results[0];
      const fileLocator: FileLocator = {
        id: matchedFile.id,
        name: matchedFile.name,
        ...(matchedFile.parents?.[0] ? { parentName: matchedFile.parents[0] } : {}),
        ...(matchedFile.mimeType ? { mimeType: matchedFile.mimeType } : {}),
        ...(matchedFile.webViewLink ? { uri: matchedFile.webViewLink } : {}),
      };

      return {
        success: true,
        files: [fileLocator],
        documentDataPatch: {
          fileId: matchedFile.id,
          ...(matchedFile.webViewLink ? { webViewLink: matchedFile.webViewLink } : {}),
        },
        contextVariables: {
          fileId: matchedFile.id,
          ...(matchedFile.webViewLink ? { webViewLink: matchedFile.webViewLink } : {}),
        },
      };
    } catch (error) {
      if (error instanceof DriveServiceError) {
        throw error;
      }
      throw new Error(
        `DriveActivityHandler failed to search files: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  private async handleMove(
    payload: Record<string, unknown>
  ): Promise<ActivityOutput> {
    let targetSourceFiles: SourceFile[] = [];

    const payloadFileId =
      typeof payload.fileId === 'string' && payload.fileId.trim().length > 0
        ? payload.fileId.trim()
        : undefined;

    if (this.sourceFiles !== undefined) {
      targetSourceFiles = [...this.sourceFiles];
    } else if (payloadFileId) {
      targetSourceFiles = [{ id: payloadFileId }];
    } else {
      const searchQuery = this.extractSearchQuery(payload);
      if (searchQuery) {
        const results = await this.driveService.searchFiles(searchQuery);
        if (results.length === 0) {
          throw new FileNotFoundError(`FileNotFoundError: File not found for target '${searchQuery.targetName}'`);
        }
        if (results.length > 1) {
          throw new AmbiguousFileError(
            `AmbiguousFileError: Query for target '${searchQuery.targetName}' returned ${results.length} matches and could not be uniquely resolved.`
          );
        }
        targetSourceFiles = [{ id: results[0].id }];
      }
    }

    if (this.sourceFiles === undefined && targetSourceFiles.length === 0) {
      throw new Error('DriveActivityHandler: No fileId found in activity payload or execution context');
    }

    let driveConfig;
    if (this.options.configProvider) {
      try {
        driveConfig = await this.options.configProvider.getDriveConfig();
      } catch (error) {
        throw new Error(
          `DriveActivityHandler failed to get drive config: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    const rootStorageId =
      typeof payload.rootStorageId === 'string' && payload.rootStorageId.trim().length > 0
        ? payload.rootStorageId.trim()
        : undefined;

    let parentPathSegments: string[] = [];
    if (payload.parentPath !== undefined) {
      parentPathSegments = parsePathSegments(payload.parentPath as string);
    }

    let startingId: string;
    if (rootStorageId) {
      startingId = rootStorageId;
    } else if (targetSourceFiles.length > 0 && !(targetSourceFiles[0].content instanceof Uint8Array)) {
      startingId =
        (await this.driveService.getFile(targetSourceFiles[0].id)).parents?.[0] ??
        'root';
    } else {
      throw new Error(
        'DriveActivityHandler: Cannot create destination folder for zero-file filing because rootStorageId is missing or unresolved in activity payload'
      );
    }
    const baseFolderId =
      parentPathSegments.length > 0
        ? (await this.driveService.resolveFolderPath(startingId, parentPathSegments)).id
        : startingId;

    const defaultTargetName =
      driveConfig?.defaultFolderName ?? this.options.defaultFolderName ?? 'Unfiled';
    let folderSegments: string[];
    if (payload.folderName !== undefined) {
      folderSegments = parsePathSegments(payload.folderName as string);
    } else {
      folderSegments = [defaultTargetName];
    }

    let currentParentId = baseFolderId;
    let leafFolder: DriveFileResult = { id: baseFolderId, name: '' };

    for (const segment of folderSegments) {
      leafFolder = await this.driveService.findOrCreateFolder(currentParentId, segment);
      currentParentId = leafFolder.id;
    }

    const movedFiles: FileLocator[] = [];
    for (const sourceFile of targetSourceFiles) {
      try {
        if (sourceFile.content instanceof Uint8Array) {
          const file = await this.driveService.saveBuffer(sourceFile.content, {
            action: 'create',
            targetFolderId: leafFolder.id,
            name: sourceFile.name || sourceFile.id,
            ...(sourceFile.mimeType !== undefined ? { mimeType: sourceFile.mimeType } : {}),
          });
          const resolvedMimeType = file.mimeType ?? sourceFile.mimeType;
          const fileLocator: FileLocator = {
            id: file.id,
            name: file.name,
            parentName: leafFolder.name,
            ...(resolvedMimeType !== undefined ? { mimeType: resolvedMimeType } : {}),
            uri: file.webViewLink ?? '',
          };
          movedFiles.push(fileLocator);
        } else {
          const movedFile = await this.driveService.move(sourceFile.id, leafFolder.id);

          let uri = movedFile.webViewLink;
          let mimeType = movedFile.mimeType;
          let name = movedFile.name;

          if (!uri || !name) {
            try {
              const fileMeta = await this.driveService.getFile(sourceFile.id);
              uri = uri ?? fileMeta.webViewLink;
              mimeType = mimeType ?? fileMeta.mimeType;
              name = name || fileMeta.name;
            } catch {
              // Ignore
            }
          }

          const fileLocator: FileLocator = {
            id: movedFile.id,
            name: name || sourceFile.name || '',
            parentName: leafFolder.name,
            ...(mimeType ? { mimeType } : {}),
            ...(uri ? { uri } : {}),
          };
          movedFiles.push(fileLocator);
        }
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return {
            success: false,
            error: 'The specified Google Drive file or folder was not found.',
            files: movedFiles,
          };
        }

        if (isAccessDeniedError(error)) {
          return {
            success: false,
            error: 'Access denied. You do not have permission to access this Google Drive file or folder.',
            files: movedFiles,
          };
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: errorMessage,
          files: movedFiles,
        };
      }
    }

    return {
      success: true,
      files: movedFiles,
    };
  }
}


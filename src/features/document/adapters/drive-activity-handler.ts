import type { Activity, ActivityOutput, FileLocator } from '../domain';
import {
  AmbiguousFileError,
  AmbiguousPathSpecError,
  DriveServiceError,
  FileNotFoundError,
  validatePrimaryTargetId,
  type ActivityHandler,
  type AppConfigurationProviderPort,
  type DriveSearchQuery,
  type DriveServicePort,
} from '../ports';

export interface DriveActivityHandlerOptions {
  defaultFolderName?: string | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  primaryTargetId?: string | undefined;
}

export class DriveActivityHandler implements ActivityHandler {
  private readonly options: DriveActivityHandlerOptions;

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
  }

  canHandle(activity: Activity): boolean {
    return (
      activity.type === 'MOVE_DRIVE_FILE' ||
      activity.type === 'MOVE_SELECTED_FILE' ||
      activity.type === 'DRIVE_MOVE_SELECTED_FILE' ||
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

    try {
      if (isSearchActivity) {
        return await this.handleSearch(payload);
      }

      return await this.handleMove(payload);
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
    const payloadFileId =
      typeof payload.fileId === 'string' ? payload.fileId : undefined;
    let fileId = payloadFileId ?? this.options.primaryTargetId;

    if (!fileId) {
      const searchQuery = this.extractSearchQuery(payload);
      if (searchQuery) {
        try {
          const results = await this.driveService.searchFiles(searchQuery);
          if (results.length === 0) {
            throw new FileNotFoundError(`FileNotFoundError: File not found for target '${searchQuery.targetName}'`);
          }
          if (results.length > 1) {
            throw new AmbiguousFileError(
              `AmbiguousFileError: Query for target '${searchQuery.targetName}' returned ${results.length} matches and could not be uniquely resolved.`
            );
          }
          fileId = results[0].id;
        } catch (error) {
          if (error instanceof DriveServiceError) {
            throw error;
          }
          throw new Error(
            `DriveActivityHandler failed to resolve file for move: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
      }
    }

    if (!fileId) {
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

    const defaultTargetName =
      driveConfig?.defaultFolderName ?? this.options.defaultFolderName ?? 'Unfiled';
    const folderName =
      typeof payload.folderName === 'string'
        ? payload.folderName
        : defaultTargetName;

    try {
      const file = await this.driveService.getFile(fileId);
      const currentParentId = file.parents?.[0] ?? 'root';
      const targetFolder = await this.driveService.findOrCreateFolder(currentParentId, folderName);
      const movedFile = await this.driveService.move(fileId, targetFolder.id);

      const mimeType = movedFile.mimeType ?? file.mimeType;
      const uri = movedFile.webViewLink ?? file.webViewLink;
      const fileLocator: FileLocator = {
        id: movedFile.id,
        name: movedFile.name,
        parentName: targetFolder.name,
        ...(mimeType ? { mimeType } : {}),
        ...(uri ? { uri } : {}),
      };

      return {
        success: true,
        files: [fileLocator],
      };
    } catch (error) {
      if (error instanceof DriveServiceError) {
        throw error;
      }
      throw new Error(
        `DriveActivityHandler failed to move file: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}


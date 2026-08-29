import type { Activity, ActivityOutput, FileLocator } from '../domain';
import type {
  ActivityHandler,
  AppConfigurationProviderPort,
  DriveServicePort,
  ExecutionContext,
} from '../ports';

export interface DriveActivityHandlerOptions {
  defaultFolderName?: string | undefined;
  fallbackAuth?: string | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
}

export class DriveActivityHandler implements ActivityHandler {
  constructor(
    private readonly driveService: DriveServicePort,
    private readonly options: DriveActivityHandlerOptions = {}
  ) {}

  canHandle(activity: Activity): boolean {
    return (
      activity.type === 'MOVE_DRIVE_FILE' ||
      activity.type === 'MOVE_SELECTED_FILE' ||
      activity.type === 'DRIVE_MOVE_SELECTED_FILE'
    );
  }

  async handle(
    activity: Activity,
    context?: ExecutionContext
  ): Promise<ActivityOutput> {
    let fileId =
      typeof activity.payload?.fileId === 'string' ? activity.payload.fileId : undefined;

    if (!fileId && context?.resources?.primaryTargetId) {
      fileId = context.resources.primaryTargetId;
    }

    if (!fileId) {
      throw new Error('DriveActivityHandler: No fileId found in activity payload or execution context');
    }

    let auth = this.options.fallbackAuth;
    if (context?.credentials?.oauthToken) {
      auth = context.credentials.oauthToken;
    }

    const driveOptions = auth ? { auth } : undefined;

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
      typeof activity.payload?.folderName === 'string'
        ? activity.payload.folderName
        : defaultTargetName;

    try {
      const file = await this.driveService.getFile(fileId, driveOptions);
      const currentParentId = file.parents?.[0] ?? 'root';
      const targetFolder = await this.driveService.findOrCreateFolder(currentParentId, folderName, driveOptions);
      const movedFile = await this.driveService.moveFile(fileId, currentParentId, targetFolder.id, driveOptions);

      const mimeType = movedFile.mimeType ?? file.mimeType;
      const fileLocator: FileLocator = {
        id: movedFile.id,
        name: movedFile.name,
        parentName: targetFolder.name,
        ...(mimeType ? { mimeType } : {}),
        uri: `https://drive.google.com/file/d/${movedFile.id}/view`,
      };

      return {
        success: true,
        files: [fileLocator],
      };
    } catch (error) {
      throw new Error(
        `DriveActivityHandler failed to move file: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}

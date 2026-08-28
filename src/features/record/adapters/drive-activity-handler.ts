import type { Activity } from '../domain';
import type { ActivityHandler, AppConfigurationProviderPort, DriveServicePort } from '../ports';

export interface DriveActivityExecutionResult {
  fileId: string;
  fileName: string;
  destinationFolder: string;
}

export interface DriveActivitySelectedItem {
  id: string;
  title?: string | undefined;
  mimeType?: string | undefined;
}

export interface DriveActivityContext {
  selectedItems?: DriveActivitySelectedItem[] | undefined;
  userOAuthToken?: string | undefined;
  lastExecutionResult?: DriveActivityExecutionResult | undefined;
}

export interface DriveActivityHandlerOptions {
  defaultFolderName?: string | undefined;
  fallbackAuth?: string | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
}


export class DriveActivityHandler implements ActivityHandler {
  private lastResult: DriveActivityExecutionResult | null = null;

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

  async handle<TContext = unknown>(activity: Activity, context?: TContext): Promise<void> {
    const ctx = context && typeof context === 'object' ? (context as DriveActivityContext) : undefined;

    let fileId =
      typeof activity.payload?.fileId === 'string' ? activity.payload.fileId : undefined;

    if (!fileId && ctx?.selectedItems && ctx.selectedItems.length > 0 && ctx.selectedItems[0]?.id) {
      fileId = ctx.selectedItems[0].id;
    }

    if (!fileId) {
      throw new Error('DriveActivityHandler: No fileId found in activity payload or execution context');
    }

    let auth = this.options.fallbackAuth;
    if (ctx?.userOAuthToken) {
      auth = ctx.userOAuthToken;
    }

    const driveOptions = auth ? { auth } : undefined;

    try {
      const driveConfig = this.options.configProvider
        ? await this.options.configProvider.getDriveConfig()
        : undefined;

      const defaultTargetName =
        driveConfig?.defaultFolderName ?? this.options.defaultFolderName ?? 'Unfiled';
      const folderName =
        typeof activity.payload?.folderName === 'string'
          ? activity.payload.folderName
          : defaultTargetName;

      const file = await this.driveService.getFile(fileId, driveOptions);
      const currentParentId = file.parents?.[0] ?? 'root';
      const targetFolder = await this.driveService.findOrCreateFolder(currentParentId, folderName, driveOptions);
      const movedFile = await this.driveService.moveFile(fileId, currentParentId, targetFolder.id, driveOptions);

      const result: DriveActivityExecutionResult = {
        fileId: movedFile.id,
        fileName: movedFile.name,
        destinationFolder: targetFolder.name,
      };

      this.lastResult = result;

      if (ctx) {
        ctx.lastExecutionResult = result;
      }

    } catch (error) {
      throw new Error(
        `DriveActivityHandler failed to move file: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  getLastExecutionResult(): DriveActivityExecutionResult | null {
    return this.lastResult;
  }
}

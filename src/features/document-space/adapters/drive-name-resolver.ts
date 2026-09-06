import type { DriveStorageClientPort } from './google-drive-storage-adapter';

export class DriveNameResolver {
  constructor(private readonly driveClient: DriveStorageClientPort) {}

  async resolveSharedDriveId(sharedDriveName: string): Promise<string> {
    let drivePageToken: string | undefined;
    do {
      const res = await this.driveClient.listSharedDrives({
        pageSize: 100,
        pageToken: drivePageToken,
      });
      const drive = res.drives.find((d) => d.name === sharedDriveName);
      if (drive) {
        return drive.id;
      }
      drivePageToken = res.nextPageToken;
    } while (drivePageToken);

    throw new Error(`Shared drive not found with name: ${sharedDriveName}`);
  }

  async resolveParentFolderId(
    parentFolderName: string,
    sharedDriveId?: string
  ): Promise<string> {
    if (!this.driveClient.searchFiles) {
      throw new Error(
        'driveClient.searchFiles is not implemented on the provided DriveStorageClientPort'
      );
    }
    const files = await this.driveClient.searchFiles({
      targetName: parentFolderName,
      exactMatch: true,
      sharedDriveId,
      mimeTypes: ['application/vnd.google-apps.folder'],
    });
    if (files.length === 0) {
      throw new Error(`Parent folder not found with name: ${parentFolderName}`);
    }
    if (files.length > 1) {
      throw new Error(`Multiple parent folders found with name: ${parentFolderName}`);
    }
    return files[0].id;
  }
}

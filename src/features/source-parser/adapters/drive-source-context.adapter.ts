import type { DriveFileMetadata } from '../../../infrastructure/drive/drive-client';
import type {
  DriveSourceContextPort,
  DriveItemHierarchy,
  DriveHierarchyNode,
} from '../ports';

export interface DriveSourceContextClientPort {
  getFile(fileId: string): Promise<DriveFileMetadata>;
  listSharedDrives?(options?: { pageSize?: number; pageToken?: string }): Promise<{
    drives: Array<{ id: string; name: string }>;
    nextPageToken?: string | undefined;
  }>;
}

export function isTerminalRoutingFolder(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'opportunities') return true;
  if (normalized === '1 admin/communication' || normalized === '1 admin / communication') return true;
  if (normalized === '3 ffe' || normalized.startsWith('3 ffe/') || normalized.startsWith('3 ffe /')) return true;
  if (normalized === '6 construction' || normalized.startsWith('6 construction/') || normalized.startsWith('6 construction /')) return true;
  return false;
}

export class DriveSourceContextAdapter implements DriveSourceContextPort {
  private readonly fileCache = new Map<string, DriveFileMetadata>();
  private sharedDrivesMap?: Map<string, string>;

  constructor(private readonly client: DriveSourceContextClientPort) {}

  async getItemHierarchy(itemId: string): Promise<DriveItemHierarchy> {
    const itemMetadata = await this.getCachedFile(itemId);
    const driveId = itemMetadata.driveId;
    const driveName = driveId ? await this.resolveDriveName(driveId) : undefined;

    const ancestors: DriveHierarchyNode[] = [];
    const visited = new Set<string>([itemId]);
    let currentParents = itemMetadata.parents;
    let depth = 0;

    while (currentParents && currentParents.length > 0 && depth < 15) {
      const parentId = currentParents[0];
      if (!parentId || visited.has(parentId)) {
        break;
      }
      if (parentId === 'root' || (driveId && parentId === driveId)) {
        break;
      }
      visited.add(parentId);
      depth++;

      const parentMetadata = await this.getCachedFile(parentId);
      ancestors.push({
        id: parentMetadata.id,
        name: parentMetadata.name,
        ...(parentMetadata.mimeType !== undefined ? { mimeType: parentMetadata.mimeType } : {}),
      });

      if (isTerminalRoutingFolder(parentMetadata.name)) {
        break;
      }

      currentParents = parentMetadata.parents;
    }

    ancestors.reverse();

    return {
      item: {
        id: itemMetadata.id,
        name: itemMetadata.name,
        ...(itemMetadata.mimeType !== undefined ? { mimeType: itemMetadata.mimeType } : {}),
      },
      ...(driveId !== undefined ? { driveId } : {}),
      ...(driveName !== undefined ? { driveName } : {}),
      ancestors,
    };
  }

  private async getCachedFile(fileId: string): Promise<DriveFileMetadata> {
    const existing = this.fileCache.get(fileId);
    if (existing) {
      return existing;
    }
    const fetched = await this.client.getFile(fileId);
    this.fileCache.set(fileId, fetched);
    return fetched;
  }

  private async resolveDriveName(driveId: string): Promise<string | undefined> {
    if (!this.client.listSharedDrives) {
      return undefined;
    }
    if (!this.sharedDrivesMap) {
      this.sharedDrivesMap = new Map();
      try {
        const res = await this.client.listSharedDrives();
        for (const drive of res.drives ?? []) {
          if (drive.id && drive.name) {
            this.sharedDrivesMap.set(drive.id, drive.name);
          }
        }
      } catch {
        return undefined;
      }
    }
    return this.sharedDrivesMap.get(driveId);
  }
}

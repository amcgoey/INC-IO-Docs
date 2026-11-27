import type {
  DriveSourceContextPort,
  DriveSourceContextClientPort,
  DriveSourceFileMetadata,
  DriveItemHierarchy,
  DriveHierarchyNode,
} from '../ports';

export function isTerminalRoutingFolder(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'opportunities') return true;
  if (normalized === '1 admin/communication' || normalized === '1 admin / communication') return true;
  if (normalized === '3 ffe' || normalized.startsWith('3 ffe/') || normalized.startsWith('3 ffe /')) return true;
  if (normalized === '6 construction' || normalized.startsWith('6 construction/') || normalized.startsWith('6 construction /')) return true;
  return false;
}

export function isPermissionBoundaryOrNotFound(error: unknown): boolean {
  if (!error) return false;
  const status =
    (error as { statusCode?: number })?.statusCode ??
    (error as { status?: number })?.status ??
    (error as { code?: number | string })?.code ??
    (error as { response?: { status?: number } })?.response?.status;
  if (status === 403 || status === 404 || status === '403' || status === '404') {
    return true;
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes('403') ||
      msg.includes('404') ||
      msg.includes('forbidden') ||
      msg.includes('not found') ||
      msg.includes('notfound')
    ) {
      return true;
    }
  }
  return false;
}

export class DriveSourceContextAdapter implements DriveSourceContextPort {
  private readonly filePromiseCache = new Map<string, Promise<DriveSourceFileMetadata>>();
  private readonly hierarchyPromiseCache = new Map<string, Promise<DriveItemHierarchy>>();
  private sharedDrivesPromise?: Promise<Map<string, string>>;

  constructor(private readonly client: DriveSourceContextClientPort) {}

  getItemHierarchy(itemId: string): Promise<DriveItemHierarchy> {
    const existing = this.hierarchyPromiseCache.get(itemId);
    if (existing) {
      return existing;
    }
    const promise = this.loadItemHierarchy(itemId);
    this.hierarchyPromiseCache.set(itemId, promise);
    return promise;
  }

  private async loadItemHierarchy(itemId: string): Promise<DriveItemHierarchy> {
    let itemMetadata = await this.getCachedFile(itemId);

    if (
      itemMetadata.mimeType === 'application/vnd.google-apps.shortcut' &&
      itemMetadata.shortcutDetails?.targetId
    ) {
      itemMetadata = await this.getCachedFile(itemMetadata.shortcutDetails.targetId);
    }

    const driveId = itemMetadata.driveId;
    const driveName = driveId ? await this.resolveDriveName(driveId) : undefined;

    const ancestors: DriveHierarchyNode[] = [];
    const visited = new Set<string>([itemMetadata.id]);
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

      let parentMetadata: DriveSourceFileMetadata;
      try {
        parentMetadata = await this.getCachedFile(parentId);
      } catch (error: unknown) {
        if (isPermissionBoundaryOrNotFound(error)) {
          break;
        }
        throw error;
      }

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
        ...(itemMetadata.size !== undefined ? { size: itemMetadata.size } : {}),
        ...(itemMetadata.createdTime !== undefined ? { createdTime: itemMetadata.createdTime } : {}),
        ...(itemMetadata.modifiedTime !== undefined ? { modifiedTime: itemMetadata.modifiedTime } : {}),
      },
      ...(driveId !== undefined ? { driveId } : {}),
      ...(driveName !== undefined ? { driveName } : {}),
      ancestors,
    };
  }

  private getCachedFile(fileId: string): Promise<DriveSourceFileMetadata> {
    const existing = this.filePromiseCache.get(fileId);
    if (existing) {
      return existing;
    }
    const promise = (async () => this.client.getFile(fileId))();
    this.filePromiseCache.set(fileId, promise);
    return promise;
  }

  private async resolveDriveName(driveId: string): Promise<string | undefined> {
    if (!this.client.listSharedDrives) {
      return undefined;
    }
    if (!this.sharedDrivesPromise) {
      this.sharedDrivesPromise = this.loadSharedDrivesMap();
    }
    const map = await this.sharedDrivesPromise;
    return map.get(driveId);
  }

  private async loadSharedDrivesMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.client.listSharedDrives) {
      return map;
    }
    try {
      const res = await this.client.listSharedDrives();
      for (const drive of res.drives ?? []) {
        if (drive.id && drive.name) {
          map.set(drive.id, drive.name);
        }
      }
    } catch {
      // Non-fatal: driveName remains undefined if shared drives listing fails
    }
    return map;
  }
}

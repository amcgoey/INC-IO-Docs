import type {
  DriveOptionFolderResult,
  DriveOptionSourcePort,
  LookupValidationStatus,
} from '../ports';

export interface DriveFolderListClient {
  listFolders(
    options?: {
      parentFolderId?: string | undefined;
      sharedDriveId?: string | undefined;
      pageSize?: number | undefined;
      pageToken?: string | undefined;
      name?: string | undefined;
    },
    driveOptions?: {
      auth?: string | undefined;
      signal?: AbortSignal | undefined;
    }
  ): Promise<{
    folders: Array<{ id: string; name: string }>;
    nextPageToken?: string | undefined;
  }>;
}

const DEFAULT_MAX_ITEMS = 150;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason !== undefined) {
    throw signal.reason;
  }
  const err = new Error('Operation aborted');
  err.name = 'AbortError';
  throw err;
}

function extractDrivePathSpec(relativePath?: string): string {
  if (typeof relativePath !== 'string') {
    return '';
  }
  return relativePath.trim().replace(/^\/+|\/+$/g, '');
}

function extractDriveTargetPath(pathSpec: string): string {
  return pathSpec.length > 0 ? pathSpec : 'root';
}

function getDrivePathSegments(pathSpec: string): string[] {
  if (!pathSpec) {
    return [];
  }
  return pathSpec
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type ResolveFolderOutcome =
  | { success: true; folderId: string }
  | { success: false; status: 'path_not_found' | 'ambiguous_path' };

export class DriveOptionSourceAdapter implements DriveOptionSourcePort {
  constructor(private readonly driveClient: DriveFolderListClient) {}

  async listFoldersAtPath(params: {
    spaceStorageId: string;
    relativePath?: string | undefined;
    maxItems?: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<DriveOptionFolderResult> {
    throwIfAborted(params.signal);
    const pathSpec = extractDrivePathSpec(params.relativePath);
    const targetPath = extractDriveTargetPath(pathSpec);
    const maxItems = params.maxItems ?? DEFAULT_MAX_ITEMS;

    const outcome = await this.resolveTargetFolder(params.spaceStorageId, pathSpec, params.signal);
    if (!outcome.success) {
      return { status: outcome.status, items: [], targetPath };
    }

    const items: Array<{ key: string; name: string }> = [];
    let pageToken: string | undefined;
    let truncated = false;

    do {
      throwIfAborted(params.signal);
      const listArgs = {
        parentFolderId: outcome.folderId,
        pageSize: 100,
        ...(pageToken !== undefined ? { pageToken } : {}),
      };
      const result =
        params.signal !== undefined
          ? await this.driveClient.listFolders(listArgs, { signal: params.signal })
          : await this.driveClient.listFolders(listArgs);
      throwIfAborted(params.signal);

      for (const folder of result.folders) {
        if (items.length >= maxItems) {
          truncated = true;
          break;
        }
        items.push({ key: folder.name, name: folder.name });
      }

      if (items.length >= maxItems && result.nextPageToken) {
        truncated = true;
      }

      pageToken = result.nextPageToken;
    } while (pageToken && !truncated && items.length < maxItems);

    if (items.length === 0) {
      return { status: 'empty', items: [], targetPath, truncated: false };
    }

    return {
      status: 'ready',
      items,
      targetPath,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  async validateFolderExistence(params: {
    spaceStorageId: string;
    relativePath?: string | undefined;
    value: string;
    allowUserInput?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{
    isValid: boolean;
    status: LookupValidationStatus;
    targetPath: string;
    matchedTuple?: { key: string; name: string } | undefined;
  }> {
    throwIfAborted(params.signal);
    const pathSpec = extractDrivePathSpec(params.relativePath);
    const targetPath = extractDriveTargetPath(pathSpec);
    const trimmed = params.value.trim();

    if (trimmed.length === 0) {
      return { isValid: false, status: 'option_not_found', targetPath };
    }

    const outcome = await this.resolveTargetFolder(params.spaceStorageId, pathSpec, params.signal);
    if (!outcome.success) {
      return { isValid: false, status: outcome.status, targetPath };
    }

    const normalizedTarget = trimmed.toLowerCase();
    let pageToken: string | undefined;
    let matchCount = 0;
    let matchedFolderName: string | undefined;

    do {
      throwIfAborted(params.signal);
      const listArgs = {
        parentFolderId: outcome.folderId,
        name: trimmed,
        pageSize: 100,
        ...(pageToken !== undefined ? { pageToken } : {}),
      };
      const result =
        params.signal !== undefined
          ? await this.driveClient.listFolders(listArgs, { signal: params.signal })
          : await this.driveClient.listFolders(listArgs);
      throwIfAborted(params.signal);

      for (const folder of result.folders) {
        if (folder.name.trim().toLowerCase() === normalizedTarget) {
          matchCount++;
          matchedFolderName = folder.name;
          if (matchCount >= 2) {
            return { isValid: false, status: 'ambiguous_option', targetPath };
          }
        }
      }

      pageToken = result.nextPageToken;
    } while (pageToken);

    if (matchCount === 1 && matchedFolderName !== undefined) {
      return {
        isValid: true,
        status: 'valid',
        targetPath,
        matchedTuple: { key: matchedFolderName, name: matchedFolderName },
      };
    }

    if (matchCount === 0 && params.allowUserInput === true) {
      return { isValid: true, status: 'valid', targetPath };
    }

    return { isValid: false, status: 'option_not_found', targetPath };
  }

  private async resolveTargetFolder(
    spaceStorageId: string,
    pathSpec: string,
    signal?: AbortSignal
  ): Promise<ResolveFolderOutcome> {
    throwIfAborted(signal);
    const segments = getDrivePathSegments(pathSpec);
    if (segments.length === 0) {
      return { success: true, folderId: spaceStorageId };
    }

    let currentFolderId = spaceStorageId;

    for (const segment of segments) {
      throwIfAborted(signal);
      const matchingFolders: Array<{ id: string; name: string }> = [];
      let pageToken: string | undefined;

      do {
        throwIfAborted(signal);
        const listArgs = {
          parentFolderId: currentFolderId,
          pageSize: 100,
          ...(pageToken !== undefined ? { pageToken } : {}),
        };
        const result =
          signal !== undefined
            ? await this.driveClient.listFolders(listArgs, { signal })
            : await this.driveClient.listFolders(listArgs);
        throwIfAborted(signal);

        const matchesInPage = result.folders.filter((f) => f.name === segment);
        matchingFolders.push(...matchesInPage);

        if (matchingFolders.length >= 2) {
          return { success: false, status: 'ambiguous_path' };
        }

        pageToken = result.nextPageToken;
      } while (pageToken);

      if (matchingFolders.length === 0) {
        return { success: false, status: 'path_not_found' };
      }

      currentFolderId = matchingFolders[0].id;
    }

    return { success: true, folderId: currentFolderId };
  }
}

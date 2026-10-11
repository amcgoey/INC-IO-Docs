import type {
  DynamicOptionItem,
  DynamicOptionQuery,
  OptionsFetcherContext,
  OptionsFetcherPort,
} from '../features/schema-driven-ui/ports';

export interface DynamicOptionsDriveClient {
  listFolders(options?: {
    parentFolderId?: string | undefined;
    sharedDriveId?: string | undefined;
    pageSize?: number | undefined;
    pageToken?: string | undefined;
  }): Promise<{
    folders: Array<{ id: string; name: string }>;
    nextPageToken?: string | undefined;
  }>;
}

export interface DynamicOptionsAdapterOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_DYNAMIC_OPTIONS = 150;
const PLACEHOLDER_MISSING_SPACE: DynamicOptionItem[] = [
  { text: 'Select a Space first', value: '' },
];

export class DynamicOptionsAdapter implements OptionsFetcherPort {
  private readonly timeoutMs: number;

  constructor(
    private readonly driveClient: DynamicOptionsDriveClient,
    options?: DynamicOptionsAdapterOptions
  ) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async fetchOptions(
    queries: DynamicOptionQuery[],
    context: OptionsFetcherContext
  ): Promise<Record<string, DynamicOptionItem[]>> {
    const results: Record<string, DynamicOptionItem[]> = {};

    if (!context.spaceId) {
      for (const query of queries) {
        results[query.sourceKey] = [...PLACEHOLDER_MISSING_SPACE];
      }
      return results;
    }

    const spaceId = context.spaceId;

    const settledQueries = await Promise.allSettled(
      queries.map(async (query) => {
        const items = await this.resolveQueryWithTimeout(query, spaceId);
        return { sourceKey: query.sourceKey, items };
      })
    );

    for (const settled of settledQueries) {
      if (settled.status === 'fulfilled') {
        results[settled.value.sourceKey] = settled.value.items;
      } else {
        // If unhandled error, default to empty array
        // (Individual query failures are already caught in resolveQueryWithTimeout,
        // but this guarantees safety).
      }
    }

    // Ensure all queries have an entry
    for (const query of queries) {
      if (!results[query.sourceKey]) {
        results[query.sourceKey] = [];
      }
    }

    return results;
  }

  private async resolveQueryWithTimeout(
    query: DynamicOptionQuery,
    spaceId: string
  ): Promise<Array<{ text: string; value: string }>> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Dynamic option fetch timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.executeQuery(query, spaceId),
        timeoutPromise,
      ]);
    } catch {
      return [];
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async executeQuery(
    query: DynamicOptionQuery,
    spaceId: string
  ): Promise<DynamicOptionItem[]> {
    const provider = query.config.provider;
    const method = query.config.method;

    if (provider !== 'google_drive' || method !== 'list_folders') {
      return [];
    }

    const relativePath =
      typeof query.config.relativePath === 'string'
        ? query.config.relativePath.trim()
        : '';

    const targetFolderId = await this.resolveTargetFolder(spaceId, relativePath);
    if (!targetFolderId) {
      return [];
    }

    return await this.listFoldersUpToMax(targetFolderId, MAX_DYNAMIC_OPTIONS);
  }

  private async resolveTargetFolder(
    spaceId: string,
    relativePath: string
  ): Promise<string | undefined> {
    if (!relativePath) {
      return spaceId;
    }

    const segments = relativePath
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    let currentFolderId: string = spaceId;

    for (const segment of segments) {
      let foundChildId: string | undefined;
      let pageToken: string | undefined;

      do {
        const result = await this.driveClient.listFolders({
          parentFolderId: currentFolderId,
          pageSize: 100,
          ...(pageToken !== undefined ? { pageToken } : {}),
        });

        const match = result.folders.find((f) => f.name === segment);
        if (match) {
          foundChildId = match.id;
          break;
        }

        pageToken = result.nextPageToken;
      } while (pageToken);

      if (!foundChildId) {
        return undefined;
      }

      currentFolderId = foundChildId;
    }

    return currentFolderId;
  }

  private async listFoldersUpToMax(
    parentFolderId: string,
    maxItems: number
  ): Promise<DynamicOptionItem[]> {
    const items: DynamicOptionItem[] = [];
    let pageToken: string | undefined;

    do {
      const result = await this.driveClient.listFolders({
        parentFolderId,
        pageSize: 100,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });

      for (const folder of result.folders) {
        items.push({ text: folder.name, value: folder.name });
        if (items.length >= maxItems) {
          return items.slice(0, maxItems);
        }
      }

      pageToken = result.nextPageToken;
    } while (pageToken && items.length < maxItems);

    return items;
  }
}

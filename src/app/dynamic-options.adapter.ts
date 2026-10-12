import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  DynamicOptionItem,
  DynamicOptionQuery,
  OptionsFetcherContext,
  OptionsFetcherPort,
} from '../features/schema-driven-ui/ports';
import {
  type DocumentDynamicValidationPort,
  type DynamicValidationContext,
  type DynamicValidationQuery,
  type DynamicValidationResult,
  OPTION_NOT_FOUND_MSG,
  VALIDATION_TIMEOUT_MSG,
} from '../features/document/ports';

export interface DynamicOptionsDriveClient {
  listFolders(options?: {
    parentFolderId?: string | undefined;
    sharedDriveId?: string | undefined;
    pageSize?: number | undefined;
    pageToken?: string | undefined;
    name?: string | undefined;
  }): Promise<{
    folders: Array<{ id: string; name: string }>;
    nextPageToken?: string | undefined;
  }>;
}

export interface DynamicOptionsAdapterOptions {
  timeoutMs?: number;
}

export const GoogleDriveDynamicConfigSchema = Type.Object({
  provider: Type.Literal('google_drive'),
  method: Type.Literal('list_folders'),
  relativePath: Type.Optional(Type.String()),
}, { additionalProperties: true });

export type GoogleDriveDynamicConfig = Static<typeof GoogleDriveDynamicConfigSchema>;

export function isGoogleDriveDynamicConfig(
  config: unknown
): config is GoogleDriveDynamicConfig {
  return Value.Check(GoogleDriveDynamicConfigSchema, config);
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_DYNAMIC_OPTIONS = 150;
const PLACEHOLDER_MISSING_SPACE: DynamicOptionItem[] = [
  { text: 'Select a Space first', value: '' },
];
const OPTION_NOT_FOUND: DynamicValidationResult = {
  isValid: false,
  errorMessage: OPTION_NOT_FOUND_MSG,
};

export class DynamicOptionsAdapter implements OptionsFetcherPort, DocumentDynamicValidationPort {
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

    for (const query of queries) {
      results[query.sourceKey] = [];
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
    if (!isGoogleDriveDynamicConfig(query.config)) {
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

  async validateExistence(
    queries: DynamicValidationQuery[],
    context: DynamicValidationContext
  ): Promise<Record<string, DynamicValidationResult>> {
    const results: Record<string, DynamicValidationResult> = {};

    for (const query of queries) {
      results[query.queryId] = { ...OPTION_NOT_FOUND };
    }

    if (!context.spaceId) {
      return results;
    }

    const spaceId = context.spaceId;

    const settledQueries = await Promise.allSettled(
      queries.map(async (query) => {
        const result = await this.validateQueryWithTimeout(query, spaceId);
        return { key: query.queryId, result };
      })
    );

    for (const settled of settledQueries) {
      if (settled.status === 'fulfilled') {
        results[settled.value.key] = settled.value.result;
      }
    }

    return results;
  }

  private async validateQueryWithTimeout(
    query: DynamicValidationQuery,
    spaceId: string
  ): Promise<DynamicValidationResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`Dynamic option validation timed out after ${this.timeoutMs}ms`)
        );
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.executeValidationQuery(query, spaceId),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        return {
          isValid: false,
          errorMessage: VALIDATION_TIMEOUT_MSG,
        };
      }
      return {
        isValid: false,
        errorMessage: 'An unexpected error occurred during dynamic option validation.',
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async executeValidationQuery(
    query: DynamicValidationQuery,
    spaceId: string
  ): Promise<DynamicValidationResult> {
    if (!isGoogleDriveDynamicConfig(query.config)) {
      return { ...OPTION_NOT_FOUND };
    }

    const relativePath =
      typeof query.config.relativePath === 'string'
        ? query.config.relativePath.trim()
        : '';

    const targetFolderId = await this.resolveTargetFolder(spaceId, relativePath);
    if (!targetFolderId) {
      return { ...OPTION_NOT_FOUND };
    }

    const result = await this.driveClient.listFolders({
      parentFolderId: targetFolderId,
      name: query.valueToValidate,
    });

    const matchingFolders = result.folders.filter(
      (f) => f.name === query.valueToValidate
    );

    if (matchingFolders.length === 1) {
      return { isValid: true };
    }

    if (matchingFolders.length === 0) {
      return { ...OPTION_NOT_FOUND };
    }

    return {
      isValid: false,
      errorMessage:
        'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.',
    };
  }
}

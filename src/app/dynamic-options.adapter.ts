import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  DynamicOptionItem,
  DynamicOptionResolution,
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
const OPTION_NOT_FOUND: DynamicValidationResult = {
  isValid: false,
  errorMessage: OPTION_NOT_FOUND_MSG,
};

function normalizeTargetPath(relativePath?: unknown): string {
  if (typeof relativePath !== 'string') {
    return 'root';
  }
  const trimmed = relativePath.trim().replace(/^\/+|\/+$/g, '');
  return trimmed || 'root';
}

function getPathSegments(targetPath: string): string[] {
  if (targetPath === 'root') {
    return [];
  }
  return targetPath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type ResolveFolderOutcome =
  | { success: true; folderId: string }
  | { success: false; status: 'path_not_found' | 'ambiguous_path' };

function cleanSpaceId(spaceId?: string): string | undefined {
  if (typeof spaceId !== 'string') {
    return undefined;
  }
  const trimmed = spaceId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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
  ): Promise<Record<string, DynamicOptionResolution>> {
    const results: Record<string, DynamicOptionResolution> = {};

    for (const query of queries) {
      const targetPath = normalizeTargetPath(
        isGoogleDriveDynamicConfig(query.config) ? query.config.relativePath : undefined
      );
      results[query.sourceKey] = { status: 'empty', items: [], targetPath };
    }

    const spaceId = cleanSpaceId(context.spaceId);

    const settledQueries = await Promise.allSettled(
      queries.map(async (query) => {
        const resolution = await this.resolveQueryWithTimeout(query, spaceId);
        return { sourceKey: query.sourceKey, resolution };
      })
    );

    for (const settled of settledQueries) {
      if (settled.status === 'fulfilled') {
        results[settled.value.sourceKey] = settled.value.resolution;
      }
    }

    return results;
  }

  private async resolveQueryWithTimeout(
    query: DynamicOptionQuery,
    spaceId?: string
  ): Promise<DynamicOptionResolution> {
    const targetPath = normalizeTargetPath(
      isGoogleDriveDynamicConfig(query.config) ? query.config.relativePath : undefined
    );

    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Dynamic option fetch timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    const queryPromise = this.executeQuery(query, spaceId);
    queryPromise.catch(() => {});

    try {
      return await Promise.race([queryPromise, timeoutPromise]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        return { status: 'timeout', items: [], targetPath };
      }
      return { status: 'error', items: [], targetPath };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async executeQuery(
    query: DynamicOptionQuery,
    spaceId?: string
  ): Promise<DynamicOptionResolution> {
    const targetPath = normalizeTargetPath(
      isGoogleDriveDynamicConfig(query.config) ? query.config.relativePath : undefined
    );

    if (!isGoogleDriveDynamicConfig(query.config)) {
      return { status: 'empty', items: [], targetPath };
    }

    if (!spaceId) {
      return { status: 'missing_space', items: [], targetPath };
    }

    const outcome = await this.resolveTargetFolder(spaceId, targetPath);
    if (!outcome.success) {
      return { status: outcome.status, items: [], targetPath };
    }

    const items = await this.listFoldersUpToMax(outcome.folderId, MAX_DYNAMIC_OPTIONS);
    if (items.length === 0) {
      return { status: 'empty', items: [], targetPath };
    }

    return { status: 'ready', items, targetPath };
  }

  private async resolveTargetFolder(
    spaceId: string,
    targetPath: string
  ): Promise<ResolveFolderOutcome> {
    const segments = getPathSegments(targetPath);
    if (segments.length === 0) {
      return { success: true, folderId: spaceId };
    }

    let currentFolderId: string = spaceId;

    for (const segment of segments) {
      const matchingFolders: Array<{ id: string; name: string }> = [];
      let pageToken: string | undefined;

      do {
        const result = await this.driveClient.listFolders({
          parentFolderId: currentFolderId,
          pageSize: 100,
          ...(pageToken !== undefined ? { pageToken } : {}),
        });

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

    const spaceId = cleanSpaceId(context.spaceId);

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
    spaceId?: string
  ): Promise<DynamicValidationResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(`Dynamic option validation timed out after ${this.timeoutMs}ms`)
        );
      }, this.timeoutMs);
    });

    const queryPromise = this.executeValidationQuery(query, spaceId);
    queryPromise.catch(() => {});

    try {
      return await Promise.race([
        queryPromise,
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
    spaceId?: string
  ): Promise<DynamicValidationResult> {
    if (!isGoogleDriveDynamicConfig(query.config)) {
      return { ...OPTION_NOT_FOUND };
    }

    if (!spaceId) {
      return { ...OPTION_NOT_FOUND };
    }

    const targetPath = normalizeTargetPath(query.config.relativePath);
    const outcome = await this.resolveTargetFolder(spaceId, targetPath);
    if (!outcome.success) {
      return { ...OPTION_NOT_FOUND };
    }

    const result = await this.driveClient.listFolders({
      parentFolderId: outcome.folderId,
      name: query.valueToValidate,
    });

    const matchingFolders = result.folders.filter(
      (f) => f.name === query.valueToValidate
    );

    if (matchingFolders.length === 1) {
      return { isValid: true };
    }

    if (matchingFolders.length === 0) {
      if (query.allowUserInput === true) {
        return { isValid: true };
      }
      return { ...OPTION_NOT_FOUND };
    }

    return {
      isValid: false,
      errorMessage:
        'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.',
    };
  }
}

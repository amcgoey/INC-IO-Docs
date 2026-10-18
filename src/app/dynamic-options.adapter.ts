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

export function extractPathSpec(relativePath?: unknown): string {
  if (typeof relativePath !== 'string') {
    return '';
  }
  return relativePath.trim().replace(/^\/+|\/+$/g, '');
}

export function extractTargetPath(pathSpec: string): string {
  return pathSpec.length > 0 ? pathSpec : 'root';
}

export function extractPathInfo(config: unknown): { pathSpec: string; targetPath: string } {
  const relativePath = isGoogleDriveDynamicConfig(config) ? config.relativePath : undefined;
  const pathSpec = extractPathSpec(relativePath);
  const targetPath = extractTargetPath(pathSpec);
  return { pathSpec, targetPath };
}

export function getPathSegments(pathSpec: string): string[] {
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
      const { targetPath } = extractPathInfo(query.config);
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
    const { targetPath } = extractPathInfo(query.config);

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
    const { pathSpec, targetPath } = extractPathInfo(query.config);

    if (!isGoogleDriveDynamicConfig(query.config)) {
      return { status: 'empty', items: [], targetPath };
    }

    if (!spaceId) {
      return { status: 'missing_space', items: [], targetPath };
    }

    const outcome = await this.resolveTargetFolder(spaceId, pathSpec);
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
    pathSpec: string
  ): Promise<ResolveFolderOutcome> {
    const segments = getPathSegments(pathSpec);
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
      const { targetPath } = extractPathInfo(query.config);
      results[query.queryId] = { isValid: false, status: 'option_not_found', targetPath };
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
    const { targetPath } = extractPathInfo(query.config);

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
          status: 'timeout',
          targetPath,
        };
      }
      return {
        isValid: false,
        status: 'error',
        targetPath,
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
    const { pathSpec, targetPath } = extractPathInfo(query.config);

    if (query.valueToValidate.trim() === '') {
      return { isValid: false, status: 'option_not_found', targetPath };
    }

    if (!isGoogleDriveDynamicConfig(query.config)) {
      return { isValid: false, status: 'option_not_found', targetPath };
    }

    if (!spaceId) {
      return { isValid: false, status: 'missing_space', targetPath };
    }

    const outcome = await this.resolveTargetFolder(spaceId, pathSpec);
    if (!outcome.success) {
      return { isValid: false, status: outcome.status, targetPath };
    }

    let pageToken: string | undefined;
    let matchCount = 0;

    do {
      const result = await this.driveClient.listFolders({
        parentFolderId: outcome.folderId,
        name: query.valueToValidate,
        pageSize: 100,
        ...(pageToken !== undefined ? { pageToken } : {}),
      });

      for (const folder of result.folders) {
        if (folder.name === query.valueToValidate) {
          matchCount++;
          if (matchCount >= 2) {
            return { isValid: false, status: 'ambiguous_option', targetPath };
          }
        }
      }

      pageToken = result.nextPageToken;
    } while (pageToken);

    if (matchCount === 1) {
      return { isValid: true, status: 'valid', targetPath };
    }

    if (matchCount === 0) {
      if (query.allowUserInput === true) {
        return { isValid: true, status: 'valid', targetPath };
      }
      return { isValid: false, status: 'option_not_found', targetPath };
    }

    return { isValid: false, status: 'ambiguous_option', targetPath };
  }
}

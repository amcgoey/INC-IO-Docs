import type {
  DriveOptionSourcePort,
  LookupDocumentSchema,
  LookupFieldOptions,
  LookupFieldValidationQuery,
  LookupFieldValidationResult,
  LookupInvalidationScope,
  LookupManifestPort,
  LookupMatchResult,
  LookupOptionItem,
  LookupOptionsCallContext,
  LookupOptionsPort,
  LookupOptionSource,
  LookupOptionTuple,
  LookupSourceResolution,
  LookupSpaceContext,
} from './ports';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_DRIVE_DYNAMIC_OPTIONS = 150;

function extractTargetPath(relativePath?: string): string {
  if (typeof relativePath !== 'string') {
    return 'root';
  }
  const trimmed = relativePath.trim().replace(/^\/+|\/+$/g, '');
  return trimmed.length > 0 ? trimmed : 'root';
}

function getSpaceStorageId(space?: LookupSpaceContext): string | undefined {
  const raw = space?.abstractStorageId ?? space?.id;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readTupleProperty(tuple: LookupOptionTuple, prop: string): string | undefined {
  const value = tuple[prop];
  if (value === undefined || value === null) {
    return undefined;
  }
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function deduplicateTuplesByKey(
  tuples: readonly LookupOptionTuple[],
  keyProp: string
): { uniqueTuples: LookupOptionTuple[]; duplicateNormalizedKeys: Set<string> } {
  const uniqueTuples: LookupOptionTuple[] = [];
  const seenKeys = new Set<string>();
  const duplicateNormalizedKeys = new Set<string>();

  for (const tuple of tuples) {
    const keyVal = readTupleProperty(tuple, keyProp);
    if (!keyVal) {
      uniqueTuples.push(tuple);
      continue;
    }
    const normKey = keyVal.toLowerCase();
    if (seenKeys.has(normKey)) {
      duplicateNormalizedKeys.add(normKey);
      continue;
    }
    seenKeys.add(normKey);
    uniqueTuples.push(tuple);
  }

  return { uniqueTuples, duplicateNormalizedKeys };
}

/**
 * Formats option tuples into UI `SelectionItem` entries using `name` when configured else `key`,
 * appending `" (KEY)"` only when multiple distinct keys share the same display name.
 */
export function formatLookupOptionItems(
  tuples: readonly LookupOptionTuple[],
  fieldOptions?: Pick<LookupFieldOptions, 'key' | 'name'>
): LookupOptionItem[] {
  const { key: keyProp = 'key', name: nameProp } = fieldOptions ?? {};

  const entries = tuples.map((tuple) => {
    const keyVal = readTupleProperty(tuple, keyProp) ?? '';
    const displayVal =
      nameProp !== undefined
        ? (readTupleProperty(tuple, nameProp) ?? keyVal)
        : keyVal;
    return { keyVal, displayVal };
  });

  const keysByNormalizedDisplay = new Map<string, Set<string>>();
  for (const entry of entries) {
    const normDisplay = entry.displayVal.toLowerCase();
    let keys = keysByNormalizedDisplay.get(normDisplay);
    if (!keys) {
      keys = new Set<string>();
      keysByNormalizedDisplay.set(normDisplay, keys);
    }
    keys.add(entry.keyVal.toLowerCase());
  }

  return entries.map(({ keyVal, displayVal }) => {
    const distinctCount = keysByNormalizedDisplay.get(displayVal.toLowerCase())?.size ?? 0;
    const text = distinctCount > 1 && keyVal.length > 0 ? `${displayVal} (${keyVal})` : displayVal;
    return { text, value: keyVal };
  });
}

/**
 * Matches a candidate string against option tuples:
 * 1) trimmed case-insensitive `key` first,
 * 2) trimmed case-insensitive `name` only when `options.name` is configured,
 * 3) formatted `"Name (KEY)"` label when `options.name` is configured and duplicate display names exist.
 */
export function matchLookupTuple(
  tuples: readonly LookupOptionTuple[],
  candidate: string,
  fieldOptions?: Pick<LookupFieldOptions, 'key' | 'name'>
): LookupMatchResult {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return { matched: false };
  }

  const normalized = trimmed.toLowerCase();
  const { key: keyProp = 'key', name: nameProp } = fieldOptions ?? {};

  for (const tuple of tuples) {
    const keyVal = readTupleProperty(tuple, keyProp);
    if (keyVal !== undefined && keyVal.toLowerCase() === normalized) {
      return { matched: true, key: keyVal, tuple };
    }
  }

  if (nameProp !== undefined) {
    for (const tuple of tuples) {
      const nameVal = readTupleProperty(tuple, nameProp);
      if (nameVal !== undefined && nameVal.toLowerCase() === normalized) {
        const keyVal = readTupleProperty(tuple, keyProp) ?? nameVal;
        return { matched: true, key: keyVal, tuple };
      }
    }

    const formattedItems = formatLookupOptionItems(tuples, fieldOptions);
    for (let i = 0; i < formattedItems.length; i++) {
      if (formattedItems[i].text.trim().toLowerCase() === normalized) {
        const tuple = tuples[i];
        const keyVal = readTupleProperty(tuple, keyProp) ?? formattedItems[i].value;
        return { matched: true, key: keyVal, tuple };
      }
    }
  }

  return { matched: false };
}

interface InternalSourceResolution {
  resolution: LookupSourceResolution;
  duplicateNormalizedKeys: Set<string>;
  truncated: boolean;
  optionSource?: LookupOptionSource | undefined;
}

export interface LookupOptionsServiceDeps {
  driveOptionSource?: DriveOptionSourcePort | undefined;
  timeoutMs?: number | undefined;
}

export class LookupOptionsService implements LookupOptionsPort {
  private readonly timeoutMs: number;
  private readonly schemaCache = new Map<string, Promise<LookupDocumentSchema | undefined>>();
  private readonly sourceCache = new Map<string, Promise<InternalSourceResolution>>();
  private readonly validationCache = new Map<string, Promise<LookupFieldValidationResult>>();

  constructor(
    private readonly manifestPort: LookupManifestPort,
    private readonly deps?: LookupOptionsServiceDeps
  ) {
    this.timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  invalidate(scope?: LookupInvalidationScope): void {
    if (!scope || (!scope.spaceId && !scope.documentTypeKey && !scope.selectedLogId)) {
      this.sourceCache.clear();
      this.validationCache.clear();
      this.schemaCache.clear();
      return;
    }

    const scopeSpace = scope.spaceId?.trim() ?? '';
    const scopeDocType = scope.documentTypeKey?.trim() ?? '';
    const scopeLogId = scope.selectedLogId?.trim() ?? '';

    const matchesScope = (key: string): boolean => {
      const [keySpace, keyDocType, keyLogId] = key.split('::');
      const spaceMatches = !scopeSpace || keySpace === scopeSpace;
      const docTypeMatches = !scopeDocType || keyDocType === scopeDocType;
      const logMatches = !scopeLogId || keyLogId === scopeLogId;
      return spaceMatches && docTypeMatches && logMatches;
    };

    for (const key of this.sourceCache.keys()) {
      if (matchesScope(key)) {
        this.sourceCache.delete(key);
      }
    }
    for (const key of this.validationCache.keys()) {
      if (matchesScope(key)) {
        this.validationCache.delete(key);
      }
    }

    if (scopeDocType) {
      this.schemaCache.delete(scopeDocType);
    }
  }

  async resolveOptions(
    context: LookupOptionsCallContext,
    sourceKeys?: readonly string[]
  ): Promise<Record<string, LookupSourceResolution>> {
    const schema = await this.getSchema(context.documentTypeKey);
    if (!schema) {
      return {};
    }

    const requestedKeys =
      sourceKeys && sourceKeys.length > 0
        ? Array.from(new Set(sourceKeys))
        : Array.from(
            new Set([
              ...Object.keys(schema.options ?? {}),
              ...Object.keys(schema.optionSources ?? {}),
            ])
          );

    const results: Record<string, LookupSourceResolution> = {};
    await Promise.allSettled(
      requestedKeys.map(async (sourceKey) => {
        const internal = await this.resolveSingleSource(context, schema, sourceKey);
        // nosemgrep: domain-pass-through-read
        results[sourceKey] = internal.resolution;
      })
    );

    return results;
  }

  async getCanonicalOptions(
    context: LookupOptionsCallContext,
    fieldKey: string
  ): Promise<LookupOptionTuple[]> {
    const schema = await this.getSchema(context.documentTypeKey);
    const field = schema?.fields.find((f) => f.key === fieldKey);
    if (!schema || !field?.options) {
      return [];
    }

    const internal = await this.resolveSingleSource(context, schema, field.options.source);
    if (internal.resolution.status !== 'ready') {
      return [];
    }

    return internal.resolution.tuples;
  }

  async matchOption(
    context: LookupOptionsCallContext,
    fieldKey: string,
    candidate: string
  ): Promise<LookupMatchResult> {
    const schema = await this.getSchema(context.documentTypeKey);
    const field = schema?.fields.find((f) => f.key === fieldKey);
    if (!schema || !field?.options) {
      return { matched: false };
    }

    const internal = await this.resolveSingleSource(context, schema, field.options.source);
    if (internal.resolution.status !== 'ready') {
      return { matched: false };
    }

    return matchLookupTuple(internal.resolution.tuples, candidate, field.options);
  }

  async validateFields(
    context: LookupOptionsCallContext,
    queries: readonly LookupFieldValidationQuery[]
  ): Promise<Record<string, LookupFieldValidationResult>> {
    const schema = await this.getSchema(context.documentTypeKey);
    const results: Record<string, LookupFieldValidationResult> = {};

    await Promise.allSettled(
      queries.map(async (query) => {
        results[query.queryId] = await this.validateSingleField(context, schema, query);
      })
    );

    return results;
  }

  private async validateSingleField(
    context: LookupOptionsCallContext,
    schema: LookupDocumentSchema | undefined,
    query: LookupFieldValidationQuery
  ): Promise<LookupFieldValidationResult> {
    const optionSource = schema?.optionSources?.[query.sourceKey];
    const targetPath =
      optionSource?.provider === 'google_drive'
        ? extractTargetPath(optionSource.relativePath)
        : undefined;

    if (query.value.trim().length === 0) {
      return {
        isValid: false,
        status: 'option_not_found',
        ...(targetPath !== undefined ? { targetPath } : {}),
      };
    }

    if (!schema) {
      return {
        isValid: false,
        status: 'config_error',
        ...(targetPath !== undefined ? { targetPath } : {}),
      };
    }

    const field = schema.fields.find((f) => f.key === query.fieldKey);
    const fieldOptions = field?.options ?? { source: query.sourceKey, key: 'key' };
    const allowUserInput = query.allowUserInput ?? field?.options?.allowUserInput ?? false;

    const spaceStorageId = getSpaceStorageId(context.space) ?? '';
    const docKey = context.documentTypeKey.trim();
    const selectedLogId = context.selectedLogId?.trim() ?? '';
    const sourceCacheKey = `${spaceStorageId}::${docKey}::${selectedLogId}::${query.sourceKey}`;

    if (
      optionSource?.provider === 'google_drive' &&
      !this.sourceCache.has(sourceCacheKey) &&
      this.deps?.driveOptionSource?.validateFolderExistence
    ) {
      if (optionSource.method !== undefined && optionSource.method !== 'list_folders') {
        return {
          isValid: false,
          status: 'config_error',
          ...(targetPath !== undefined ? { targetPath } : {}),
        };
      }
      if (!spaceStorageId) {
        return {
          isValid: false,
          status: 'missing_space',
          ...(targetPath !== undefined ? { targetPath } : {}),
        };
      }
      const valCacheKey = `${sourceCacheKey}::${query.value.trim().toLowerCase()}::${String(allowUserInput)}`;
      let cachedValidation = this.validationCache.get(valCacheKey);
      if (!cachedValidation) {
        cachedValidation = this.runWithTimeout<LookupFieldValidationResult>(
          () =>
            this.deps!.driveOptionSource!.validateFolderExistence!({
              spaceStorageId,
              relativePath: optionSource.relativePath,
              value: query.value,
              allowUserInput,
            }),
          () => ({
            isValid: false,
            status: 'timeout',
            ...(targetPath !== undefined ? { targetPath } : {}),
          }),
          () => ({
            isValid: false,
            status: 'error',
            ...(targetPath !== undefined ? { targetPath } : {}),
          })
        ).catch((error) => {
          this.validationCache.delete(valCacheKey);
          throw error;
        });
        this.validationCache.set(valCacheKey, cachedValidation);
      }
      return cachedValidation;
    }

    const internal = await this.resolveSingleSource(context, schema, query.sourceKey);
    const { resolution, duplicateNormalizedKeys, truncated } = internal;

    if (
      resolution.status === 'missing_space' ||
      resolution.status === 'path_not_found' ||
      resolution.status === 'ambiguous_path' ||
      resolution.status === 'missing_log' ||
      resolution.status === 'ambiguous_log' ||
      resolution.status === 'config_error' ||
      resolution.status === 'timeout' ||
      resolution.status === 'error'
    ) {
      return {
        isValid: false,
        status: resolution.status,
        ...(resolution.targetPath !== undefined ? { targetPath: resolution.targetPath } : {}),
      };
    }

    const match = matchLookupTuple(resolution.tuples, query.value, fieldOptions);
    if (match.matched && match.key !== undefined) {
      if (duplicateNormalizedKeys.has(match.key.trim().toLowerCase())) {
        return {
          isValid: false,
          status: 'ambiguous_option',
          ...(resolution.targetPath !== undefined ? { targetPath: resolution.targetPath } : {}),
        };
      }
      return {
        isValid: true,
        status: 'valid',
        ...(resolution.targetPath !== undefined ? { targetPath: resolution.targetPath } : {}),
        ...(match.tuple !== undefined ? { matchedTuple: match.tuple } : {}),
        canonicalValue: match.key,
      };
    }

    if (
      truncated &&
      optionSource?.provider === 'google_drive' &&
      this.deps?.driveOptionSource?.validateFolderExistence
    ) {
      const spaceStorageId = getSpaceStorageId(context.space);
      if (spaceStorageId) {
        return this.runWithTimeout<LookupFieldValidationResult>(
          () =>
            this.deps!.driveOptionSource!.validateFolderExistence!({
              spaceStorageId,
              relativePath: optionSource.relativePath,
              value: query.value,
              allowUserInput,
            }),
          () => ({
            isValid: false,
            status: 'timeout',
            ...(resolution.targetPath !== undefined ? { targetPath: resolution.targetPath } : {}),
          }),
          () => ({
            isValid: false,
            status: 'error',
            ...(resolution.targetPath !== undefined ? { targetPath: resolution.targetPath } : {}),
          })
        );
      }
    }

    if (allowUserInput) {
      return {
        isValid: true,
        status: 'valid',
        ...(resolution.targetPath !== undefined ? { targetPath: resolution.targetPath } : {}),
      };
    }

    return {
      isValid: false,
      status: 'option_not_found',
      ...(resolution.targetPath !== undefined ? { targetPath: resolution.targetPath } : {}),
    };
  }

  private getSchema(documentTypeKey: string): Promise<LookupDocumentSchema | undefined> {
    const trimmedKey = documentTypeKey.trim();
    let cached = this.schemaCache.get(trimmedKey);
    if (!cached) {
      cached = Promise.resolve(this.manifestPort.getDocumentSchema(trimmedKey)).catch((error) => {
        this.schemaCache.delete(trimmedKey);
        throw error;
      });
      this.schemaCache.set(trimmedKey, cached);
    }
    return cached;
  }

  private resolveSingleSource(
    context: LookupOptionsCallContext,
    schema: LookupDocumentSchema,
    sourceKey: string
  ): Promise<InternalSourceResolution> {
    const spaceStorageId = getSpaceStorageId(context.space) ?? '';
    const docKey = context.documentTypeKey.trim();
    const selectedLogId = context.selectedLogId?.trim() ?? '';
    const cacheKey = `${spaceStorageId}::${docKey}::${selectedLogId}::${sourceKey}`;

    let cached = this.sourceCache.get(cacheKey);
    if (!cached) {
      cached = this.executeResolveSingleSource(context, schema, sourceKey, spaceStorageId).catch(
        (error) => {
          this.sourceCache.delete(cacheKey);
          throw error;
        }
      );
      this.sourceCache.set(cacheKey, cached);
    }

    return cached;
  }

  private async executeResolveSingleSource(
    _context: LookupOptionsCallContext,
    schema: LookupDocumentSchema,
    sourceKey: string,
    spaceStorageId: string
  ): Promise<InternalSourceResolution> {
    const fieldForSource = schema.fields.find((f) => f.options?.source === sourceKey);
    const keyProp = fieldForSource?.options?.key ?? 'key';
    const staticTuples = schema.options?.[sourceKey];

    if (staticTuples !== undefined) {
      const { uniqueTuples, duplicateNormalizedKeys } = deduplicateTuplesByKey(
        staticTuples,
        keyProp
      );
      const items = formatLookupOptionItems(uniqueTuples, fieldForSource?.options);
      return {
        resolution: {
          status: uniqueTuples.length > 0 ? 'ready' : 'empty',
          tuples: uniqueTuples,
          items,
        },
        duplicateNormalizedKeys,
        truncated: false,
      };
    }

    const optionSource = schema.optionSources?.[sourceKey];
    if (!optionSource) {
      return {
        resolution: { status: 'config_error', tuples: [], items: [] },
        duplicateNormalizedKeys: new Set(),
        truncated: false,
      };
    }

    if (optionSource.provider === 'google_drive') {
      const targetPath = extractTargetPath(optionSource.relativePath);
      if (optionSource.method !== undefined && optionSource.method !== 'list_folders') {
        return {
          resolution: { status: 'config_error', tuples: [], items: [], targetPath },
          duplicateNormalizedKeys: new Set(),
          truncated: false,
          optionSource,
        };
      }
      if (!spaceStorageId) {
        return {
          resolution: { status: 'missing_space', tuples: [], items: [], targetPath },
          duplicateNormalizedKeys: new Set(),
          truncated: false,
          optionSource,
        };
      }
      if (!this.deps?.driveOptionSource) {
        return {
          resolution: { status: 'error', tuples: [], items: [], targetPath },
          duplicateNormalizedKeys: new Set(),
          truncated: false,
          optionSource,
        };
      }

      return this.runWithTimeout<InternalSourceResolution>(
        async () => {
          const outcome = await this.deps!.driveOptionSource!.listFoldersAtPath({
            spaceStorageId,
            relativePath: optionSource.relativePath,
            maxItems: MAX_DRIVE_DYNAMIC_OPTIONS,
          });
          if (outcome.status === 'empty') {
            return {
              resolution: { status: 'empty', tuples: [], items: [], targetPath: outcome.targetPath },
              duplicateNormalizedKeys: new Set(),
              truncated: Boolean(outcome.truncated),
              optionSource,
            };
          }
          if (outcome.status !== 'ready') {
            return {
              resolution: { status: outcome.status, tuples: [], items: [], targetPath: outcome.targetPath },
              duplicateNormalizedKeys: new Set(),
              truncated: false,
              optionSource,
            };
          }
          if (outcome.items.length === 0) {
            return {
              resolution: { status: 'empty', tuples: [], items: [], targetPath: outcome.targetPath },
              duplicateNormalizedKeys: new Set(),
              truncated: Boolean(outcome.truncated),
              optionSource,
            };
          }
          const { uniqueTuples, duplicateNormalizedKeys } = deduplicateTuplesByKey(
            outcome.items,
            keyProp
          );
          const items = formatLookupOptionItems(uniqueTuples, fieldForSource?.options);
          return {
            resolution: {
              status: 'ready',
              tuples: uniqueTuples,
              items,
              targetPath: outcome.targetPath,
            },
            duplicateNormalizedKeys,
            truncated: Boolean(outcome.truncated),
            optionSource,
          };
        },
        () => ({
          resolution: { status: 'timeout', tuples: [], items: [], targetPath },
          duplicateNormalizedKeys: new Set(),
          truncated: false,
          optionSource,
        }),
        () => ({
          resolution: { status: 'error', tuples: [], items: [], targetPath },
          duplicateNormalizedKeys: new Set(),
          truncated: false,
          optionSource,
        })
      );
    }

    // document_log OptionSource will be wired in Ticket #358
    return {
      resolution: { status: 'config_error', tuples: [], items: [] },
      duplicateNormalizedKeys: new Set(),
      truncated: false,
      optionSource,
    };
  }

  private async runWithTimeout<T>(
    operation: () => Promise<T>,
    onTimeout: () => T,
    onError: () => T
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error(`LookupOptions operation timed out after ${this.timeoutMs}ms`);

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(timeoutError);
      }, this.timeoutMs);
    });

    const opPromise = operation();
    opPromise.catch(() => {});

    try {
      return await Promise.race([opPromise, timeoutPromise]);
    } catch (error) {
      if (error === timeoutError) {
        return onTimeout();
      }
      return onError();
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

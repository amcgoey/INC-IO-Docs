import {
  DocumentLogAmbiguousError,
  DocumentLogConfigurationError,
  DocumentLogMissingError,
  type CopyDocumentLogResult,
  type DocumentLogEntry,
  type DocumentLogOptionBinding,
  type DocumentLogOptionTableSourceResult,
  type DocumentLogPort,
  type DocumentLogSchema,
  type DocumentLogSpace,
  type DocumentLogUiCandidateOption,
  type DocumentLogUiContextResult,
  type DocumentLogUiHistoryEntry,
  type DocumentLogUiReadStatus,
  type LogCellPrimitive,
  type LogDiscoveryFileMetadata,
  type LogDiscoveryPort,
  type LogFilterBy,
  type LogResolutionCandidate,
  type LogResolutionResult,
  type LogSchemaRegistryPort,
  type LogStoragePort,
  type LogTargetDocumentOptionTuple,
  type LogTargetDocumentSchema,
  type LogTemplateEvaluatorPort,
  type LogTemplateParserPort,
  type QueryDocumentLogUiContextRequest,
  type ReadDocumentLogRequest,
  type ReadDocumentLogResult,
  type ReadNamedRangeEntry,
  type ReadOptionTablesRequest,
  type ReadOptionTablesResult,
  type RowHydrationWarning,
  type WriteDocumentLogRequest,
  type WriteDocumentLogResult,
} from './ports';
import {
  buildLogRowHydrator,
  buildRowKeyExtractor,
  computeTargetRowKeys,
  enrichDocumentData,
  extractFormIdGroup,
  formatHistoryDisplayEntry,
  mapDocumentToLogRow,
} from './row-mapper';

const GOOGLE_SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const MAX_PARENT_CHAIN_DEPTH = 10;

function splitFolderPath(preferredFolderPath: string): string[] {
  return preferredFolderPath
    .split(/[/\\]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function parseTimestampMs(modifiedTime?: string): number | undefined {
  if (!modifiedTime || modifiedTime.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(modifiedTime);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Ranks ambiguous DocumentLog candidates by:
 * 1) Membership in preferredFolderId,
 * 2) Case-insensitive exact match against rendered copyNameTemplate,
 * 3) Newest valid modifiedTime descending (missing/unparseable timestamps last),
 * 4) Deterministic candidate id.localeCompare tiebreak.
 */
function rankAmbiguousCandidates(params: {
  candidates: readonly LogResolutionCandidate[];
  preferredFolderId: string | undefined;
  expectedCopyName: string;
}): LogResolutionCandidate[] {
  const { candidates, preferredFolderId, expectedCopyName } = params;
  const expectedLower = expectedCopyName.toLowerCase();

  return [...candidates].sort((a, b) => {
    const aInPreferred = preferredFolderId !== undefined && (a.parents?.includes(preferredFolderId) ?? false);
    const bInPreferred = preferredFolderId !== undefined && (b.parents?.includes(preferredFolderId) ?? false);
    if (aInPreferred !== bInPreferred) {
      return aInPreferred ? -1 : 1;
    }

    const aExactName = a.name.toLowerCase() === expectedLower;
    const bExactName = b.name.toLowerCase() === expectedLower;
    if (aExactName !== bExactName) {
      return aExactName ? -1 : 1;
    }

    const aTime = parseTimestampMs(a.modifiedTime);
    const bTime = parseTimestampMs(b.modifiedTime);
    if (aTime !== undefined && bTime !== undefined) {
      if (aTime !== bTime) {
        return bTime - aTime;
      }
    } else if (aTime !== undefined) {
      return -1;
    } else if (bTime !== undefined) {
      return 1;
    }

    return a.id.localeCompare(b.id);
  });
}

function filterCandidatesByConfig(
  candidates: readonly LogResolutionCandidate[],
  fileNameContains: string,
  excludePrefixes: readonly string[],
  excludeSubstrings: readonly string[]
): LogResolutionCandidate[] {
  const normalizedContains = fileNameContains.toLowerCase();
  const normalizedPrefixes = excludePrefixes.map((p) => p.toLowerCase());
  const normalizedSubstrings = excludeSubstrings.map((s) => s.toLowerCase());

  return candidates.filter((candidate) => {
    const lowerName = candidate.name.toLowerCase();
    if (!lowerName.includes(normalizedContains)) {
      return false;
    }
    if (normalizedPrefixes.some((prefix) => lowerName.startsWith(prefix))) {
      return false;
    }
    if (normalizedSubstrings.some((substring) => lowerName.includes(substring))) {
      return false;
    }
    return true;
  });
}

/**
 * Creates a per-resolveLog-call memoized metadata lookup that treats unreadable ancestors as null.
 */
function createPerCallGetFileMemo(
  getFile: (fileId: string) => Promise<LogDiscoveryFileMetadata>
): (fileId: string) => Promise<LogDiscoveryFileMetadata | null> {
  const cache = new Map<string, Promise<LogDiscoveryFileMetadata | null>>();
  return (fileId: string): Promise<LogDiscoveryFileMetadata | null> => {
    const existing = cache.get(fileId);
    if (existing) {
      return existing;
    }
    const pending = Promise.resolve()
      .then(() => getFile(fileId))
      .catch(() => null);
    cache.set(fileId, pending);
    return pending;
  };
}

/**
 * Walks parent folder IDs via bounded BFS (up to MAX_PARENT_CHAIN_DEPTH intermediate folders)
 * to determine whether a candidate belongs under rootFolderId.
 */
async function isDescendantOfRoot(
  initialParents: readonly string[] | undefined,
  rootFolderId: string,
  getFile: (fileId: string) => Promise<LogDiscoveryFileMetadata | null>
): Promise<boolean> {
  if (!initialParents || initialParents.length === 0) {
    return false;
  }

  const visited = new Set<string>();
  const queue: Array<{ folderId: string; depth: number }> = [];

  for (const parentId of initialParents) {
    if (parentId === rootFolderId) {
      return true;
    }
    // 'root' is My Drive's terminal root and has no parents above it.
    if (parentId === 'root' || visited.has(parentId)) {
      continue;
    }
    visited.add(parentId);
    queue.push({ folderId: parentId, depth: 1 });
  }

  let head = 0;
  while (head < queue.length) {
    const { folderId, depth } = queue[head++];
    if (depth > MAX_PARENT_CHAIN_DEPTH) {
      continue;
    }

    const folderMeta = await getFile(folderId);
    if (!folderMeta?.parents || folderMeta.parents.length === 0) {
      continue;
    }

    for (const parentId of folderMeta.parents) {
      if (parentId === rootFolderId) {
        return true;
      }
      if (parentId === 'root' || visited.has(parentId) || depth >= MAX_PARENT_CHAIN_DEPTH) {
        continue;
      }
      visited.add(parentId);
      queue.push({ folderId: parentId, depth: depth + 1 });
    }
  }

  return false;
}

function buildCandidateUrl(candidate: LogResolutionCandidate): string {
  const link = candidate.webViewLink?.trim();
  return link && link.length > 0
    ? link
    : `https://docs.google.com/spreadsheets/d/${candidate.id}/edit`;
}

function formatCandidateDate(modifiedTime?: string): string | undefined {
  const ms = parseTimestampMs(modifiedTime);
  if (ms === undefined) {
    return undefined;
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function formatCandidateOptionLabel(candidate: LogResolutionCandidate): string {
  const folder = candidate.parentFolderName?.trim();
  const date = formatCandidateDate(candidate.modifiedTime);
  const metaParts: string[] = [];
  if (folder && folder.length > 0) {
    metaParts.push(folder);
  }
  if (date) {
    metaParts.push(date);
  }
  return metaParts.length > 0 ? `${candidate.name} (${metaParts.join(' · ')})` : candidate.name;
}

function formatReadErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.trim() : String(error).trim();
  return raw.length > 0 ? raw : 'Unable to read Document Log history right now.';
}

function cellToTrimmedString(cell: LogCellPrimitive | undefined): string {
  if (cell === null || cell === undefined) {
    return '';
  }
  return String(cell).trim();
}

function parseOptionTableEntry(
  sourceKey: string,
  binding: DocumentLogOptionBinding,
  entry: ReadNamedRangeEntry | undefined
): DocumentLogOptionTableSourceResult {
  if (!entry || entry.status === 'missing_range') {
    return {
      status: 'config_error',
      tuples: [],
      errorMessage:
        entry?.errorMessage ??
        `Named range "${binding.rangeName}" not found on sheet "${binding.sheetName}".`,
    };
  }

  const { values: rows } = entry;
  if (rows.length === 0) {
    return {
      status: 'config_error',
      tuples: [],
      errorMessage: `Option table "${binding.rangeName}" on sheet "${binding.sheetName}" is missing headers and endMarker "${binding.endMarker}".`,
    };
  }

  const headerRow = rows[0] ?? [];
  const headerIndexMap = new Map<string, number>();
  headerRow.forEach((cell, idx) => {
    const headerName = cellToTrimmedString(cell);
    if (headerName.length > 0 && !headerIndexMap.has(headerName)) {
      headerIndexMap.set(headerName, idx);
    }
  });

  const columnEntries: Array<{ colIdx: number; propName: string }> = [];
  for (const [sheetHeader, propName] of Object.entries(binding.columns)) {
    const colIdx = headerIndexMap.get(sheetHeader.trim());
    if (colIdx === undefined) {
      return {
        status: 'config_error',
        tuples: [],
        errorMessage: `Option table "${binding.rangeName}" (${sourceKey}) is missing required header "${sheetHeader}".`,
      };
    }
    columnEntries.push({ colIdx, propName });
  }

  const keyColumnEntry =
    columnEntries.find((c) => c.propName === 'key') ?? columnEntries[0];
  const keyColIdx = keyColumnEntry !== undefined ? keyColumnEntry.colIdx : undefined;
  const dedupProp = keyColumnEntry !== undefined ? keyColumnEntry.propName : 'key';

  let terminatorIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const col0Text = cellToTrimmedString(row[0]);
    const keyColText = keyColIdx !== undefined ? cellToTrimmedString(row[keyColIdx]) : '';
    if (col0Text === binding.endMarker || keyColText === binding.endMarker) {
      terminatorIndex = i;
      break;
    }
  }

  if (terminatorIndex === -1) {
    return {
      status: 'config_error',
      tuples: [],
      errorMessage: `Option table "${binding.rangeName}" on sheet "${binding.sheetName}" is missing endMarker "${binding.endMarker}".`,
    };
  }

  const tuples: LogTargetDocumentOptionTuple[] = [];
  const seenKeys = new Set<string>();

  for (let i = 1; i < terminatorIndex; i++) {
    const row = rows[i] ?? [];
    const isEntireRowBlank = row.every((cell) => cellToTrimmedString(cell) === '');
    if (isEntireRowBlank) {
      continue;
    }

    const tuple: LogTargetDocumentOptionTuple = {};
    let hasNonBlankMapped = false;
    for (const { colIdx, propName } of columnEntries) {
      const value = cellToTrimmedString(colIdx < row.length ? row[colIdx] : undefined);
      if (value.length > 0) {
        hasNonBlankMapped = true;
      }
      tuple[propName] = value;
    }

    if (!hasNonBlankMapped) {
      continue;
    }

    const rawKey = typeof tuple[dedupProp] === 'string' ? tuple[dedupProp].trim() : '';
    if (rawKey.length === 0) {
      continue;
    }

    const normalizedKey = rawKey.toLowerCase();
    if (seenKeys.has(normalizedKey)) {
      continue;
    }
    seenKeys.add(normalizedKey);
    tuples.push(tuple);
  }

  return {
    status: 'ready',
    tuples,
  };
}

export interface DocumentLogServiceOptions {
  memoizeResolvePerInstance?: boolean | undefined;
}

/**
 * Core domain service managing live DocumentLog discovery and Document dehydration/write orchestration.
 */
export class DocumentLogService implements DocumentLogPort {
  private readonly resolveLogMemo: Map<string, Promise<LogResolutionResult>> | undefined;
  private readonly optionTablesMemo:
    | Map<string, Record<string, DocumentLogOptionTableSourceResult>>
    | undefined;

  constructor(
    private readonly schemaRegistry: LogSchemaRegistryPort,
    private readonly logDiscovery: LogDiscoveryPort,
    private readonly logStorage: LogStoragePort,
    private readonly templateEvaluator: LogTemplateEvaluatorPort,
    private readonly templateParser?: LogTemplateParserPort,
    options?: DocumentLogServiceOptions
  ) {
    this.resolveLogMemo = options?.memoizeResolvePerInstance ? new Map() : undefined;
    this.optionTablesMemo = options?.memoizeResolvePerInstance ? new Map() : undefined;
  }

  private resolveTemplateParser(): LogTemplateParserPort {
    if (this.templateParser) {
      return this.templateParser;
    }
    const candidate = this.templateEvaluator as Partial<LogTemplateParserPort>;
    if (typeof candidate.parseMustacheTemplate === 'function') {
      return candidate as LogTemplateParserPort;
    }
    throw new DocumentLogConfigurationError(
      'DocumentLogService requires a LogTemplateParserPort to parse idGroup and historyDisplay templates.'
    );
  }

  private async loadUiHistoryContext(params: {
    documentTypeKey: string;
    activeCandidateId: string;
    formData?: Readonly<Record<string, unknown>> | undefined;
  }): Promise<{
    readStatus: DocumentLogUiReadStatus;
    idGroup?: string | undefined;
    missingIdFields?: string[] | undefined;
    readErrorMessage?: string | undefined;
    warningMessages?: string[] | undefined;
    entries?: DocumentLogUiHistoryEntry[] | undefined;
  }> {
    const { documentTypeKey, activeCandidateId, formData } = params;
    const { logSchema, targetSchema } = this.requireSchemasForDocumentType(documentTypeKey);
    const templateParser = this.resolveTemplateParser();

    const idGroupExtraction = extractFormIdGroup({
      documentTypeKey,
      formData,
      targetSchema,
      templateParser,
      templateEvaluator: this.templateEvaluator,
    });

    if (!idGroupExtraction.complete) {
      return {
        readStatus: 'idle_incomplete_id',
        missingIdFields: idGroupExtraction.missingIdFields,
      };
    }

    const { idGroup } = idGroupExtraction;
    try {
      const readResult = await this.readLog({
        documentTypeKey,
        selectedLogId: activeCandidateId,
        filterBy: 'idGroup',
        values: [idGroup],
      });

      const orderedEntries =
        logSchema.grouping.rowSortOrder === 'desc'
          ? [...readResult.entries]
          : [...readResult.entries].reverse();

      const entries = orderedEntries.map((entry) =>
        formatHistoryDisplayEntry({
          entry,
          logSchema,
          templateParser,
        })
      );

      if (readResult.warnings.length > 0) {
        return {
          readStatus: 'partial_hydration',
          idGroup,
          warningMessages: readResult.warnings.map((w) => `Row ${w.rowNumber}: ${w.message}`),
          entries,
        };
      }

      return {
        readStatus: 'ready',
        idGroup,
        entries,
      };
    } catch (error) {
      if (error instanceof DocumentLogConfigurationError) {
        throw error;
      }
      return {
        readStatus: 'read_error',
        idGroup,
        readErrorMessage: formatReadErrorMessage(error),
      };
    }
  }

  requiresDocumentLog(documentTypeKey: string): boolean {
    const trimmed = typeof documentTypeKey === 'string' ? documentTypeKey.trim() : '';
    if (trimmed.length === 0) {
      return false;
    }
    return this.schemaRegistry.getDocumentLogSchema(trimmed) !== undefined;
  }

  async queryUiContext(
    request: QueryDocumentLogUiContextRequest
  ): Promise<DocumentLogUiContextResult | undefined> {
    if (!request.documentTypeKey || !this.requiresDocumentLog(request.documentTypeKey)) {
      return undefined;
    }

    if (!request.space) {
      return { status: 'missing_space' };
    }

    let resolution: LogResolutionResult;
    try {
      resolution = await this.resolveLog(request.space);
    } catch (error) {
      if (error instanceof DocumentLogConfigurationError) {
        throw error;
      }
      return {
        status: 'discovery_error',
        spaceName: request.space.name,
        discoveryErrorMessage: error instanceof Error ? error.message : String(error),
      };
    }

    const discoveryConfig = this.schemaRegistry.getDiscoveryConfig(request.space.typeId);

    if (resolution.status === 'missing') {
      const targetFileName = discoveryConfig
        ? this.templateEvaluator.evaluate(discoveryConfig.copyNameTemplate, {
            DocumentSpace: request.space,
          })
        : undefined;
      return {
        status: 'missing',
        spaceName: request.space.name,
        targetFolderPath: resolution.expectedFolderPath,
        ...(targetFileName !== undefined ? { targetFileName } : {}),
      };
    }

    if (resolution.status === 'resolved') {
      const historyContext = await this.loadUiHistoryContext({
        documentTypeKey: request.documentTypeKey,
        activeCandidateId: resolution.candidate.id,
        formData: request.formData,
      });

      return {
        status: 'resolved',
        spaceName: request.space.name,
        activeCandidate: {
          name: resolution.candidate.name,
          url: buildCandidateUrl(resolution.candidate),
        },
        ...historyContext,
      };
    }

    const trimmedSelectedId = request.selectedLogId?.trim();
    const active =
      (trimmedSelectedId
        ? resolution.candidates.find((c) => c.id === trimmedSelectedId)
        : undefined) ?? resolution.candidates[0];

    const candidateOptions: DocumentLogUiCandidateOption[] = resolution.candidates.map(
      (candidate) => ({
        text: formatCandidateOptionLabel(candidate),
        value: candidate.id,
        selected: candidate.id === active.id,
      })
    );

    const historyContext = await this.loadUiHistoryContext({
      documentTypeKey: request.documentTypeKey,
      activeCandidateId: active.id,
      formData: request.formData,
    });

    return {
      status: 'ambiguous',
      spaceName: request.space.name,
      candidateOptions,
      activeCandidate: {
        name: active.name,
        url: buildCandidateUrl(active),
      },
      ...historyContext,
    };
  }

  private async resolveDiscoveryScope(
    space: DocumentLogSpace
  ): Promise<{ searchSharedDriveId: string | undefined; useFolderDescendantWalk: boolean }> {
    const fetchMethod = this.schemaRegistry.getSpaceFetchMethod?.(space.typeId);

    if (fetchMethod === 'shared_drives') {
      return {
        searchSharedDriveId: space.abstractStorageId,
        useFolderDescendantWalk: false,
      };
    }

    if (fetchMethod === 'folders') {
      if (!this.logDiscovery.getFile) {
        throw new DocumentLogConfigurationError(
          'Folder-backed DocumentLog discovery requires LogDiscoveryPort.getFile to be implemented.'
        );
      }
      const containerMeta = await this.logDiscovery.getFile(space.abstractStorageId);
      return {
        searchSharedDriveId: containerMeta.driveId,
        useFolderDescendantWalk: true,
      };
    }

    if (!this.logDiscovery.getFile) {
      return {
        searchSharedDriveId: space.abstractStorageId,
        useFolderDescendantWalk: false,
      };
    }

    const containerMeta = await this.logDiscovery.getFile(space.abstractStorageId);
    const isFolderContainer =
      (containerMeta.driveId !== undefined && containerMeta.driveId !== space.abstractStorageId) ||
      (containerMeta.driveId === undefined && containerMeta.mimeType === GOOGLE_FOLDER_MIME_TYPE);

    return {
      searchSharedDriveId: isFolderContainer ? containerMeta.driveId : space.abstractStorageId,
      useFolderDescendantWalk: isFolderContainer,
    };
  }

  private async resolvePreferredFolderId(
    rootFolderId: string,
    preferredFolderPath: string
  ): Promise<string | undefined> {
    const pathSegments = splitFolderPath(preferredFolderPath);
    if (!this.logDiscovery.resolveFolderPath || pathSegments.length === 0) {
      return undefined;
    }

    try {
      const { id } = await this.logDiscovery.resolveFolderPath(rootFolderId, pathSegments);
      return id;
    } catch {
      return undefined;
    }
  }

  private getResolveLogMemoKey(space: DocumentLogSpace): string {
    return `${space.typeId.trim()}::${space.abstractStorageId.trim()}`;
  }

  async resolveLog(space: DocumentLogSpace): Promise<LogResolutionResult> {
    if (!this.resolveLogMemo) {
      return this.executeResolveLog(space);
    }

    const memoKey = this.getResolveLogMemoKey(space);
    const existing = this.resolveLogMemo.get(memoKey);
    if (existing) {
      return existing;
    }

    const pending = this.executeResolveLog(space).catch((error) => {
      this.resolveLogMemo?.delete(memoKey);
      throw error;
    });
    this.resolveLogMemo.set(memoKey, pending);
    return pending;
  }

  private async executeResolveLog(space: DocumentLogSpace): Promise<LogResolutionResult> {
    const discoveryConfig = this.schemaRegistry.getDiscoveryConfig(space.typeId);
    if (!discoveryConfig) {
      throw new DocumentLogConfigurationError(
        'DocumentLog discovery configuration (configuration.documentLog) is not initialized.'
      );
    }
    if (!space.abstractStorageId || space.abstractStorageId.trim().length === 0) {
      throw new DocumentLogConfigurationError(
        `DocumentSpace "${space.name}" is missing abstractStorageId for DocumentLog resolution.`
      );
    }

    const { searchSharedDriveId, useFolderDescendantWalk } = await this.resolveDiscoveryScope(space);

    const rawMatches = await this.logDiscovery.searchSpreadsheets({
      targetName: discoveryConfig.fileNameContains,
      ...(searchSharedDriveId !== undefined ? { sharedDriveId: searchSharedDriveId } : {}),
      mimeTypes: [GOOGLE_SPREADSHEET_MIME_TYPE],
      exactMatch: false,
    });

    let filtered = filterCandidatesByConfig(
      rawMatches,
      discoveryConfig.fileNameContains,
      discoveryConfig.excludePrefixes,
      discoveryConfig.excludeSubstrings
    );

    let getFileMemo: ((fileId: string) => Promise<LogDiscoveryFileMetadata | null>) | undefined;
    if (useFolderDescendantWalk && filtered.length > 0) {
      getFileMemo = createPerCallGetFileMemo(this.logDiscovery.getFile!);
      const checked = await Promise.all(
        filtered.map(async (candidate) => ({
          candidate,
          isDescendant: await isDescendantOfRoot(
            candidate.parents,
            space.abstractStorageId,
            getFileMemo!
          ),
        }))
      );
      filtered = checked.filter((entry) => entry.isDescendant).map((entry) => entry.candidate);
    }

    if (filtered.length === 0) {
      return {
        status: 'missing',
        candidates: [],
        expectedFolderPath: discoveryConfig.preferredFolderPath,
      };
    }

    if (filtered.length === 1) {
      return {
        status: 'resolved',
        candidate: filtered[0],
        candidates: [filtered[0]],
      };
    }

    const preferredFolderId = await this.resolvePreferredFolderId(
      space.abstractStorageId,
      discoveryConfig.preferredFolderPath
    );

    const expectedCopyName = this.templateEvaluator.evaluate(discoveryConfig.copyNameTemplate, {
      DocumentSpace: space,
    });
    const ranked = rankAmbiguousCandidates({
      candidates: filtered,
      preferredFolderId,
      expectedCopyName,
    });

    const candidatesWithParents = this.logDiscovery.getFile
      ? await (async () => {
          const memo = getFileMemo ?? createPerCallGetFileMemo(this.logDiscovery.getFile!);
          return Promise.all(
            ranked.map(async (candidate): Promise<LogResolutionCandidate> => {
              const parentId = candidate.parents?.[0]?.trim();
              if (!parentId || parentId === space.abstractStorageId) {
                return candidate;
              }
              const parentMeta = await memo(parentId);
              const folderName = parentMeta?.name?.trim();
              if (!folderName) {
                return candidate;
              }
              return {
                ...candidate,
                parentFolderName: folderName,
              };
            })
          );
        })()
      : ranked;

    return {
      status: 'ambiguous',
      candidates: candidatesWithParents,
    };
  }

  async copyLog(space: DocumentLogSpace): Promise<CopyDocumentLogResult> {
    const discoveryConfig = this.schemaRegistry.getDiscoveryConfig(space.typeId);
    if (!discoveryConfig) {
      throw new DocumentLogConfigurationError(
        'DocumentLog discovery configuration (configuration.documentLog) is not initialized.'
      );
    }

    const { preferredFolderPath, copyNameTemplate, templateSpreadsheetId } = discoveryConfig;
    const resolution = await this.resolveLog(space);

    if (resolution.status === 'resolved') {
      return {
        created: false,
        candidate: resolution.candidate,
        folderPath: preferredFolderPath,
      };
    }

    if (resolution.status === 'ambiguous') {
      return {
        created: false,
        candidate: resolution.candidates[0],
        folderPath: preferredFolderPath,
      };
    }

    if (!this.logDiscovery.ensureFolderPath || !this.logDiscovery.copyFile) {
      throw new DocumentLogConfigurationError(
        'DocumentLog provisioning requires LogDiscoveryPort.ensureFolderPath and LogDiscoveryPort.copyFile to be implemented.'
      );
    }

    const preferredFolderSegments = splitFolderPath(preferredFolderPath);
    const targetFolder = await this.logDiscovery.ensureFolderPath(
      space.abstractStorageId,
      preferredFolderSegments
    );

    const newName = this.templateEvaluator
      .evaluate(copyNameTemplate, { DocumentSpace: space })
      .trim();
    if (newName.length === 0) {
      throw new DocumentLogConfigurationError(
        `Evaluated DocumentLog copyNameTemplate "${copyNameTemplate}" is empty for space "${space.name}".`
      );
    }

    const candidate = await this.logDiscovery.copyFile(templateSpreadsheetId, {
      targetFolderId: targetFolder.id,
      newName,
    });
    this.resolveLogMemo?.delete(this.getResolveLogMemoKey(space));

    return {
      created: true,
      candidate,
      folderPath: preferredFolderPath,
    };
  }

  private requireSchemasForDocumentType(documentTypeKey: string): {
    logSchema: DocumentLogSchema;
    targetSchema: LogTargetDocumentSchema;
  } {
    const logSchema = this.schemaRegistry.getDocumentLogSchema(documentTypeKey);
    if (!logSchema) {
      throw new DocumentLogConfigurationError(
        `No documentLogSchema configured for DocumentType "${documentTypeKey}".`
      );
    }

    const targetSchema = this.schemaRegistry.getTargetSchema(documentTypeKey);
    if (!targetSchema) {
      throw new DocumentLogConfigurationError(
        `No target DocumentSchema metadata found for DocumentType "${documentTypeKey}".`
      );
    }

    return { logSchema, targetSchema };
  }

  private async resolveSpreadsheetId(
    space: DocumentLogSpace | undefined,
    selectedLogId?: string
  ): Promise<string> {
    const trimmedSelectedLogId = selectedLogId?.trim();
    if (trimmedSelectedLogId && trimmedSelectedLogId.length > 0) {
      return trimmedSelectedLogId;
    }

    if (!space) {
      throw new DocumentLogConfigurationError(
        'Document.space is required to resolve a DocumentLog when selectedLogId is not provided.'
      );
    }

    const resolution = await this.resolveLog(space);
    if (resolution.status === 'missing') {
      throw new DocumentLogMissingError(space.name, resolution.expectedFolderPath);
    }
    if (resolution.status === 'ambiguous') {
      throw new DocumentLogAmbiguousError(space.name, resolution.candidates);
    }
    return resolution.candidate.id;
  }

  private parseReadFilter(
    filterBy: LogFilterBy | undefined,
    values: string | string[] | undefined
  ): { filterBy: LogFilterBy; normalizedTargets: Set<string> } | { shortCircuit: true } | undefined {
    if (
      filterBy !== undefined &&
      filterBy !== 'idGroup' &&
      filterBy !== 'idDocument' &&
      filterBy !== 'id'
    ) {
      throw new DocumentLogConfigurationError(
        `Unsupported readLog filterBy "${String(filterBy)}". Expected "idGroup", "idDocument", or "id".`
      );
    }

    const hasFilterBy = filterBy !== undefined;
    const hasValues = values !== undefined;
    if (hasFilterBy !== hasValues) {
      throw new DocumentLogConfigurationError(
        'readLog requires filterBy and values to either both be provided or both be omitted.'
      );
    }

    if (!hasFilterBy || !hasValues) {
      return undefined;
    }

    const rawList = Array.isArray(values) ? values : [values];
    const normalizedTargets = new Set<string>();
    for (const item of rawList) {
      if (typeof item !== 'string') {
        throw new DocumentLogConfigurationError('readLog values must be a string or string[].');
      }
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        normalizedTargets.add(trimmed.toLowerCase());
      }
    }

    if (normalizedTargets.size === 0) {
      return { shortCircuit: true };
    }

    return { filterBy, normalizedTargets };
  }

  async readLog(request: ReadDocumentLogRequest): Promise<ReadDocumentLogResult> {
    const { logSchema, targetSchema } = this.requireSchemasForDocumentType(request.documentTypeKey);
    const parsedFilter = this.parseReadFilter(request.filterBy, request.values);

    if (parsedFilter && 'shortCircuit' in parsedFilter) {
      return {
        spreadsheetId: '',
        sheetName: logSchema.target.sheetName,
        entries: [],
        warnings: [],
      };
    }

    const spreadsheetId = await this.resolveSpreadsheetId(request.space, request.selectedLogId);

    const linkColumns: string[] = [];
    for (const [header, binding] of Object.entries(logSchema.columns)) {
      if (!('template' in binding) && binding.source === 'fileLink') {
        linkColumns.push(header);
      }
    }

    const tableResult = await this.logStorage.readRows({
      target: {
        spreadsheetId,
        sheetName: logSchema.target.sheetName,
        rangeName: logSchema.target.rangeName,
        extentMarker: logSchema.target.extentMarker,
        groupDividerMarker: logSchema.target.groupDividerMarker,
      },
      ...(linkColumns.length > 0 ? { linkColumns } : {}),
    });

    const hydrateRow = buildLogRowHydrator({
      documentTypeKey: request.documentTypeKey,
      logSchema,
      targetSchema,
      templateEvaluator: this.templateEvaluator,
    });

    const allEntries: DocumentLogEntry[] = [];
    const allWarnings: RowHydrationWarning[] = [];
    for (const row of tableResult.rows) {
      const hydrated = hydrateRow(row);
      allEntries.push(hydrated.entry);
      allWarnings.push(...hydrated.warnings);
    }

    if (!parsedFilter) {
      return {
        spreadsheetId,
        sheetName: logSchema.target.sheetName,
        entries: allEntries,
        warnings: allWarnings,
      };
    }

    const matchedEntries = allEntries.filter((entry) => {
      const candidateKey = entry.document[parsedFilter.filterBy];
      return (
        typeof candidateKey === 'string' &&
        parsedFilter.normalizedTargets.has(candidateKey.trim().toLowerCase())
      );
    });
    const matchedRowNumbers = new Set(matchedEntries.map((entry) => entry.rowNumber));
    const scopedWarnings = allWarnings.filter((warning) =>
      matchedRowNumbers.has(warning.rowNumber)
    );

    return {
      spreadsheetId,
      sheetName: logSchema.target.sheetName,
      entries: matchedEntries,
      warnings: scopedWarnings,
    };
  }

  /**
   * Reads all requested `_Config` option tables from the active `DocumentLog` spreadsheet in one
   * batched storage read, resolving omitted or stale `selectedLogId` to `candidates[0]` when `ambiguous`.
   */
  async readOptionTables(request: ReadOptionTablesRequest): Promise<ReadOptionTablesResult> {
    const { logSchema } = this.requireSchemasForDocumentType(request.documentTypeKey);

    const trimmedSelectedId = request.selectedLogId?.trim();
    const spaceStorageId = (request.space?.abstractStorageId ?? request.space?.id ?? '').trim();

    if (spaceStorageId.length === 0 && (!trimmedSelectedId || trimmedSelectedId.length === 0)) {
      return {
        status: 'missing_space',
        tables: {},
      };
    }

    let spreadsheetId: string;
    if (spaceStorageId.length > 0) {
      const normalizedSpace: DocumentLogSpace = {
        id: request.space?.id?.trim() || spaceStorageId,
        typeId: request.space?.typeId?.trim() ?? '',
        name: request.space?.name?.trim() ?? '',
        abstractStorageId: spaceStorageId,
      };
      const resolution = await this.resolveLog(normalizedSpace);
      if (resolution.status === 'missing') {
        return {
          status: 'missing_log',
          expectedFolderPath: resolution.expectedFolderPath,
          tables: {},
        };
      }
      if (resolution.status === 'resolved') {
        spreadsheetId = resolution.candidate.id.trim();
      } else {
        const active =
          (trimmedSelectedId
            ? resolution.candidates.find((c) => c.id === trimmedSelectedId)
            : undefined) ?? resolution.candidates[0];
        spreadsheetId = active.id.trim();
      }
    } else {
      spreadsheetId = trimmedSelectedId!;
    }

    const optionBindings = logSchema.optionBindings ?? {};
    const requestedKeys =
      request.sourceKeys && request.sourceKeys.length > 0
        ? Array.from(new Set(request.sourceKeys))
        : Object.keys(optionBindings);

    const tables: Record<string, DocumentLogOptionTableSourceResult> = {};
    const targets: Array<{ key: string; sheetName: string; rangeName: string }> = [];

    for (const sourceKey of requestedKeys) {
      const binding = optionBindings[sourceKey];
      if (!binding) {
        tables[sourceKey] = {
          status: 'config_error',
          tuples: [],
          errorMessage: `Missing optionBinding for "${sourceKey}" on DocumentType "${request.documentTypeKey}".`,
        };
        continue;
      }
      targets.push({
        key: sourceKey,
        sheetName: binding.sheetName,
        rangeName: binding.rangeName,
      });
    }

    if (targets.length > 0) {
      if (!this.logStorage.readNamedRanges) {
        throw new DocumentLogConfigurationError(
          'LogStoragePort.readNamedRanges is required to read DocumentLog option tables.'
        );
      }
      const batchEntries = await this.logStorage.readNamedRanges({
        spreadsheetId,
        targets,
      });
      for (const target of targets) {
        const binding = optionBindings[target.key]!;
        tables[target.key] = parseOptionTableEntry(target.key, binding, batchEntries[target.key]);
      }
    }

    if (this.optionTablesMemo) {
      const cacheKey = `${request.documentTypeKey}::${spreadsheetId}`;
      const existing = this.optionTablesMemo.get(cacheKey);
      this.optionTablesMemo.set(cacheKey, {
        ...(existing ?? {}),
        ...tables,
      });
    }

    return {
      status: 'ready',
      spreadsheetId,
      tables,
    };
  }

  private async readBoundOptionTuples(
    documentTypeKey: string,
    spreadsheetId: string,
    logSchema: DocumentLogSchema
  ): Promise<Record<string, readonly LogTargetDocumentOptionTuple[]>> {
    const { optionBindings } = logSchema;
    if (!optionBindings) {
      return {};
    }

    const keys = Object.keys(optionBindings);
    if (keys.length === 0) {
      return {};
    }

    const cacheKey = `${documentTypeKey}::${spreadsheetId}`;
    const cachedTables = this.optionTablesMemo?.get(cacheKey);
    const missingTargets: Array<{ key: string; sheetName: string; rangeName: string }> = [];
    const tableResults: Record<string, DocumentLogOptionTableSourceResult> = {};

    for (const sourceKey of keys) {
      const cached = cachedTables?.[sourceKey];
      if (cached) {
        tableResults[sourceKey] = cached;
      } else {
        const binding = optionBindings[sourceKey];
        if (binding) {
          missingTargets.push({
            key: sourceKey,
            sheetName: binding.sheetName,
            rangeName: binding.rangeName,
          });
        }
      }
    }

    if (missingTargets.length > 0 && this.logStorage.readNamedRanges) {
      const batchEntries = await this.logStorage.readNamedRanges({
        spreadsheetId,
        targets: missingTargets,
      });
      for (const target of missingTargets) {
        const binding = optionBindings[target.key]!;
        tableResults[target.key] = parseOptionTableEntry(
          target.key,
          binding,
          batchEntries[target.key]
        );
      }
      if (this.optionTablesMemo) {
        this.optionTablesMemo.set(cacheKey, {
          ...(cachedTables ?? {}),
          ...tableResults,
        });
      }
    }

    const tuplesBySource: Record<string, readonly LogTargetDocumentOptionTuple[]> = {};
    for (const [sourceKey, entry] of Object.entries(tableResults)) {
      if (entry.status === 'ready') {
        const { tuples } = entry;
        tuplesBySource[sourceKey] = tuples;
      }
    }
    return tuplesBySource;
  }

  async writeLog(request: WriteDocumentLogRequest): Promise<WriteDocumentLogResult> {
    const { document, fileUri, selectedLogId } = request;
    const { logSchema, targetSchema } = this.requireSchemasForDocumentType(document.type);

    const spreadsheetId = await this.resolveSpreadsheetId(document.space, selectedLogId);
    const dynamicOptions = await this.readBoundOptionTuples(
      document.type,
      spreadsheetId,
      logSchema
    );
    const enrichedData = enrichDocumentData(document.data, targetSchema, dynamicOptions);

    const { rowData, readOnlyColumns } = mapDocumentToLogRow({
      document,
      logSchema,
      targetSchema,
      templateEvaluator: this.templateEvaluator,
      fileUri,
      enrichedData,
    });

    const targetKeys = computeTargetRowKeys({
      document,
      logSchema,
      targetSchema,
      templateEvaluator: this.templateEvaluator,
      enrichedData,
    });

    const rowKeyExtractor = buildRowKeyExtractor({
      logSchema,
      targetSchema,
      templateEvaluator: this.templateEvaluator,
      dynamicOptions,
    });

    const insertResult = await this.logStorage.insertRow({
      target: {
        spreadsheetId,
        sheetName: logSchema.target.sheetName,
        rangeName: logSchema.target.rangeName,
        extentMarker: logSchema.target.extentMarker,
        groupDividerMarker: logSchema.target.groupDividerMarker,
      },
      rowData,
      rowKeyExtractor,
      ...(targetKeys !== null ? { targetKeys } : {}),
      ...(readOnlyColumns.length > 0 ? { readOnlyColumns } : {}),
      groupSortOrder: logSchema.grouping.groupSortOrder,
      rowSortOrder: logSchema.grouping.rowSortOrder,
      duplicatePolicy: logSchema.grouping.duplicatePolicy,
    });

    return {
      spreadsheetId,
      sheetName: logSchema.target.sheetName,
      rowNumber: insertResult.rowNumber,
      action: insertResult.action,
    };
  }
}

import {
  DocumentLogAmbiguousError,
  DocumentLogConfigurationError,
  DocumentLogMissingError,
  type DocumentLogEntry,
  type DocumentLogPort,
  type DocumentLogSchema,
  type DocumentLogSpace,
  type DocumentLogUiContextResult,
  type LogDiscoveryFileMetadata,
  type LogDiscoveryPort,
  type LogFilterBy,
  type LogResolutionCandidate,
  type LogResolutionResult,
  type LogSchemaRegistryPort,
  type LogStoragePort,
  type LogTargetDocumentSchema,
  type LogTemplateEvaluatorPort,
  type QueryDocumentLogUiContextRequest,
  type ReadDocumentLogRequest,
  type ReadDocumentLogResult,
  type RowHydrationWarning,
  type WriteDocumentLogRequest,
  type WriteDocumentLogResult,
} from './ports';
import {
  buildLogRowHydrator,
  buildRowKeyExtractor,
  computeTargetRowKeys,
  enrichDocumentData,
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

/**
 * Core domain service managing live DocumentLog discovery and Document dehydration/write orchestration.
 */
export class DocumentLogService implements DocumentLogPort {
  constructor(
    private readonly schemaRegistry: LogSchemaRegistryPort,
    private readonly logDiscovery: LogDiscoveryPort,
    private readonly logStorage: LogStoragePort,
    private readonly templateEvaluator: LogTemplateEvaluatorPort
  ) {}

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
      return {
        status: 'resolved',
        spaceName: request.space.name,
        ...(discoveryConfig?.preferredFolderPath !== undefined
          ? { targetFolderPath: discoveryConfig.preferredFolderPath }
          : {}),
        activeCandidate: {
          name: resolution.candidate.name,
          url: buildCandidateUrl(resolution.candidate),
        },
      };
    }

    const trimmedSelectedId = request.selectedLogId?.trim();
    const active =
      (trimmedSelectedId
        ? resolution.candidates.find((c) => c.id === trimmedSelectedId)
        : undefined) ?? resolution.candidates[0];

    return {
      status: 'ambiguous',
      spaceName: request.space.name,
      ...(discoveryConfig?.preferredFolderPath !== undefined
        ? { targetFolderPath: discoveryConfig.preferredFolderPath }
        : {}),
      activeCandidate: {
        name: active.name,
        url: buildCandidateUrl(active),
      },
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

  async resolveLog(space: DocumentLogSpace): Promise<LogResolutionResult> {
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

    if (useFolderDescendantWalk && filtered.length > 0) {
      const getFileMemo = createPerCallGetFileMemo(this.logDiscovery.getFile!);
      const checked = await Promise.all(
        filtered.map(async (candidate) => ({
          candidate,
          isDescendant: await isDescendantOfRoot(
            candidate.parents,
            space.abstractStorageId,
            getFileMemo
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

    return {
      status: 'ambiguous',
      candidates: ranked,
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

  async writeLog(request: WriteDocumentLogRequest): Promise<WriteDocumentLogResult> {
    const { document, fileUri, selectedLogId } = request;
    const { logSchema, targetSchema } = this.requireSchemasForDocumentType(document.type);

    const spreadsheetId = await this.resolveSpreadsheetId(document.space, selectedLogId);
    const enrichedData = enrichDocumentData(document.data, targetSchema);

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

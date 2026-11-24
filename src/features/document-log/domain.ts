import {
  DocumentLogAmbiguousError,
  DocumentLogConfigurationError,
  DocumentLogMissingError,
  type DocumentLogPort,
  type DocumentLogSpace,
  type LogDiscoveryPort,
  type LogResolutionCandidate,
  type LogResolutionResult,
  type LogSchemaRegistryPort,
  type LogStoragePort,
  type LogTemplateEvaluatorPort,
  type WriteDocumentLogRequest,
  type WriteDocumentLogResult,
} from './ports';
import { mapDocumentToLogRow } from './row-mapper';

const GOOGLE_SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

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
 * Core domain service managing live DocumentLog discovery and Document dehydration/write orchestration.
 */
export class DocumentLogService implements DocumentLogPort {
  constructor(
    private readonly schemaRegistry: LogSchemaRegistryPort,
    private readonly logDiscovery: LogDiscoveryPort,
    private readonly logStorage: LogStoragePort,
    private readonly templateEvaluator: LogTemplateEvaluatorPort
  ) {}

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

    const rawMatches = await this.logDiscovery.searchSpreadsheets({
      targetName: discoveryConfig.fileNameContains,
      sharedDriveId: space.abstractStorageId,
      mimeTypes: [GOOGLE_SPREADSHEET_MIME_TYPE],
      exactMatch: false,
    });

    const filtered = filterCandidatesByConfig(
      rawMatches,
      discoveryConfig.fileNameContains,
      discoveryConfig.excludePrefixes,
      discoveryConfig.excludeSubstrings
    );

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

    return {
      status: 'ambiguous',
      candidates: filtered,
    };
  }

  async writeLog(request: WriteDocumentLogRequest): Promise<WriteDocumentLogResult> {
    const { document, fileUri, selectedLogId } = request;

    const logSchema = this.schemaRegistry.getDocumentLogSchema(document.type);
    if (!logSchema) {
      throw new DocumentLogConfigurationError(
        `No documentLogSchema configured for DocumentType "${document.type}".`
      );
    }

    const targetSchema = this.schemaRegistry.getTargetSchema(document.type);
    if (!targetSchema) {
      throw new DocumentLogConfigurationError(
        `No target DocumentSchema metadata found for DocumentType "${document.type}".`
      );
    }

    let spreadsheetId: string;
    const trimmedSelectedLogId = selectedLogId?.trim();
    if (trimmedSelectedLogId && trimmedSelectedLogId.length > 0) {
      spreadsheetId = trimmedSelectedLogId;
    } else {
      if (!document.space) {
        throw new DocumentLogConfigurationError(
          'Document.space is required to resolve a DocumentLog when selectedLogId is not provided.'
        );
      }

      const resolution = await this.resolveLog(document.space);
      if (resolution.status === 'missing') {
        throw new DocumentLogMissingError(document.space.name, resolution.expectedFolderPath);
      }
      if (resolution.status === 'ambiguous') {
        throw new DocumentLogAmbiguousError(document.space.name, resolution.candidates);
      }
      spreadsheetId = resolution.candidate.id;
    }

    const { rowData, readOnlyColumns } = mapDocumentToLogRow({
      document,
      logSchema,
      targetSchema,
      templateEvaluator: this.templateEvaluator,
      fileUri,
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

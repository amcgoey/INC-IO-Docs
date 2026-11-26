import { OAuth2Client } from 'google-auth-library';
import {
  DocumentLogConfigurationError,
  DocumentLogError,
  DocumentLogService,
  LogSchemaRegistryAdapter,
  type DocumentLogPort,
  type LogDiscoveryPort,
  type LogSchemaRegistryPort,
  type LogStoragePort,
  type LogTemplateEvaluatorPort,
  type LogTemplateParserPort,
  type RawManifestProviderPort,
} from '../features/document-log';
import type { ActivityHandler, AppConfigurationProviderPort } from '../features/document/ports';
import {
  DocumentLogActivityHandler,
  type DocumentLogActivityHandlerOptions,
} from './document-log-activity-handler';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import {
  GoogleSheetsApiError,
  GoogleSheetsClient,
  GoogleSheetsOptionTableConfigError,
  type RowRecord,
  type SheetsClient,
  type SheetsConfigProvider,
} from '../infrastructure/sheets';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { UiProcessDocumentLogPort } from '../features/ui-process-manager';
import type { UiContextQueryPort } from '../features/schema-driven-ui/ports';
import type { DocumentSpaceService } from '../features/document-space/domain';
import { UiContextQueryAdapter } from './ui-context-query.adapter';

export interface DocumentLogServiceRequestOverrides {
  driveClient?: GoogleDriveClient | undefined;
  sheetsClient?: SheetsClient | undefined;
  documentLogService?: DocumentLogPort | undefined;
  selectedLogId?: string | undefined;
  onWriteLogSuccess?: ((spaceId?: string) => void) | undefined;
}

export type DocumentLogServiceFactory = (
  context: WorkspaceExecutionContext,
  overrides?: DocumentLogServiceRequestOverrides
) => DocumentLogPort;

export type DocumentLogActivityHandlerFactory = (
  context: WorkspaceExecutionContext,
  overrides?: DocumentLogServiceRequestOverrides
) => ActivityHandler;

export interface DocumentLogWiringOptions {
  manifestProvider?: RawManifestProviderPort | undefined;
  logSchemaRegistry?: LogSchemaRegistryPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  sheetsClient?: SheetsClient | undefined;
  configProvider?:
    | (Partial<AppConfigurationProviderPort> & Partial<SheetsConfigProvider>)
    | undefined;
  templateParser?: LogTemplateParserPort | undefined;
  templateEvaluator?: unknown;
  documentLogService?: DocumentLogPort | undefined;
}

export interface DocumentLogWiring {
  logSchemaRegistry: LogSchemaRegistryPort;
  documentLogService: DocumentLogPort;
  createDocumentLogService: DocumentLogServiceFactory;
  getPerRequestService: (
    context: WorkspaceExecutionContext,
    overrides?: DocumentLogServiceRequestOverrides
  ) => DocumentLogPort;
  createActivityHandler: (options?: DocumentLogActivityHandlerOptions) => ActivityHandler;
  createPerRequestActivityHandler: DocumentLogActivityHandlerFactory;
  createUiProcessDocumentLogPort: (
    context: WorkspaceExecutionContext,
    options?: {
      ensureInitialized?: (() => Promise<void>) | undefined;
      overrides?: DocumentLogServiceRequestOverrides | undefined;
    }
  ) => Promise<UiProcessDocumentLogPort>;
  createUiContextQueryPort: (
    context: WorkspaceExecutionContext,
    options: {
      getDocumentSpaceService: () => Promise<DocumentSpaceService> | DocumentSpaceService;
      ensureInitialized?: (() => Promise<void>) | undefined;
      overrides?: DocumentLogServiceRequestOverrides | undefined;
    }
  ) => UiContextQueryPort;
}

/**
 * Adapts `DocumentLogPort` to the narrow `UiProcessDocumentLogPort` boundary.
 */
export function createUiProcessDocumentLogAdapter(
  documentLogService: DocumentLogPort
): UiProcessDocumentLogPort {
  return {
    requiresDocumentLog: (documentTypeKey) =>
      documentLogService.requiresDocumentLog(documentTypeKey),
    resolveLog: async (space) => {
      const res = await documentLogService.resolveLog({
        id: space.id,
        typeId: space.typeId,
        name: space.name,
        abstractStorageId: space.abstractStorageId,
      });
      if (res.status === 'missing') {
        return { status: 'missing', expectedFolderPath: res.expectedFolderPath };
      }
      if (res.status === 'resolved') {
        return {
          status: 'resolved',
          candidate: { id: res.candidate.id, name: res.candidate.name },
        };
      }
      return {
        status: 'ambiguous',
        candidates: res.candidates.map((c) => ({ id: c.id, name: c.name })),
      };
    },
    copyLog: async (space) => {
      const res = await documentLogService.copyLog({
        id: space.id,
        typeId: space.typeId,
        name: space.name,
        abstractStorageId: space.abstractStorageId,
      });
      return {
        created: res.created,
        candidate: { id: res.candidate.id, name: res.candidate.name },
        folderPath: res.folderPath,
      };
    },
  };
}

function createOAuth2Client(oauthCred: string): OAuth2Client {
  const oauth2Client = new OAuth2Client();
  oauth2Client.setCredentials({ access_token: oauthCred });
  return oauth2Client;
}

function resolveTemplateParser(candidate: unknown): LogTemplateParserPort | undefined {
  if (
    candidate !== null &&
    candidate !== undefined &&
    typeof (candidate as { parseMustacheTemplate?: unknown }).parseMustacheTemplate === 'function'
  ) {
    return candidate as LogTemplateParserPort;
  }
  return undefined;
}

function resolveTemplateEvaluator(candidate: unknown): LogTemplateEvaluatorPort | undefined {
  if (
    candidate !== null &&
    candidate !== undefined &&
    typeof (candidate as { evaluate?: unknown }).evaluate === 'function'
  ) {
    return candidate as LogTemplateEvaluatorPort;
  }
  return undefined;
}

function createDriveDiscoveryAdapter(driveClient: GoogleDriveClient): LogDiscoveryPort {
  return {
    searchSpreadsheets: async (query) => {
      const files = await driveClient.searchFiles({
        targetName: query.targetName,
        ...(query.exactMatch !== undefined ? { exactMatch: query.exactMatch } : {}),
        ...(query.sharedDriveId !== undefined ? { sharedDriveId: query.sharedDriveId } : {}),
        ...(query.mimeTypes !== undefined ? { mimeTypes: query.mimeTypes } : {}),
      });
      return files.map((file) => ({
        id: file.id,
        name: file.name,
        ...(file.parents !== undefined ? { parents: file.parents } : {}),
        ...(file.webViewLink !== undefined ? { webViewLink: file.webViewLink } : {}),
        ...(file.modifiedTime !== undefined ? { modifiedTime: file.modifiedTime } : {}),
      }));
    },
    ...(typeof driveClient.getFile === 'function'
      ? {
          getFile: async (fileId) => {
            const file = await driveClient.getFile(fileId);
            return {
              id: file.id,
              name: file.name,
              ...(file.parents !== undefined ? { parents: file.parents } : {}),
              ...(file.driveId !== undefined ? { driveId: file.driveId } : {}),
              ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
              ...(file.webViewLink !== undefined ? { webViewLink: file.webViewLink } : {}),
              ...(file.modifiedTime !== undefined ? { modifiedTime: file.modifiedTime } : {}),
            };
          },
        }
      : {}),
    ...(typeof driveClient.resolveFolderPath === 'function'
      ? {
          resolveFolderPath: async (rootFolderId, pathSegments) => {
            const folder = await driveClient.resolveFolderPath(rootFolderId, pathSegments);
            return {
              id: folder.id,
              name: folder.name,
            };
          },
        }
      : {}),
    ...(typeof driveClient.ensureFolderPath === 'function'
      ? {
          ensureFolderPath: async (rootFolderId, pathSegments) => {
            const folder = await driveClient.ensureFolderPath(rootFolderId, pathSegments);
            return {
              id: folder.id,
              name: folder.name,
            };
          },
        }
      : {}),
    ...(typeof driveClient.duplicate === 'function'
      ? {
          copyFile: async (templateFileId, options) => {
            const file = await driveClient.duplicate(templateFileId, {
              targetFolderId: options.targetFolderId,
              newName: options.newName,
            });
            return {
              id: file.id,
              name: file.name,
              ...(file.parents !== undefined ? { parents: file.parents } : {}),
              ...(file.webViewLink !== undefined ? { webViewLink: file.webViewLink } : {}),
              ...(file.modifiedTime !== undefined ? { modifiedTime: file.modifiedTime } : {}),
            };
          },
        }
      : {}),
  };
}

const SHEETS_ERROR_NAME_REGEX = /^GoogleSheets[A-Za-z]*Error$/;
const SHEETS_ERROR_PREFIX_REGEX = /^GoogleSheets[A-Za-z]*Error:\s*/;

function sanitizeSheetsErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message.trim() : String(error).trim();
  const sanitized = raw.replace(SHEETS_ERROR_PREFIX_REGEX, '').trim();
  return sanitized.length > 0 ? sanitized : 'Unable to read Document Log storage.';
}

function createSheetsStorageAdapter(sheetsClient: SheetsClient): LogStoragePort {
  return {
    insertRow: async (request) => {
      try {
        return await sheetsClient.insertIntoGroupedList({
          target: request.target,
          rowData: request.rowData,
          ...(request.rowKeyExtractor !== undefined
            ? { rowKeyExtractor: (row: RowRecord) => request.rowKeyExtractor!(row) }
            : {}),
          ...(request.targetKeys !== undefined ? { targetKeys: request.targetKeys } : {}),
          ...(request.groupSortOrder !== undefined
            ? { groupSortOrder: request.groupSortOrder }
            : {}),
          ...(request.rowSortOrder !== undefined ? { rowSortOrder: request.rowSortOrder } : {}),
          ...(request.duplicatePolicy !== undefined
            ? { duplicatePolicy: request.duplicatePolicy }
            : {}),
          ...(request.readOnlyColumns !== undefined
            ? { readOnlyColumns: request.readOnlyColumns }
            : {}),
          ...(request.optionWrites !== undefined
            ? { optionWrites: request.optionWrites }
            : {}),
          ...(request.templateSpreadsheetId !== undefined
            ? { templateSpreadsheetId: request.templateSpreadsheetId }
            : {}),
        });
      } catch (error) {
        if (error instanceof GoogleSheetsOptionTableConfigError) {
          throw new DocumentLogConfigurationError(sanitizeSheetsErrorMessage(error), {
            cause: error,
          });
        }
        throw error;
      }
    },
    readRows: async (request) => {
      try {
        return await sheetsClient.readTable({
          target: request.target,
          ...(request.linkColumns !== undefined ? { linkColumns: request.linkColumns } : {}),
        });
      } catch (error) {
        if (
          error instanceof GoogleSheetsApiError ||
          (error instanceof Error &&
            (SHEETS_ERROR_NAME_REGEX.test(error.name) ||
              SHEETS_ERROR_PREFIX_REGEX.test(error.message))) ||
          (typeof error === 'string' && SHEETS_ERROR_PREFIX_REGEX.test(error.trim()))
        ) {
          throw new DocumentLogError(sanitizeSheetsErrorMessage(error), { cause: error });
        }
        throw error;
      }
    },
    readNamedRanges: async (request) => {
      if (!sheetsClient.readNamedRangesBatch) {
        throw new Error('SheetsClient.readNamedRangesBatch is not implemented.');
      }
      try {
        return await sheetsClient.readNamedRangesBatch({
          spreadsheetId: request.spreadsheetId,
          targets: request.targets,
        });
      } catch (error) {
        if (
          error instanceof GoogleSheetsApiError ||
          (error instanceof Error &&
            (SHEETS_ERROR_NAME_REGEX.test(error.name) ||
              SHEETS_ERROR_PREFIX_REGEX.test(error.message))) ||
          (typeof error === 'string' && SHEETS_ERROR_PREFIX_REGEX.test(error.trim()))
        ) {
          throw new DocumentLogError(sanitizeSheetsErrorMessage(error), { cause: error });
        }
        throw error;
      }
    },
  };
}

/**
 * Per-feature composition root for `DocumentLog` (`LogSchemaRegistryAdapter`,
 * thin Drive/Sheets adapters, default `DocumentLogService`, and per-request factory).
 */
export function createDocumentLogWiring(
  options: DocumentLogWiringOptions = {}
): DocumentLogWiring {
  const handlebars = new HandlebarsAdapter();
  const templateParser =
    options.templateParser ?? resolveTemplateParser(options.templateEvaluator) ?? handlebars;
  const templateEvaluator = resolveTemplateEvaluator(options.templateEvaluator) ?? handlebars;

  const logSchemaRegistry: LogSchemaRegistryPort =
    options.logSchemaRegistry ??
    new LogSchemaRegistryAdapter(options.manifestProvider, templateParser);

  const driveConfigProvider: AppConfigurationProviderPort | undefined =
    options.configProvider && typeof options.configProvider.getDriveConfig === 'function'
      ? (options.configProvider as AppConfigurationProviderPort)
      : undefined;

  const sheetsConfigProvider: SheetsConfigProvider | undefined =
    options.configProvider && typeof options.configProvider.getSheetsConfig === 'function'
      ? (options.configProvider as SheetsConfigProvider)
      : undefined;

  const defaultDriveClient =
    options.driveClient ?? new GoogleDriveClient({ configProvider: driveConfigProvider });
  const defaultSheetsClient =
    options.sheetsClient ?? new GoogleSheetsClient({ configProvider: sheetsConfigProvider });

  const documentLogService: DocumentLogPort =
    options.documentLogService ??
    new DocumentLogService(
      logSchemaRegistry,
      createDriveDiscoveryAdapter(defaultDriveClient),
      createSheetsStorageAdapter(defaultSheetsClient),
      templateEvaluator,
      templateParser
    );

  const buildDocumentLogService = (
    context: WorkspaceExecutionContext,
    overrides?: DocumentLogServiceRequestOverrides,
    memoizeResolvePerInstance = false
  ): DocumentLogPort => {
    if (overrides?.documentLogService) {
      return overrides.documentLogService;
    }
    if (options.documentLogService) {
      return options.documentLogService;
    }

    const rawCredential = context.userOAuthToken ?? context.gmail?.accessToken;
    const requestAuth = rawCredential ? createOAuth2Client(rawCredential) : undefined;

    const reqDriveClient =
      overrides?.driveClient ??
      (requestAuth
        ? new GoogleDriveClient({ auth: requestAuth, configProvider: driveConfigProvider })
        : defaultDriveClient);

    const reqSheetsClient =
      overrides?.sheetsClient ??
      options.sheetsClient ??
      (requestAuth
        ? new GoogleSheetsClient({ auth: requestAuth, configProvider: sheetsConfigProvider })
        : defaultSheetsClient);

    return new DocumentLogService(
      logSchemaRegistry,
      createDriveDiscoveryAdapter(reqDriveClient),
      createSheetsStorageAdapter(reqSheetsClient),
      templateEvaluator,
      templateParser,
      memoizeResolvePerInstance ? { memoizeResolvePerInstance: true } : undefined
    );
  };

  const createDocumentLogService: DocumentLogServiceFactory = (
    context: WorkspaceExecutionContext,
    overrides?: DocumentLogServiceRequestOverrides
  ): DocumentLogPort => buildDocumentLogService(context, overrides, false);

  const createActivityHandler = (
    handlerOptions?: DocumentLogActivityHandlerOptions
  ): ActivityHandler => new DocumentLogActivityHandler(documentLogService, handlerOptions);

  const perRequestServices = new WeakMap<WorkspaceExecutionContext, DocumentLogPort>();
  const perRequestUiContextAdapters = new WeakMap<WorkspaceExecutionContext, UiContextQueryPort>();

  const getPerRequestService = (
    context: WorkspaceExecutionContext,
    overrides?: DocumentLogServiceRequestOverrides
  ): DocumentLogPort => {
    const hasServiceOverrides =
      overrides?.documentLogService !== undefined ||
      overrides?.driveClient !== undefined ||
      overrides?.sheetsClient !== undefined;
    if (hasServiceOverrides) {
      return buildDocumentLogService(context, overrides, true);
    }
    let service = perRequestServices.get(context);
    if (!service) {
      service = buildDocumentLogService(context, undefined, true);
      perRequestServices.set(context, service);
    }
    return service;
  };

  const createPerRequestActivityHandler: DocumentLogActivityHandlerFactory = (
    context: WorkspaceExecutionContext,
    overrides?: DocumentLogServiceRequestOverrides
  ): ActivityHandler => {
    const effectiveSelectedLogId = overrides?.selectedLogId ?? context.selectedLogId;
    return new DocumentLogActivityHandler(getPerRequestService(context, overrides), {
      ...(effectiveSelectedLogId !== undefined ? { selectedLogId: effectiveSelectedLogId } : {}),
      ...(overrides?.onWriteLogSuccess !== undefined
        ? { onWriteLogSuccess: overrides.onWriteLogSuccess }
        : {}),
    });
  };

  const createUiProcessDocumentLogPort: DocumentLogWiring['createUiProcessDocumentLogPort'] = async (
    context,
    portOptions
  ) => {
    if (portOptions?.ensureInitialized) {
      await portOptions.ensureInitialized();
    }
    return createUiProcessDocumentLogAdapter(getPerRequestService(context, portOptions?.overrides));
  };

  const buildUiContextQueryAdapter = (
    context: WorkspaceExecutionContext,
    portOptions: Parameters<DocumentLogWiring['createUiContextQueryPort']>[1]
  ): UiContextQueryPort =>
    new UiContextQueryAdapter({
      documentLogService: getPerRequestService(context, portOptions.overrides),
      getDocumentSpaceService: portOptions.getDocumentSpaceService,
      ...(portOptions.ensureInitialized !== undefined
        ? { ensureInitialized: portOptions.ensureInitialized }
        : {}),
    });

  const createUiContextQueryPort: DocumentLogWiring['createUiContextQueryPort'] = (
    context,
    portOptions
  ) => {
    if (portOptions.overrides !== undefined) {
      return buildUiContextQueryAdapter(context, portOptions);
    }
    let adapter = perRequestUiContextAdapters.get(context);
    if (!adapter) {
      adapter = buildUiContextQueryAdapter(context, portOptions);
      perRequestUiContextAdapters.set(context, adapter);
    }
    return adapter;
  };

  return {
    logSchemaRegistry,
    documentLogService,
    createDocumentLogService,
    getPerRequestService,
    createActivityHandler,
    createPerRequestActivityHandler,
    createUiProcessDocumentLogPort,
    createUiContextQueryPort,
  };
}

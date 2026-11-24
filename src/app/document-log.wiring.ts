import { OAuth2Client } from 'google-auth-library';
import {
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
  GoogleSheetsClient,
  type RowRecord,
  type SheetsClient,
  type SheetsConfigProvider,
} from '../infrastructure/sheets';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';

export interface DocumentLogServiceRequestOverrides {
  driveClient?: GoogleDriveClient | undefined;
  sheetsClient?: SheetsClient | undefined;
  documentLogService?: DocumentLogPort | undefined;
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
  createActivityHandler: (options?: DocumentLogActivityHandlerOptions) => ActivityHandler;
  createPerRequestActivityHandler: DocumentLogActivityHandlerFactory;
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
  };
}

function createSheetsStorageAdapter(sheetsClient: SheetsClient): LogStoragePort {
  return {
    insertRow: async (request) =>
      sheetsClient.insertIntoGroupedList({
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
      }),
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
      templateEvaluator
    );

  const createDocumentLogService: DocumentLogServiceFactory = (
    context: WorkspaceExecutionContext,
    overrides?: DocumentLogServiceRequestOverrides
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
      templateEvaluator
    );
  };

  const createActivityHandler = (
    handlerOptions?: DocumentLogActivityHandlerOptions
  ): ActivityHandler => new DocumentLogActivityHandler(documentLogService, handlerOptions);

  const createPerRequestActivityHandler: DocumentLogActivityHandlerFactory = (
    context: WorkspaceExecutionContext,
    overrides?: DocumentLogServiceRequestOverrides
  ): ActivityHandler =>
    new DocumentLogActivityHandler(createDocumentLogService(context, overrides), {
      ...(context.selectedLogId !== undefined ? { selectedLogId: context.selectedLogId } : {}),
    });

  return {
    logSchemaRegistry,
    documentLogService,
    createDocumentLogService,
    createActivityHandler,
    createPerRequestActivityHandler,
  };
}

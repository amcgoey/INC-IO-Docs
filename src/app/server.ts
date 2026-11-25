import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createHttpServer, type HttpServer } from '../infrastructure/http';
import { AppManifestProvider } from '../infrastructure/manifest/app-manifest-provider';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { GoogleDocsClient } from '../infrastructure/docs';
import { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import {
  createDocumentFeatureWiring,
  wireDocumentServicesAndRoutes,
  type InjectedDocumentService,
} from './document.wiring';
import { createDocumentSpaceFeatureWiring } from './document-space.wiring';
import { wireWorkspaceAddonRoutes } from './workspace-addon.wiring';
import { createSourceParserWiring } from './source-parser.wiring';
import { createDocumentLogWiring } from './document-log.wiring';
import type { PdfProcessor } from '../infrastructure/pdf/pdf-processor';
import type { SheetsClient, SheetsConfigProvider } from '../infrastructure/sheets';
import type { DocumentLogPort, LogSchemaRegistryPort } from '../features/document-log/ports';

import type { DocumentSpaceService } from '../features/document-space/domain';
import type {
  RawManifestProviderPort as SpaceRawManifestProviderPort,
  DocumentSpaceUiSchemaQueryPort,
  DocumentSpaceStoragePort,
} from '../features/document-space/ports';
import type {
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  DriveServicePort,
  DocumentSchemaRegistryPort,
  CompiledSchemaRegistryPort,
  TemplateEvaluatorPort,
  RawManifestProviderPort,
} from '../features/document/ports';
import type {
  WorkspaceAuthVerifierPort,
} from '../infrastructure/workspace-addon/api';
import type { WorkspaceConfigProviderPort } from '../infrastructure/workspace-addon/config';
import type { DriveSourceContextClientPort } from '../features/source-parser/ports';

export type CompositeManifestProvider =
  AppConfigurationProviderPort &
  WorkspaceConfigProviderPort &
  RawManifestProviderPort &
  SpaceRawManifestProviderPort &
  Partial<SheetsConfigProvider>;

export interface AppOptions {
  manifestProvider?: CompositeManifestProvider | undefined;
  manifestPath?: string | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  authVerifier?: WorkspaceAuthVerifierPort | undefined;
  driveService?: DriveServicePort | undefined;
  driveContextClient?: DriveSourceContextClientPort | undefined;
  gmailClient?: GoogleGmailClient | undefined;
  storageAdapter?: DocumentSpaceStoragePort | undefined;
  documentSpaceStoragePort?: DocumentSpaceStoragePort | undefined;
  documentSpaceService?: DocumentSpaceService | undefined;
  documentService?: InjectedDocumentService | undefined;
  sheetsClient?: SheetsClient | undefined;
  documentLogService?: DocumentLogPort | undefined;
  authorizationUrl?: string | undefined;
  logger?: boolean | undefined;
  skipSpaceValidation?: boolean | undefined;
  appBaseUrl?: string | undefined;
  pdfProcessor?: PdfProcessor | undefined;
  docsClient?: GoogleDocsClient | undefined;
}

export interface AppInstance {
  server: HttpServer;
  documentService: InjectedDocumentService;
  documentSpaceService: DocumentSpaceService;
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
  documentSpaceUiSchemaQuery?: DocumentSpaceUiSchemaQueryPort | undefined;
  documentLogService?: DocumentLogPort | undefined;
  logSchemaRegistry?: LogSchemaRegistryPort | undefined;
  initialize: () => Promise<void>;
  start: (port?: number, host?: string) => Promise<void>;
}

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

export function createApp(options?: AppOptions): AppInstance {
  const server = createHttpServer(options?.logger !== undefined ? { logger: options.logger } : {});
  const templateEvaluator = options?.templateEvaluator ?? new HandlebarsAdapter();

  let manifestProvider = options?.manifestProvider;
  if (!manifestProvider) {
    const manifestPath = options?.manifestPath ?? process.env.APP_MANIFEST_PATH;
    if (!options?.documentSchemaRegistry && !manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable.'
      );
    }
    if (manifestPath) {
      manifestProvider = new AppManifestProvider({ manifestPath });
    }
  }

  let documentSchemaRegistry: DocumentSchemaRegistryPort | undefined =
    options?.documentSchemaRegistry;
  let compiledSchemaRegistry: CompiledSchemaRegistryPort | undefined =
    options?.compiledSchemaRegistry;

  if (manifestProvider) {
    const documentWiring = createDocumentFeatureWiring({
      manifestProvider,
      templateEvaluator,
      documentSchemaRegistry: options?.documentSchemaRegistry,
      compiledSchemaRegistry: options?.compiledSchemaRegistry,
    });
    documentSchemaRegistry = documentWiring.documentSchemaRegistry;
    compiledSchemaRegistry = documentWiring.compiledSchemaRegistry;
  }

  if (!documentSchemaRegistry) {
    throw new Error('DocumentSchemaRegistry could not be initialized.');
  }

  const driveClient = new GoogleDriveClient({ configProvider: manifestProvider });

  const defaultAppConfigProvider: AppConfigurationProviderPort = {
    getDriveConfig: async () => undefined,
  };

  const defaultSpaceRawManifestProvider: SpaceRawManifestProviderPort = {
    getRawManifest: async () => ({}),
  };

  const documentLogWiring = createDocumentLogWiring({
    manifestProvider,
    driveClient,
    sheetsClient: options?.sheetsClient,
    configProvider: manifestProvider ?? defaultAppConfigProvider,
    templateEvaluator,
    documentLogService: options?.documentLogService,
  });

  const documentService = wireDocumentServicesAndRoutes({
    server,
    driveClient,
    configProvider: manifestProvider ?? defaultAppConfigProvider,
    documentSchemaRegistry,
    templateEvaluator,
    driveService: options?.driveService,
    activityEngine: options?.activityEngine,
    documentService: options?.documentService,
    compiledSchemaRegistry,
    additionalActivityHandlers: [documentLogWiring.createActivityHandler()],
  });

  const storageAdapter = options?.storageAdapter ?? options?.documentSpaceStoragePort;
  const documentSpaceWiring = createDocumentSpaceFeatureWiring({
    rawManifestProvider: manifestProvider ?? defaultSpaceRawManifestProvider,
    storageAdapter,
    driveClient: storageAdapter ? undefined : driveClient,
  });
  const documentSpaceService =
    options?.documentSpaceService ??
    documentSpaceWiring.documentSpaceService;

  const appBaseUrl = options?.appBaseUrl ?? process.env.APP_BASE_URL;

  const gmailClient = options?.gmailClient ?? new GoogleGmailClient();

  const spaceTypesProvider =
    documentSpaceService ??
    documentSpaceWiring.documentSpaceRegistry ?? {
      getAllTypes: () => [],
    };

  const sourceParserWiring = createSourceParserWiring({
    spaceTypesProvider,
    manifestProvider,
    driveClient,
    driveContextClient: options?.driveContextClient,
    configProvider: manifestProvider ?? defaultAppConfigProvider,
    workspaceConfigProvider: manifestProvider,
    templateEvaluator,
    ...(options?.pdfProcessor !== undefined ? { pdfProcessor: options.pdfProcessor } : {}),
    ...(options?.docsClient !== undefined ? { docsClient: options.docsClient } : {}),
  });

  wireWorkspaceAddonRoutes({
    server,
    documentService: options?.documentService,
    documentSpaceService: options?.documentSpaceService,
    authVerifier: options?.authVerifier,
    configProvider: manifestProvider,
    manifestProvider,
    appBaseUrl,
    compiledSchemaRegistry,
    documentSchemaRegistry,
    templateEvaluator,
    driveClient,
    gmailClient,
    documentSpaceRegistry: documentSpaceWiring.documentSpaceRegistry,
    storageAdapter,
    pdfProcessor: options?.pdfProcessor,
    driveContextClient: options?.driveContextClient,
    ...(options?.docsClient !== undefined ? { docsClient: options.docsClient } : {}),
    ...(options?.sheetsClient !== undefined ? { sheetsClient: options.sheetsClient } : {}),
    ...(options?.documentLogService !== undefined
      ? { documentLogService: options.documentLogService }
      : {}),
    documentLogWiring,
    createAdditionalActivityHandlers: (context) => [
      documentLogWiring.createPerRequestActivityHandler(context),
    ],
    sourceParser: sourceParserWiring.sourceParser,
    createSourceParser: sourceParserWiring.createSourceParser,
  });

  const initialize = async () => {
    await sourceParserWiring.parseSchemaRegistry.initialize();
    await documentLogWiring.logSchemaRegistry.initialize();
    if (compiledSchemaRegistry) {
      await compiledSchemaRegistry.initialize();
    }
    const maybeDocService = documentService as { initialize?: unknown };
    if (typeof maybeDocService.initialize === 'function') {
      await (maybeDocService as { initialize: () => Promise<unknown> }).initialize();
    }
    await documentSpaceService.initialize();
    const shouldSkipValidation =
      options?.skipSpaceValidation ??
      (process.env.SKIP_SPACE_VALIDATION === 'true' || process.env.NODE_ENV === 'production');
    if (!shouldSkipValidation) {
      const spaceErrors = await documentSpaceService.validateEndToEnd();
      if (spaceErrors.length > 0) {
        throw new Error(`Failed to validate DocumentSpaceTypes:\n${spaceErrors.join('\n')}`);
      }
    }
  };

  const start = async (port = 8080, host = '0.0.0.0') => {
    await initialize();
    await server.start(port, host);
  };

  return {
    server,
    documentService,
    documentSpaceService,
    documentSchemaRegistry,
    compiledSchemaRegistry,
    documentSpaceUiSchemaQuery: documentSpaceWiring.documentSpaceUiSchemaQuery,
    documentLogService: documentLogWiring.documentLogService,
    logSchemaRegistry: documentLogWiring.logSchemaRegistry,
    initialize,
    start,
  };
}

export const start = async (port = 8080, host = '0.0.0.0') => {
  try {
    const app = createApp({
      logger: true,
      skipSpaceValidation: process.env.SKIP_SPACE_VALIDATION === 'true' || process.env.NODE_ENV === 'production',
    });
    await app.start(port, host);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}

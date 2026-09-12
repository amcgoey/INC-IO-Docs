import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createHttpServer, type HttpServer } from '../infrastructure/http';
import { registerDocumentFeatureRoutes } from '../features/document/adapters/api';
import { registerWorkspaceFeatureRoutes } from '../features/workspace/adapters/api';
import { ActivityEngine } from '../features/document/adapters/activity-engine';
import { DriveActivityHandler } from '../features/document/adapters/drive-activity-handler';
import { DriveServiceAdapter } from '../features/document/adapters/drive-service-adapter';
import { DocumentSchemaRegistryAdapter } from '../features/document/adapters/document-schema-registry';
import { AppManifestProvider } from '../infrastructure/manifest/app-manifest-provider';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { DocumentService } from '../features/document/domain';
import { DocumentSpaceService } from '../features/document-space/domain';
import { GoogleDriveStorageAdapter } from '../features/document-space/adapters/google-drive-storage-adapter';
import { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';
import type { RawManifestProviderPort } from '../features/document-space/ports';
import type {
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  DriveServicePort,
  DocumentSchemaRegistryPort,
  SchemaQueryPort,
  TemplateEvaluatorPort,
} from '../features/document/ports';
import type {
  AuthVerifierPort,
  WorkspaceConfigProviderPort,
} from '../features/workspace/ports';
import type { WorkspaceUiBuilderPort } from '../features/workspace/adapters/ui-builder';
import * as uiBlocks from '../infrastructure/workspace-addon/ui-blocks';

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

export interface AppOptions {
  manifestProvider?: AppManifestProvider | undefined;
  manifestPath?: string | undefined;
  documentSchemaRegistry?: (DocumentSchemaRegistryPort & SchemaQueryPort) | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  authVerifier?: AuthVerifierPort | undefined;
  uiBuilder?: WorkspaceUiBuilderPort | undefined;
  driveService?: DriveServicePort | undefined;
  documentSpaceService?: DocumentSpaceService | undefined;
  authorizationUrl?: string | undefined;
  logger?: boolean | undefined;
  skipSpaceValidation?: boolean | undefined;
}

export interface AppInstance {
  server: HttpServer;
  documentService: DocumentService;
  documentSpaceService: DocumentSpaceService;
  documentSchemaRegistry: DocumentSchemaRegistryPort & SchemaQueryPort;
  initialize: () => Promise<void>;
  start: (port?: number, host?: string) => Promise<void>;
}

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

  const documentSchemaRegistry: DocumentSchemaRegistryPort & SchemaQueryPort =
    options?.documentSchemaRegistry ??
    new DocumentSchemaRegistryAdapter(manifestProvider!, templateEvaluator);

  const driveConfigProvider: AppConfigurationProviderPort | undefined = manifestProvider;
  const workspaceConfigProvider: WorkspaceConfigProviderPort | undefined = manifestProvider;

  const driveClient = new GoogleDriveClient({ configProvider: driveConfigProvider });

  const driveService: DriveServicePort =
    options?.driveService ??
    new DriveServiceAdapter(driveClient);

  const driveActivityHandler = new DriveActivityHandler(driveService, {
    configProvider: driveConfigProvider,
  });
  const activityEngine = options?.activityEngine ?? new ActivityEngine([driveActivityHandler]);
  const documentService = new DocumentService(activityEngine, documentSchemaRegistry, templateEvaluator);

  const rawManifestProvider: RawManifestProviderPort =
    manifestProvider ?? {
      getRawManifest: async () => ({}),
    };
  const documentSpaceRegistry = new DocumentSpaceManifestRegistryAdapter(rawManifestProvider);
  const documentSpaceStorage = new GoogleDriveStorageAdapter(driveClient);
  const documentSpaceService =
    options?.documentSpaceService ??
    new DocumentSpaceService(documentSpaceRegistry, documentSpaceStorage);

  const authVerifier: AuthVerifierPort = options?.authVerifier ?? new GoogleJwtVerifier();
  const uiBuilder: WorkspaceUiBuilderPort = options?.uiBuilder ?? uiBlocks;

  registerDocumentFeatureRoutes(server, { service: documentService, schemaQuery: documentSchemaRegistry });
  registerWorkspaceFeatureRoutes(server, {
    authVerifier,
    uiBuilder,
    documentService,
    schemaQuery: documentSchemaRegistry,
    documentSpaceService,
    configProvider: workspaceConfigProvider,
  });

  const initialize = async () => {
    await documentService.initialize();
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

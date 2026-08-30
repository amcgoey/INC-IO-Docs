import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createHttpServer, type HttpServer } from '../infrastructure/http';
import { registerDocumentFeatureRoutes } from '../features/document/adapters/api';
import { registerWorkspaceFeatureRoutes } from '../features/workspace/adapters/api';
import { ActivityEngine } from '../features/document/adapters/activity-engine';
import { DriveActivityHandler } from '../features/document/adapters/drive-activity-handler';
import { ManifestRegistryAdapter } from '../features/document/adapters/manifest-registry';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { DocumentService } from '../features/document/domain';
import type {
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  DriveServicePort,
  ManifestRegistryPort,
  TemplateEvaluatorPort,
} from '../features/document/ports';
import type { AuthVerifierPort, WorkspaceConfigProviderPort } from '../features/workspace/ports';

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

export interface AppOptions {
  manifestRegistry?: ManifestRegistryPort | undefined;
  manifestPath?: string | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  authVerifier?: AuthVerifierPort | undefined;
  driveService?: DriveServicePort | undefined;
  authorizationUrl?: string | undefined;
  logger?: boolean | undefined;
}

export interface AppInstance {
  server: HttpServer;
  documentService: DocumentService;
  initialize: () => Promise<void>;
  start: (port?: number, host?: string) => Promise<void>;
}

export function createApp(options?: AppOptions): AppInstance {
  const server = createHttpServer(options?.logger !== undefined ? { logger: options.logger } : {});
  const templateEvaluator = options?.templateEvaluator ?? new HandlebarsAdapter();

  let manifestRegistry = options?.manifestRegistry;
  if (!manifestRegistry) {
    const manifestPath = options?.manifestPath ?? process.env.APP_MANIFEST_PATH;
    if (!manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable.'
      );
    }
    manifestRegistry = new ManifestRegistryAdapter({ manifestPath, templateEvaluator });
  }

  const driveConfigProvider =
    manifestRegistry && 'getDriveConfig' in manifestRegistry
      ? (manifestRegistry as AppConfigurationProviderPort)
      : undefined;

  const workspaceConfigProvider =
    manifestRegistry && 'getWorkspaceConfig' in manifestRegistry
      ? (manifestRegistry as WorkspaceConfigProviderPort)
      : undefined;

  const driveService: DriveServicePort =
    options?.driveService ?? new GoogleDriveClient({ configProvider: driveConfigProvider });

  const driveActivityHandler = new DriveActivityHandler(driveService, {
    configProvider: driveConfigProvider,
  });
  const activityEngine = options?.activityEngine ?? new ActivityEngine([driveActivityHandler]);
  const documentService = new DocumentService(activityEngine, manifestRegistry, templateEvaluator);

  const authVerifier: AuthVerifierPort = options?.authVerifier ?? new GoogleJwtVerifier();

  registerDocumentFeatureRoutes(server, { service: documentService, schemaQuery: documentService });
  registerWorkspaceFeatureRoutes(server, {
    authVerifier,
    documentService,
    configProvider: workspaceConfigProvider,
    authorizationUrl:
      options?.authorizationUrl ??
      process.env.GOOGLE_WORKSPACE_AUTH_URL ??
      process.env.WORKSPACE_AUTH_URL,
  });



  const initialize = async () => {
    await documentService.initialize();
  };

  const start = async (port = 8080, host = '0.0.0.0') => {
    await initialize();
    await server.start(port, host);
  };

  return {
    server,
    documentService,
    initialize,
    start,
  };
}

export const start = async (port = 8080, host = '0.0.0.0') => {
  try {
    const app = createApp({ logger: true });
    await app.start(port, host);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}

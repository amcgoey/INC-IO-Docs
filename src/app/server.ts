import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createSharedInfrastructure, type SharedInfrastructure } from './shared.wiring';
import { createDocumentFeatureWiring, wireDocumentServicesAndRoutes } from './document.wiring';
import { createDocumentSpaceFeatureWiring } from './document-space.wiring';
import { wireWorkspaceFeature } from './workspace.wiring';

import type { DocumentService } from '../features/document/domain';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type {
  RawManifestProviderPort,
  DocumentSpaceUiSchemaQueryPort,
} from '../features/document-space/ports';
import type {
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  DriveServicePort,
  DocumentSchemaRegistryPort,
  SchemaQueryPort,
  TemplateEvaluatorPort,
  DocumentUiSchemaQueryPort,
} from '../features/document/ports';
import type {
  AuthVerifierPort,
  WorkspaceConfigProviderPort,
} from '../features/workspace/ports';

// We import the HTTP server port from shared.wiring to avoid leaking infrastructure paths
import type { HttpServer } from './shared.wiring';

// Import only the ports for options to avoid leaking adapter/infra types.
// We make a small concession to backwards compatibility if an adapter type was leaked,
// but the test suites can pass mocks that satisfy the ports.
export interface AppOptions {
  manifestProvider?: (AppConfigurationProviderPort & WorkspaceConfigProviderPort & RawManifestProviderPort) | undefined;
  manifestPath?: string | undefined;
  documentSchemaRegistry?: (DocumentSchemaRegistryPort & SchemaQueryPort) | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  authVerifier?: AuthVerifierPort | undefined;
  uiBuilder?: any | undefined;
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
  documentUiSchemaQuery?: DocumentUiSchemaQueryPort | undefined;
  documentSpaceUiSchemaQuery?: DocumentSpaceUiSchemaQueryPort | undefined;
  documentUiBlock?: any | undefined;
  initialize: () => Promise<void>;
  start: (port?: number, host?: string) => Promise<void>;
}

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

export function createApp(options?: AppOptions): AppInstance {
  // 1. Shared Infrastructure
  if (!options?.documentSchemaRegistry && !options?.manifestProvider && !options?.manifestPath && !process.env.APP_MANIFEST_PATH) {
    throw new Error(
      "Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable."
    );
  }

  const sharedInfra = createSharedInfrastructure({
    logger: options?.logger,
    manifestPath: options?.manifestPath,
    manifestProvider: options?.manifestProvider,
    templateEvaluator: options?.templateEvaluator,
  });

  const { server, templateEvaluator, manifestProvider, driveClient } = sharedInfra;

  // 2. Document Feature - Schemas
  let documentSchemaRegistry: (DocumentSchemaRegistryPort & SchemaQueryPort) | undefined =
    options?.documentSchemaRegistry;
  let documentWiring: ReturnType<typeof createDocumentFeatureWiring> | undefined = undefined;

  if (manifestProvider) {
    documentWiring = createDocumentFeatureWiring({
      manifestProvider,
      templateEvaluator,
      documentSchemaRegistry: options?.documentSchemaRegistry,
    });
    documentSchemaRegistry = documentWiring.documentSchemaRegistry;
  }

  if (!documentSchemaRegistry) {
    throw new Error("DocumentSchemaRegistry could not be initialized.");
  }

  const configProvider = manifestProvider ?? { getAppConfig: async () => ({}) };
  const rawManifestProvider = manifestProvider ?? { getRawManifest: async () => ({}) };

  // 3. Document Feature - Services & Routes
  const documentService = wireDocumentServicesAndRoutes({
    server,
    driveClient,
    configProvider: configProvider as AppConfigurationProviderPort,
    documentSchemaRegistry,
    templateEvaluator,
    driveService: options?.driveService,
    activityEngine: options?.activityEngine,
  });

  // 4. Document Space Feature
  const documentSpaceWiring = createDocumentSpaceFeatureWiring({
    rawManifestProvider: rawManifestProvider as RawManifestProviderPort,
    driveClient,
  });
  const documentSpaceService =
    options?.documentSpaceService ??
    documentSpaceWiring.documentSpaceService;

  // 5. Workspace Feature
  wireWorkspaceFeature({
    server,
    documentService,
    documentSpaceService,
    documentSchemaRegistry,
    authVerifier: options?.authVerifier,
    uiBuilder: options?.uiBuilder,
    configProvider: manifestProvider,
  });

  const initialize = async () => {
    await documentService.initialize();
    await documentSpaceService.initialize();
    const shouldSkipValidation =
      options?.skipSpaceValidation ??
      (process.env.SKIP_SPACE_VALIDATION === "true" || process.env.NODE_ENV === "production");
    if (!shouldSkipValidation) {
      const spaceErrors = await documentSpaceService.validateEndToEnd();
      if (spaceErrors.length > 0) {
        throw new Error(`Failed to validate DocumentSpaceTypes:\n${spaceErrors.join("\n")}`);
      }
    }
  };

  const start = async (port = 8080, host = "0.0.0.0") => {
    await initialize();
    await server.start(port, host);
  };

  return {
    server,
    documentService,
    documentSpaceService,
    documentSchemaRegistry,
    documentUiSchemaQuery: documentWiring?.documentUiSchemaQuery,
    documentSpaceUiSchemaQuery: documentSpaceWiring.documentSpaceUiSchemaQuery,
    documentUiBlock: documentWiring?.documentUiBlock,
    initialize,
    start,
  };
}

export const start = async (port = 8080, host = "0.0.0.0") => {
  try {
    const app = createApp({
      logger: true,
      skipSpaceValidation: process.env.SKIP_SPACE_VALIDATION === "true" || process.env.NODE_ENV === "production",
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


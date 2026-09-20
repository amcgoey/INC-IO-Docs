import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createHttpServer, type HttpServer } from '../infrastructure/http';
import { AppManifestProvider } from '../infrastructure/manifest/app-manifest-provider';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { createDocumentFeatureWiring, wireDocumentServicesAndRoutes } from './document.wiring';
import { createDocumentSpaceFeatureWiring } from './document-space.wiring';
import { wireWorkspaceAddonRoutes } from './workspace-addon.wiring';

import type { DocumentService } from '../features/document/domain';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type {
  RawManifestProviderPort as SpaceRawManifestProviderPort,
  DocumentSpaceUiSchemaQueryPort,
} from '../features/document-space/ports';
import type {
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  DriveServicePort,
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  RawManifestProviderPort,
} from '../features/document/ports';
import type {
  WorkspaceAuthVerifierPort,
  WorkspaceConfigProviderPort,
} from '../infrastructure/workspace-addon/api';

export type CompositeManifestProvider =
  AppConfigurationProviderPort &
  WorkspaceConfigProviderPort &
  RawManifestProviderPort &
  SpaceRawManifestProviderPort;

export interface AppOptions {
  manifestProvider?: CompositeManifestProvider | undefined;
  manifestPath?: string | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  authVerifier?: WorkspaceAuthVerifierPort | undefined;
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
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  documentSpaceUiSchemaQuery?: DocumentSpaceUiSchemaQueryPort | undefined;
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
    throw new Error('DocumentSchemaRegistry could not be initialized.');
  }

  const driveClient = new GoogleDriveClient({ configProvider: manifestProvider });

  const defaultAppConfigProvider: AppConfigurationProviderPort = {
    getDriveConfig: async () => undefined,
  };

  const defaultSpaceRawManifestProvider: SpaceRawManifestProviderPort = {
    getRawManifest: async () => ({}),
  };

  const documentService = wireDocumentServicesAndRoutes({
    server,
    driveClient,
    configProvider: manifestProvider ?? defaultAppConfigProvider,
    documentSchemaRegistry,
    templateEvaluator,
    driveService: options?.driveService,
    activityEngine: options?.activityEngine,
  });

  const documentSpaceWiring = createDocumentSpaceFeatureWiring({
    rawManifestProvider: manifestProvider ?? defaultSpaceRawManifestProvider,
    driveClient,
  });
  const documentSpaceService =
    options?.documentSpaceService ??
    documentSpaceWiring.documentSpaceService;

  wireWorkspaceAddonRoutes({
    server,
    documentService,
    documentSpaceService,
    authVerifier: options?.authVerifier,
    configProvider: manifestProvider,
    manifestProvider,
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
    documentSpaceUiSchemaQuery: documentSpaceWiring.documentSpaceUiSchemaQuery,
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

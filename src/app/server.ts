import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createHttpServer, type HttpServer } from '../infrastructure/http';
import { registerRecordFeatureRoutes } from '../features/record/adapters/api';
import { registerWorkspaceFeatureRoutes } from '../features/workspace/adapters/api';
import { ActivityEngine } from '../features/record/adapters/activity-engine';
import { DriveActivityHandler } from '../features/record/adapters/drive-activity-handler';
import { ManifestRegistryAdapter } from '../features/record/adapters/manifest-registry';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { RecordService } from '../features/record/domain';
import type {
  ActivityDispatcherPort,
  DriveServicePort,
  ManifestRegistryPort,
  TemplateEvaluatorPort,
} from '../features/record/ports';
import type { AuthVerifierPort } from '../features/workspace/ports';

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

export interface AppOptions {
  manifestRegistry?: ManifestRegistryPort | undefined;
  manifestPath?: string | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  authVerifier?: AuthVerifierPort | undefined;
  driveService?: DriveServicePort | undefined;
  logger?: boolean | undefined;
}

export interface AppInstance {
  server: HttpServer;
  recordService: RecordService;
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

  const driveService: DriveServicePort =
    options?.driveService ?? new GoogleDriveClient();

  const driveActivityHandler = new DriveActivityHandler(driveService);
  const activityEngine = options?.activityEngine ?? new ActivityEngine([driveActivityHandler]);
  const recordService = new RecordService(activityEngine, manifestRegistry, templateEvaluator);

  const authVerifier: AuthVerifierPort = options?.authVerifier ?? new GoogleJwtVerifier();

  registerRecordFeatureRoutes(server, { service: recordService, schemaQuery: recordService });
  registerWorkspaceFeatureRoutes(server, {
    authVerifier,
    recordService,
  });

  const initialize = async () => {
    await recordService.initialize();
  };

  const start = async (port = 8080, host = '0.0.0.0') => {
    await initialize();
    await server.start(port, host);
  };

  return {
    server,
    recordService,
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

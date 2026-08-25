import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createHttpServer, type HttpServer } from '../infrastructure/http';
import { registerRecordFeatureRoutes } from '../features/record/adapters/api';
import { ActivityEngine } from '../features/record/adapters/activity-engine';
import { ManifestRegistryAdapter } from '../features/record/adapters/manifest-registry';
import { RecordService } from '../features/record/domain';
import type { ActivityDispatcherPort, ManifestRegistryPort } from '../features/record/ports';

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

export interface AppOptions {
  manifestRegistry?: ManifestRegistryPort;
  manifestPath?: string;
  activityEngine?: ActivityDispatcherPort;
  logger?: boolean;
}

export interface AppInstance {
  server: HttpServer;
  recordService: RecordService;
  initialize: () => Promise<void>;
  start: (port?: number, host?: string) => Promise<void>;
}

export function createApp(options?: AppOptions): AppInstance {
  const server = createHttpServer({ logger: options?.logger ?? false });

  let manifestRegistry = options?.manifestRegistry;
  if (!manifestRegistry) {
    const manifestPath = options?.manifestPath ?? process.env.APP_MANIFEST_PATH;
    if (!manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable.'
      );
    }
    manifestRegistry = new ManifestRegistryAdapter({ manifestPath });
  }

  const activityEngine = options?.activityEngine ?? new ActivityEngine();
  const recordService = new RecordService(activityEngine, manifestRegistry);
  registerRecordFeatureRoutes(server, { service: recordService, schemaQuery: recordService });

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




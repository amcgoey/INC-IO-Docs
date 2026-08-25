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

  // Basic POST route for the Add-on homepage
  server.registerRoute({
    method: 'POST',
    url: '/onDocsHomepage',
    handler: async () => {
      // A typical Google Workspace Add-on response returning a homepage card
      const response = {
        action: {
          navigations: [
            {
              pushCard: {
                header: {
                  title: 'Welcome to INC-IO Add-on',
                },
                sections: [
                  {
                    widgets: [
                      {
                        textParagraph: {
                          text: 'This is the homepage of the Add-on.',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      };

      return {
        status: 200,
        body: response,
      };
    },
  });

  const manifestRegistry = options?.manifestRegistry ?? new ManifestRegistryAdapter();
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

const defaultApp = createApp({ logger: true });
const { server, recordService } = defaultApp;

// Start the server
const start = async () => {
  try {
    await defaultApp.start(8080, '0.0.0.0');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}

export { server, recordService };



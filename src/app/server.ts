import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { createHttpServer } from '../infrastructure/http';
import { registerRecordRoutes } from '../features/record/adapters/http';
import { ActivityEngine } from '../features/record/adapters/activity-engine';
import { RecordService } from '../features/record/domain';

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

const server = createHttpServer({ logger: true });

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

// Register feature routes
const activityEngine = new ActivityEngine();
const recordService = new RecordService(activityEngine);
registerRecordRoutes(server, { service: recordService });

// Start the server
const start = async () => {
  try {
    await server.start(8080, '0.0.0.0');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}

export { server };

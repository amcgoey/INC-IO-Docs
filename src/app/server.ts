import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { recordRoutes } from '../features/record/adapters/http';
import { ActivityEngine } from '../features/record/adapters/activity-engine';
import { RecordService } from '../features/record/domain';

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

const fastify = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

// Auth is handled by Cloud Run IAM

// Basic POST route for the Add-on homepage
fastify.post('/onDocsHomepage', async (_request: FastifyRequest, reply: FastifyReply) => {
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
  
  return reply.send(response);
});

// Register feature routes
const activityEngine = new ActivityEngine();
const recordService = new RecordService(activityEngine);
void fastify.register(recordRoutes, { service: recordService });


// Start the server
const start = async () => {
  try {
    await fastify.listen({ port: 8080, host: '0.0.0.0' });
    fastify.log.info(`Server is running on http://localhost:8080`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

if (require.main === module) {
  void start();
}

export { fastify };

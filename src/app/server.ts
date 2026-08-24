import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { recordRoutes } from '../features/record/adapters/http';

TypeSystemPolicy.ExactOptionalPropertyTypes = true;

const fastify = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();

// Initialize OAuth2 client
const oAuth2Client = new OAuth2Client();

const verifyGoogleAuth = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify the OIDC token
    const ticket = await oAuth2Client.verifyIdToken({
      idToken: token,
    });
    
    const payload = ticket.getPayload();
    
    // Attach payload to request context for use in routes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (request as any).user = payload;
  } catch (error) {
    fastify.log.error(error, 'Token verification failed:');
    return reply.code(401).send({ error: 'Unauthorized: Invalid Token' });
  }
};

// Basic POST route for the Add-on homepage
fastify.post('/onDocsHomepage', { preHandler: verifyGoogleAuth }, async (_request: FastifyRequest, reply: FastifyReply) => {
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
void fastify.register(recordRoutes);

// Example route using TypeBox schema for body validation
fastify.post('/api/documents', {
  schema: {
    body: Type.Object({
      title: Type.String(),
      projectId: Type.Number(),
    }),
  },
}, async (request, reply) => {
  // The request body is strictly typed here without manual casting!
  const { title, projectId } = request.body;
  
  return reply.send({
    success: true,
    message: `Document '${title}' created in project ${projectId}`,
  });
});

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

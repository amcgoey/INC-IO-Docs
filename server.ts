import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import { OAuth2Client } from 'google-auth-library';

const fastify = Fastify({ logger: true });

// Initialize OAuth2 client
const oAuth2Client = new OAuth2Client();

// Add-ons usually send an ID token in the authorization header as "Bearer <token>"
fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.split(' ')[1];
    
    // Verify the OIDC token
    const ticket = await oAuth2Client.verifyIdToken({
      idToken: token,
      // audience: 'YOUR_CLIENT_ID' // Uncomment and set to verify audience for your specific app
    });
    
    const payload = ticket.getPayload();
    
    // Attach payload to request context for use in routes
    (request as any).user = payload;
  } catch (error) {
    fastify.log.error(error, 'Token verification failed:');
    reply.code(401).send({ error: 'Unauthorized: Invalid Token' });
  }
});

// Basic POST route for the Add-on homepage
fastify.post('/onDocsHomepage', async (request: FastifyRequest, reply: FastifyReply) => {
  // A typical Google Workspace Add-on response returning a homepage card
  const response = {
    action: {
      navigations: [
        {
          pushCard: {
            header: {
              title: "Welcome to INC-IO Add-on"
            },
            sections: [
              {
                widgets: [
                  {
                    textParagraph: {
                      text: "This is the homepage of the Add-on."
                    }
                  }
                ]
              }
            ]
          }
        }
      ]
    }
  };
  
  return reply.send(response);
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
  start();
}

export { fastify };

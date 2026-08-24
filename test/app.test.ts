import { describe, it, expect, vi } from 'vitest';
import { fastify } from '../src/app/server';

// Mock the entire google-auth-library so we can bypass the token verification
vi.mock('google-auth-library', () => {
  return {
    OAuth2Client: class {
      verifyIdToken = vi.fn().mockResolvedValue({
        getPayload: vi.fn().mockReturnValue({ sub: 'user123', email: 'test@example.com' })
      });
    }
  };
});

describe('App routes', () => {
  it('POST /onDocsHomepage should return 200 with a valid token', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/onDocsHomepage',
      headers: {
        authorization: 'Bearer mocked-token-for-testing'
      }
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('action');
    expect(body.action).toHaveProperty('navigations');
  });
});

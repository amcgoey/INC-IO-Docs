import { describe, it, expect, vi, beforeAll } from 'vitest';
import { server, recordService } from '../src/app/server';

// Mock the entire google-auth-library so we can bypass the token verification
vi.mock('google-auth-library', () => {
  return {
    OAuth2Client: class {
      verifyIdToken = vi.fn().mockResolvedValue({
        getPayload: vi.fn().mockReturnValue({ sub: 'user123', email: 'test@example.com' }),
      });
    },
  };
});

describe('App routes', () => {
  beforeAll(async () => {
    await recordService.initialize();
  });

  it('POST /onDocsHomepage should return 200 with a valid token', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/onDocsHomepage',
      headers: {
        authorization: 'Bearer mocked-token-for-testing',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toHaveProperty('action');
    expect(body.action).toHaveProperty('navigations');
  });

  it('POST /records should return 200 for valid record payload', async () => {
    const validRecord = {
      id: 'doc-001',
      type: 'submittal',
      title: 'Foundation Spec',
    };

    const response = await server.inject({
      method: 'POST',
      url: '/records',
      payload: validRecord,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toEqual({
      success: true,
      data: validRecord,
      activity: {
        type: 'LOG_RECORD',
        payload: { record: validRecord },
      },
    });
  });

  it('POST /records should return 400 for invalid record payload', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/records',
      payload: {
        invalid: 'record payload',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body).toEqual({
      success: false,
      errors: expect.any(Array),
    });
  });

  it('GET /forms should return 200 with FormSchema list', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/forms',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toMatchObject({
      key: 'communication-project',
      name: 'Communication Project',
      recordSchema: expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({ key: 'Contact', type: 'string', required: true }),
        ]),
      }),
    });
  });
});



import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleJwtVerifier } from './jwt-verifier';
import type { OAuth2Client, LoginTicket, TokenPayload } from 'google-auth-library';

describe('GoogleJwtVerifier', () => {
  let mockOAuthClient: OAuth2Client;

  beforeEach(() => {
    mockOAuthClient = {
      verifyIdToken: vi.fn(),
    } as unknown as OAuth2Client;
  });

  it('returns valid when token is verified successfully', async () => {
    const mockPayload: TokenPayload = {
      iss: 'https://accounts.google.com',
      sub: '12345',
      aud: 'https://example.com/workspace/action',
      iat: 123456,
      exp: 234567,
      email: 'user@example.com',
    };

    const mockTicket = {
      getPayload: () => mockPayload,
    } as LoginTicket;

    (mockOAuthClient.verifyIdToken as ReturnType<typeof vi.fn>).mockResolvedValue(mockTicket);

    const verifier = new GoogleJwtVerifier({ client: mockOAuthClient });
    const result = await verifier.verifyToken('Bearer valid-id-token');

    expect(result.isValid).toBe(true);
    expect(result.payload).toEqual(mockPayload);
    expect(mockOAuthClient.verifyIdToken).toHaveBeenCalledWith({
      idToken: 'valid-id-token',
      audience: undefined,
    });
  });

  it('rejects when Authorization header is missing', async () => {
    const verifier = new GoogleJwtVerifier({ client: mockOAuthClient });
    const result = await verifier.verifyToken();

    expect(result.isValid).toBe(false);
    expect(result.error).toBe('Missing Authorization header');
  });

  it('rejects when Authorization header is not Bearer format', async () => {
    const verifier = new GoogleJwtVerifier({ client: mockOAuthClient });
    const result = await verifier.verifyToken('Basic user:pass');

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Expected Bearer <token>');
  });

  it('rejects when verifyIdToken throws verification error', async () => {
    (mockOAuthClient.verifyIdToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Token used too early or expired')
    );

    const verifier = new GoogleJwtVerifier({ client: mockOAuthClient });
    const result = await verifier.verifyToken('Bearer expired-token');

    expect(result.isValid).toBe(false);
    expect(result.error).toContain('Token used too early or expired');
  });

  it('skips verification when skipVerification is set to true', async () => {
    const verifier = new GoogleJwtVerifier({
      client: mockOAuthClient,
      skipVerification: true,
    });

    const result = await verifier.verifyToken();
    expect(result.isValid).toBe(true);
    expect(result.payload?.email).toBe('dev@example.com');
    expect(mockOAuthClient.verifyIdToken).not.toHaveBeenCalled();
  });
});

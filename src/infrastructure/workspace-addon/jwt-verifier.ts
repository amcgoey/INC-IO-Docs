import { OAuth2Client } from 'google-auth-library';

export interface VerifyJwtResult {
  isValid: boolean;
  payload?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface GoogleJwtVerifierOptions {
  client?: OAuth2Client | undefined;
  expectedAudience?: string | string[] | undefined;
  skipVerification?: boolean | undefined;
}

export class GoogleJwtVerifier {
  private readonly client: OAuth2Client;
  private readonly expectedAudience?: string | string[] | undefined;
  private readonly skipVerification: boolean;

  constructor(options: GoogleJwtVerifierOptions = {}) {
    this.client = options.client ?? new OAuth2Client();
    this.expectedAudience = options.expectedAudience;
    this.skipVerification = options.skipVerification ?? (process.env.SKIP_JWT_VERIFICATION === 'true');
  }

  async verifyToken(authHeader?: string): Promise<VerifyJwtResult> {
    if (this.skipVerification) {
      return {
        isValid: true,
        payload: { email: 'dev@example.com', sub: 'dev-user-id' },
      };
    }

    if (!authHeader) {
      return {
        isValid: false,
        error: 'Missing Authorization header',
      };
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return {
        isValid: false,
        error: 'Invalid Authorization header format. Expected Bearer <token>',
      };
    }

    const token = match[1];

    try {
      const verifyOptions: { idToken: string; audience?: string | string[] } = {
        idToken: token,
      };
      if (this.expectedAudience !== undefined) {
        verifyOptions.audience = this.expectedAudience;
      }

      const ticket = await this.client.verifyIdToken(verifyOptions);

      const payload = ticket.getPayload();
      if (!payload) {
        return {
          isValid: false,
          error: 'ID token verification returned empty payload',
        };
      }

      return {
        isValid: true,
        payload: payload as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isValid: false,
        error: `JWT verification failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

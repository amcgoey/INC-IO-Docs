export interface AuthVerificationResult {
  isValid: boolean;
  payload?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface AuthVerifierPort {
  verifyToken(authHeader?: string): Promise<AuthVerificationResult>;
}

export interface GoogleApiRetryOptions {
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  backoffFactor?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export function extractHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  if (typeof err.code === 'number') return err.code;
  if (typeof err.code === 'string' && err.code.trim() !== '' && !Number.isNaN(Number(err.code))) {
    return Number(err.code);
  }
  return undefined;
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

export function isRateLimitOrQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const status = extractHttpStatusCode(error);
  if (status === 429) return true;

  const err = error as Record<string, unknown>;
  if (err.code === '429' || err.code === 429) return true;

  if (status === 403 || err.code === '403' || err.code === 403) {
    try {
      const errorStr = JSON.stringify(error);
      const quotaReasons = ['userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded'];
      if (quotaReasons.some((reason) => errorStr.includes(reason))) {
        return true;
      }
    } catch {
      // Non-serializable object
    }
    const message = formatErrorMessage(error).toLowerCase();
    if (
      message.includes('rate limit') ||
      message.includes('ratelimit') ||
      message.includes('quota exceeded') ||
      message.includes('user rate limit')
    ) {
      return true;
    }
  }

  return false;
}

export async function executeWithRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: GoogleApiRetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 1000;
  const backoffFactor = options.backoffFactor ?? 2;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (isRateLimitOrQuotaError(error) && attempt < maxRetries) {
        const baseDelay = initialDelayMs * Math.pow(backoffFactor, attempt);
        const jitter = 0.75 + Math.random() * 0.5;
        const delay = Math.round(baseDelay * jitter);
        attempt++;
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
}

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractHttpStatusCode,
  formatErrorMessage,
  isRateLimitOrQuotaError,
  executeWithRateLimitRetry,
} from './retry';

describe('google/retry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractHttpStatusCode', () => {
    it('extracts numeric statusCode, status, response.status, and code', () => {
      expect(extractHttpStatusCode({ statusCode: 429 })).toBe(429);
      expect(extractHttpStatusCode({ status: 403 })).toBe(403);
      expect(extractHttpStatusCode({ response: { status: 404 } })).toBe(404);
      expect(extractHttpStatusCode({ code: 503 })).toBe(503);
    });

    it('extracts numeric string code while rejecting empty, whitespace, or non-numeric string codes', () => {
      expect(extractHttpStatusCode({ code: '429' })).toBe(429);
      expect(extractHttpStatusCode({ code: ' 403 ' })).toBe(403);
      expect(extractHttpStatusCode({ code: '' })).toBeUndefined();
      expect(extractHttpStatusCode({ code: '   ' })).toBeUndefined();
      expect(extractHttpStatusCode({ code: 'ECONNRESET' })).toBeUndefined();
    });

    it('returns undefined for non-object or missing status fields', () => {
      expect(extractHttpStatusCode(null)).toBeUndefined();
      expect(extractHttpStatusCode(undefined)).toBeUndefined();
      expect(extractHttpStatusCode('429')).toBeUndefined();
      expect(extractHttpStatusCode({})).toBeUndefined();
    });
  });

  describe('formatErrorMessage', () => {
    it('formats Error instances, message-bearing objects, and fallback values', () => {
      expect(formatErrorMessage(new Error('boom'))).toBe('boom');
      expect(formatErrorMessage({ message: 'structured error' })).toBe('structured error');
      expect(formatErrorMessage({ message: 123 })).toBe('[object Object]');
      expect(formatErrorMessage('plain text')).toBe('plain text');
      expect(formatErrorMessage(null)).toBe('null');
    });
  });

  describe('isRateLimitOrQuotaError', () => {
    it('returns true for HTTP 429 in status, statusCode, response.status, or code', () => {
      expect(isRateLimitOrQuotaError({ statusCode: 429 })).toBe(true);
      expect(isRateLimitOrQuotaError({ status: 429 })).toBe(true);
      expect(isRateLimitOrQuotaError({ response: { status: 429 } })).toBe(true);
      expect(isRateLimitOrQuotaError({ code: 429 })).toBe(true);
      expect(isRateLimitOrQuotaError({ code: '429' })).toBe(true);
    });

    it('returns true for HTTP 403 with quota reasons or rate-limit message substrings', () => {
      expect(
        isRateLimitOrQuotaError({
          status: 403,
          errors: [{ reason: 'userRateLimitExceeded' }],
        })
      ).toBe(true);
      expect(
        isRateLimitOrQuotaError({
          code: '403',
          response: { data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } },
        })
      ).toBe(true);
      expect(
        isRateLimitOrQuotaError({
          statusCode: 403,
          errors: [{ reason: 'quotaExceeded' }],
        })
      ).toBe(true);

      const circular: Record<string, unknown> = {
        status: 403,
        message: 'User Rate Limit Exceeded',
      };
      circular.self = circular;
      expect(isRateLimitOrQuotaError(circular)).toBe(true);
      expect(isRateLimitOrQuotaError({ status: 403, message: 'Quota exceeded for quota group' })).toBe(
        true
      );
    });

    it('returns false for non-quota 403, 404, 500, empty code, and non-objects', () => {
      expect(
        isRateLimitOrQuotaError({
          status: 403,
          errors: [{ reason: 'forbidden' }],
          message: 'Insufficient Permission',
        })
      ).toBe(false);
      expect(isRateLimitOrQuotaError({ status: 404, message: 'Not found' })).toBe(false);
      expect(isRateLimitOrQuotaError({ status: 500, message: 'Server error' })).toBe(false);
      expect(isRateLimitOrQuotaError({ code: '' })).toBe(false);
      expect(isRateLimitOrQuotaError(null)).toBe(false);
    });

    it('inspects Error.cause chains when HTTP 403 or 429 is wrapped in an outer error', () => {
      const wrappedQuotaReason = new Error('Google Sheets API error: Forbidden', {
        cause: {
          response: {
            status: 403,
            data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
          },
          message: 'Forbidden',
        },
      });
      Object.assign(wrappedQuotaReason, { statusCode: 403 });
      expect(isRateLimitOrQuotaError(wrappedQuotaReason)).toBe(true);

      const wrappedInheritedStatusQuota = new Error('Google Sheets API error: Forbidden', {
        cause: { errors: [{ reason: 'userRateLimitExceeded' }] },
      });
      Object.assign(wrappedInheritedStatusQuota, { statusCode: 403 });
      expect(isRateLimitOrQuotaError(wrappedInheritedStatusQuota)).toBe(true);

      const wrapped429Cause = new Error('Wrapped error', {
        cause: { status: 429, message: 'Too Many Requests' },
      });
      expect(isRateLimitOrQuotaError(wrapped429Cause)).toBe(true);

      const wrappedForbidden = new Error('Google Sheets API error: The caller does not have permission', {
        cause: {
          status: 403,
          errors: [{ reason: 'forbidden' }],
          message: 'The caller does not have permission',
        },
      });
      Object.assign(wrappedForbidden, { statusCode: 403 });
      expect(isRateLimitOrQuotaError(wrappedForbidden)).toBe(false);

      const cyclicCause: Error & { statusCode?: number; cause?: unknown } = new Error('Cyclic');
      cyclicCause.statusCode = 403;
      cyclicCause.cause = cyclicCause;
      expect(isRateLimitOrQuotaError(cyclicCause)).toBe(false);
    });
  });

  describe('executeWithRateLimitRetry', () => {
    it('retries rate-limit errors with exponential backoff and jitter until success', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 0.75 + 0.25 = 1.0
      const sleepDelays: number[] = [];
      const mockSleep = vi.fn(async (ms: number) => {
        sleepDelays.push(ms);
      });

      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' })
        .mockRejectedValueOnce({
          code: '403',
          errors: [{ reason: 'rateLimitExceeded' }],
        })
        .mockResolvedValueOnce('ok');

      const result = await executeWithRateLimitRetry(operation, {
        maxRetries: 3,
        initialDelayMs: 100,
        backoffFactor: 2,
        sleep: mockSleep,
      });

      expect(result).toBe('ok');
      expect(operation).toHaveBeenCalledTimes(3);
      expect(sleepDelays).toEqual([100, 200]);
    });

    it('uses default maxRetries=3, initialDelayMs=1000, backoffFactor=2 and jitter bounds [0.75, 1.25]', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0); // jitter = 0.75
      const sleepDelays: number[] = [];
      const mockSleep = vi.fn(async (ms: number) => {
        sleepDelays.push(ms);
      });

      const rateLimitErr = { status: 429, message: 'Rate limit' };
      const operation = vi.fn<() => Promise<never>>().mockRejectedValue(rateLimitErr);

      await expect(executeWithRateLimitRetry(operation, { sleep: mockSleep })).rejects.toBe(
        rateLimitErr
      );
      expect(operation).toHaveBeenCalledTimes(4);
      expect(sleepDelays).toEqual([750, 1500, 3000]);
    });

    it('does not retry non-rate-limit errors', async () => {
      const mockSleep = vi.fn(async () => undefined);
      const forbiddenErr = { status: 403, message: 'Forbidden' };
      const operation = vi.fn<() => Promise<never>>().mockRejectedValue(forbiddenErr);

      await expect(
        executeWithRateLimitRetry(operation, { maxRetries: 3, sleep: mockSleep })
      ).rejects.toBe(forbiddenErr);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('rejects immediately when AbortSignal is already aborted without calling operation or sleep', async () => {
      const controller = new AbortController();
      const abortReason = new Error('Lookup timed out');
      controller.abort(abortReason);

      const mockSleep = vi.fn(async () => undefined);
      const operation = vi.fn<() => Promise<string>>().mockResolvedValue('ok');

      await expect(
        executeWithRateLimitRetry(operation, {
          sleep: mockSleep,
          signal: controller.signal,
        })
      ).rejects.toBe(abortReason);
      expect(operation).not.toHaveBeenCalled();
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('terminates active default backoff timer immediately when AbortSignal aborts', async () => {
      const controller = new AbortController();
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' })
        .mockResolvedValueOnce('should-not-run');

      const startedAt = Date.now();
      const promise = executeWithRateLimitRetry(operation, {
        maxRetries: 3,
        initialDelayMs: 60_000,
        signal: controller.signal,
      });

      // Let first attempt reject and enter backoff wait, then abort immediately
      await new Promise((resolve) => setTimeout(resolve, 15));
      controller.abort();

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('terminates active custom sleep immediately when AbortSignal aborts', async () => {
      const controller = new AbortController();
      const customReason = new Error('Cancelled by caller');
      let capturedSignal: AbortSignal | undefined;
      const hangingSleep = vi.fn((_ms: number, sig?: AbortSignal) => {
        capturedSignal = sig;
        return new Promise<void>(() => {
          // Intentionally never resolves to prove abort short-circuits the wait
        });
      });

      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status: 403, errors: [{ reason: 'userRateLimitExceeded' }] })
        .mockResolvedValueOnce('never');

      const promise = executeWithRateLimitRetry(operation, {
        maxRetries: 3,
        initialDelayMs: 1000,
        sleep: hangingSleep,
        signal: controller.signal,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort(customReason);

      await expect(promise).rejects.toBe(customReason);
      expect(capturedSignal).toBe(controller.signal);
      expect(hangingSleep).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not retry when AbortSignal aborts during an in-flight failing operation', async () => {
      const controller = new AbortController();
      const mockSleep = vi.fn(async () => undefined);
      const operation = vi.fn<() => Promise<string>>().mockImplementation(async () => {
        controller.abort(new Error('Aborted mid-flight'));
        throw { status: 429, message: 'Rate limited' };
      });

      await expect(
        executeWithRateLimitRetry(operation, {
          maxRetries: 3,
          sleep: mockSleep,
          signal: controller.signal,
        })
      ).rejects.toThrow('Aborted mid-flight');
      expect(operation).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('removes abort listeners after completing retries normally', async () => {
      const controller = new AbortController();
      const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');
      const operation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce({ status: 429 })
        .mockResolvedValueOnce('ok');

      const result = await executeWithRateLimitRetry(operation, {
        maxRetries: 2,
        initialDelayMs: 5,
        signal: controller.signal,
      });

      expect(result).toBe('ok');
      expect(operation).toHaveBeenCalledTimes(2);
      expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });
});

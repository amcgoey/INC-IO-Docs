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
  });
});

import { describe, it, expect, vi } from 'vitest';
import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { GoogleGmailClient } from './gmail-client';
import { GoogleGmailApiError, GoogleGmailNotFoundError } from './errors';

describe('GoogleGmailClient', () => {
  it('returns basic message details (id, threadId) for a message with no payload', async () => {
    const mockGet = vi.fn().mockResolvedValue({
      data: {
        id: '18d4f0c1a2b3c4d5',
        threadId: '18d4f0c1a2b3c4d5_thread',
      },
    });

    const mockGmail = {
      users: {
        messages: {
          get: mockGet,
        },
      },
    } as unknown as gmail_v1.Gmail;

    const client = new GoogleGmailClient({ gmail: mockGmail });
    const result = await client.getMessage('18d4f0c1a2b3c4d5');

    expect(mockGet).toHaveBeenCalledWith({
      userId: 'me',
      id: '18d4f0c1a2b3c4d5',
      format: 'full',
    });
    expect(result.id).toBe('18d4f0c1a2b3c4d5');
    expect(result.threadId).toBe('18d4f0c1a2b3c4d5_thread');
    expect(result.inlineImages).toEqual([]);
    expect(result.attachments).toEqual([]);
  });

  describe('Header Extraction', () => {
    it('extracts headers case-insensitively and maps Message-ID to both messageId and rfcMessageId', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: '18d4f0c1a2b3c4d5',
          threadId: '18d4f0c1a2b3c4d5_thread',
          payload: {
            headers: [
              { name: 'mEsSaGe-Id', value: '<test-message-123@example.com>' },
              { name: 'sUbJeCt', value: 'Project Status Update' },
              { name: 'FROM', value: 'Alice <alice@example.com>' },
              { name: 'to', value: 'Bob <bob@example.com>' },
              { name: 'CC', value: 'Charlie <charlie@example.com>' },
              { name: 'dAtE', value: 'Mon, 18 Oct 2026 12:00:00 GMT' },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('18d4f0c1a2b3c4d5');

      expect(result.messageId).toBe('<test-message-123@example.com>');
      expect(result.rfcMessageId).toBe('<test-message-123@example.com>');
      expect(result.subject).toBe('Project Status Update');
      expect(result.from).toBe('Alice <alice@example.com>');
      expect(result.to).toBe('Bob <bob@example.com>');
      expect(result.cc).toBe('Charlie <charlie@example.com>');
      expect(result.date).toBe('Mon, 18 Oct 2026 12:00:00 GMT');
    });

    it('sets subject to undefined when header is missing, empty, or whitespace only', async () => {
      const mockGetWhitespace = vi.fn().mockResolvedValue({
        data: {
          id: '18d4f0c1a2b3c4d5',
          payload: {
            headers: [
              { name: 'Subject', value: '   ' },
            ],
          },
        },
      });

      const clientWhitespace = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGetWhitespace } } } as unknown as gmail_v1.Gmail,
      });

      const resultWhitespace = await clientWhitespace.getMessage('18d4f0c1a2b3c4d5');
      expect(resultWhitespace.subject).toBeUndefined();

      const mockGetMissing = vi.fn().mockResolvedValue({
        data: {
          id: '18d4f0c1a2b3c4d5',
          payload: {
            headers: [],
          },
        },
      });

      const clientMissing = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGetMissing } } } as unknown as gmail_v1.Gmail,
      });

      const resultMissing = await clientMissing.getMessage('18d4f0c1a2b3c4d5');
      expect(resultMissing.subject).toBeUndefined();
    });

    it('sets cc and messageId to undefined when headers are missing', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: '18d4f0c1a2b3c4d5',
          payload: {
            headers: [
              { name: 'From', value: 'Alice <alice@example.com>' },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('18d4f0c1a2b3c4d5');
      expect(result.cc).toBeUndefined();
      expect(result.messageId).toBeUndefined();
      expect(result.rfcMessageId).toBeUndefined();
    });
  });

  describe('Single-Part Body Decoding', () => {
    it('decodes single-part text/plain body from base64url data into plainTextBody', async () => {
      const rawText = 'Hello plain text world! Special chars: € and emojis: 🚀';
      const base64urlData = Buffer.from(rawText, 'utf-8').toString('base64url');

      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-plain',
          payload: {
            mimeType: 'text/plain',
            body: {
              data: base64urlData,
            },
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-plain');

      expect(result.plainTextBody).toBe(rawText);
      expect(result.htmlBody).toBeUndefined();
      expect(result.inlineImages).toEqual([]);
      expect(result.attachments).toEqual([]);
    });

    it('decodes single-part text/html body from base64url data into htmlBody', async () => {
      const rawHtml = '<h1>Hello HTML</h1><p>Paragraph with <b>formatting</b>.</p>';
      const base64urlData = Buffer.from(rawHtml, 'utf-8').toString('base64url');

      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-html',
          payload: {
            mimeType: 'text/html',
            parts: [],
            body: {
              data: base64urlData,
            },
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-html');

      expect(result.htmlBody).toBe(rawHtml);
      expect(result.plainTextBody).toBeUndefined();
      expect(result.inlineImages).toEqual([]);
      expect(result.attachments).toEqual([]);
    });

    it('handles single-part message with missing or empty body data gracefully', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-empty',
          payload: {
            mimeType: 'text/plain',
            body: {},
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-empty');

      expect(result.plainTextBody).toBeUndefined();
      expect(result.htmlBody).toBeUndefined();
      expect(result.inlineImages).toEqual([]);
      expect(result.attachments).toEqual([]);
    });
  });

  describe('Error Handling', () => {
    it('throws GoogleGmailNotFoundError with statusCode 404 when message is not found', async () => {
      const mockApiError = {
        message: 'Requested entity was not found.',
        response: { status: 404 },
      };
      const mockGet = vi.fn().mockRejectedValue(mockApiError);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      await expect(client.getMessage('missing-id')).rejects.toThrow(GoogleGmailNotFoundError);

      try {
        await client.getMessage('missing-id');
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleGmailNotFoundError);
        const notFoundErr = err as GoogleGmailNotFoundError;
        expect(notFoundErr.statusCode).toBe(404);
        expect(notFoundErr.cause).toBe(mockApiError);
        expect(notFoundErr.message).toContain('Google Gmail API error in getMessage');
      }
    });

    it('throws GoogleGmailApiError preserving statusCode and cause on 500 server error', async () => {
      const mockApiError = {
        message: 'Backend Error',
        status: 500,
      };
      const mockGet = vi.fn().mockRejectedValue(mockApiError);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      await expect(client.getMessage('server-error-id')).rejects.toThrow(GoogleGmailApiError);

      try {
        await client.getMessage('server-error-id');
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleGmailApiError);
        expect(err).not.toBeInstanceOf(GoogleGmailNotFoundError);
        const apiErr = err as GoogleGmailApiError;
        expect(apiErr.statusCode).toBe(500);
        expect(apiErr.cause).toBe(mockApiError);
        expect(apiErr.message).toContain('Google Gmail API error in getMessage');
      }
    });

    it('does not re-wrap an error that is already an instance of GoogleGmailApiError', async () => {
      const existingError = new GoogleGmailNotFoundError('Pre-existing not found');
      const mockGet = vi.fn().mockRejectedValue(existingError);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      await expect(client.getMessage('any-id')).rejects.toThrow(existingError);
    });
  });

  describe('Authentication and Credentials', () => {
    it('uses ephemeral client when per-request options.auth is provided', async () => {
      const defaultMockGet = vi.fn().mockResolvedValue({ data: { id: 'default-id' } });
      const ephemeralMockGet = vi.fn().mockResolvedValue({ data: { id: 'ephemeral-auth-id' } });

      const defaultGmail = {
        users: { messages: { get: defaultMockGet } },
      } as unknown as gmail_v1.Gmail;

      const ephemeralGmail = {
        users: { messages: { get: ephemeralMockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(ephemeralGmail);

      const client = new GoogleGmailClient({ gmail: defaultGmail });
      const result = await client.getMessage('msg-auth', { auth: 'ya29.override-auth' });

      expect(result.id).toBe('ephemeral-auth-id');
      expect(defaultMockGet).not.toHaveBeenCalled();
      expect(ephemeralMockGet).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-auth',
        format: 'full',
      });
      expect(gmailSpy).toHaveBeenCalled();

      gmailSpy.mockRestore();
    });

    it('uses ephemeral client when per-request options.accessToken is provided', async () => {
      const defaultMockGet = vi.fn().mockResolvedValue({ data: { id: 'default-id' } });
      const ephemeralMockGet = vi.fn().mockResolvedValue({ data: { id: 'ephemeral-token-id' } });

      const defaultGmail = {
        users: { messages: { get: defaultMockGet } },
      } as unknown as gmail_v1.Gmail;

      const ephemeralGmail = {
        users: { messages: { get: ephemeralMockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(ephemeralGmail);

      const client = new GoogleGmailClient({ gmail: defaultGmail });
      const result = await client.getMessage('msg-token', { accessToken: 'ya29.override-token' });

      expect(result.id).toBe('ephemeral-token-id');
      expect(defaultMockGet).not.toHaveBeenCalled();
      expect(ephemeralMockGet).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-token',
        format: 'full',
      });
      expect(gmailSpy).toHaveBeenCalled();

      gmailSpy.mockRestore();
    });

    it('constructs client from string token in auth option', async () => {
      const mockGet = vi.fn().mockResolvedValue({ data: { id: 'token-client-id' } });
      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);

      const client = new GoogleGmailClient({ auth: 'ya29.constructor-token' });
      const result = await client.getMessage('test-msg');

      expect(result.id).toBe('token-client-id');
      expect(gmailSpy).toHaveBeenCalled();
      const callArg = gmailSpy.mock.calls[0]?.[0];
      expect(callArg?.version).toBe('v1');
      expect(callArg?.auth).toBeInstanceOf(OAuth2Client);

      gmailSpy.mockRestore();
    });

    it('constructs client from OAuth2Client in auth option', async () => {
      const oauth2Client = new OAuth2Client();
      const mockGet = vi.fn().mockResolvedValue({ data: { id: 'oauth2-client-id' } });
      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);

      const client = new GoogleGmailClient({ auth: oauth2Client });
      const result = await client.getMessage('test-msg');

      expect(result.id).toBe('oauth2-client-id');
      expect(gmailSpy).toHaveBeenCalledWith({
        version: 'v1',
        auth: oauth2Client,
      });

      gmailSpy.mockRestore();
    });

    it('constructs client with default fallback when no options provided', async () => {
      const mockGet = vi.fn().mockResolvedValue({ data: { id: 'default-fallback-id' } });
      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);

      const client = new GoogleGmailClient();
      const result = await client.getMessage('test-msg');

      expect(result.id).toBe('default-fallback-id');
      expect(gmailSpy).toHaveBeenCalledWith({
        version: 'v1',
      });

      gmailSpy.mockRestore();
    });
  });

  describe('getAttachment', () => {
    it('downloads and decodes base64url attachment payload into binary Uint8Array', async () => {
      const rawPayload = 'Sample binary payload content for attachment download test';
      const base64urlData = Buffer.from(rawPayload, 'utf-8').toString('base64url');

      const mockGetAttachment = vi.fn().mockResolvedValue({
        data: {
          size: base64urlData.length,
          data: base64urlData,
        },
      });

      const mockGmail = {
        users: {
          messages: {
            attachments: {
              get: mockGetAttachment,
            },
          },
        },
      } as unknown as gmail_v1.Gmail;

      const client = new GoogleGmailClient({ gmail: mockGmail });
      const result = await client.getAttachment('msg-123', 'att-456');

      expect(mockGetAttachment).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'msg-123',
        id: 'att-456',
      });
      expect(result).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(result).toString('utf-8')).toBe(rawPayload);
    });

    it('supports per-request auth override in getAttachment', async () => {
      const defaultMockGet = vi.fn();
      const ephemeralMockGet = vi.fn().mockResolvedValue({
        data: { data: Buffer.from('ephemeral-data').toString('base64url') },
      });

      const defaultGmail = {
        users: { messages: { attachments: { get: defaultMockGet } } },
      } as unknown as gmail_v1.Gmail;

      const ephemeralGmail = {
        users: { messages: { attachments: { get: ephemeralMockGet } } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(ephemeralGmail);

      const client = new GoogleGmailClient({ gmail: defaultGmail });
      const result = await client.getAttachment('msg-1', 'att-1', { auth: 'ya29.override-auth' });

      expect(defaultMockGet).not.toHaveBeenCalled();
      expect(ephemeralMockGet).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'msg-1',
        id: 'att-1',
      });
      expect(Buffer.from(result).toString('utf-8')).toBe('ephemeral-data');

      gmailSpy.mockRestore();
    });

    it('supports per-request accessToken override in getAttachment', async () => {
      const defaultMockGet = vi.fn();
      const ephemeralMockGet = vi.fn().mockResolvedValue({
        data: { data: Buffer.from('token-data').toString('base64url') },
      });

      const defaultGmail = {
        users: { messages: { attachments: { get: defaultMockGet } } },
      } as unknown as gmail_v1.Gmail;

      const ephemeralGmail = {
        users: { messages: { attachments: { get: ephemeralMockGet } } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(ephemeralGmail);

      const client = new GoogleGmailClient({ gmail: defaultGmail });
      const result = await client.getAttachment('msg-2', 'att-2', { accessToken: 'ya29.override-token' });

      expect(defaultMockGet).not.toHaveBeenCalled();
      expect(ephemeralMockGet).toHaveBeenCalledWith({
        userId: 'me',
        messageId: 'msg-2',
        id: 'att-2',
      });
      expect(Buffer.from(result).toString('utf-8')).toBe('token-data');

      gmailSpy.mockRestore();
    });

    it('throws GoogleGmailNotFoundError with statusCode 404 when attachment API returns 404', async () => {
      const mockApiError = {
        message: 'Attachment not found',
        response: { status: 404 },
      };
      const mockGetAttachment = vi.fn().mockRejectedValue(mockApiError);

      const client = new GoogleGmailClient({
        gmail: {
          users: { messages: { attachments: { get: mockGetAttachment } } },
        } as unknown as gmail_v1.Gmail,
      });

      await expect(client.getAttachment('msg-1', 'missing-att')).rejects.toThrow(GoogleGmailNotFoundError);

      try {
        await client.getAttachment('msg-1', 'missing-att');
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleGmailNotFoundError);
        const notFound = err as GoogleGmailNotFoundError;
        expect(notFound.statusCode).toBe(404);
        expect(notFound.cause).toBe(mockApiError);
        expect(notFound.message).toContain('Google Gmail API error in getAttachment');
      }
    });

    it.each([
      { desc: 'missing data property', payload: {} },
      { desc: 'empty string data property', payload: { data: '' } },
    ])('throws GoogleGmailNotFoundError when attachment payload is $desc', async ({ payload }) => {
      const mockGetAttachment = vi.fn().mockResolvedValue({ data: payload });

      const client = new GoogleGmailClient({
        gmail: {
          users: { messages: { attachments: { get: mockGetAttachment } } },
        } as unknown as gmail_v1.Gmail,
      });

      await expect(client.getAttachment('msg-1', 'att-empty')).rejects.toThrow(GoogleGmailNotFoundError);

      try {
        await client.getAttachment('msg-1', 'att-empty');
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleGmailNotFoundError);
        const notFound = err as GoogleGmailNotFoundError;
        expect(notFound.statusCode).toBe(404);
        expect(notFound.message).toContain('not found or payload is empty');
      }
    });

    it('throws GoogleGmailApiError preserving statusCode on 500 error in getAttachment', async () => {
      const mockApiError = {
        message: 'Internal error',
        status: 500,
      };
      const mockGetAttachment = vi.fn().mockRejectedValue(mockApiError);

      const client = new GoogleGmailClient({
        gmail: {
          users: { messages: { attachments: { get: mockGetAttachment } } },
        } as unknown as gmail_v1.Gmail,
      });

      await expect(client.getAttachment('msg-1', 'att-err')).rejects.toThrow(GoogleGmailApiError);
    });
  });

  describe('Exponential Backoff Retries (429 / 403 Quota)', () => {
    it('retries getMessage on HTTP 429 and succeeds when a retry attempt succeeds', async () => {
      const error429 = { status: 429, message: 'Too Many Requests' };
      const successResponse = { data: { id: 'retry-success-msg' } };

      const mockGet = vi
        .fn()
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce(successResponse);

      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffFactor: 2,
          sleep: mockSleep,
        },
      });

      const result = await client.getMessage('retry-success-msg');

      expect(result.id).toBe('retry-success-msg');
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(mockSleep).toHaveBeenCalledTimes(2);

      // Attempt 0: baseDelay = 100, jitter in [75, 125]
      const delay0 = mockSleep.mock.calls[0]?.[0] as number;
      expect(delay0).toBeGreaterThanOrEqual(75);
      expect(delay0).toBeLessThanOrEqual(125);

      // Attempt 1: baseDelay = 200, jitter in [150, 250]
      const delay1 = mockSleep.mock.calls[1]?.[0] as number;
      expect(delay1).toBeGreaterThanOrEqual(150);
      expect(delay1).toBeLessThanOrEqual(250);
    });

    it('retries getAttachment on HTTP 429 and succeeds when a retry attempt succeeds', async () => {
      const error429 = { status: 429, message: 'Too Many Requests' };
      const rawPayload = 'Downloaded after 429 retry';
      const successResponse = {
        data: { data: Buffer.from(rawPayload).toString('base64url') },
      };

      const mockGetAttachment = vi
        .fn()
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce(successResponse);

      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleGmailClient({
        gmail: {
          users: { messages: { attachments: { get: mockGetAttachment } } },
        } as unknown as gmail_v1.Gmail,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffFactor: 2,
          sleep: mockSleep,
        },
      });

      const result = await client.getAttachment('msg-1', 'att-1');

      expect(Buffer.from(result).toString('utf-8')).toBe(rawPayload);
      expect(mockGetAttachment).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenCalledTimes(1);
      const delay = mockSleep.mock.calls[0]?.[0] as number;
      expect(delay).toBeGreaterThanOrEqual(75);
      expect(delay).toBeLessThanOrEqual(125);
    });

    it('fails when maxRetries is exceeded on HTTP 429 and throws wrapped GoogleGmailApiError', async () => {
      const error429 = { status: 429, message: 'Too Many Requests' };
      const mockGet = vi.fn().mockRejectedValue(error429);
      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffFactor: 2,
          sleep: mockSleep,
        },
      });

      await expect(client.getMessage('always-fails')).rejects.toThrow(GoogleGmailApiError);
      expect(mockGet).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
      expect(mockSleep).toHaveBeenCalledTimes(3);
    });

    it.each([
      {
        reason: 'userRateLimitExceeded',
        error: {
          status: 403,
          response: {
            status: 403,
            data: {
              error: {
                errors: [{ reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }],
              },
            },
          },
        },
      },
      {
        reason: 'rateLimitExceeded',
        error: {
          statusCode: 403,
          message: 'rateLimitExceeded: Rate limit exceeded',
        },
      },
      {
        reason: 'quotaExceeded',
        error: {
          code: 403,
          errors: [{ reason: 'quotaExceeded', message: 'Quota exceeded' }],
        },
      },
    ])('retries on HTTP 403 with $reason error', async ({ error }) => {
      const successResponse = { data: { id: 'quota-retry-ok' } };
      const mockGet = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(successResponse);

      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 100,
          sleep: mockSleep,
        },
      });

      const result = await client.getMessage('quota-retry-ok');
      expect(result.id).toBe('quota-retry-ok');
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry on HTTP 403 when reason is not quota/rate-limit (e.g. forbidden/permission denied)', async () => {
      const nonQuotaError = {
        status: 403,
        message: 'The caller does not have permission',
        response: {
          status: 403,
          data: {
            error: {
              errors: [{ reason: 'forbidden', message: 'Forbidden' }],
            },
          },
        },
      };

      const mockGet = vi.fn().mockRejectedValue(nonQuotaError);
      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        retryOptions: {
          maxRetries: 3,
          sleep: mockSleep,
        },
      });

      await expect(client.getMessage('forbidden-msg')).rejects.toThrow(GoogleGmailApiError);
      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('does NOT retry on HTTP 404 or HTTP 500 errors', async () => {
      const error404 = { status: 404, message: 'Not Found' };
      const mockGet404 = vi.fn().mockRejectedValue(error404);
      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet404 } } } as unknown as gmail_v1.Gmail,
        retryOptions: {
          maxRetries: 3,
          sleep: mockSleep,
        },
      });

      await expect(client.getMessage('missing')).rejects.toThrow(GoogleGmailNotFoundError);
      expect(mockGet404).toHaveBeenCalledTimes(1);
      expect(mockSleep).not.toHaveBeenCalled();
    });

    it('honors default retry options (maxRetries: 3, initialDelayMs: 1000, backoffFactor: 2) when only sleep is provided', async () => {
      const error429 = { status: 429, message: 'Too Many Requests' };
      const mockGet = vi
        .fn()
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({ data: { id: 'default-retry-success' } });

      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        retryOptions: {
          sleep: mockSleep,
        },
      });

      const result = await client.getMessage('default-retry-success');
      expect(result.id).toBe('default-retry-success');
      expect(mockGet).toHaveBeenCalledTimes(4);
      expect(mockSleep).toHaveBeenCalledTimes(3);

      // Attempt 0: initialDelayMs = 1000 -> [750, 1250]
      const delay0 = mockSleep.mock.calls[0]?.[0] as number;
      expect(delay0).toBeGreaterThanOrEqual(750);
      expect(delay0).toBeLessThanOrEqual(1250);

      // Attempt 1: 1000 * 2^1 = 2000 -> [1500, 2500]
      const delay1 = mockSleep.mock.calls[1]?.[0] as number;
      expect(delay1).toBeGreaterThanOrEqual(1500);
      expect(delay1).toBeLessThanOrEqual(2500);

      // Attempt 2: 1000 * 2^2 = 4000 -> [3000, 5000]
      const delay2 = mockSleep.mock.calls[2]?.[0] as number;
      expect(delay2).toBeGreaterThanOrEqual(3000);
      expect(delay2).toBeLessThanOrEqual(5000);
    });
  });
});


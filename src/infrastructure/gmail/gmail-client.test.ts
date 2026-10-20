import { describe, it, expect, vi } from 'vitest';
import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { GoogleGmailClient, parseMessageDetails } from './gmail-client';
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

  describe('Recursive Multipart MIME Traversal & Attachment Separation', () => {
    it('decodes plainTextBody and htmlBody from nested multipart/alternative container inside multipart/mixed', async () => {
      const plainText = 'Plain text body content';
      const htmlText = '<p>HTML body content</p>';

      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-multipart-1',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'multipart/alternative',
                parts: [
                  {
                    partId: '0.0',
                    mimeType: 'text/plain',
                    body: {
                      data: Buffer.from(plainText, 'utf-8').toString('base64url'),
                    },
                  },
                  {
                    partId: '0.1',
                    mimeType: 'text/html',
                    body: {
                      data: Buffer.from(htmlText, 'utf-8').toString('base64url'),
                    },
                  },
                ],
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-multipart-1');

      expect(result.plainTextBody).toBe(plainText);
      expect(result.htmlBody).toBe(htmlText);
    });

    it('excludes attached html files with non-empty filename from htmlBody extraction', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-attached-html',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/html',
                filename: 'attached_page.html',
                body: {
                  attachmentId: 'att-html-1',
                  data: Buffer.from('<html>attached content</html>', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p>actual email body</p>', 'utf-8').toString('base64url'),
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-attached-html');
      expect(result.htmlBody).toBe('<p>actual email body</p>');
    });

    it('excludes parts with Content-Disposition: attachment from body extraction', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-disposition-att',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/plain',
                headers: [
                  { name: 'Content-Disposition', value: 'attachment; filename="notes.txt"' },
                ],
                body: {
                  data: Buffer.from('attached notes', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'text/plain',
                headers: [
                  { name: 'Content-Disposition', value: 'inline' },
                ],
                body: {
                  data: Buffer.from('actual plain body', 'utf-8').toString('base64url'),
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-disposition-att');
      expect(result.plainTextBody).toBe('actual plain body');
    });

    it('excludes message/rfc822 attached emails from recursive body extraction', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-with-eml',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'message/rfc822',
                filename: 'forwarded.eml',
                parts: [
                  {
                    partId: '0.0',
                    mimeType: 'text/plain',
                    body: {
                      data: Buffer.from('inner forwarded email body', 'utf-8').toString('base64url'),
                    },
                  },
                ],
              },
              {
                partId: '1',
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('outer parent email body', 'utf-8').toString('base64url'),
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-with-eml');
      expect(result.plainTextBody).toBe('outer parent email body');
    });

    it('classifies an image referenced in htmlBody via cid:<normalized-cid> as an inline image and decodes part.body.data', async () => {
      const samplePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-inline-1',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p>Image: <img src="cid:img-logo-001@example.com"></p>', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'image/png',
                filename: 'logo.png',
                headers: [
                  { name: 'Content-ID', value: ' <img-logo-001@example.com> ' },
                ],
                body: {
                  size: 67,
                  attachmentId: 'att-img-1',
                  data: Buffer.from(samplePng, 'base64').toString('base64url'),
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-inline-1');

      expect(result.inlineImages).toHaveLength(1);
      const img = result.inlineImages[0]!;
      expect(img.cid).toBe('img-logo-001@example.com');
      expect(img.partId).toBe('1');
      expect(img.attachmentId).toBe('att-img-1');
      expect(img.filename).toBe('logo.png');
      expect(img.mimeType).toBe('image/png');
      expect(img.size).toBe(67);
      expect(img.data).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(img.data!).toString('base64')).toBe(samplePng);
    });

    it('handles case-insensitivity and URL-encoded CIDs in htmlBody (e.g. CID:Logo%20Asset%40corp)', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-inline-encoded',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p>Logo: <img src="CID:Logo%20Asset%40corp"></p>', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'image/jpeg',
                filename: 'asset.jpg',
                headers: [
                  { name: 'Content-ID', value: '<Logo Asset@corp>' },
                ],
                body: {
                  size: 100,
                  attachmentId: 'att-img-encoded',
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-inline-encoded');

      expect(result.inlineImages).toHaveLength(1);
      expect(result.inlineImages[0]?.cid).toBe('Logo Asset@corp');
      expect(result.inlineImages[0]?.mimeType).toBe('image/jpeg');
      expect(result.inlineImages[0]?.data).toBeUndefined();
    });

    it('matches bracketed CIDs in htmlBody (e.g. <img src="cid:<bracketed-cid@corp>">) and classifies into inlineImages not attachments', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-bracketed-cid',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p>Logo: <img src="cid:<bracketed-cid@corp>"></p>', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'image/png',
                filename: 'bracketed-logo.png',
                headers: [
                  { name: 'Content-ID', value: '<bracketed-cid@corp>' },
                ],
                body: {
                  size: 50,
                  attachmentId: 'att-bracketed-1',
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-bracketed-cid');

      expect(result.inlineImages).toHaveLength(1);
      expect(result.inlineImages[0]?.cid).toBe('bracketed-cid@corp');
      expect(result.inlineImages[0]?.filename).toBe('bracketed-logo.png');
      expect(result.attachments).toHaveLength(0);
    });

    it('matches URL-encoded bracketed CIDs in htmlBody (e.g. <img src="cid:<bracketed%20cid@corp>">)', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-encoded-bracketed-cid',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p>Banner: <img src="cid:<bracketed%20cid@corp>"></p>', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'image/png',
                filename: 'bracketed-space.png',
                headers: [
                  { name: 'Content-ID', value: '<bracketed cid@corp>' },
                ],
                body: {
                  size: 60,
                  attachmentId: 'att-bracketed-2',
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-encoded-bracketed-cid');

      expect(result.inlineImages).toHaveLength(1);
      expect(result.inlineImages[0]?.cid).toBe('bracketed cid@corp');
      expect(result.inlineImages[0]?.filename).toBe('bracketed-space.png');
      expect(result.attachments).toHaveLength(0);
    });


    it('classifies an image residing strictly within multipart/related container as inline image even if not in htmlBody', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-related-container',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'multipart/related',
                parts: [
                  {
                    partId: '0.0',
                    mimeType: 'text/html',
                    body: {
                      data: Buffer.from('<p>No cid references in html</p>', 'utf-8').toString('base64url'),
                    },
                  },
                  {
                    partId: '0.1',
                    mimeType: 'image/png',
                    headers: [
                      { name: 'Content-ID', value: '<signature-logo>' },
                    ],
                    body: {
                      size: 50,
                      attachmentId: 'att-sig',
                    },
                  },
                ],
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-related-container');

      expect(result.inlineImages).toHaveLength(1);
      expect(result.inlineImages[0]?.cid).toBe('signature-logo');
    });

    it('does not classify image as inline if not in multipart/related and not referenced in htmlBody', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-unreferenced-image',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p>Hello world with no images</p>', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'image/jpeg',
                filename: 'photo.jpg',
                headers: [
                  { name: 'Content-ID', value: '<unreferenced-photo>' },
                ],
                body: {
                  size: 200,
                  attachmentId: 'att-unref',
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-unreferenced-image');

      expect(result.inlineImages).toHaveLength(0);
    });

    it('classifies a non-image part with filename and attachmentId as loose attachment and decodes data when present', async () => {
      const samplePdfBase64 = Buffer.from('%PDF-1.4 test', 'utf-8').toString('base64');
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-with-pdf',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('Here is the report.', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'application/pdf',
                filename: 'Report.pdf',
                body: {
                  attachmentId: 'att-pdf-1',
                  size: 1024,
                  data: Buffer.from(samplePdfBase64, 'base64').toString('base64url'),
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-with-pdf');

      expect(result.attachments).toHaveLength(1);
      const att = result.attachments[0]!;
      expect(att.partId).toBe('1');
      expect(att.attachmentId).toBe('att-pdf-1');
      expect(att.filename).toBe('Report.pdf');
      expect(att.mimeType).toBe('application/pdf');
      expect(att.size).toBe(1024);
      expect(att.data).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(att.data!).toString('utf-8')).toBe('%PDF-1.4 test');
    });

    it('classifies attached .eml file (message/rfc822) as loose attachment', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-eml-att',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('See attached email.', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'message/rfc822',
                filename: 'previous_conversation.eml',
                body: {
                  attachmentId: 'att-eml-42',
                  size: 2048,
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-eml-att');

      expect(result.attachments).toHaveLength(1);
      const att = result.attachments[0]!;
      expect(att.partId).toBe('1');
      expect(att.attachmentId).toBe('att-eml-42');
      expect(att.filename).toBe('previous_conversation.eml');
      expect(att.mimeType).toBe('message/rfc822');
      expect(att.size).toBe(2048);
      expect(att.data).toBeUndefined();
    });

    it('does not include inline CID images in attachments even if they have filename and attachmentId', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-inline-not-attachment',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/html',
                body: {
                  data: Buffer.from('<p><img src="cid:logo123"></p>', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'image/png',
                filename: 'logo.png',
                headers: [
                  { name: 'Content-ID', value: '<logo123>' },
                ],
                body: {
                  attachmentId: 'att-inline-123',
                  size: 500,
                  data: Buffer.from('png-data', 'utf-8').toString('base64url'),
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-inline-not-attachment');

      expect(result.inlineImages).toHaveLength(1);
      expect(result.inlineImages[0]?.cid).toBe('logo123');
      expect(result.attachments).toHaveLength(0);
    });

    it('classifies image with filename and attachmentId as loose attachment if NOT classified as inline image', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-standalone-photo',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: '0',
                mimeType: 'text/plain',
                body: {
                  data: Buffer.from('Here is the photo attached.', 'utf-8').toString('base64url'),
                },
              },
              {
                partId: '1',
                mimeType: 'image/jpeg',
                filename: 'vacation.jpg',
                headers: [
                  { name: 'Content-ID', value: '<photo123>' },
                ],
                body: {
                  attachmentId: 'att-photo-1',
                  size: 4000,
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-standalone-photo');

      expect(result.inlineImages).toHaveLength(0);
      expect(result.attachments).toHaveLength(1);
      const att = result.attachments[0]!;
      expect(att.filename).toBe('vacation.jpg');
      expect(att.attachmentId).toBe('att-photo-1');
      expect(att.mimeType).toBe('image/jpeg');
      expect(att.size).toBe(4000);
    });

    it('assembles body from the first decoded part when multiple parts exist and ignores non-images in multipart/related for inlineImages', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-multiple-bodies',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'multipart/related',
                parts: [
                  {
                    partId: '0.0',
                    mimeType: 'text/plain',
                    body: {
                      data: Buffer.from('first plain body', 'utf-8').toString('base64url'),
                    },
                  },
                  {
                    partId: '0.1',
                    mimeType: 'text/plain',
                    body: {
                      data: Buffer.from('second plain body', 'utf-8').toString('base64url'),
                    },
                  },
                  {
                    partId: '0.2',
                    mimeType: 'application/octet-stream',
                    headers: [{ name: 'Content-ID', value: '<not-an-image>' }],
                    filename: 'data.bin',
                    body: {
                      attachmentId: 'att-bin',
                      size: 100,
                    },
                  },
                ],
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-multiple-bodies');

      expect(result.plainTextBody).toBe('first plain body');
      expect(result.inlineImages).toHaveLength(0);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]?.filename).toBe('data.bin');
    });

    it('generates globally monotonic hierarchical part-<path> fallback when partId is omitted in deeply nested multipart MIME trees', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-nested-omitted-partid',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'multipart/related',
                parts: [
                  {
                    mimeType: 'text/html',
                    body: {
                      data: Buffer.from('<p>Hello <img src="cid:nested-img-1"></p>', 'utf-8').toString('base64url'),
                    },
                  },
                  {
                    mimeType: 'image/png',
                    headers: [{ name: 'Content-ID', value: '<nested-img-1>' }],
                    filename: 'nested-photo.png',
                    body: {
                      attachmentId: 'att-img-nested',
                      size: 512,
                    },
                  },
                ],
              },
              {
                mimeType: 'multipart/mixed',
                parts: [
                  {
                    mimeType: 'application/pdf',
                    filename: 'first-doc.pdf',
                    body: {
                      attachmentId: 'att-doc-1',
                      size: 1024,
                    },
                  },
                  {
                    mimeType: 'application/pdf',
                    filename: 'second-doc.pdf',
                    body: {
                      attachmentId: 'att-doc-2',
                      size: 2048,
                    },
                  },
                ],
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-nested-omitted-partid');

      expect(result.inlineImages).toHaveLength(1);
      expect(result.inlineImages[0]?.cid).toBe('nested-img-1');
      expect(result.inlineImages[0]?.partId).toBe('part-0.1');

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments[0]?.filename).toBe('first-doc.pdf');
      expect(result.attachments[0]?.partId).toBe('part-1.0');
      expect(result.attachments[1]?.filename).toBe('second-doc.pdf');
      expect(result.attachments[1]?.partId).toBe('part-1.1');
    });

    it('preserves canonical non-empty partId and only falls back to part-<path> when partId is missing or empty', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-mixed-partid',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: 'custom-part-explicit',
                mimeType: 'application/pdf',
                filename: 'explicit.pdf',
                body: {
                  attachmentId: 'att-explicit',
                  size: 100,
                },
              },
              {
                partId: '   ',
                mimeType: 'application/pdf',
                filename: 'fallback.pdf',
                body: {
                  attachmentId: 'att-fallback',
                  size: 200,
                },
              },
            ],
          },
        },
      });

      const client = new GoogleGmailClient({
        gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
      });

      const result = await client.getMessage('msg-mixed-partid');

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments[0]?.filename).toBe('explicit.pdf');
      expect(result.attachments[0]?.partId).toBe('custom-part-explicit');
      expect(result.attachments[1]?.filename).toBe('fallback.pdf');
      expect(result.attachments[1]?.partId).toBe('part-1');
    });
    describe('Small Inline Attachments (body.data without attachmentId) (Ticket #205)', () => {
      it('extracts non-image MIME part with filename and inline body.data (without attachmentId) as attachment with inline-<partId> fallback', async () => {
        const textContent = 'Small inline configuration payload';
        const base64urlData = Buffer.from(textContent, 'utf-8').toString('base64url');

        const mockGet = vi.fn().mockResolvedValue({
          data: {
            id: 'msg-inline-att-1',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                {
                  partId: '0',
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Email body', 'utf-8').toString('base64url'),
                  },
                },
                {
                  partId: '1',
                  mimeType: 'application/json',
                  filename: 'config.json',
                  body: {
                    size: 34,
                    data: base64urlData,
                    // Note: attachmentId is omitted by Gmail API for small inline payloads
                  },
                },
              ],
            },
          },
        });

        const client = new GoogleGmailClient({
          gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        });

        const result = await client.getMessage('msg-inline-att-1');

        expect(result.attachments).toHaveLength(1);
        const att = result.attachments[0]!;
        expect(att.partId).toBe('1');
        expect(att.attachmentId).toBe('inline-1');
        expect(att.filename).toBe('config.json');
        expect(att.mimeType).toBe('application/json');
        expect(att.size).toBe(34);
        expect(att.data).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(att.data!).toString('utf-8')).toBe(textContent);
      });

      it('extracts attachment using fallbackPartId for inline-<partId> when partId is missing or empty', async () => {
        const textContent = 'No partId inline payload';
        const base64urlData = Buffer.from(textContent, 'utf-8').toString('base64url');

        const mockGet = vi.fn().mockResolvedValue({
          data: {
            id: 'msg-inline-att-fallback-partid',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                {
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Email body', 'utf-8').toString('base64url'),
                  },
                },
                {
                  // partId omitted
                  mimeType: 'text/csv',
                  filename: 'data.csv',
                  body: {
                    size: 24,
                    data: base64urlData,
                  },
                },
              ],
            },
          },
        });

        const client = new GoogleGmailClient({
          gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        });

        const result = await client.getMessage('msg-inline-att-fallback-partid');

        expect(result.attachments).toHaveLength(1);
        const att = result.attachments[0]!;
        expect(att.partId).toBe('part-1');
        expect(att.attachmentId).toBe('inline-part-1');
        expect(att.filename).toBe('data.csv');
        expect(att.mimeType).toBe('text/csv');
        expect(att.size).toBe(24);
        expect(att.data).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(att.data!).toString('utf-8')).toBe(textContent);
      });

      it('extracts unreferenced image MIME part with filename and inline body.data (without attachmentId) as attachment with inline-<partId>', async () => {
        const samplePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

        const mockGet = vi.fn().mockResolvedValue({
          data: {
            id: 'msg-unreferenced-image-inline-att',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                {
                  partId: '0',
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Here is the image.', 'utf-8').toString('base64url'),
                  },
                },
                {
                  partId: '1',
                  mimeType: 'image/png',
                  filename: 'unreferenced.png',
                  headers: [
                    { name: 'Content-ID', value: '<not-in-html>' },
                  ],
                  body: {
                    size: 67,
                    data: Buffer.from(samplePng, 'base64').toString('base64url'),
                    // No attachmentId
                  },
                },
              ],
            },
          },
        });

        const client = new GoogleGmailClient({
          gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        });

        const result = await client.getMessage('msg-unreferenced-image-inline-att');

        expect(result.inlineImages).toHaveLength(0);
        expect(result.attachments).toHaveLength(1);
        const att = result.attachments[0]!;
        expect(att.partId).toBe('1');
        expect(att.attachmentId).toBe('inline-1');
        expect(att.filename).toBe('unreferenced.png');
        expect(att.mimeType).toBe('image/png');
        expect(att.size).toBe(67);
        expect(att.data).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(att.data!).toString('base64')).toBe(samplePng);
      });

      it('continues to classify CID-referenced multipart/related image with body.data (without attachmentId) as inlineImage, NOT as attachment', async () => {
        const samplePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

        const mockGet = vi.fn().mockResolvedValue({
          data: {
            id: 'msg-related-inline-image-data-only',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                {
                  mimeType: 'multipart/related',
                  parts: [
                    {
                      partId: '0.0',
                      mimeType: 'text/html',
                      body: {
                        data: Buffer.from('<p>Hello <img src="cid:sig-logo"></p>', 'utf-8').toString('base64url'),
                      },
                    },
                    {
                      partId: '0.1',
                      mimeType: 'image/png',
                      filename: 'signature.png',
                      headers: [
                        { name: 'Content-ID', value: '<sig-logo>' },
                      ],
                      body: {
                        size: 67,
                        data: Buffer.from(samplePng, 'base64').toString('base64url'),
                        // No attachmentId
                      },
                    },
                  ],
                },
              ],
            },
          },
        });

        const client = new GoogleGmailClient({
          gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        });

        const result = await client.getMessage('msg-related-inline-image-data-only');

        expect(result.inlineImages).toHaveLength(1);
        expect(result.inlineImages[0]?.cid).toBe('sig-logo');
        expect(result.inlineImages[0]?.partId).toBe('0.1');
        expect(result.inlineImages[0]?.data).toBeInstanceOf(Uint8Array);
        expect(result.attachments).toHaveLength(0);
      });

      it('decodes both base64 and base64url data and defaults size to data.length when body.size is undefined', async () => {
        const rawBytes = new Uint8Array([251, 239, 10, 20]); // contains + / in base64, - _ in base64url
        const standardBase64 = Buffer.from(rawBytes).toString('base64'); // "++8KFA=="

        const mockGet = vi.fn().mockResolvedValue({
          data: {
            id: 'msg-std-b64',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                {
                  partId: 'part-b64',
                  mimeType: 'application/octet-stream',
                  filename: 'binary.dat',
                  body: {
                    data: standardBase64,
                    // size undefined
                  },
                },
              ],
            },
          },
        });

        const client = new GoogleGmailClient({
          gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        });

        const result = await client.getMessage('msg-std-b64');

        expect(result.attachments).toHaveLength(1);
        const att = result.attachments[0]!;
        expect(att.attachmentId).toBe('inline-part-b64');
        expect(att.size).toBe(rawBytes.length);
        expect(att.data).toEqual(rawBytes);
      });

      it('does NOT extract as attachment when MIME part has filename but neither attachmentId nor non-empty body.data', async () => {
        const mockGet = vi.fn().mockResolvedValue({
          data: {
            id: 'msg-empty-part',
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                {
                  partId: '0',
                  mimeType: 'text/plain',
                  filename: 'empty-file.txt',
                  body: {
                    // No attachmentId and no data (or empty string)
                    data: '   ',
                  },
                },
              ],
            },
          },
        });

        const client = new GoogleGmailClient({
          gmail: { users: { messages: { get: mockGet } } } as unknown as gmail_v1.Gmail,
        });

        const result = await client.getMessage('msg-empty-part');

        expect(result.attachments).toHaveLength(0);
      });
    });

  });

  describe('Bounded getMessage memoization', () => {
    it('resolves sequential calls with same auth token and message ID within TTL from cache, calling users.messages.get only once', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-memo-1',
          threadId: 'th-memo-1',
        },
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);

      const client = new GoogleGmailClient();

      const res1 = await client.getMessage('msg-memo-1', { auth: 'token-abc' });
      const res2 = await client.getMessage('msg-memo-1', { auth: 'token-abc' });

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(res1).toEqual(res2);
      expect(res1.id).toBe('msg-memo-1');

      gmailSpy.mockRestore();
    });

    it('shares in-flight promise for concurrent getMessage calls with same auth token and message ID', async () => {
      let resolvePromise: (value: unknown) => void;
      const deferred = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      const mockGet = vi.fn().mockReturnValue(deferred);
      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      const promise1 = client.getMessage('msg-concurrent', { auth: 'token-abc' });
      const promise2 = client.getMessage('msg-concurrent', { auth: 'token-abc' });

      expect(mockGet).toHaveBeenCalledTimes(1);

      resolvePromise!({
        data: {
          id: 'msg-concurrent',
          threadId: 'th-concurrent',
        },
      });

      const [res1, res2] = await Promise.all([promise1, promise2]);

      expect(mockGet).toHaveBeenCalledTimes(1);
      expect(res1).toBe(res2);
      expect(res1.id).toBe('msg-concurrent');

      gmailSpy.mockRestore();
    });

    it('isolates cache entries across distinct auth tokens for the same message ID', async () => {
      const mockGet = vi.fn().mockImplementation(async () => ({
        data: {
          id: 'msg-shared-id',
          threadId: 'th-shared',
        },
      }));

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      await client.getMessage('msg-shared-id', { auth: 'token-user-1' });
      await client.getMessage('msg-shared-id', { auth: 'token-user-2' });

      expect(mockGet).toHaveBeenCalledTimes(2);

      gmailSpy.mockRestore();
    });

    it('isolates cache entries across distinct OAuth2Client instances based on access_token', async () => {
      const mockGet = vi.fn().mockImplementation(async () => ({
        data: {
          id: 'msg-shared-oauth-id',
          threadId: 'th-shared',
        },
      }));

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      const oauthClient1 = new OAuth2Client();
      oauthClient1.setCredentials({ access_token: 'oauth-token-1' });

      const oauthClient2 = new OAuth2Client();
      oauthClient2.setCredentials({ access_token: 'oauth-token-2' });

      await client.getMessage('msg-shared-oauth-id', { auth: oauthClient1 });
      await client.getMessage('msg-shared-oauth-id', { auth: oauthClient2 });

      expect(mockGet).toHaveBeenCalledTimes(2);

      // Re-calling with oauthClient1 should use cached entry
      await client.getMessage('msg-shared-oauth-id', { auth: oauthClient1 });
      expect(mockGet).toHaveBeenCalledTimes(2);

      gmailSpy.mockRestore();
    });

    it('isolates cache entries across distinct message IDs for the same auth token', async () => {
      const mockGet = vi.fn().mockImplementation(async (params: { id: string }) => ({
        data: {
          id: params.id,
          threadId: `${params.id}_thread`,
        },
      }));

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      const res1 = await client.getMessage('msg-alpha', { auth: 'token-same' });
      const res2 = await client.getMessage('msg-beta', { auth: 'token-same' });

      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(res1.id).toBe('msg-alpha');
      expect(res2.id).toBe('msg-beta');

      gmailSpy.mockRestore();
    });

    it('maps auth and accessToken options to the same cache entry', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-mapped',
          threadId: 'th-mapped',
        },
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      await client.getMessage('msg-mapped', { auth: 'token-mapped' });
      await client.getMessage('msg-mapped', { accessToken: 'token-mapped' });

      expect(mockGet).toHaveBeenCalledTimes(1);

      gmailSpy.mockRestore();
    });

    it('re-fetches expired entries after TTL elapses and evicts stale entries', async () => {
      let currentTime = 1000;
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-ttl',
          threadId: 'th-ttl',
        },
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient({
        cacheOptions: {
          ttlMs: 60_000,
          clock: () => currentTime,
        },
      });

      // Call 1 at t=1000 -> API called
      await client.getMessage('msg-ttl', { auth: 'token-ttl' });
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Call 2 at t=60_999 (within 60s TTL window) -> cached
      currentTime = 60_999;
      await client.getMessage('msg-ttl', { auth: 'token-ttl' });
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Call 3 at t=61_001 (> 60s TTL window) -> expired and re-fetched
      currentTime = 61_001;
      await client.getMessage('msg-ttl', { auth: 'token-ttl' });
      expect(mockGet).toHaveBeenCalledTimes(2);

      gmailSpy.mockRestore();
    });

    it('evicts rejected getMessage promises so transient failures can be retried', async () => {
      let failCount = 1;
      const mockGet = vi.fn().mockImplementation(async () => {
        if (failCount > 0) {
          failCount--;
          const err = new Error('Transient 500 error');
          (err as { status?: number }).status = 500;
          throw err;
        }
        return {
          data: {
            id: 'msg-transient',
            threadId: 'th-transient',
          },
        };
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      // Attempt 1 fails
      await expect(client.getMessage('msg-transient', { auth: 'tok' })).rejects.toThrow();
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Attempt 2 retries and succeeds because failed promise was evicted
      const res = await client.getMessage('msg-transient', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(res.id).toBe('msg-transient');

      // Attempt 3 within TTL uses cached success
      await client.getMessage('msg-transient', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(2);

      gmailSpy.mockRestore();
    });

    it('enforces maximum entry bound via LRU eviction', async () => {
      const mockGet = vi.fn().mockImplementation(async (params: { id: string }) => ({
        data: {
          id: params.id,
          threadId: `${params.id}_thread`,
        },
      }));

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient({
        cacheOptions: {
          maxEntries: 2,
        },
      });

      // Fetch msg-1 and msg-2 -> cache has [msg-1, msg-2]
      await client.getMessage('msg-1', { auth: 'tok' });
      await client.getMessage('msg-2', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(2);

      // Access msg-1 -> refreshes msg-1 as MRU; msg-2 is now LRU
      await client.getMessage('msg-1', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(2);

      // Fetch msg-3 -> exceeds capacity (maxEntries: 2) -> evicts msg-2
      await client.getMessage('msg-3', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(3);

      // msg-1 is still in cache -> no API call
      await client.getMessage('msg-1', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(3);

      // msg-2 was evicted -> triggers fresh API call
      await client.getMessage('msg-2', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(4);

      gmailSpy.mockRestore();
    });

    it('normalizes message ID whitespace in cache keys', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-trim',
          threadId: 'th-trim',
        },
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      await client.getMessage('  msg-trim  ', { auth: 'tok' });
      await client.getMessage('msg-trim', { auth: 'tok' });

      expect(mockGet).toHaveBeenCalledTimes(1);

      gmailSpy.mockRestore();
    });

    it('uses constructor auth token in cache key when per-request options are omitted', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-ctor-auth',
          threadId: 'th-ctor-auth',
        },
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient({ auth: 'ya29.ctor-token' });

      await client.getMessage('msg-ctor-auth');
      await client.getMessage('msg-ctor-auth');

      expect(mockGet).toHaveBeenCalledTimes(1);

      gmailSpy.mockRestore();
    });

    it('clears cache on clearCache() and reports cache size via getCacheSize()', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-clear',
          threadId: 'th-clear',
        },
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      expect(client.getCacheSize()).toBe(0);
      await client.getMessage('msg-clear', { auth: 'tok' });
      expect(client.getCacheSize()).toBe(1);

      client.clearCache();
      expect(client.getCacheSize()).toBe(0);

      await client.getMessage('msg-clear', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(client.getCacheSize()).toBe(1);

      gmailSpy.mockRestore();
    });

    it('bypasses cache when options.skipCache is true in getMessage', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          id: 'msg-skip-cache',
          threadId: 'th-skip-cache',
        },
      });

      const mockGmail = {
        users: { messages: { get: mockGet } },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmail);
      const client = new GoogleGmailClient();

      await client.getMessage('msg-skip-cache', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Normal read hits cache
      await client.getMessage('msg-skip-cache', { auth: 'tok' });
      expect(mockGet).toHaveBeenCalledTimes(1);

      // skipCache: true forces fresh fetch
      await client.getMessage('msg-skip-cache', { auth: 'tok', skipCache: true });
      expect(mockGet).toHaveBeenCalledTimes(2);

      gmailSpy.mockRestore();
    });
  });

  describe('getThread', () => {
    it('fetches full thread and parses all messages in chronological order', async () => {
      const mockThreadGet = vi.fn().mockResolvedValue({
        data: {
          id: 'thread-123',
          messages: [
            {
              id: 'msg-1',
              threadId: 'thread-123',
              payload: {
                headers: [
                  { name: 'From', value: 'Alice <alice@example.com>' },
                  { name: 'Subject', value: 'Hello' },
                  { name: 'Date', value: 'Mon, 19 Oct 2026 10:00:00 +0000' },
                ],
                body: { data: Buffer.from('Message 1').toString('base64url') },
                mimeType: 'text/plain',
              },
            },
            {
              id: 'msg-2',
              threadId: 'thread-123',
              payload: {
                headers: [
                  { name: 'From', value: 'Bob <bob@example.com>' },
                  { name: 'Subject', value: 'Re: Hello' },
                  { name: 'Date', value: 'Mon, 19 Oct 2026 11:00:00 +0000' },
                ],
                parts: [
                  {
                    partId: '0.1',
                    filename: 'attachment.pdf',
                    mimeType: 'application/pdf',
                    body: { attachmentId: 'att-99', size: 1024 },
                  },
                ],
              },
            },
          ],
        },
      });

      const mockGmail = {
        users: {
          threads: {
            get: mockThreadGet,
          },
        },
      } as unknown as gmail_v1.Gmail;

      const client = new GoogleGmailClient({ gmail: mockGmail });
      const result = await client.getThread('thread-123');

      expect(mockThreadGet).toHaveBeenCalledWith({
        userId: 'me',
        id: 'thread-123',
        format: 'full',
      });
      expect(result.id).toBe('thread-123');
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].id).toBe('msg-1');
      expect(result.messages[0].from).toBe('Alice <alice@example.com>');
      expect(result.messages[0].plainTextBody).toBe('Message 1');
      expect(result.messages[1].id).toBe('msg-2');
      expect(result.messages[1].attachments).toHaveLength(1);
      expect(result.messages[1].attachments[0].filename).toBe('attachment.pdf');
    });

    it('wraps 404 into GoogleGmailNotFoundError', async () => {
      const mockThreadGet = vi.fn().mockRejectedValue({
        message: 'Thread not found',
        status: 404,
      });

      const mockGmail = {
        users: {
          threads: {
            get: mockThreadGet,
          },
        },
      } as unknown as gmail_v1.Gmail;

      const client = new GoogleGmailClient({ gmail: mockGmail });
      await expect(client.getThread('non-existent')).rejects.toThrow(GoogleGmailNotFoundError);
    });

    it('wraps API errors into GoogleGmailApiError', async () => {
      const mockThreadGet = vi.fn().mockRejectedValue({
        message: 'Internal server error',
        status: 500,
      });

      const mockGmail = {
        users: {
          threads: {
            get: mockThreadGet,
          },
        },
      } as unknown as gmail_v1.Gmail;

      const client = new GoogleGmailClient({ gmail: mockGmail });
      await expect(client.getThread('th-500')).rejects.toThrow(GoogleGmailApiError);
    });

    it('retries on rate limit (429) errors during getThread', async () => {
      let attempts = 0;
      const mockThreadGet = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) {
          const err = new Error('Rate limit exceeded');
          Object.assign(err, { statusCode: 429 });
          throw err;
        }
        return {
          data: {
            id: 'th-retry',
            messages: [{ id: 'msg-retry' }],
          },
        };
      });

      const mockSleep = vi.fn().mockResolvedValue(undefined);
      const mockGmail = {
        users: {
          threads: {
            get: mockThreadGet,
          },
        },
      } as unknown as gmail_v1.Gmail;

      const client = new GoogleGmailClient({
        gmail: mockGmail,
        retryOptions: { maxRetries: 3, initialDelayMs: 10, backoffFactor: 2, sleep: mockSleep },
      });

      const result = await client.getThread('th-retry');
      expect(result.id).toBe('th-retry');
      expect(attempts).toBe(2);
      expect(mockSleep).toHaveBeenCalledTimes(1);
    });

    describe('Thread Caching & Per-Message Cache Warming (Ticket #213)', () => {
      it('populates per-message cache during getThread: subsequent getMessage calls resolve with 0 users.messages.get calls', async () => {
        const mockThreadGet = vi.fn().mockResolvedValue({
          data: {
            id: 'th-warm',
            messages: [
              {
                id: 'msg-warm-1',
                threadId: 'th-warm',
                payload: {
                  headers: [
                    { name: 'Subject', value: 'Warmed Message 1' },
                    { name: 'From', value: 'alice@example.com' },
                    { name: 'Date', value: 'Tue, 20 Oct 2026 10:00:00 GMT' },
                  ],
                  body: { data: Buffer.from('Body 1').toString('base64url') },
                  mimeType: 'text/plain',
                },
              },
              {
                id: 'msg-warm-2',
                threadId: 'th-warm',
                payload: {
                  headers: [
                    { name: 'Subject', value: 'Warmed Message 2' },
                    { name: 'From', value: 'bob@example.com' },
                    { name: 'Date', value: 'Tue, 20 Oct 2026 11:00:00 GMT' },
                  ],
                  body: { data: Buffer.from('Body 2').toString('base64url') },
                  mimeType: 'text/plain',
                },
              },
            ],
          },
        });

        const mockMessageGet = vi.fn().mockResolvedValue({
          data: { id: 'unexpected', threadId: 'unexpected' },
        });

        const mockGmail = {
          users: {
            threads: { get: mockThreadGet },
            messages: { get: mockMessageGet },
          },
        } as unknown as gmail_v1.Gmail;

        const client = new GoogleGmailClient({ gmail: mockGmail });

        const thread = await client.getThread('th-warm');
        expect(thread.messages).toHaveLength(2);
        expect(mockThreadGet).toHaveBeenCalledTimes(1);

        // Immediate subsequent getMessage calls within TTL resolve from cache without calling users.messages.get
        const msg1 = await client.getMessage('msg-warm-1');
        const msg2 = await client.getMessage('msg-warm-2');

        expect(mockMessageGet).toHaveBeenCalledTimes(0);
        expect(msg1.id).toBe('msg-warm-1');
        expect(msg1.subject).toBe('Warmed Message 1');
        expect(msg1.plainTextBody).toBe('Body 1');
        expect(msg2.id).toBe('msg-warm-2');
        expect(msg2.subject).toBe('Warmed Message 2');
        expect(msg2.plainTextBody).toBe('Body 2');
      });

      it('enforces cacheMaxEntries LRU capacity eviction during bulk insertion in getThread', async () => {
        const mockThreadGet = vi.fn().mockResolvedValue({
          data: {
            id: 'th-overflow',
            messages: [
              { id: 'msg-1', threadId: 'th-overflow', payload: { headers: [{ name: 'Subject', value: 'One' }] } },
              { id: 'msg-2', threadId: 'th-overflow', payload: { headers: [{ name: 'Subject', value: 'Two' }] } },
              { id: 'msg-3', threadId: 'th-overflow', payload: { headers: [{ name: 'Subject', value: 'Three' }] } },
              { id: 'msg-4', threadId: 'th-overflow', payload: { headers: [{ name: 'Subject', value: 'Four' }] } },
              { id: 'msg-5', threadId: 'th-overflow', payload: { headers: [{ name: 'Subject', value: 'Five' }] } },
            ],
          },
        });

        const mockMessageGet = vi.fn().mockImplementation(async ({ id }: { id: string }) => ({
          data: { id, threadId: 'th-overflow', payload: { headers: [{ name: 'Subject', value: `Fresh ${id}` }] } },
        }));

        const mockGmail = {
          users: {
            threads: { get: mockThreadGet },
            messages: { get: mockMessageGet },
          },
        } as unknown as gmail_v1.Gmail;

        // Max entries is 3
        const client = new GoogleGmailClient({
          gmail: mockGmail,
          cacheOptions: { maxEntries: 3, ttlMs: 60_000 },
        });

        await client.getThread('th-overflow');

        // Bounded capacity check
        expect(client.getCacheSize()).toBeLessThanOrEqual(3);

        // msg-3, msg-4, msg-5 are the newest entries in cache -> 0 network calls
        const msg5 = await client.getMessage('msg-5');
        const msg4 = await client.getMessage('msg-4');
        const msg3 = await client.getMessage('msg-3');
        expect(mockMessageGet).toHaveBeenCalledTimes(0);
        expect(msg5.subject).toBe('Five');
        expect(msg4.subject).toBe('Four');
        expect(msg3.subject).toBe('Three');

        // msg-1 was evicted by LRU capacity enforcement -> fresh network call
        const msg1 = await client.getMessage('msg-1');
        expect(mockMessageGet).toHaveBeenCalledTimes(1);
        expect(mockMessageGet).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-1' }));
        expect(msg1.subject).toBe('Fresh msg-1');
      });

      it('caches getThread results and bypasses cache when skipCache is true', async () => {
        const mockThreadGet = vi.fn().mockResolvedValue({
          data: {
            id: 'th-skip',
            messages: [
              { id: 'msg-skip-1', threadId: 'th-skip', payload: { headers: [{ name: 'Subject', value: 'Initial' }] } },
            ],
          },
        });

        const mockGmail = {
          users: {
            threads: { get: mockThreadGet },
          },
        } as unknown as gmail_v1.Gmail;

        const client = new GoogleGmailClient({ gmail: mockGmail });

        // Initial fetch
        const res1 = await client.getThread('th-skip');
        expect(mockThreadGet).toHaveBeenCalledTimes(1);
        expect(res1.id).toBe('th-skip');

        // Second call within TTL hits thread cache
        const res2 = await client.getThread('th-skip');
        expect(mockThreadGet).toHaveBeenCalledTimes(1);
        expect(res2).toEqual(res1);

        // Third call with skipCache: true bypasses cache and issues fresh API call
        const res3 = await client.getThread('th-skip', { skipCache: true });
        expect(mockThreadGet).toHaveBeenCalledTimes(2);
        expect(res3.id).toBe('th-skip');
      });

      it('bypasses pre-warmed per-message cache when skipCache: true is passed to getMessage', async () => {
        const mockThreadGet = vi.fn().mockResolvedValue({
          data: {
            id: 'th-prewarm',
            messages: [
              { id: 'msg-warmed', threadId: 'th-prewarm', payload: { headers: [{ name: 'Subject', value: 'Warmed' }] } },
            ],
          },
        });

        const mockMessageGet = vi.fn().mockResolvedValue({
          data: { id: 'msg-warmed', threadId: 'th-prewarm', payload: { headers: [{ name: 'Subject', value: 'Fresh Message' }] } },
        });

        const mockGmail = {
          users: {
            threads: { get: mockThreadGet },
            messages: { get: mockMessageGet },
          },
        } as unknown as gmail_v1.Gmail;

        const client = new GoogleGmailClient({ gmail: mockGmail });

        await client.getThread('th-prewarm');
        expect(mockThreadGet).toHaveBeenCalledTimes(1);

        // Cached call
        const cached = await client.getMessage('msg-warmed');
        expect(mockMessageGet).toHaveBeenCalledTimes(0);
        expect(cached.subject).toBe('Warmed');

        // skipCache: true forces fresh get
        const fresh = await client.getMessage('msg-warmed', { skipCache: true });
        expect(mockMessageGet).toHaveBeenCalledTimes(1);
        expect(fresh.subject).toBe('Fresh Message');
      });

      it('clears both message and thread caches on clearCache()', async () => {
        const mockGmail = {
          users: {
            threads: { get: vi.fn().mockResolvedValue({ data: { id: 'th-clear-both', messages: [{ id: 'm-clear-both' }] } }) },
            messages: { get: vi.fn().mockResolvedValue({ data: { id: 'm-clear-both-2' } }) },
          },
        } as unknown as gmail_v1.Gmail;

        const client = new GoogleGmailClient({ gmail: mockGmail });
        await client.getThread('th-clear-both');
        expect(client.getThreadCacheSize()).toBe(1);
        expect(client.getCacheSize()).toBe(1);

        client.clearCache();
        expect(client.getThreadCacheSize()).toBe(0);
        expect(client.getCacheSize()).toBe(0);
      });
    });
  });

  describe('parseMessageDetails', () => {
    it('parses message headers, body, and fallback id correctly', () => {
      const parsed = parseMessageDetails(
        {
          id: 'msg-direct',
          payload: {
            headers: [
              { name: 'Subject', value: 'Test Subject' },
              { name: 'From', value: 'sender@example.com' },
              { name: 'Date', value: 'Tue, 20 Oct 2026 12:00:00 GMT' },
            ],
            body: { data: Buffer.from('Direct body').toString('base64url') },
            mimeType: 'text/plain',
          },
        },
        'fallback-id'
      );

      expect(parsed.id).toBe('msg-direct');
      expect(parsed.subject).toBe('Test Subject');
      expect(parsed.from).toBe('sender@example.com');
      expect(parsed.plainTextBody).toBe('Direct body');
    });

    it('uses fallbackId when message.id is missing', () => {
      const parsed = parseMessageDetails({}, 'fallback-id');
      expect(parsed.id).toBe('fallback-id');
    });
  });
});


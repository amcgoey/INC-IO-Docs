import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type {
  GoogleGmailClientOptions,
  GmailOperationOptions,
  GmailMessageDetails,
} from './types';
import { GoogleGmailApiError, GoogleGmailNotFoundError } from './errors';

function extractHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as { statusCode?: unknown; status?: unknown; code?: unknown; response?: { status?: unknown } };
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  if (typeof err.code === 'number') return err.code;
  if (typeof err.code === 'string' && !Number.isNaN(Number(err.code))) return Number(err.code);
  return undefined;
}

function formatErrorMessage(error: unknown): string {
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

function getHeaderValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  const header = headers.find((h) => h.name?.toLowerCase() === target);
  return header?.value ?? undefined;
}

function decodeBase64UrlToUtf8(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

export class GoogleGmailClient {
  private readonly defaultGmail: gmail_v1.Gmail;

  constructor(options: GoogleGmailClientOptions = {}) {
    if (options.gmail) {
      this.defaultGmail = options.gmail;
    } else if (typeof options.auth === 'string') {
      this.defaultGmail = this.createGmailClientFromToken(options.auth);
    } else if (options.auth) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.defaultGmail = google.gmail({ version: 'v1', auth: options.auth as any });
    } else {
      this.defaultGmail = google.gmail({ version: 'v1' });
    }
  }

  private createGmailClientFromToken(token: string): gmail_v1.Gmail {
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: token });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return google.gmail({ version: 'v1', auth: oauth2Client as any });
  }

  private getGmail(options?: GmailOperationOptions): gmail_v1.Gmail {
    const token = options?.accessToken ?? options?.auth;
    if (token) {
      return this.createGmailClientFromToken(token);
    }
    return this.defaultGmail;
  }

  private wrapApiError(methodName: string, error: unknown): never {
    if (error instanceof GoogleGmailApiError) {
      throw error;
    }
    const statusCode = extractHttpStatusCode(error);
    const message = `Google Gmail API error in ${methodName}: ${formatErrorMessage(error)}`;

    if (statusCode === 404) {
      throw new GoogleGmailNotFoundError(message, { cause: error, statusCode: 404 });
    }

    throw new GoogleGmailApiError(message, { cause: error, statusCode });
  }

  async getMessage(messageId: string, options?: GmailOperationOptions): Promise<GmailMessageDetails> {
    const gmail = this.getGmail(options);
    let res: { data: gmail_v1.Schema$Message };
    try {
      res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
    } catch (error) {
      this.wrapApiError('getMessage', error);
    }


    const payload = res.data.payload;
    const headers = payload?.headers;
    const rfcMessageId = getHeaderValue(headers, 'Message-ID');
    const rawSubject = getHeaderValue(headers, 'Subject');
    const subject = rawSubject && rawSubject.trim().length > 0 ? rawSubject : undefined;
    const from = getHeaderValue(headers, 'From');
    const to = getHeaderValue(headers, 'To');
    const cc = getHeaderValue(headers, 'Cc');
    const date = getHeaderValue(headers, 'Date');

    let plainTextBody: string | undefined;
    let htmlBody: string | undefined;

    if (!payload?.parts || payload.parts.length === 0) {
      const bodyData = payload?.body?.data;
      if (bodyData) {
        const decoded = decodeBase64UrlToUtf8(bodyData);
        const mimeType = payload.mimeType?.toLowerCase();
        if (mimeType === 'text/plain') {
          plainTextBody = decoded;
        } else if (mimeType === 'text/html') {
          htmlBody = decoded;
        }
      }
    }

    const details: GmailMessageDetails = {
      id: res.data.id ?? messageId,
      inlineImages: [],
      attachments: [],
      ...(res.data.threadId ? { threadId: res.data.threadId } : {}),
      ...(rfcMessageId !== undefined ? { rfcMessageId, messageId: rfcMessageId } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(cc !== undefined ? { cc } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(plainTextBody !== undefined ? { plainTextBody } : {}),
      ...(htmlBody !== undefined ? { htmlBody } : {}),
    };

    return details;
  }
}


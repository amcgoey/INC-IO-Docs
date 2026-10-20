import { google, type gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type {
  GoogleGmailClientOptions,
  GmailOperationOptions,
  GmailMessageDetails,
  GmailThreadDetails,
  GmailRetryOptions,
  GmailInlineImageDescriptor,
  GmailAttachmentDescriptor,
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

function isRateLimitOrQuotaError(error: unknown): boolean {
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

function decodeBase64ToBytes(data: string): Uint8Array {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(normalized, 'base64'));
}

function normalizeContentId(rawCid?: string): string | undefined {
  if (!rawCid) return undefined;
  const trimmed = rawCid.trim();
  const stripped = trimmed.replace(/^<+/, '').replace(/>+$/, '').trim();
  return stripped.length > 0 ? stripped : undefined;
}

function isCidReferencedInHtml(html: string | undefined, normalizedCid: string): boolean {
  if (!html) return false;
  const targetLower = normalizedCid.toLowerCase();
  const encodedTarget = encodeURIComponent(targetLower);
  const cidRegex = /cid:([^\s"'`>)]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = cidRegex.exec(html)) !== null) {
    const rawRef = match[1] ?? '';
    const cleanedRef = rawRef.replace(/^<+/, '').replace(/>+$/, '').trim();
    const cleanedRefLower = cleanedRef.toLowerCase();
    if (cleanedRefLower === targetLower || cleanedRefLower === encodedTarget) return true;
    try {
      const decoded = decodeURIComponent(cleanedRef).replace(/^<+/, '').replace(/>+$/, '').trim().toLowerCase();
      if (decoded === targetLower) return true;
    } catch {
      // ignore URI malformed error
    }
  }
  return false;
}

export function parseMessageDetails(
  message: gmail_v1.Schema$Message,
  fallbackId?: string
): GmailMessageDetails {
  const payload = message.payload;
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
  const inlineImages: GmailInlineImageDescriptor[] = [];
  const attachments: GmailAttachmentDescriptor[] = [];

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
  } else {
    interface PartContext {
      part: gmail_v1.Schema$MessagePart;
      isInsideMultipartRelated: boolean;
      fallbackPartId: string;
    }
    const candidateParts: PartContext[] = [];

    const traverse = (
      parts: gmail_v1.Schema$MessagePart[],
      isInsideMultipartRelated: boolean,
      pathPrefix = ''
    ) => {
      parts.forEach((part, index) => {
        const currentPath = pathPrefix ? `${pathPrefix}.${index}` : `${index}`;
        const fallbackPartId = `part-${currentPath}`;

        const mimeType = part.mimeType?.toLowerCase();
        const isRelated = isInsideMultipartRelated || mimeType === 'multipart/related';

        if (mimeType === 'message/rfc822') {
          candidateParts.push({ part, isInsideMultipartRelated: isRelated, fallbackPartId });
          return;
        }

        const filename = part.filename;
        const hasFilename = Boolean(filename && filename.trim().length > 0);
        const disposition = getHeaderValue(part.headers, 'Content-Disposition');
        const isAttachmentDisposition = disposition
          ? disposition.toLowerCase().includes('attachment')
          : false;

        if (!hasFilename && !isAttachmentDisposition) {
          if (mimeType === 'text/plain' && plainTextBody === undefined && part.body?.data) {
            plainTextBody = decodeBase64UrlToUtf8(part.body.data);
          } else if (mimeType === 'text/html' && htmlBody === undefined && part.body?.data) {
            htmlBody = decodeBase64UrlToUtf8(part.body.data);
          }
        }

        if (part.parts && part.parts.length > 0) {
          traverse(part.parts, isRelated, currentPath);
        } else {
          candidateParts.push({ part, isInsideMultipartRelated: isInsideMultipartRelated, fallbackPartId });
        }
      });
    };

    traverse(payload.parts, false, '');

    for (const { part, isInsideMultipartRelated, fallbackPartId } of candidateParts) {
      const mimeType = part.mimeType?.toLowerCase() ?? '';
      const rawCid = getHeaderValue(part.headers, 'Content-ID');
      const normalizedCid = normalizeContentId(rawCid);
      const isImage = mimeType.startsWith('image/');
      const resolvedPartId =
        typeof part.partId === 'string' && part.partId.trim().length > 0
          ? part.partId.trim()
          : fallbackPartId;

      let isInlineImage = false;
      if (isImage && normalizedCid) {
        if (isInsideMultipartRelated || isCidReferencedInHtml(htmlBody, normalizedCid)) {
          isInlineImage = true;
        }
      }

      if (isInlineImage && normalizedCid) {
        let data: Uint8Array | undefined;
        if (part.body?.data) {
          data = decodeBase64ToBytes(part.body.data);
        }

        const inlineImage: GmailInlineImageDescriptor = {
          cid: normalizedCid,
          partId: resolvedPartId,
          mimeType: part.mimeType ?? 'image/png',
          ...(part.body?.attachmentId ? { attachmentId: part.body.attachmentId } : {}),
          ...(part.filename && part.filename.trim().length > 0 ? { filename: part.filename } : {}),
          ...(typeof part.body?.size === 'number' ? { size: part.body.size } : {}),
          ...(data ? { data } : {}),
        };
        inlineImages.push(inlineImage);
      } else {
        const filename = part.filename?.trim();
        const rawAttachmentId = part.body?.attachmentId?.trim();
        const hasAttachmentId = Boolean(rawAttachmentId && rawAttachmentId.length > 0);
        const rawBodyData = part.body?.data?.trim();
        const hasInlineData = Boolean(rawBodyData && rawBodyData.length > 0);

        if (filename && filename.length > 0 && (hasAttachmentId || hasInlineData)) {
          const attachmentId = hasAttachmentId ? rawAttachmentId! : `inline-${resolvedPartId}`;
          let data: Uint8Array | undefined;
          if (hasInlineData && rawBodyData) {
            data = decodeBase64ToBytes(rawBodyData);
          }

          const attachment: GmailAttachmentDescriptor = {
            partId: resolvedPartId,
            attachmentId,
            filename: part.filename ?? filename,
            mimeType: part.mimeType ?? 'application/octet-stream',
            size: typeof part.body?.size === 'number' ? part.body.size : (data ? data.length : 0),
            ...(data ? { data } : {}),
          };
          attachments.push(attachment);
        }
      }
    }
  }

  const details: GmailMessageDetails = {
    id: message.id ?? fallbackId ?? '',
    inlineImages,
    attachments,
    ...(message.threadId ? { threadId: message.threadId } : {}),
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

export class GoogleGmailClient {
  private readonly defaultGmail: gmail_v1.Gmail;
  private readonly defaultAuthToken?: string | undefined;
  private readonly retryOptions: GmailRetryOptions;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private readonly clock: () => number;
  private readonly cache = new Map<
    string,
    { promise: Promise<GmailMessageDetails>; expiresAt: number }
  >();

  constructor(options: GoogleGmailClientOptions = {}) {
    this.retryOptions = options.retryOptions ?? {};
    this.cacheTtlMs = options.cacheOptions?.ttlMs ?? 60_000;
    this.cacheMaxEntries = Math.max(1, options.cacheOptions?.maxEntries ?? 100);
    this.clock = options.cacheOptions?.clock ?? Date.now;

    if (options.gmail) {
      this.defaultGmail = options.gmail;
    } else if (typeof options.auth === 'string') {
      this.defaultAuthToken = options.auth;
      this.defaultGmail = this.createGmailClientFromToken(options.auth);
    } else if (options.auth) {
      if ('credentials' in options.auth && typeof options.auth.credentials?.access_token === 'string') {
        this.defaultAuthToken = options.auth.credentials.access_token;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.defaultGmail = google.gmail({ version: 'v1', auth: options.auth as any });
    } else {
      this.defaultGmail = google.gmail({ version: 'v1' });
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  private getAuthCacheKey(options?: GmailOperationOptions): string {
    const token = options?.accessToken ?? options?.auth;
    if (typeof token === 'string' && token.trim().length > 0) {
      return token.trim();
    }
    if (typeof token === 'object' && token !== null) {
      const client = token as {
        credentials?: { access_token?: string | null; id_token?: string | null };
        apiKey?: string;
      };
      const candidate =
        client.credentials?.access_token ??
        client.credentials?.id_token ??
        (client as { apiKey?: string }).apiKey;
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    if (typeof this.defaultAuthToken === 'string' && this.defaultAuthToken.trim().length > 0) {
      return this.defaultAuthToken.trim();
    }
    return '__default__';
  }

  async getMessage(
    messageId: string,
    options?: GmailOperationOptions
  ): Promise<GmailMessageDetails> {
    const key = `${this.getAuthCacheKey(options)}\0${messageId.trim()}`;
    const now = this.clock();

    if (!options?.skipCache) {
      const existing = this.cache.get(key);
      if (existing) {
        if (now <= existing.expiresAt) {
          // Cache hit: move to end for LRU order
          this.cache.delete(key);
          this.cache.set(key, existing);
          return existing.promise;
        }
        // Expired entry
        this.cache.delete(key);
      }
    }

    // Prune expired entries to maintain bounds
    for (const [k, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(k);
      }
    }

    // Evict oldest (least recently used) entries if at capacity
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }

    const expiresAt = now + this.cacheTtlMs;
    const promise = this.fetchMessageDetails(messageId, options);

    const newEntry = { promise, expiresAt };

    promise.catch(() => {
      if (this.cache.get(key) === newEntry) {
        this.cache.delete(key);
      }
    });

    this.cache.set(key, newEntry);
    return promise;
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
      if (typeof token === 'string') {
        return this.createGmailClientFromToken(token);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return google.gmail({ version: 'v1', auth: token as any });
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

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    const maxRetries = this.retryOptions.maxRetries ?? 3;
    const initialDelayMs = this.retryOptions.initialDelayMs ?? 1000;
    const backoffFactor = this.retryOptions.backoffFactor ?? 2;
    const sleep =
      this.retryOptions.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

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

  async getThread(
    threadId: string,
    options?: GmailOperationOptions
  ): Promise<GmailThreadDetails> {
    const gmail = this.getGmail(options);
    if (!gmail?.users?.threads?.get) {
      throw new GoogleGmailApiError('Google Gmail API error in getThread: threads API is not available');
    }
    let res: { data: gmail_v1.Schema$Thread };
    try {
      res = await this.executeWithRetry(() =>
        gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        })
      );
    } catch (error) {
      this.wrapApiError('getThread', error);
    }

    const messages = (res.data.messages ?? []).map((msg) =>
      parseMessageDetails(msg, msg.id ?? undefined)
    );

    return {
      id: res.data.id ?? threadId,
      messages,
    };
  }

  private async fetchMessageDetails(messageId: string, options?: GmailOperationOptions): Promise<GmailMessageDetails> {
    const gmail = this.getGmail(options);
    let res: { data: gmail_v1.Schema$Message };
    try {
      res = await this.executeWithRetry(() =>
        gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        })
      );
    } catch (error) {
      this.wrapApiError('getMessage', error);
    }

    return parseMessageDetails(res.data, messageId);
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
    options?: GmailOperationOptions
  ): Promise<Uint8Array> {
    const gmail = this.getGmail(options);
    let res: { data: gmail_v1.Schema$MessagePartBody };
    try {
      res = await this.executeWithRetry(() =>
        gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        })
      );
    } catch (error) {
      this.wrapApiError('getAttachment', error);
    }

    const data = res.data.data;
    if (!data || data.length === 0) {
      throw new GoogleGmailNotFoundError(
        `Google Gmail API error in getAttachment: Attachment '${attachmentId}' in message '${messageId}' not found or payload is empty`,
        { statusCode: 404 }
      );
    }

    const buffer = Buffer.from(data, 'base64url');
    if (buffer.length === 0) {
      throw new GoogleGmailNotFoundError(
        `Google Gmail API error in getAttachment: Attachment '${attachmentId}' in message '${messageId}' payload is empty`,
        { statusCode: 404 }
      );
    }

    return new Uint8Array(buffer);
  }
}


import { Type, type Static } from '@sinclair/typebox';
import type { OAuth2Client } from 'google-auth-library';
import type { gmail_v1 } from 'googleapis';

export interface GmailRetryOptions {
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  backoffFactor?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface GmailOperationOptions {
  auth?: string | undefined;
  accessToken?: string | undefined;
}

export interface GoogleGmailClientOptions {
  auth?: OAuth2Client | string | undefined;
  gmail?: gmail_v1.Gmail | undefined;
  retryOptions?: GmailRetryOptions | undefined;
}

export const GmailInlineImageDescriptorSchema = Type.Object({
  cid: Type.String({ minLength: 1 }),
  partId: Type.String(),
  attachmentId: Type.Optional(Type.String()),
  filename: Type.Optional(Type.String()),
  mimeType: Type.String(),
  size: Type.Optional(Type.Number()),
});

export interface GmailInlineImageDescriptor extends Static<typeof GmailInlineImageDescriptorSchema> {
  data?: Uint8Array | undefined;
}

export const GmailAttachmentDescriptorSchema = Type.Object({
  partId: Type.String(),
  attachmentId: Type.String({ minLength: 1 }),
  filename: Type.String({ minLength: 1 }),
  mimeType: Type.String(),
  size: Type.Number(),
});

export interface GmailAttachmentDescriptor extends Static<typeof GmailAttachmentDescriptorSchema> {
  data?: Uint8Array | undefined;
}

export const GmailMessageDetailsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  messageId: Type.Optional(Type.String()),
  rfcMessageId: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  cc: Type.Optional(Type.String()),
  date: Type.Optional(Type.String()),
  plainTextBody: Type.Optional(Type.String()),
  htmlBody: Type.Optional(Type.String()),
  inlineImages: Type.Array(GmailInlineImageDescriptorSchema),
  attachments: Type.Array(GmailAttachmentDescriptorSchema),
});

export type GmailMessageDetails = Static<typeof GmailMessageDetailsSchema> & {
  inlineImages: GmailInlineImageDescriptor[];
  attachments: GmailAttachmentDescriptor[];
};

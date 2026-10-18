import { Type, type Static } from '@sinclair/typebox';

export const EmailPdfInlineImageSchema = Type.Object({
  cid: Type.String({ minLength: 1 }),
  mimeType: Type.String(),
  filename: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export interface EmailPdfInlineImage extends Static<typeof EmailPdfInlineImageSchema> {
  data: Uint8Array;
}

export const EmailPdfRenderInputSchema = Type.Object({
  messageId: Type.String({ minLength: 1 }),
  rfcMessageId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  subject: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  from: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  to: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  cc: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  date: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  attachmentNames: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  plainTextBody: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  htmlBody: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  inlineImages: Type.Optional(Type.Union([Type.Array(EmailPdfInlineImageSchema), Type.Undefined()])),
});

export type EmailPdfRenderInput = Static<typeof EmailPdfRenderInputSchema> & {
  inlineImages?: EmailPdfInlineImage[] | undefined;
};

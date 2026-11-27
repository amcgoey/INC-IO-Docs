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

export type EmailPdfRenderInput = Omit<
  Static<typeof EmailPdfRenderInputSchema>,
  'inlineImages'
> & {
  inlineImages?: EmailPdfInlineImage[] | undefined;
};

export type PdfFormFieldInputValue =
  | string
  | number
  | boolean
  | string[]
  | undefined
  | null;

export type PdfFormData = Record<string, PdfFormFieldInputValue>;

/**
 * Policy for handling existing AcroForm fields in a target PDF during page grafting or merging.
 * Flattening is strictly prohibited anywhere in this application.
 */
export type PdfTargetAcroFormPolicy = 'namespace' | 'strip';

/**
 * Policy for handling XFA dictionaries in a target PDF.
 * Pure XFA (without AcroForm fields/widgets) is always rejected.
 */
export type PdfXfaPolicy = 'fallbackHybrid' | 'error';

/**
 * Insertion point in the target PDF: `'start'`, `'end'`, or a 0-based page insertion index.
 */
export type PdfInsertPosition = 'start' | 'end' | number;

export interface PdfInsertPagesOptions {
  /** Insertion position in the target PDF (`'start'` default, `'end'`, or 0-based index `0..targetPageCount`). */
  position?: PdfInsertPosition | undefined;
  /** 1-indexed page numbers to copy from `insertBuffer` (defaults to all pages). */
  sourcePages?: number[] | undefined;
  /** How to handle hybrid XFA on the target PDF (`'fallbackHybrid'` default or `'error'`). Pure XFA is always rejected. */
  xfaPolicy?: PdfXfaPolicy | undefined;
  /** How to preserve target AcroForm fields (`'namespace'` default or `'strip'`). Never flattens. */
  targetAcroFormPolicy?: PdfTargetAcroFormPolicy | undefined;
  /** Preferred namespace parent name when `targetAcroFormPolicy` is `'namespace'` (defaults to `'__target'`). */
  targetFieldNamespace?: string | undefined;
  /** Optional form values to populate onto the inserted pages' AcroForm fields in a single pass. */
  formData?: PdfFormData | undefined;
}

export interface PdfCreateDocumentFromPagesOptions {
  /** 1-indexed page numbers to copy from `sourceBuffer` (defaults to all pages). */
  sourcePages?: number[] | undefined;
  /** Optional form values to populate onto the selected pages' AcroForm fields without flattening. */
  formData?: PdfFormData | undefined;
}

export interface PdfMergeDocumentsOptions {
  /** How to handle colliding AcroForm root fields across merged documents (`'namespace'` default or `'strip'`). */
  acroFormPolicy?: PdfTargetAcroFormPolicy | undefined;
  /** How to handle hybrid XFA on merged PDFs (`'fallbackHybrid'` default or `'error'`). Pure XFA is always rejected. */
  xfaPolicy?: PdfXfaPolicy | undefined;
  /** Preferred namespace parent name when `acroFormPolicy` is `'namespace'` (defaults to `'__target'`). */
  targetFieldNamespace?: string | undefined;
}

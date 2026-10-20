import type { SourceFile, SourceFileHydratorPort } from '../ports';
import { GoogleGmailClient } from '../../../infrastructure/gmail/gmail-client';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';
import type { EmailPdfInlineImage, EmailPdfRenderInput } from '../../../infrastructure/pdf/types';
import { formatEmailPdfFileName } from '../domain';

export interface GmailSourceFileHydratorAdapterOptions {
  gmailClient?: GoogleGmailClient | undefined;
  auth?: string | undefined;
  messageId?: string | undefined;
  isFileSourceEmailAttachments?: boolean | undefined;
  pdfProcessor?: PdfProcessor | undefined;
}

export class GmailSourceFileHydratorAdapter implements SourceFileHydratorPort {
  private readonly gmailClient: GoogleGmailClient;
  private readonly pdfProcessor: PdfProcessor;
  private readonly auth?: string | undefined;
  private readonly messageId?: string | undefined;
  private readonly isFileSourceEmailAttachments?: boolean | undefined;

  constructor(
    clientOrOptions: GoogleGmailClient | GmailSourceFileHydratorAdapterOptions,
    options?: GmailSourceFileHydratorAdapterOptions
  ) {
    if ('getMessage' in clientOrOptions) {
      this.gmailClient = clientOrOptions;
      this.auth = options?.auth;
      this.messageId = options?.messageId;
      this.isFileSourceEmailAttachments = options?.isFileSourceEmailAttachments;
      this.pdfProcessor = options?.pdfProcessor ?? new PdfProcessor();
    } else {
      if (!clientOrOptions.gmailClient) {
        throw new Error('GmailSourceFileHydratorAdapter: gmailClient is required');
      }
      this.gmailClient = clientOrOptions.gmailClient;
      this.auth = clientOrOptions.auth;
      this.messageId = clientOrOptions.messageId;
      this.isFileSourceEmailAttachments = clientOrOptions.isFileSourceEmailAttachments;
      this.pdfProcessor = clientOrOptions.pdfProcessor ?? new PdfProcessor();
    }
  }

  async hydrate(sourceFiles: SourceFile[]): Promise<SourceFile[]> {
    if (!sourceFiles || sourceFiles.length === 0) {
      return [];
    }

    const messageId =
      this.messageId ??
      sourceFiles.find((f) => f.id.startsWith('email-pdf-'))?.id.slice('email-pdf-'.length);
    if (!messageId) {
      return [...sourceFiles];
    }

    const candidates = sourceFiles.filter(
      (file) => !(file.content instanceof Uint8Array)
    );

    if (candidates.length === 0) {
      return [...sourceFiles];
    }

    const hasEmailPdf = candidates.some((f) => f.id.startsWith('email-pdf-'));
    const canHydrateAttachments = this.isFileSourceEmailAttachments !== false;
    const hasAttachmentCandidates =
      canHydrateAttachments && candidates.some((f) => !f.id.startsWith('email-pdf-'));

    if (!hasEmailPdf && !hasAttachmentCandidates) {
      return [...sourceFiles];
    }

    const token = this.auth;

    let messageDetails;
    try {
      messageDetails = await this.gmailClient.getMessage(messageId, { auth: token });
    } catch {
      return [...sourceFiles];
    }

    const attachments = messageDetails.attachments ?? [];

    const partIdMap = new Map<string, (typeof attachments)[number]>();
    const attachmentIdMap = new Map<string, (typeof attachments)[number]>();
    const filenameCounts = new Map<string, number>();

    for (const att of attachments) {
      if (att.partId && att.partId.trim().length > 0) {
        partIdMap.set(att.partId.trim(), att);
      }
      if (att.attachmentId && att.attachmentId.trim().length > 0) {
        attachmentIdMap.set(att.attachmentId.trim(), att);
      }
      const rawName = att.filename?.trim();
      if (rawName) {
        filenameCounts.set(rawName, (filenameCounts.get(rawName) ?? 0) + 1);
      }
    }

    const uniqueFilenameMap = new Map<string, (typeof attachments)[number]>();
    if (canHydrateAttachments) {
      for (const att of attachments) {
        const rawName = att.filename?.trim();
        if (rawName && filenameCounts.get(rawName) === 1) {
          uniqueFilenameMap.set(rawName, att);
        }
      }
    }

    const hydrated: SourceFile[] = [];
    for (const file of sourceFiles) {
      if (file.content instanceof Uint8Array) {
        hydrated.push(file);
        continue;
      }

      if (file.id.startsWith('email-pdf-')) {
        const emailMessageId = file.id.slice('email-pdf-'.length) || messageId;
        const msgDetails =
          emailMessageId === messageId
            ? messageDetails
            : await this.gmailClient.getMessage(emailMessageId, { auth: token });

        const resolvedInlineImages: EmailPdfInlineImage[] = [];
        for (const img of msgDetails.inlineImages ?? []) {
          let data = img.data;
          if (!data && img.attachmentId) {
            data = await this.gmailClient.getAttachment(emailMessageId, img.attachmentId, {
              auth: token,
            });
          }
          if (data) {
            resolvedInlineImages.push({
              cid: img.cid,
              mimeType: img.mimeType,
              ...(img.filename !== undefined ? { filename: img.filename } : {}),
              data,
            });
          }
        }

        const attachmentNames = (msgDetails.attachments ?? [])
          .map((att) => att.filename)
          .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);

        const renderInput: EmailPdfRenderInput = {
          messageId: emailMessageId,
          ...(msgDetails.rfcMessageId !== undefined ? { rfcMessageId: msgDetails.rfcMessageId } : {}),
          ...(msgDetails.subject !== undefined ? { subject: msgDetails.subject } : {}),
          ...(msgDetails.from !== undefined ? { from: msgDetails.from } : {}),
          ...(msgDetails.to !== undefined ? { to: msgDetails.to } : {}),
          ...(msgDetails.cc !== undefined ? { cc: msgDetails.cc } : {}),
          ...(msgDetails.date !== undefined ? { date: msgDetails.date } : {}),
          ...(attachmentNames.length > 0 ? { attachmentNames } : {}),
          ...(msgDetails.plainTextBody !== undefined ? { plainTextBody: msgDetails.plainTextBody } : {}),
          ...(msgDetails.htmlBody !== undefined ? { htmlBody: msgDetails.htmlBody } : {}),
          ...(resolvedInlineImages.length > 0 ? { inlineImages: resolvedInlineImages } : {}),
        };

        const pdfBytes = await this.pdfProcessor.generateEmailPdf(renderInput);
        const pdfFileName =
          file.name || formatEmailPdfFileName(msgDetails.subject, emailMessageId);

        hydrated.push({
          id: file.id,
          name: pdfFileName,
          mimeType: 'application/pdf',
          content: pdfBytes,
        });
        continue;
      }

      if (canHydrateAttachments) {
        const fileId = file.id.trim();
        const fileName = file.name?.trim();

        let matchedAtt = partIdMap.get(fileId);

        if (!matchedAtt) {
          matchedAtt = attachmentIdMap.get(fileId);
        }

        if (!matchedAtt) {
          if (fileName) {
            matchedAtt = uniqueFilenameMap.get(fileName);
          }
          if (!matchedAtt) {
            matchedAtt = uniqueFilenameMap.get(fileId);
          }
        }

        if (matchedAtt) {
          let content = matchedAtt.data;
          if (!content) {
            content = await this.gmailClient.getAttachment(messageId, matchedAtt.attachmentId, {
              auth: token,
            });
          }

          hydrated.push({
            id: file.id,
            name: file.name || matchedAtt.filename,
            mimeType: file.mimeType || matchedAtt.mimeType,
            content,
          });
          continue;
        }
      }

      hydrated.push(file);
    }

    return hydrated;
  }
}

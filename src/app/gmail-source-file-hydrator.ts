import type { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { UiProcessSourceFileDto } from '../features/ui-process-manager/ports';
import { PdfProcessor } from '../infrastructure/pdf/pdf-processor';
import type { EmailPdfInlineImage, EmailPdfRenderInput } from '../infrastructure/pdf/types';
import { formatEmailPdfFileName } from '../features/document/domain';

export class GmailSourceFileHydrator {
  constructor(
    private readonly gmailClient: GoogleGmailClient,
    private readonly pdfProcessor: PdfProcessor = new PdfProcessor()
  ) {}

  async hydrate(
    sourceFiles: UiProcessSourceFileDto[],
    context: WorkspaceExecutionContext
  ): Promise<UiProcessSourceFileDto[]> {
    if (!sourceFiles || sourceFiles.length === 0) {
      return [];
    }

    const messageId =
      context.gmail?.messageId ??
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

    const token = context.userOAuthToken ?? context.gmail?.accessToken;

    let messageDetails;
    try {
      messageDetails = await this.gmailClient.getMessage(messageId, { auth: token });
    } catch {
      return [...sourceFiles];
    }

    const attachmentMap = new Map<
      string,
      { filename: string; mimeType: string; data?: Uint8Array | undefined }
    >();

    for (const att of messageDetails.attachments ?? []) {
      attachmentMap.set(att.attachmentId, {
        filename: att.filename,
        mimeType: att.mimeType,
        ...(att.data !== undefined ? { data: att.data } : {}),
      });
    }

    const hydrated: UiProcessSourceFileDto[] = [];
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

      const attMeta = attachmentMap.get(file.id);
      if (attMeta) {
        let content = attMeta.data;
        if (!content) {
          content = await this.gmailClient.getAttachment(messageId, file.id, {
            auth: token,
          });
        }

        hydrated.push({
          id: file.id,
          name: file.name || attMeta.filename,
          mimeType: file.mimeType || attMeta.mimeType,
          content,
        });
      } else {
        hydrated.push(file);
      }
    }

    return hydrated;
  }
}

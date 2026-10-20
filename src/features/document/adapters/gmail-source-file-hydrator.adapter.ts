import { DriveServiceError, type SourceFile, type SourceFileHydratorPort } from '../ports';
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
  public readonly auth?: string | undefined;
  public readonly messageId?: string | undefined;
  public readonly isFileSourceEmailAttachments?: boolean | undefined;

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

    const messageId =
      this.messageId ??
      sourceFiles.find((f) => f.id.startsWith('email-pdf-'))?.id.slice('email-pdf-'.length);

    if (!messageId) {
      if (this.isFileSourceEmailAttachments === true && hasAttachmentCandidates) {
        throw new DriveServiceError(
          'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
        );
      }
      if (hasEmailPdf) {
        throw new DriveServiceError('Could not generate the Email PDF. Please try again.');
      }
      return [...sourceFiles];
    }

    const token = this.auth;

    let primaryMessageDetails:
      | Awaited<ReturnType<GoogleGmailClient['getMessage']>>
      | undefined;

    const fetchMessage = async (msgId: string, forAttachment: boolean) => {
      if (msgId === messageId && primaryMessageDetails) {
        return primaryMessageDetails;
      }
      try {
        const details = await this.gmailClient.getMessage(msgId, { auth: token });
        if (!details) {
          throw new Error('Message details not found');
        }
        if (msgId === messageId) {
          primaryMessageDetails = details;
        }
        return details;
      } catch (err) {
        if (err instanceof DriveServiceError) {
          throw err;
        }
        if (forAttachment) {
          throw new DriveServiceError(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          );
        } else {
          throw new DriveServiceError('Could not generate the Email PDF. Please try again.');
        }
      }
    };

    let attachmentMapsPromise:
      | Promise<{
          partIdMap: Map<string, NonNullable<Awaited<ReturnType<GoogleGmailClient['getMessage']>>['attachments']>[number]>;
          attachmentIdMap: Map<string, NonNullable<Awaited<ReturnType<GoogleGmailClient['getMessage']>>['attachments']>[number]>;
          uniqueFilenameMap: Map<string, NonNullable<Awaited<ReturnType<GoogleGmailClient['getMessage']>>['attachments']>[number]>;
        }>
      | undefined;

    const getAttachmentMaps = async () => {
      if (!attachmentMapsPromise) {
        attachmentMapsPromise = (async () => {
          const details = await fetchMessage(messageId, true);
          const attachments = details.attachments ?? [];

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
          for (const att of attachments) {
            const rawName = att.filename?.trim();
            if (rawName && filenameCounts.get(rawName) === 1) {
              uniqueFilenameMap.set(rawName, att);
            }
          }

          return { partIdMap, attachmentIdMap, uniqueFilenameMap };
        })();
      }
      return attachmentMapsPromise;
    };

    const hydrated: SourceFile[] = [];
    for (const file of sourceFiles) {
      if (file.content instanceof Uint8Array) {
        hydrated.push(file);
        continue;
      }

      if (file.id.startsWith('email-pdf-')) {
        const emailMessageId = file.id.slice('email-pdf-'.length) || messageId;
        const msgDetails = await fetchMessage(emailMessageId, false);

        const resolvedInlineImages: EmailPdfInlineImage[] = [];
        for (const img of msgDetails.inlineImages ?? []) {
          let data = img.data;
          if (!data && img.attachmentId) {
            try {
              data = await this.gmailClient.getAttachment(emailMessageId, img.attachmentId, {
                auth: token,
              });
            } catch {
              throw new DriveServiceError('Could not generate the Email PDF. Please try again.');
            }
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

        let pdfBytes: Uint8Array;
        try {
          pdfBytes = await this.pdfProcessor.generateEmailPdf(renderInput);
        } catch {
          throw new DriveServiceError('Could not generate the Email PDF. Please try again.');
        }

        if (!(pdfBytes instanceof Uint8Array)) {
          throw new DriveServiceError('Could not generate the Email PDF. Please try again.');
        }

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

        const { partIdMap, attachmentIdMap, uniqueFilenameMap } = await getAttachmentMaps();

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
          const isInline =
            matchedAtt.data instanceof Uint8Array ||
            matchedAtt.attachmentId?.startsWith('inline-') ||
            matchedAtt.partId?.startsWith('inline-') ||
            fileId.startsWith('inline-');

          if (!content && !isInline) {
            if (!matchedAtt.attachmentId) {
              throw new DriveServiceError(
                'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
              );
            }
            try {
              content = await this.gmailClient.getAttachment(messageId, matchedAtt.attachmentId, {
                auth: token,
              });
            } catch {
              throw new DriveServiceError(
                'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
              );
            }
          }

          if (!(content instanceof Uint8Array)) {
            throw new DriveServiceError(
              'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
            );
          }

          hydrated.push({
            id: file.id,
            name: file.name || matchedAtt.filename,
            mimeType: file.mimeType || matchedAtt.mimeType,
            ...(content !== undefined ? { content } : {}),
          });
          continue;
        }

        if (this.isFileSourceEmailAttachments === true) {
          throw new DriveServiceError(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          );
        }
      }

      hydrated.push(file);
    }

    return hydrated;
  }
}

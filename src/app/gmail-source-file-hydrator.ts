import type { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { UiProcessSourceFileDto } from '../features/ui-process-manager/ports';

export class GmailSourceFileHydrator {
  constructor(private readonly gmailClient: GoogleGmailClient) {}

  async hydrate(
    sourceFiles: UiProcessSourceFileDto[],
    context: WorkspaceExecutionContext
  ): Promise<UiProcessSourceFileDto[]> {
    if (!sourceFiles || sourceFiles.length === 0) {
      return [];
    }

    const messageId = context.gmail?.messageId;
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

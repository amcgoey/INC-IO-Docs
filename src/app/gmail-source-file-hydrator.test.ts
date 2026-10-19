import { describe, it, expect, vi } from 'vitest';
import { GmailSourceFileHydrator } from './gmail-source-file-hydrator';
import type { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { UiProcessSourceFileDto } from '../features/ui-process-manager/ports';

describe('GmailSourceFileHydrator', () => {
  it('returns empty array when sourceFiles is empty or undefined', async () => {
    const mockGmailClient = {
      getMessage: vi.fn(),
      getAttachment: vi.fn(),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydrator(mockGmailClient);
    const result = await hydrator.hydrate([], {} as WorkspaceExecutionContext);
    expect(result).toEqual([]);
  });

  it('returns sourceFiles unchanged when context.gmail.messageId is undefined', async () => {
    const mockGmailClient = {
      getMessage: vi.fn(),
      getAttachment: vi.fn(),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydrator(mockGmailClient);
    const files: UiProcessSourceFileDto[] = [{ id: 'drive-file-1', name: 'File.pdf' }];
    const result = await hydrator.hydrate(files, {} as WorkspaceExecutionContext);
    expect(result).toEqual(files);
    expect(mockGmailClient.getMessage).not.toHaveBeenCalled();
  });

  it('returns sourceFiles unchanged if all files already have binary content', async () => {
    const mockGmailClient = {
      getMessage: vi.fn(),
      getAttachment: vi.fn(),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydrator(mockGmailClient);
    const files: UiProcessSourceFileDto[] = [
      { id: 'att-1', content: new Uint8Array([1, 2, 3]) },
    ];
    const context: WorkspaceExecutionContext = {
      gmail: { messageId: 'msg-123' },
    };
    const result = await hydrator.hydrate(files, context);
    expect(result).toEqual(files);
    expect(mockGmailClient.getMessage).not.toHaveBeenCalled();
  });

  it('hydrates Gmail attachments by fetching metadata and bytes via getAttachment', async () => {
    const attachmentBytes = new Uint8Array([10, 20, 30, 40]);
    const mockGmailClient = {
      getMessage: vi.fn().mockResolvedValue({
        messageId: 'msg-123',
        attachments: [
          {
            attachmentId: 'att-1',
            filename: 'Invoice.pdf',
            mimeType: 'application/pdf',
          },
          {
            attachmentId: 'att-2',
            filename: 'Receipt.png',
            mimeType: 'image/png',
          },
        ],
      }),
      getAttachment: vi.fn().mockResolvedValue(attachmentBytes),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydrator(mockGmailClient);
    const files: UiProcessSourceFileDto[] = [
      { id: 'att-1' },
      { id: 'drive-folder-456', name: 'Existing Folder' }, // not in attachments
    ];
    const context: WorkspaceExecutionContext = {
      gmail: { messageId: 'msg-123', accessToken: 'ya29.live-token' },
      userOAuthToken: 'ya29.user-token',
    };

    const result = await hydrator.hydrate(files, context);

    expect(mockGmailClient.getMessage).toHaveBeenCalledWith('msg-123', {
      auth: 'ya29.user-token',
    });
    expect(mockGmailClient.getAttachment).toHaveBeenCalledTimes(1);
    expect(mockGmailClient.getAttachment).toHaveBeenCalledWith('msg-123', 'att-1', {
      auth: 'ya29.user-token',
    });

    expect(result).toEqual([
      {
        id: 'att-1',
        name: 'Invoice.pdf',
        mimeType: 'application/pdf',
        content: attachmentBytes,
      },
      {
        id: 'drive-folder-456',
        name: 'Existing Folder',
      },
    ]);
  });

  it('preserves existing name and mimeType on sourceFile if already present', async () => {
    const attachmentBytes = new Uint8Array([50, 60]);
    const mockGmailClient = {
      getMessage: vi.fn().mockResolvedValue({
        messageId: 'msg-123',
        attachments: [
          {
            attachmentId: 'att-1',
            filename: 'OriginalName.pdf',
            mimeType: 'application/pdf',
          },
        ],
      }),
      getAttachment: vi.fn().mockResolvedValue(attachmentBytes),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydrator(mockGmailClient);
    const files: UiProcessSourceFileDto[] = [
      { id: 'att-1', name: 'CustomRenamed.pdf', mimeType: 'application/x-custom' },
    ];
    const context: WorkspaceExecutionContext = {
      gmail: { messageId: 'msg-123' },
    };

    const result = await hydrator.hydrate(files, context);

    expect(result).toEqual([
      {
        id: 'att-1',
        name: 'CustomRenamed.pdf',
        mimeType: 'application/x-custom',
        content: attachmentBytes,
      },
    ]);
  });
});

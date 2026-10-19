import { describe, it, expect, vi } from 'vitest';
import { GmailSourceFileHydrator } from './gmail-source-file-hydrator';
import type { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { UiProcessSourceFileDto } from '../features/ui-process-manager/ports';
import type { PdfProcessor } from '../infrastructure/pdf/pdf-processor';

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

  describe('email-pdf hydration', () => {
    it('hydrates email-pdf descriptor: downloads inline images, calls generateEmailPdf, formats filename', async () => {
      const inlineImageBytes = new Uint8Array([200, 201, 202]);
      const generatedPdfBytes = new Uint8Array([37, 80, 68, 70]); // %PDF
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-abc',
          rfcMessageId: '<abc@example.com>',
          subject: 'Weekly Project Status',
          from: 'Alice <alice@example.com>',
          to: 'Bob <bob@example.com>',
          cc: 'Carol <carol@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 GMT',
          plainTextBody: 'Hello Bob,\nHere is the weekly update.',
          htmlBody: '<p>Hello Bob,</p><p><img src="cid:img001"></p>',
          attachments: [
            {
              attachmentId: 'att-other',
              filename: 'Specs.docx',
              mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            },
          ],
          inlineImages: [
            {
              cid: 'img001',
              partId: 'part-inline-1',
              attachmentId: 'att-inline-1',
              filename: 'chart.png',
              mimeType: 'image/png',
            },
            {
              cid: 'img002',
              partId: 'part-inline-2',
              filename: 'already-binary.png',
              mimeType: 'image/png',
              data: new Uint8Array([111, 222]),
            },
          ],
        }),
        getAttachment: vi.fn().mockResolvedValue(inlineImageBytes),
      } as unknown as GoogleGmailClient;

      const mockPdfProcessor = {
        generateEmailPdf: vi.fn().mockResolvedValue(generatedPdfBytes),
      };

      const hydrator = new GmailSourceFileHydrator(mockGmailClient, mockPdfProcessor as unknown as PdfProcessor);
      const files: UiProcessSourceFileDto[] = [
        { id: 'email-pdf-msg-abc', mimeType: 'application/pdf' },
      ];
      const context: WorkspaceExecutionContext = {
        gmail: { messageId: 'msg-abc' },
        userOAuthToken: 'ya29.auth-token',
      };

      const result = await hydrator.hydrate(files, context);

      expect(mockGmailClient.getMessage).toHaveBeenCalledWith('msg-abc', {
        auth: 'ya29.auth-token',
      });
      // Fetch only the inline image that lacks binary data
      expect(mockGmailClient.getAttachment).toHaveBeenCalledTimes(1);
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith('msg-abc', 'att-inline-1', {
        auth: 'ya29.auth-token',
      });

      // generateEmailPdf called with all headers, bodies, attachment names, and inline images
      expect(mockPdfProcessor.generateEmailPdf).toHaveBeenCalledWith({
        messageId: 'msg-abc',
        rfcMessageId: '<abc@example.com>',
        subject: 'Weekly Project Status',
        from: 'Alice <alice@example.com>',
        to: 'Bob <bob@example.com>',
        cc: 'Carol <carol@example.com>',
        date: 'Mon, 19 Oct 2026 10:00:00 GMT',
        plainTextBody: 'Hello Bob,\nHere is the weekly update.',
        htmlBody: '<p>Hello Bob,</p><p><img src="cid:img001"></p>',
        attachmentNames: ['Specs.docx'],
        inlineImages: [
          {
            cid: 'img001',
            mimeType: 'image/png',
            filename: 'chart.png',
            data: inlineImageBytes,
          },
          {
            cid: 'img002',
            mimeType: 'image/png',
            filename: 'already-binary.png',
            data: new Uint8Array([111, 222]),
          },
        ],
      });

      expect(result).toEqual([
        {
          id: 'email-pdf-msg-abc',
          name: 'Email - Weekly Project Status.pdf',
          mimeType: 'application/pdf',
          content: generatedPdfBytes,
        },
      ]);
    });

    it('falls back to Email - <messageId>.pdf when subject is empty or whitespace', async () => {
      const generatedPdfBytes = new Uint8Array([1, 2, 3]);
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-no-subject',
          subject: '   ',
          plainTextBody: 'Body without subject',
          attachments: [],
          inlineImages: [],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const mockPdfProcessor = {
        generateEmailPdf: vi.fn().mockResolvedValue(generatedPdfBytes),
      };

      const hydrator = new GmailSourceFileHydrator(mockGmailClient, mockPdfProcessor as unknown as PdfProcessor);
      const files: UiProcessSourceFileDto[] = [
        { id: 'email-pdf-msg-no-subject', mimeType: 'application/pdf' },
      ];
      const context: WorkspaceExecutionContext = {
        gmail: { messageId: 'msg-no-subject' },
      };

      const result = await hydrator.hydrate(files, context);

      expect(result[0].name).toBe('Email - msg-no-subject.pdf');
      expect(result[0].content).toEqual(generatedPdfBytes);
    });

    it('re-uses fetched message across attachment hydration and PDF generation in the same request', async () => {
      const attachmentBytes = new Uint8Array([10, 20]);
      const generatedPdfBytes = new Uint8Array([30, 40]);

      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-combo',
          subject: 'Project Combo',
          attachments: [
            {
              attachmentId: 'att-1',
              filename: 'Estimate.pdf',
              mimeType: 'application/pdf',
            },
          ],
          inlineImages: [],
        }),
        getAttachment: vi.fn().mockResolvedValue(attachmentBytes),
      } as unknown as GoogleGmailClient;

      const mockPdfProcessor = {
        generateEmailPdf: vi.fn().mockResolvedValue(generatedPdfBytes),
      };

      const hydrator = new GmailSourceFileHydrator(mockGmailClient, mockPdfProcessor as unknown as PdfProcessor);
      const files: UiProcessSourceFileDto[] = [
        { id: 'att-1' },
        { id: 'email-pdf-msg-combo', mimeType: 'application/pdf' },
      ];
      const context: WorkspaceExecutionContext = {
        gmail: { messageId: 'msg-combo' },
      };

      const result = await hydrator.hydrate(files, context);

      // getMessage must be called only ONCE for both attachments and PDF
      expect(mockGmailClient.getMessage).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'att-1',
        name: 'Estimate.pdf',
        mimeType: 'application/pdf',
        content: attachmentBytes,
      });
      expect(result[1]).toEqual({
        id: 'email-pdf-msg-combo',
        name: 'Email - Project Combo.pdf',
        mimeType: 'application/pdf',
        content: generatedPdfBytes,
      });
    });
  });
});

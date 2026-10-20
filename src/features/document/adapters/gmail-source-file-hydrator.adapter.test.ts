import { describe, it, expect, vi } from 'vitest';
import { GmailSourceFileHydratorAdapter } from './gmail-source-file-hydrator.adapter';
import type { GoogleGmailClient } from '../../../infrastructure/gmail/gmail-client';
import type { SourceFile } from '../ports';
import type { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';

describe('GmailSourceFileHydratorAdapter', () => {
  it('returns empty array when sourceFiles is empty or undefined', async () => {
    const mockGmailClient = {
      getMessage: vi.fn(),
      getAttachment: vi.fn(),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
      messageId: 'msg-123',
    });
    const result = await hydrator.hydrate([]);
    expect(result).toEqual([]);
    expect(mockGmailClient.getMessage).not.toHaveBeenCalled();
  });

  it('returns sourceFiles unchanged when messageId is undefined and no email-pdf files', async () => {
    const mockGmailClient = {
      getMessage: vi.fn(),
      getAttachment: vi.fn(),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
      auth: 'ya29.auth',
    });
    const files: SourceFile[] = [{ id: 'drive-file-1', name: 'File.pdf' }];
    const result = await hydrator.hydrate(files);
    expect(result).toEqual(files);
    expect(mockGmailClient.getMessage).not.toHaveBeenCalled();
  });

  it('returns sourceFiles unchanged if all files already have binary content', async () => {
    const mockGmailClient = {
      getMessage: vi.fn(),
      getAttachment: vi.fn(),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
      messageId: 'msg-123',
      isFileSourceEmailAttachments: true,
    });
    const files: SourceFile[] = [
      { id: 'att-1', content: new Uint8Array([1, 2, 3]) },
    ];
    const result = await hydrator.hydrate(files);
    expect(result).toEqual(files);
    expect(mockGmailClient.getMessage).not.toHaveBeenCalled();
  });

  it('returns sourceFiles unchanged without calling getMessage when isFileSourceEmailAttachments is false and no email-pdf files exist', async () => {
    const mockGmailClient = {
      getMessage: vi.fn(),
      getAttachment: vi.fn(),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
      messageId: 'msg-123',
      isFileSourceEmailAttachments: false,
    });
    const files: SourceFile[] = [{ id: 'drive-file-999', name: 'DriveDoc.pdf' }];
    const result = await hydrator.hydrate(files);
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

    const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
      messageId: 'msg-123',
      auth: 'ya29.user-token',
      isFileSourceEmailAttachments: true,
    });
    const files: SourceFile[] = [
      { id: 'att-1' },
    ];

    const result = await hydrator.hydrate(files);

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
    ]);
  });

  it('leaves non-attachment files unchanged when isFileSourceEmailAttachments is undefined', async () => {
    const attachmentBytes = new Uint8Array([10, 20]);
    const mockGmailClient = {
      getMessage: vi.fn().mockResolvedValue({
        messageId: 'msg-123',
        attachments: [
          {
            attachmentId: 'att-1',
            filename: 'Invoice.pdf',
            mimeType: 'application/pdf',
          },
        ],
      }),
      getAttachment: vi.fn().mockResolvedValue(attachmentBytes),
    } as unknown as GoogleGmailClient;

    const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
      messageId: 'msg-123',
    });
    const files: SourceFile[] = [
      { id: 'att-1' },
      { id: 'drive-folder-456', name: 'Existing Folder' },
    ];

    const result = await hydrator.hydrate(files);

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

    const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
      messageId: 'msg-123',
      isFileSourceEmailAttachments: true,
    });
    const files: SourceFile[] = [
      { id: 'att-1', name: 'CustomRenamed.pdf', mimeType: 'application/x-custom' },
    ];

    const result = await hydrator.hydrate(files);

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

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-abc',
        auth: 'ya29.auth-token',
        pdfProcessor: mockPdfProcessor as unknown as PdfProcessor,
      });
      const files: SourceFile[] = [
        { id: 'email-pdf-msg-abc', mimeType: 'application/pdf' },
      ];

      const result = await hydrator.hydrate(files);

      expect(mockGmailClient.getMessage).toHaveBeenCalledWith('msg-abc', {
        auth: 'ya29.auth-token',
      });
      expect(mockGmailClient.getAttachment).toHaveBeenCalledTimes(1);
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith('msg-abc', 'att-inline-1', {
        auth: 'ya29.auth-token',
      });

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

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-no-subject',
        pdfProcessor: mockPdfProcessor as unknown as PdfProcessor,
      });
      const files: SourceFile[] = [
        { id: 'email-pdf-msg-no-subject', mimeType: 'application/pdf' },
      ];

      const result = await hydrator.hydrate(files);

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

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-combo',
        isFileSourceEmailAttachments: true,
        pdfProcessor: mockPdfProcessor as unknown as PdfProcessor,
      });
      const files: SourceFile[] = [
        { id: 'att-1' },
        { id: 'email-pdf-msg-combo', mimeType: 'application/pdf' },
      ];

      const result = await hydrator.hydrate(files);

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

    it('hydrates email-pdf descriptor and leaves Drive item unchanged when isFileSourceEmailAttachments is false', async () => {
      const generatedPdfBytes = new Uint8Array([1, 2, 3]);
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-drive-and-pdf',
          subject: 'Drive and PDF',
          plainTextBody: 'Body',
          attachments: [
            {
              attachmentId: 'drive-file-abc', // Even if an attachment ID collided, it should NOT be touched
              filename: 'CollidedAttachment.pdf',
              mimeType: 'application/pdf',
            },
          ],
          inlineImages: [],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const mockPdfProcessor = {
        generateEmailPdf: vi.fn().mockResolvedValue(generatedPdfBytes),
      };

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-drive-and-pdf',
        isFileSourceEmailAttachments: false,
        pdfProcessor: mockPdfProcessor as unknown as PdfProcessor,
      });
      const files: SourceFile[] = [
        { id: 'drive-file-abc', name: 'GoogleDoc.gdoc' },
        { id: 'email-pdf-msg-drive-and-pdf', mimeType: 'application/pdf' },
      ];

      const result = await hydrator.hydrate(files);

      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 'drive-file-abc',
        name: 'GoogleDoc.gdoc',
      });
      expect(result[1]).toEqual({
        id: 'email-pdf-msg-drive-and-pdf',
        name: 'Email - Drive and PDF.pdf',
        mimeType: 'application/pdf',
        content: generatedPdfBytes,
      });
    });

    it('matches attachments by partId and invokes getAttachment with matched descriptor fresh attachmentId rather than SourceFile.id', async () => {
      const attachmentBytes = new Uint8Array([1, 2, 3]);
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-fresh-token',
          attachments: [
            {
              partId: 'part-0.1',
              attachmentId: 'att-rotated-fresh-token-xyz',
              filename: 'Report.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn().mockResolvedValue(attachmentBytes),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-fresh-token',
        auth: 'ya29.auth',
        isFileSourceEmailAttachments: true,
      });

      // SourceFile.id has partId 'part-0.1'
      const files: SourceFile[] = [{ id: 'part-0.1', name: 'Report.pdf' }];

      const result = await hydrator.hydrate(files);

      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(
        'msg-fresh-token',
        'att-rotated-fresh-token-xyz',
        { auth: 'ya29.auth' }
      );
      expect(result).toEqual([
        {
          id: 'part-0.1',
          name: 'Report.pdf',
          mimeType: 'application/pdf',
          content: attachmentBytes,
        },
      ]);
    });

    it('hydrates multiple attachments sharing the same filename with distinct partIds using fresh attachmentIds', async () => {
      const bytes1 = new Uint8Array([10, 11]);
      const bytes2 = new Uint8Array([20, 21]);

      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-duplicate-names',
          attachments: [
            {
              partId: 'part-0',
              attachmentId: 'att-fresh-1',
              filename: 'invoice.pdf',
              mimeType: 'application/pdf',
            },
            {
              partId: 'part-1',
              attachmentId: 'att-fresh-2',
              filename: 'invoice.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn().mockImplementation(async (_msgId: string, attId: string) => {
          if (attId === 'att-fresh-1') return bytes1;
          if (attId === 'att-fresh-2') return bytes2;
          throw new Error('Unknown attId');
        }),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-duplicate-names',
        isFileSourceEmailAttachments: true,
      });

      const files: SourceFile[] = [
        { id: 'part-0', name: 'invoice.pdf' },
        { id: 'part-1', name: 'invoice.pdf' },
      ];

      const result = await hydrator.hydrate(files);

      expect(mockGmailClient.getAttachment).toHaveBeenCalledTimes(2);
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith('msg-duplicate-names', 'att-fresh-1', expect.anything());
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith('msg-duplicate-names', 'att-fresh-2', expect.anything());

      expect(result).toEqual([
        {
          id: 'part-0',
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
          content: bytes1,
        },
        {
          id: 'part-1',
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
          content: bytes2,
        },
      ]);
    });

    it('matches by unique filename fallback when active File Source is Email Attachments and filename is unique', async () => {
      const bytes = new Uint8Array([99]);
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-unique-fallback',
          attachments: [
            {
              partId: 'part-0.5',
              attachmentId: 'att-token-555',
              filename: 'UniqueContract.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn().mockResolvedValue(bytes),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-unique-fallback',
        isFileSourceEmailAttachments: true,
      });

      // File has legacy / mismatched id but matching unique filename
      const files: SourceFile[] = [{ id: 'legacy-id-or-stale-token', name: 'UniqueContract.pdf' }];

      const result = await hydrator.hydrate(files);

      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith('msg-unique-fallback', 'att-token-555', expect.anything());
      expect(result[0].content).toEqual(bytes);
    });

    it('does NOT fallback to filename match when filename is duplicated among message attachments', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-ambiguous-names',
          attachments: [
            {
              partId: 'part-1',
              attachmentId: 'att-1',
              filename: 'photo.jpg',
              mimeType: 'image/jpeg',
            },
            {
              partId: 'part-2',
              attachmentId: 'att-2',
              filename: 'photo.jpg',
              mimeType: 'image/jpeg',
            },
          ],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-ambiguous-names',
        isFileSourceEmailAttachments: true,
      });

      // An unidentifiable file with id 'unknown' and non-unique name 'photo.jpg'
      const files: SourceFile[] = [{ id: 'unknown', name: 'photo.jpg' }];

      await expect(hydrator.hydrate(files)).rejects.toThrow(
        'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
      );

      // Should not guess or download an arbitrary attachment
      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
    });

    it('does NOT fallback to filename match when isFileSourceEmailAttachments is undefined', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-unique-fallback-no-opt',
          attachments: [
            {
              partId: 'part-0.5',
              attachmentId: 'att-token-555',
              filename: 'UniqueContract.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-unique-fallback-no-opt',
        // isFileSourceEmailAttachments is undefined
      });

      const files: SourceFile[] = [{ id: 'drive-file-id-123', name: 'UniqueContract.pdf' }];

      const result = await hydrator.hydrate(files);

      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
      expect(result).toEqual(files);
      expect(result[0].content).toBeUndefined();
    });

    it('does NOT treat fileId as a candidate filename during unique filename fallback', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-fileid-not-filename',
          attachments: [
            {
              partId: 'part-1',
              attachmentId: 'att-token-1',
              filename: 'UniqueContract.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-fileid-not-filename',
        isFileSourceEmailAttachments: true,
      });

      // fileId matches the attachment filename, but name is undefined / different
      const files: SourceFile[] = [{ id: 'UniqueContract.pdf' }];

      await expect(hydrator.hydrate(files)).rejects.toThrow(
        'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
      );

      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
    });

    it('throws DriveServiceError when pdfProcessor is omitted and an email-pdf file is hydrated', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-no-pdf-processor',
          subject: 'No PDF Processor',
          attachments: [],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-no-pdf-processor',
        // pdfProcessor omitted
      });

      const files: SourceFile[] = [{ id: 'email-pdf-msg-no-pdf-processor' }];

      await expect(hydrator.hydrate(files)).rejects.toThrow(
        'Could not generate the Email PDF. Please try again.'
      );
    });

    it('processes source files sequentially in order', async () => {
      const callOrder: string[] = [];
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-seq',
          subject: 'Sequential Order',
          attachments: [
            {
              partId: 'part-1',
              attachmentId: 'att-1',
              filename: 'First.pdf',
              mimeType: 'application/pdf',
            },
            {
              partId: 'part-2',
              attachmentId: 'att-2',
              filename: 'Second.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn().mockImplementation(async (_msgId: string, attId: string) => {
          callOrder.push(attId);
          await new Promise((r) => setTimeout(r, 10));
          return new Uint8Array([1]);
        }),
      } as unknown as GoogleGmailClient;

      const mockPdfProcessor = {
        generateEmailPdf: vi.fn().mockImplementation(async () => {
          callOrder.push('email-pdf');
          await new Promise((r) => setTimeout(r, 10));
          return new Uint8Array([2]);
        }),
      };

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-seq',
        isFileSourceEmailAttachments: true,
        pdfProcessor: mockPdfProcessor as unknown as PdfProcessor,
      });

      const files: SourceFile[] = [
        { id: 'part-1' },
        { id: 'email-pdf-msg-seq', mimeType: 'application/pdf' },
        { id: 'part-2' },
      ];

      await hydrator.hydrate(files);

      expect(callOrder).toEqual(['att-1', 'email-pdf', 'att-2']);
    });
    describe('Small Inline Attachments (Ticket #205)', () => {
      it('resolves binary content directly from descriptor data without calling getAttachment when data is present', async () => {
        const inlineBytes = new Uint8Array([11, 22, 33, 44]);
        const mockGmailClient = {
          getMessage: vi.fn().mockResolvedValue({
            id: 'msg-inline-hydrator',
            attachments: [
              {
                partId: 'part-inline-1',
                attachmentId: 'inline-part-inline-1',
                filename: 'inline-note.txt',
                mimeType: 'text/plain',
                size: 4,
                data: inlineBytes,
              },
            ],
          }),
          getAttachment: vi.fn(),
        } as unknown as GoogleGmailClient;

        const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
          messageId: 'msg-inline-hydrator',
          isFileSourceEmailAttachments: true,
        });

        const files: SourceFile[] = [{ id: 'part-inline-1' }];
        const result = await hydrator.hydrate(files);

        expect(mockGmailClient.getMessage).toHaveBeenCalledWith('msg-inline-hydrator', {
          auth: undefined,
        });
        expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
        expect(result).toEqual([
          {
            id: 'part-inline-1',
            name: 'inline-note.txt',
            mimeType: 'text/plain',
            content: inlineBytes,
          },
        ]);
      });

      it('does NOT invoke getAttachment and throws fail-fast error when matched attachment id starts with inline- even if data is undefined', async () => {
        const mockGmailClient = {
          getMessage: vi.fn().mockResolvedValue({
            id: 'msg-inline-nodata',
            attachments: [
              {
                partId: 'part-inline-nodata',
                attachmentId: 'inline-part-inline-nodata',
                filename: 'no-data.txt',
                mimeType: 'text/plain',
                size: 0,
                // data undefined
              },
            ],
          }),
          getAttachment: vi.fn(),
        } as unknown as GoogleGmailClient;

        const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
          messageId: 'msg-inline-nodata',
          isFileSourceEmailAttachments: true,
        });

        const files: SourceFile[] = [{ id: 'part-inline-nodata' }];
        await expect(hydrator.hydrate(files)).rejects.toThrow(
          'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
        );

        expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
      });

      it('resolves binary content directly from descriptor data when matched by unique filename without invoking getAttachment', async () => {
        const inlineBytes = new Uint8Array([99, 88, 77]);
        const mockGmailClient = {
          getMessage: vi.fn().mockResolvedValue({
            id: 'msg-unique-filename-inline',
            attachments: [
              {
                partId: 'part-0.3',
                attachmentId: 'inline-part-0.3',
                filename: 'manifest.json',
                mimeType: 'application/json',
                size: 3,
                data: inlineBytes,
              },
            ],
          }),
          getAttachment: vi.fn(),
        } as unknown as GoogleGmailClient;

        const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
          messageId: 'msg-unique-filename-inline',
          isFileSourceEmailAttachments: true,
        });

        // Request file with non-partId id but matching unique filename
        const files: SourceFile[] = [{ id: 'legacy-form-item-id', name: 'manifest.json' }];
        const result = await hydrator.hydrate(files);

        expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
        expect(result[0]?.content).toEqual(inlineBytes);
        expect(result[0]?.name).toBe('manifest.json');
      });
    });

  });
  describe('Ticket #207: Fail-fast hydration error attribution', () => {
    it('throws DriveServiceError with attachment message when getMessage fails and isFileSourceEmailAttachments is true', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockRejectedValue(new Error('Network error')),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-err',
        isFileSourceEmailAttachments: true,
      });

      await expect(hydrator.hydrate([{ id: 'att-1' }])).rejects.toThrow(
        'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
      );
    });

    it('throws DriveServiceError with attachment message when getAttachment fails for an attachment', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          messageId: 'msg-ok',
          attachments: [
            {
              attachmentId: 'att-fail',
              filename: 'Fail.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn().mockRejectedValue(new Error('Download failed')),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-ok',
        isFileSourceEmailAttachments: true,
      });

      await expect(hydrator.hydrate([{ id: 'att-fail' }])).rejects.toThrow(
        'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
      );
    });

    it('throws DriveServiceError with attachment message when selected attachment cannot be matched in attachments', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          messageId: 'msg-ok',
          attachments: [
            {
              attachmentId: 'att-other',
              filename: 'Other.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-ok',
        isFileSourceEmailAttachments: true,
      });

      await expect(hydrator.hydrate([{ id: 'att-unmatched' }])).rejects.toThrow(
        'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
      );
    });

    it('throws DriveServiceError with attachment message when getAttachment returns non-Uint8Array', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          messageId: 'msg-ok',
          attachments: [
            {
              attachmentId: 'att-bad-content',
              filename: 'Bad.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        getAttachment: vi.fn().mockResolvedValue('not bytes' as unknown as Uint8Array),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-ok',
        isFileSourceEmailAttachments: true,
      });

      await expect(hydrator.hydrate([{ id: 'att-bad-content' }])).rejects.toThrow(
        'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
      );
    });

    it('throws DriveServiceError with PDF message when getMessage fails for email-pdf', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockRejectedValue(new Error('Gmail message not found')),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-missing',
      });

      await expect(hydrator.hydrate([{ id: 'email-pdf-msg-missing' }])).rejects.toThrow(
        'Could not generate the Email PDF. Please try again.'
      );
    });

    it('throws DriveServiceError with PDF message when inline image getAttachment fails for email-pdf', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-with-inline',
          subject: 'Test',
          inlineImages: [
            {
              cid: 'cid-img-1',
              attachmentId: 'att-img-1',
              mimeType: 'image/png',
            },
          ],
        }),
        getAttachment: vi.fn().mockRejectedValue(new Error('Image fetch failed')),
      } as unknown as GoogleGmailClient;

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-with-inline',
      });

      await expect(hydrator.hydrate([{ id: 'email-pdf-msg-with-inline' }])).rejects.toThrow(
        'Could not generate the Email PDF. Please try again.'
      );
    });

    it('throws DriveServiceError with PDF message when generateEmailPdf fails', async () => {
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          id: 'msg-pdf-fail',
          subject: 'Test',
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const mockPdfProcessor = {
        generateEmailPdf: vi.fn().mockRejectedValue(new Error('PDF generation crash')),
      };

      const hydrator = new GmailSourceFileHydratorAdapter(mockGmailClient, {
        messageId: 'msg-pdf-fail',
        pdfProcessor: mockPdfProcessor as unknown as PdfProcessor,
      });

      await expect(hydrator.hydrate([{ id: 'email-pdf-msg-pdf-fail' }])).rejects.toThrow(
        'Could not generate the Email PDF. Please try again.'
      );
    });
  });
});

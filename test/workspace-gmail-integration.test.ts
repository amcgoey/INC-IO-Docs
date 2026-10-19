import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import type { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';

describe('Workspace-to-Gmail E2E Integration (Ticket #194 Tracer Bullet)', () => {
  let app: AppInstance;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockStorageAdapter: DocumentSpaceStoragePort;
  let mockGmailClient: Partial<GoogleGmailClient>;

  beforeEach(async () => {
    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return {
            isValid: true,
            payload: { email: 'gmail-user@example.com', sub: 'user-gmail-123' },
          };
        }
        return {
          isValid: false,
          error: 'Invalid ID token signature',
        };
      }),
    };

    mockGmailClient = {
      getMessage: vi.fn().mockImplementation(async (messageId: string) => {
        if (messageId === 'msg-with-live-attachments' || messageId === 'msg-test-with-files') {
          return {
            messageId,
            attachments: [
              {
                partId: 'att-part-1',
                attachmentId: 'att-1',
                filename: 'Invoice.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
              {
                partId: 'att-part-2',
                attachmentId: 'att-2',
                filename: 'Statement.pdf',
                mimeType: 'application/pdf',
                size: 2048,
              },
            ],
          };
        }
        return {
          messageId,
          attachments: [],
        };
      }),
    };

    mockStorageAdapter = {
      fetchSpaces: vi.fn().mockImplementation(async (_config, typeId: string) => {
        if (typeId === 'projects') {
          return [
            {
              id: 'space-projects-1',
              typeId: 'projects',
              name: 'Active Projects',
              abstractStorageId: 'shared-drive-proj-root',
            },
          ];
        }
        if (typeId === 'proposals') {
          return [
            {
              id: 'space-proposals-1',
              typeId: 'proposals',
              name: 'Client Proposals',
              abstractStorageId: 'folder-opp-root',
            },
          ];
        }
        return [];
      }),
      resolveStorageLocation: vi.fn().mockImplementation(async (abstractStorageId: string) => ({
        provider: 'google_drive',
        abstractStorageId,
      })),
    };

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
      skipSpaceValidation: true,
      storageAdapter: mockStorageAdapter,
      gmailClient: mockGmailClient as GoogleGmailClient,
    });

    await app.initialize();
  });

  it('rejects POST /workspace/gmail-contextual without auth with 401', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-test-123',
          threadId: 'th-test-456',
          accessToken: 'ya29.gmail-token',
        },
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Unauthorized');
  });

  it('renders initial gmail-document-process-card upon POST /workspace/gmail-contextual trigger', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-test-123',
          threadId: 'th-test-456',
          accessToken: 'ya29.gmail-token',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;

    // Verify navigation pushCard
    expect(body.action?.navigations).toHaveLength(1);
    const pushCard = body.action!.navigations![0].pushCard!;
    expect(pushCard).toBeDefined();

    // Verify card header
    expect(pushCard.header?.title).toBe('INC-IO Engine');
    expect(pushCard.header?.subtitle).toBe('Process Document');

    // Verify sections structure
    const sections = pushCard.sections as GoogleWorkspaceSection[];
    expect(sections.length).toBeGreaterThanOrEqual(3);

    // Section 1: Document Type Selection (defaults from manifest: workspace.defaultDocumentType = communication-project)
    const docTypeSection = sections[0];
    expect(docTypeSection.widgets).toBeDefined();

    // Section 2: File Selection (non-collapsible, SelectAttachments, empty text)
    const fileSelectionSection = sections.find((s) => s.header === 'File Selection');
    expect(fileSelectionSection).toBeDefined();
    expect(fileSelectionSection?.collapsible).toBe(false);
    expect(fileSelectionSection?.widgets).toHaveLength(1);
    expect(fileSelectionSection?.widgets[0].textParagraph?.text).toBe('No attachments found.');

    // Section 3: Document Data
    const docDataSection = sections.find((s) => s.header === 'Document Data');
    expect(docDataSection).toBeDefined();

    // Section 4: Admin
    const adminSection = sections.find((s) => s.header === 'Admin');
    expect(adminSection).toBeDefined();
  });

  it('routes to gmail-document-process-card when triggered with gmail context without explicit hostApp', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        gmail: {
          messageId: 'msg-test-without-hostapp',
          threadId: 'th-test-789',
          accessToken: 'ya29.gmail-token',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    const pushCard = body.action!.navigations![0].pushCard!;
    expect(pushCard.header?.title).toBe('INC-IO Engine');
    const fileSection = pushCard.sections.find((s) => s.header === 'File Selection');
    expect(fileSection?.collapsible).toBe(false);
    expect(fileSection?.widgets[0].textParagraph?.text).toBe('No attachments found.');
  });

  it('renders SelectAttachments checkboxes when files are passed in selectedItems', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-test-with-files',
          threadId: 'th-test-111',
          accessToken: 'ya29.gmail-token',
        },
        drive: {
          selectedItems: [
            { id: 'att-1', title: 'Invoice.pdf', mimeType: 'application/pdf' },
            { id: 'att-2', title: 'Statement.pdf', mimeType: 'application/pdf' },
          ],
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    const pushCard = body.action!.navigations![0].pushCard!;
    const fileSection = pushCard.sections.find((s) => s.header === 'File Selection');
    expect(fileSection?.collapsible).toBe(false);
    expect(fileSection?.widgets[0].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSection?.widgets[0].selectionInput?.items).toHaveLength(2);
    expect(fileSection?.widgets[0].selectionInput?.items[0].text).toBe('Invoice.pdf');
  });

  it('discovers live email attachments via gmailClient and populates SelectAttachments checkboxes on POST /workspace/gmail-contextual', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    const pushCard = body.action!.navigations![0].pushCard!;
    const fileSection = pushCard.sections.find((s) => s.header === 'File Selection');
    expect(fileSection).toBeDefined();
    expect(fileSection?.collapsible).toBe(false);
    expect(fileSection?.widgets[0].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSection?.widgets[0].selectionInput?.items).toHaveLength(2);
    expect(fileSection?.widgets[0].selectionInput?.items[0]).toEqual({
      text: 'Invoice.pdf',
      value: 'att-1',
      selected: true,
    });
    expect(fileSection?.widgets[0].selectionInput?.items[1]).toEqual({
      text: 'Statement.pdf',
      value: 'att-2',
      selected: true,
    });
    expect(mockGmailClient.getMessage).toHaveBeenCalledWith('msg-with-live-attachments', {
      auth: 'ya29.live-token',
    });
  });

  it('returns fallback error card if orchestrator fails', async () => {
    // Pass corrupted/unsupported payload structure that throws in execution
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: null as unknown as Record<string, unknown>,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    expect(body.action?.navigations?.[0]?.pushCard).toBeDefined();
  });
});

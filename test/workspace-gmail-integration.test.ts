import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
import type { GmailThreadDetails } from '../src/infrastructure/gmail/types';
// nosemgrep: adapter-leakage-warning
import { google, type gmail_v1 } from 'googleapis';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { PdfProcessor } from '../src/infrastructure/pdf/pdf-processor';

describe('Workspace-to-Gmail E2E Integration (Ticket #194 Tracer Bullet)', () => {
  let app: AppInstance;
  let manifestProvider: AppManifestProvider;
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
      getThread: vi.fn().mockImplementation(async (threadId: string) => {
        if (threadId === 'th-multi-message') {
          return {
            id: threadId,
            messages: [
              {
                id: 'msg-email-1',
                from: 'Alice <alice@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                attachments: [
                  {
                    partId: 'part-email-1-att-1',
                    attachmentId: 'att-email-1-1',
                    filename: 'Email1Doc.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
              {
                id: 'msg-email-2',
                from: 'Bob <bob@example.com>',
                date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                attachments: [
                  {
                    partId: 'part-email-2-att-1',
                    attachmentId: 'att-email-2-1',
                    filename: 'Email2DocA.pdf',
                    mimeType: 'application/pdf',
                    size: 2048,
                  },
                  {
                    partId: 'part-email-2-att-2',
                    attachmentId: 'att-email-2-2',
                    filename: 'Email2DocB.pdf',
                    mimeType: 'application/pdf',
                    size: 4096,
                  },
                ],
              },
            ],
          };
        }
        return undefined;
      }),
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
        if (messageId === 'msg-email-1') {
          return {
            id: 'msg-email-1',
            messageId: 'msg-email-1',
            subject: 'Initial Meeting Kickoff',
            from: 'Alice <alice@example.com>',
            to: 'Team <team@example.com>',
            date: 'Mon, 19 Oct 2026 10:00:00 +0000',
            plainTextBody: 'Here is the kickoff document.',
            htmlBody: '<p>Here is the kickoff document.</p>',
            attachments: [
              {
                partId: 'part-email-1-att-1',
                attachmentId: 'att-email-1-1',
                filename: 'Email1Doc.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
            ],
          };
        }
        if (messageId === 'msg-email-2') {
          return {
            id: 'msg-email-2',
            messageId: 'msg-email-2',
            subject: 'Project Scope Revision',
            from: 'Bob <bob@example.com>',
            to: 'Team <team@example.com>',
            date: 'Mon, 19 Oct 2026 11:00:00 +0000',
            plainTextBody: 'Please find the revised project documents attached.',
            htmlBody: '<p>Please find the revised project documents attached.</p>',
            attachments: [
              {
                partId: 'part-email-2-att-1',
                attachmentId: 'att-email-2-1',
                filename: 'Email2DocA.pdf',
                mimeType: 'application/pdf',
                size: 2048,
              },
              {
                partId: 'part-email-2-att-2',
                attachmentId: 'att-email-2-2',
                filename: 'Email2DocB.pdf',
                mimeType: 'application/pdf',
                size: 4096,
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
    manifestProvider = new AppManifestProvider({ manifestPath });
    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
      skipSpaceValidation: true,
      storageAdapter: mockStorageAdapter,
      gmailClient: mockGmailClient as GoogleGmailClient,
    });

    await app.initialize();
  });

  afterEach(() => {
    nock.cleanAll();
    vi.restoreAllMocks();
  });

  function mockDynamicValidationProject({
    sharedDriveId,
    adminFolderId,
    commFolderId,
    contactFolderId,
    contactName,
  }: {
    sharedDriveId: string;
    adminFolderId: string;
    commFolderId: string;
    contactFolderId: string;
    contactName: string;
  }) {
    // resolveTargetFolder step 1: list folders in shared drive root
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${sharedDriveId}' in parents`) && !q.q.includes('name ='))
      .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

    // resolveTargetFolder step 2: list folders in 1 Admin
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${adminFolderId}' in parents`) && !q.q.includes('name ='))
      .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

    // executeValidationQuery: check contact folder exists
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${commFolderId}' in parents`) && q.q.includes(`name = '${contactName}'`))
      .reply(200, { files: [{ id: contactFolderId, name: contactName }] });
  }

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

    // Section 2: File Selection (non-collapsible, SelectEmailMessage dropdown, SelectFileSource dropdown, empty text, SaveEmailToPdf)
    const fileSelectionSection = sections.find((s) => s.header === 'File Selection');
    expect(fileSelectionSection).toBeDefined();
    expect(fileSelectionSection?.collapsible).toBe(false);
    expect(fileSelectionSection?.widgets).toHaveLength(4);
    expect(fileSelectionSection?.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');
    expect(fileSelectionSection?.widgets[0].selectionInput?.type).toBe('DROPDOWN');
    expect(fileSelectionSection?.widgets[1].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSelectionSection?.widgets[1].selectionInput?.type).toBe('DROPDOWN');
    expect(fileSelectionSection?.widgets[2].textParagraph?.text).toBe('No attachments found.');
    expect(fileSelectionSection?.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');
    expect(fileSelectionSection?.widgets[3].selectionInput?.type).toBe('SWITCH');
    expect(fileSelectionSection?.widgets[3].selectionInput?.items).toEqual([
      { text: 'Save Email to PDF', value: 'true', selected: false },
    ]);

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
    expect(fileSection?.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');
    expect(fileSection?.widgets[1].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSection?.widgets[2].textParagraph?.text).toBe('No attachments found.');
    expect(fileSection?.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');
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
    expect(fileSection?.widgets).toHaveLength(3);
    expect(fileSection?.widgets[0].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSection?.widgets[0].selectionInput?.type).toBe('DROPDOWN');
    expect(fileSection?.widgets[1].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSection?.widgets[1].selectionInput?.items).toHaveLength(2);
    expect(fileSection?.widgets[1].selectionInput?.items[0].text).toBe('Invoice.pdf');
    expect(fileSection?.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
    expect(fileSection?.widgets[2].selectionInput?.type).toBe('SWITCH');
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
    expect(fileSection?.widgets).toHaveLength(4);
    expect(fileSection?.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');
    expect(fileSection?.widgets[0].selectionInput?.type).toBe('DROPDOWN');
    expect(fileSection?.widgets[1].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSection?.widgets[1].selectionInput?.type).toBe('DROPDOWN');
    expect(fileSection?.widgets[2].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSection?.widgets[2].selectionInput?.items).toHaveLength(2);
    expect(fileSection?.widgets[2].selectionInput?.items[0]).toEqual({
      text: 'Invoice.pdf',
      value: 'att-part-1',
      selected: true,
    });
    expect(fileSection?.widgets[2].selectionInput?.items[1]).toEqual({
      text: 'Statement.pdf',
      value: 'att-part-2',
      selected: true,
    });
    expect(fileSection?.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');
    expect(mockGmailClient.getMessage).toHaveBeenCalledWith(
      'msg-with-live-attachments',
      expect.objectContaining({
        auth: 'ya29.live-token',
      })
    );
  });

  it('simulates switching from Email Attachments to Google Drive URL, entering URL, switching back, and verifying state retention and updateCard', async () => {
    // Step 1: Initial trigger with 2 live attachments
    const resInitial = await app.server.inject({
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

    expect(resInitial.statusCode).toBe(200);
    const bodyInitial = JSON.parse(resInitial.payload) as GoogleWorkspaceActionResponse;
    const pushCard = bodyInitial.action!.navigations![0].pushCard!;
    const fileSecInitial = pushCard.sections.find((s) => s.header === 'File Selection')!;
    expect(fileSecInitial.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');
    expect(fileSecInitial.widgets[1].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSecInitial.widgets[1].selectionInput?.items?.[0]).toEqual({
      text: 'Email Attachments',
      value: 'Email Attachments',
      selected: true,
    });
    expect(fileSecInitial.widgets[2].selectionInput?.name).toBe('SelectAttachments');

    // Step 2: Switch to "Google Drive URL" with att-1 selected in previousAttachments
    const resSwitchToDrive = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFileSourceChange',
            previousAttachments: JSON.stringify(['att-1']),
            previousDriveUrl: '',
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resSwitchToDrive.statusCode).toBe(200);
    const bodySwitchToDrive = JSON.parse(resSwitchToDrive.payload) as GoogleWorkspaceActionResponse;
    // Verify updateCard action
    expect(bodySwitchToDrive.action?.navigations?.[0].updateCard).toBeDefined();
    const updateCardDrive = bodySwitchToDrive.action!.navigations![0].updateCard!;
    const fileSecDrive = updateCardDrive.sections.find((s) => s.header === 'File Selection')!;

    // Widget 0: Dropdown with SelectEmailMessage active
    expect(fileSecDrive.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');

    // Widget 1: Dropdown with Google Drive URL active
    expect(fileSecDrive.widgets[1].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSecDrive.widgets[1].selectionInput?.items?.[1]).toEqual({
      text: 'Google Drive URL',
      value: 'Google Drive URL',
      selected: true,
    });

    // Widget 2: InputDriveURL text input is swapped in!
    expect(fileSecDrive.widgets[2].textInput).toBeDefined();
    expect(fileSecDrive.widgets[2].textInput?.name).toBe('InputDriveURL');
    expect(fileSecDrive.widgets[2].textInput?.label).toBe('Google Drive URL');
    expect(fileSecDrive.widgets[2].textInput?.value).toBe('');

    // Widget 3: SaveEmailToPdf SWITCH
    expect(fileSecDrive.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');

    // Step 3: Switch back to "Email Attachments" with entered Drive URL preserved
    const testDriveUrl = 'https://drive.google.com/drive/folders/test-folder-123';
    const resSwitchBack = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFileSourceChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: testDriveUrl,
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            InputDriveURL: { stringInputs: { value: [testDriveUrl] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resSwitchBack.statusCode).toBe(200);
    const bodySwitchBack = JSON.parse(resSwitchBack.payload) as GoogleWorkspaceActionResponse;
    expect(bodySwitchBack.action?.navigations?.[0].updateCard).toBeDefined();
    const updateCardEmail = bodySwitchBack.action!.navigations![0].updateCard!;
    const fileSecEmail = updateCardEmail.sections.find((s) => s.header === 'File Selection')!;

    // Widget 0: Dropdown with SelectEmailMessage active
    expect(fileSecEmail.widgets[0].selectionInput?.name).toBe('SelectEmailMessage');

    // Widget 1: Dropdown with Email Attachments active
    expect(fileSecEmail.widgets[1].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSecEmail.widgets[1].selectionInput?.items?.[0]).toEqual({
      text: 'Email Attachments',
      value: 'Email Attachments',
      selected: true,
    });
    // parameters preserved the previousDriveUrl
    const onChangeParams = fileSecEmail.widgets[1].selectionInput?.onChangeAction?.parameters;
    const previousDriveUrlParam = onChangeParams?.find((p: { key: string }) => p.key === 'previousDriveUrl')?.value;
    expect(previousDriveUrlParam).toBe(testDriveUrl);

    // Widget 2: SelectAttachments checkboxes restored with att-part-1 checked and att-part-2 unchecked!
    expect(fileSecEmail.widgets[2].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSecEmail.widgets[2].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-part-1', selected: true },
      { text: 'Statement.pdf', value: 'att-part-2', selected: false },
    ]);

    // Widget 3: SaveEmailToPdf SWITCH
    expect(fileSecEmail.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');
  });

  it('retains attachments during in-card actions (onSpaceTypeChange) when drive.selectedItems is omitted', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onSpaceTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            SelectAttachments: { stringInputs: { value: ['att-part-2'] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    expect(body.action?.navigations?.[0].updateCard).toBeDefined();
    const updateCard = body.action!.navigations![0].updateCard!;
    const fileSec = updateCard.sections.find((s) => s.header === 'File Selection')!;
    expect(fileSec).toBeDefined();
    expect(fileSec.widgets[2].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSec.widgets[2].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-part-1', selected: false },
      { text: 'Statement.pdf', value: 'att-part-2', selected: true },
    ]);
  });

  it('unchecks all attachments (selected: false) when submitting empty formData in Email Attachments mode without drive.selectedItems', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onSpaceTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            // Note: SelectAttachments omitted by Google Workspace when 0 checkboxes are checked
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    expect(body.action?.navigations?.[0].updateCard).toBeDefined();
    const updateCard = body.action!.navigations![0].updateCard!;
    const fileSec = updateCard.sections.find((s) => s.header === 'File Selection')!;
    expect(fileSec).toBeDefined();
    expect(fileSec.widgets[2].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSec.widgets[2].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-part-1', selected: false },
      { text: 'Statement.pdf', value: 'att-part-2', selected: false },
    ]);
  });

  it('preserves attachment selections across File Source round-trips with intermediate in-card changes', async () => {
    // Step 1: Switch to Google Drive URL with previousAttachments=['att-part-1']
    const resStep1 = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFileSourceChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: '',
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resStep1.statusCode).toBe(200);
    const bodyStep1 = JSON.parse(resStep1.payload) as GoogleWorkspaceActionResponse;
    const updateCard1 = bodyStep1.action!.navigations![0].updateCard!;
    const docTypeSec1 = updateCard1.sections.find((s) => s.header === 'Document Type')!;

    // Verify onSpaceTypeChange, onSpaceChange, onDocumentTypeChange have previousAttachments
    const spaceTypeWidget = docTypeSec1.widgets[0].selectionInput;
    const spaceTypeParams = spaceTypeWidget?.onChangeAction?.parameters;
    expect(spaceTypeParams?.find((p: { key: string }) => p.key === 'previousAttachments')?.value).toBe(
      JSON.stringify(['att-part-1'])
    );

    // Step 2: In Google Drive URL mode, modify DocumentSpaceType (onSpaceTypeChange)
    const resStep2 = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onSpaceTypeChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: '',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resStep2.statusCode).toBe(200);
    const bodyStep2 = JSON.parse(resStep2.payload) as GoogleWorkspaceActionResponse;
    const updateCard2 = bodyStep2.action!.navigations![0].updateCard!;
    const fileSec2 = updateCard2.sections.find((s) => s.header === 'File Selection')!;
    const fileSourceDropdown2 = fileSec2.widgets[1].selectionInput;
    expect(fileSourceDropdown2?.onChangeAction?.parameters?.find((p: { key: string }) => p.key === 'previousAttachments')?.value).toBe(
      JSON.stringify(['att-part-1'])
    );

    // Step 3: Switch back to Email Attachments (onFileSourceChange)
    const resStep3 = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFileSourceChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: '',
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resStep3.statusCode).toBe(200);
    const bodyStep3 = JSON.parse(resStep3.payload) as GoogleWorkspaceActionResponse;
    const updateCard3 = bodyStep3.action!.navigations![0].updateCard!;
    const fileSec3 = updateCard3.sections.find((s) => s.header === 'File Selection')!;

    expect(fileSec3.widgets[2].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSec3.widgets[2].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-part-1', selected: true },
      { text: 'Statement.pdf', value: 'att-part-2', selected: false },
    ]);
  });

  it('preserves Google Drive URL input across File Source round-trips with intermediate in-card changes', async () => {
    const driveUrl = 'https://drive.google.com/file/d/drive-url-12345/view';

    // Step 1: User switches from Google Drive URL to Email Attachments
    const resStep1 = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFileSourceChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: driveUrl,
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            InputDriveURL: { stringInputs: { value: [driveUrl] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resStep1.statusCode).toBe(200);
    const bodyStep1 = JSON.parse(resStep1.payload) as GoogleWorkspaceActionResponse;
    const updateCard1 = bodyStep1.action!.navigations![0].updateCard!;
    const docTypeSec1 = updateCard1.sections.find((s) => s.header === 'Document Type')!;

    // In Email Attachments mode, onSpaceTypeChange has previousDriveUrl attached
    const spaceTypeWidget = docTypeSec1.widgets[0].selectionInput;
    expect(spaceTypeWidget?.onChangeAction?.parameters?.find((p: { key: string }) => p.key === 'previousDriveUrl')?.value).toBe(driveUrl);

    // Step 2: In Email Attachments mode, user modifies DocumentSpaceType (onSpaceTypeChange)
    const resStep2 = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onSpaceTypeChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: driveUrl,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['att-part-1'] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resStep2.statusCode).toBe(200);
    const bodyStep2 = JSON.parse(resStep2.payload) as GoogleWorkspaceActionResponse;
    const updateCard2 = bodyStep2.action!.navigations![0].updateCard!;
    const fileSec2 = updateCard2.sections.find((s) => s.header === 'File Selection')!;
    const fileSourceDropdown2 = fileSec2.widgets[1].selectionInput;
    expect(fileSourceDropdown2?.onChangeAction?.parameters?.find((p: { key: string }) => p.key === 'previousDriveUrl')?.value).toBe(driveUrl);

    // Step 3: Switch back to Google Drive URL (onFileSourceChange)
    const resStep3 = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFileSourceChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: driveUrl,
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(resStep3.statusCode).toBe(200);
    const bodyStep3 = JSON.parse(resStep3.payload) as GoogleWorkspaceActionResponse;
    const updateCard3 = bodyStep3.action!.navigations![0].updateCard!;
    const fileSec3 = updateCard3.sections.find((s) => s.header === 'File Selection')!;

    // InputDriveURL restored with entered URL value!
    expect(fileSec3.widgets[2].textInput?.name).toBe('InputDriveURL');
    expect(fileSec3.widgets[2].textInput?.value).toBe(driveUrl);
  });

  it('unchecking all attachments in Email Attachments mode keeps all attachments unchecked and propagates empty previousAttachments "[]"', async () => {
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFormChange',
            previousAttachments: JSON.stringify(['att-part-1']),
            previousDriveUrl: '',
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            // SelectAttachments is omitted because user unchecked all checkboxes!
          },
        },
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    const updateCard = body.action!.navigations![0].updateCard!;
    const fileSec = updateCard.sections.find((s) => s.header === 'File Selection')!;

    // All checkboxes remain unchecked
    expect(fileSec.widgets[2].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSec.widgets[2].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-part-1', selected: false },
      { text: 'Statement.pdf', value: 'att-part-2', selected: false },
    ]);

    // Propagates empty "[]" to action parameters
    const onChangeParams = fileSec.widgets[1].selectionInput?.onChangeAction?.parameters;
    const previousAttachmentsParam = onChangeParams?.find((p: { key: string }) => p.key === 'previousAttachments')?.value;
    expect(previousAttachmentsParam).toBe('[]');
  });

  it('rejects submission on processDocument when zero attachments checked, SaveEmailToPdf is false, and allowEmptySourceFiles is false even if previousAttachments exists in parameters', async () => {
    const originalRead = manifestProvider.readParsedSchema.bind(manifestProvider);
    vi.spyOn(manifestProvider, 'readParsedSchema').mockImplementation(async (relPath: string) => {
      const parsed = (await originalRead(relPath)) as Record<string, unknown>;
      return {
        ...parsed,
        allowEmptySourceFiles: false,
      };
    });

    const response = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-with-live-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'processDocument',
            previousAttachments: JSON.stringify(['att-part-1']),
          },
          formInputs: {
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            SaveEmailToPdf: { stringInputs: { value: ['false'] } },
            // SelectAttachments omitted (0 attachments checked)
            [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
            [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
            [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
            [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
    const updateCard = body.action?.navigations?.[0]?.updateCard;
    expect(updateCard).toBeDefined();

    const errorSection = updateCard!.sections.find((s) =>
      s.widgets?.some((w) =>
        w.textParagraph?.text?.includes('Please select at least one file to process or enable Save Email to PDF.')
      )
    );
    expect(errorSection).toBeDefined();
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

  it('files communication-project with zero selected files in Gmail context, creating folder hierarchy in Drive and succeeding with notification', async () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    // 1. Dynamic Options Validation
    mockDynamicValidationProject({
      sharedDriveId: rootSharedDriveId,
      adminFolderId,
      commFolderId,
      contactFolderId,
      contactName: 'Acme Corp',
    });

    // 2. DriveActivityHandler: resolveFolderPath('shared-drive-proj-root', ['1 Admin', 'Communication'])
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
      .reply(200, {
        files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
      });

    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
      .reply(200, {
        files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
      });

    // 3. DriveActivityHandler: findOrCreateFolder(commFolderId, 'Acme Corp') -> exists
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
      .reply(200, {
        files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
      });

    // 4. DriveActivityHandler: findOrCreateFolder(contactFolderId, '260920 IN - Meeting Notes') -> creates new
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
      .reply(200, { files: [] });

    nock('https://www.googleapis.com')
      .post('/drive/v3/files')
      .query(true)
      .reply(200, {
        id: newSubfolderId,
        name: '260920 IN - Meeting Notes',
        parents: [contactFolderId],
        mimeType: 'application/vnd.google-apps.folder',
      });

    const response = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        authorizationEventObject: {
          userOAuthToken: 'ya29.valid-oauth-token',
        },
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-without-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
            [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
            [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
            [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body).toEqual({
      action: {
        notification: {
          text: 'Document processed successfully',
        },
      },
    });
    expect(nock.isDone()).toBe(true);
  });

  it('rejects zero files in Gmail context when allowEmptySourceFiles is false or omitted with message "Please select at least one file to process or enable Save Email to PDF."', async () => {
    const originalRead = manifestProvider.readParsedSchema.bind(manifestProvider);
    vi.spyOn(manifestProvider, 'readParsedSchema').mockImplementation(async (relPath: string) => {
      const parsed = (await originalRead(relPath)) as Record<string, unknown>;
      return {
        ...parsed,
        allowEmptySourceFiles: false,
      };
    });

    const response = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        authorizationEventObject: {
          userOAuthToken: 'ya29.valid-oauth-token',
        },
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-without-attachments',
          threadId: 'th-test-live',
          accessToken: 'ya29.live-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
            [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
            [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
            [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
    const updateCard = body.action?.navigations?.[0]?.updateCard;
    expect(updateCard).toBeDefined();

    const errorSection = updateCard!.sections.find((s) =>
      s.widgets?.some((w) => w.textParagraph?.text?.includes('Please select at least one file to process or enable Save Email to PDF.'))
    );
    expect(errorSection).toBeDefined();
  });

  describe('Google Drive URL filing (SelectFileSource = "Google Drive URL")', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    function mockFolderResolution() {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260920 IN - Meeting Notes',
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('moves file into <contact>/<commFolderName> when SelectFileSource is Google Drive URL with valid file URL', async () => {
      mockFolderResolution();

      const fileId = '1file-drive-url-123';
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: 'Project_Contract.pdf',
          parents: ['initial-parent-folder'],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: 'Project_Contract.pdf',
          parents: [newSubfolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-without-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: [`https://drive.google.com/file/d/${fileId}/view?usp=sharing`] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          notification: {
            text: 'Document processed successfully',
          },
        },
      });
      expect(nock.isDone()).toBe(true);
    });

    it('moves folder into <contact>/<commFolderName> when SelectFileSource is Google Drive URL with valid folder URL', async () => {
      mockFolderResolution();

      const folderId = '1folder-drive-url-456';
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${folderId}`)
        .query(true)
        .reply(200, {
          id: folderId,
          name: 'Client_Assets',
          parents: ['initial-parent-folder'],
          mimeType: 'application/vnd.google-apps.folder',
          webViewLink: `https://drive.google.com/drive/folders/${folderId}`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${folderId}`)
        .query(true)
        .reply(200, {
          id: folderId,
          name: 'Client_Assets',
          parents: [newSubfolderId],
          mimeType: 'application/vnd.google-apps.folder',
          webViewLink: `https://drive.google.com/drive/folders/${folderId}`,
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-without-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: [`https://drive.google.com/drive/folders/${folderId}?usp=drive_link`] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          notification: {
            text: 'Document processed successfully',
          },
        },
      });
      expect(nock.isDone()).toBe(true);
    });

    it('parses multi-account /u/1/folders/<id> URL and moves folder into destination hierarchy', async () => {
      mockFolderResolution();

      const folderId = '1folder-multi-account-789';
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${folderId}`)
        .query(true)
        .reply(200, {
          id: folderId,
          name: 'MultiAccount_Assets',
          parents: ['initial-parent-folder'],
          mimeType: 'application/vnd.google-apps.folder',
          webViewLink: `https://drive.google.com/drive/folders/${folderId}`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${folderId}`)
        .query(true)
        .reply(200, {
          id: folderId,
          name: 'MultiAccount_Assets',
          parents: [newSubfolderId],
          mimeType: 'application/vnd.google-apps.folder',
          webViewLink: `https://drive.google.com/drive/folders/${folderId}`,
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-without-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: [`https://drive.google.com/drive/u/1/folders/${folderId}`] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          notification: {
            text: 'Document processed successfully',
          },
        },
      });
      expect(nock.isDone()).toBe(true);
    });

    it('aborts with "Invalid Google Drive URL. Please enter a valid Google Drive file or folder link." preserving inputs when URL is malformed', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-without-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: ['https://dropbox.com/s/invalid-link'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard!.sections.find((s) =>
        s.widgets?.some((w) =>
          w.textParagraph?.text?.includes(
            'Invalid Google Drive URL. Please enter a valid Google Drive file or folder link.'
          )
        )
      );
      expect(errorSection).toBeDefined();

      // Verify form inputs preserved
      const infoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
      expect(infoSection).toBeDefined();
      const contactWidget = infoSection!.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      );
      expect(contactWidget?.textInput?.value).toBe('Acme Corp');

      const fileSection = updateCard!.sections.find((s) => s.header === 'File Selection');
      expect(fileSection).toBeDefined();
      const driveUrlWidget = fileSection!.widgets.find((w) => w.textInput?.name === 'InputDriveURL');
      expect(driveUrlWidget?.textInput?.value).toBe('https://dropbox.com/s/invalid-link');
    });

    it('aborts with "The specified Google Drive file or folder was not found." preserving inputs when Drive returns 404', async () => {
      mockFolderResolution();

      const missingFileId = 'missing-file-404';
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${missingFileId}`)
        .query(true)
        .reply(404, {
          error: {
            code: 404,
            message: `File not found: ${missingFileId}`,
          },
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-without-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: [`https://drive.google.com/file/d/${missingFileId}/view`] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard!.sections.find((s) =>
        s.widgets?.some((w) =>
          w.textParagraph?.text?.includes('The specified Google Drive file or folder was not found.')
        )
      );
      expect(errorSection).toBeDefined();

      // Form inputs preserved
      const infoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
      expect(infoSection).toBeDefined();
      const contactWidget = infoSection!.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      );
      expect(contactWidget?.textInput?.value).toBe('Acme Corp');
    });

    it('aborts with "Access denied. You do not have permission to access this Google Drive file or folder." preserving inputs when Drive returns 403', async () => {
      mockFolderResolution();

      const forbiddenFileId = 'forbidden-file-403';
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${forbiddenFileId}`)
        .query(true)
        .reply(403, {
          error: {
            code: 403,
            message: 'User does not have sufficient permissions to access file',
          },
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-without-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: [`https://drive.google.com/file/d/${forbiddenFileId}/view`] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard!.sections.find((s) =>
        s.widgets?.some((w) =>
          w.textParagraph?.text?.includes(
            'Access denied. You do not have permission to access this Google Drive file or folder.'
          )
        )
      );
      expect(errorSection).toBeDefined();

      // Form inputs preserved
      const infoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
      expect(infoSection).toBeDefined();
      const contactWidget = infoSection!.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      );
      expect(contactWidget?.textInput?.value).toBe('Acme Corp');
    });
  });

  describe('Email Attachment Filing & Deferred Hydration (Ticket #200)', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    function mockFolderResolution() {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260920 IN - Meeting Notes',
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('files communication-project with checked attachments, downloading bytes from Gmail and saving via saveBuffer', async () => {
      mockFolderResolution();

      const attachmentBytes = new Uint8Array([1, 2, 3, 4, 5]);
      mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-att-1',
          name: 'Invoice.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-att-1/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-with-live-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['att-1'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Verify attachment was downloaded from Gmail preserving metadata
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(
        'msg-with-live-attachments',
        'att-1',
        { auth: 'ya29.valid-oauth-token' }
      );
    });

    it('pre-validation guard: aborts when document validation fails, asserting ZERO calls to gmailClient.getAttachment and ZERO Drive mutations', async () => {
      mockGmailClient.getAttachment = vi.fn();

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-with-live-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['att-1'] } },
              // Missing required fields (contact, date, direction, description)!
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      // Zero calls to getAttachment!
      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();

      // Zero unhandled nock requests (meaning zero Drive mutations or folder creation)
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('End-to-End SaveEmailToPdf Filing (Ticket #201)', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    const samplePng = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      )
    );

    function mockFolderResolution() {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260920 IN - Meeting Notes',
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('files communication-project with SaveEmailToPdf = true and 0 attachments, embeds inline CID images, and saves "Email - <Sanitized Subject>.pdf" via saveBuffer', async () => {
      mockFolderResolution();

      const messageId = 'msg-save-pdf-standalone';
      mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
        return {
          id: msgId,
          messageId: msgId,
          subject: 'Important Client Discussion / Updates',
          from: 'Partner <partner@example.com>',
          to: 'Team <team@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 GMT',
          plainTextBody: 'See attached graphic inline.',
          htmlBody: '<p>See graphic:</p><p><img src="cid:chart-01"></p>',
          attachments: [],
          inlineImages: [
            {
              cid: 'chart-01',
              partId: 'part-cid-1',
              attachmentId: 'att-inline-chart',
              filename: 'chart.png',
              mimeType: 'image/png',
            },
          ],
        };
      });
      mockGmailClient.getAttachment = vi.fn().mockResolvedValue(samplePng);

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-pdf-1',
          name: 'Email - Important Client Discussion _ Updates.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-pdf-1/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-test-standalone',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: [] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Verify inline CID image was downloaded
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(
        messageId,
        'att-inline-chart',
        { auth: 'ya29.valid-oauth-token' }
      );
      expect(nock.isDone()).toBe(true);
    });

    it('falls back to "Email - <messageId>.pdf" when subject is blank or whitespace', async () => {
      mockFolderResolution();

      const messageId = 'msg-save-pdf-blank-subject';
      mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
        return {
          id: msgId,
          messageId: msgId,
          subject: '   ',
          plainTextBody: 'No subject text body.',
          attachments: [],
          inlineImages: [],
        };
      });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-pdf-blank',
          name: `Email - ${messageId}.pdf`,
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: `https://drive.google.com/file/d/drive-pdf-blank/view`,
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-test-blank',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: [] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');
      expect(nock.isDone()).toBe(true);
    });

    it('files communication-project with checked SelectAttachments AND SaveEmailToPdf = true, saving both into the same folder', async () => {
      mockFolderResolution();

      const messageId = 'msg-combo-att-pdf';
      const attachmentBytes = new Uint8Array([11, 22, 33]);
      mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
        return {
          id: msgId,
          messageId: msgId,
          subject: 'Project Scope Review',
          attachments: [
            {
              partId: 'part-att-1',
              attachmentId: 'att-1',
              filename: 'Scope.pdf',
              mimeType: 'application/pdf',
              size: 1024,
            },
          ],
          inlineImages: [],
        };
      });
      mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

      // Expect two uploads to Drive: one for attachment, one for email PDF
      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-scope-att',
          name: 'Scope.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-scope-att/view',
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-scope-email-pdf',
          name: 'Email - Project Scope Review.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-scope-email-pdf/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-combo',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['att-1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Verify attachment was downloaded
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(
        messageId,
        'att-1',
        { auth: 'ya29.valid-oauth-token' }
      );
      expect(nock.isDone()).toBe(true);
    });

    it('files communication-project with SelectFileSource = Google Drive URL AND SaveEmailToPdf = true, moving the Drive file and saving the Email PDF into the same folder', async () => {
      mockFolderResolution();

      const messageId = 'msg-drive-combo';
      const driveFileId = '1drive-combo-file-789';

      mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
        return {
          id: msgId,
          messageId: msgId,
          subject: 'Drive Reference Thread',
          attachments: [],
          inlineImages: [],
        };
      });

      // 1. Move referenced Drive file
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${driveFileId}`)
        .query(true)
        .reply(200, {
          id: driveFileId,
          name: 'SharedPresentation.pdf',
          parents: ['initial-parent-folder'],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${driveFileId}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${driveFileId}`)
        .query(true)
        .reply(200, {
          id: driveFileId,
          name: 'SharedPresentation.pdf',
          parents: [newSubfolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${driveFileId}/view`,
        });

      // 2. Upload Email PDF via saveBuffer
      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-email-pdf',
          name: 'Email - Drive Reference Thread.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-email-pdf/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-drive-combo',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: [`https://drive.google.com/file/d/${driveFileId}/view`] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');
      expect(nock.isDone()).toBe(true);
    });

    it('pre-validation guard: aborts when document validation fails with SaveEmailToPdf = true, asserting ZERO calls to generateEmailPdf and ZERO Drive mutations', async () => {
      const generateEmailPdfSpy = vi.spyOn(PdfProcessor.prototype, 'generateEmailPdf');
      mockGmailClient.getAttachment = vi.fn();

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-validation-fail-pdf',
            threadId: 'th-validation-fail',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: [] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              // Missing required fields (contact, date, direction, description)!
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      // Zero calls to generateEmailPdf!
      expect(generateEmailPdfSpy).not.toHaveBeenCalled();

      // Zero calls to getAttachment!
      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();

      // Zero unhandled nock requests (meaning zero Drive mutations or folder creation)
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('End-to-End Attachment Filing with Stable partId Identity Across Card Updates (Ticket #204)', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    function mockFolderResolution(description = 'Meeting Notes') {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      const leafFolderName = `260920 IN - ${description}`;

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes(`name = '${leafFolderName}'`))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: leafFolderName,
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('persists selection and files attachments + Email PDF across rotating attachmentId tokens (POST /workspace/gmail-contextual -> POST /workspace/on-form-change -> POST /workspace/action)', async () => {
      mockFolderResolution('Audit Filing');

      const messageId = 'msg-rotation-flow';
      let fetchCount = 0;

      // Simulate rotating attachmentId tokens on each getMessage fetch
      mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
        fetchCount++;
        return {
          id: msgId,
          messageId: msgId,
          subject: 'Financial Audit Report',
          attachments: [
            {
              partId: 'part-0.1',
              attachmentId: `att-token-v${fetchCount}`,
              filename: 'AuditReport.pdf',
              mimeType: 'application/pdf',
              size: 4096,
            },
          ],
          inlineImages: [],
        };
      });

      const auditPdfBytes = new Uint8Array([55, 66, 77]);
      mockGmailClient.getAttachment = vi.fn().mockResolvedValue(auditPdfBytes);

      // --- Step 1: Initial load POST /workspace/gmail-contextual ---
      const resContextual = await app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          gmail: {
            messageId,
            threadId: 'th-rotation',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resContextual.statusCode).toBe(200);
      const bodyContextual = JSON.parse(resContextual.payload) as GoogleWorkspaceActionResponse;
      const fileSec1 = bodyContextual.action!.navigations![0].pushCard!.sections.find(
        (s) => s.header === 'File Selection'
      )!;

      // Value mapped to stable partId 'part-0.1' and defaulted to selected: true
      expect(fileSec1.widgets[2].selectionInput?.name).toBe('SelectAttachments');
      expect(fileSec1.widgets[2].selectionInput?.items).toEqual([
        { text: 'AuditReport.pdf', value: 'part-0.1', selected: true },
      ]);
      expect(fetchCount).toBe(1);

      // --- Step 2: In-card update POST /workspace/on-form-change (user toggles SaveEmailToPdf to true) ---
      const resFormChange = await app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          gmail: {
            messageId,
            threadId: 'th-rotation',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-0.1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
            },
          },
        },
      });

      expect(resFormChange.statusCode).toBe(200);
      const bodyFormChange = JSON.parse(resFormChange.payload) as GoogleWorkspaceActionResponse;
      const updateCard = bodyFormChange.action!.navigations![0].updateCard!;
      const fileSec2 = updateCard.sections.find((s) => s.header === 'File Selection')!;

      // Attachment remains selected even though token rotated to att-token-v2!
      expect(fileSec2.widgets[2].selectionInput?.items).toEqual([
        { text: 'AuditReport.pdf', value: 'part-0.1', selected: true },
      ]);
      // SaveEmailToPdf remains true
      expect(fileSec2.widgets[3].selectionInput?.name).toBe('SaveEmailToPdf');
      expect(fileSec2.widgets[3].selectionInput?.items?.[0]).toEqual({
        text: 'Save Email to PDF',
        value: 'true',
        selected: true,
      });
      expect(fetchCount).toBe(2);

      // --- Step 3: Submit POST /workspace/action (processDocument) ---
      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-audit-att',
          name: 'AuditReport.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-audit-att/view',
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-audit-email-pdf',
          name: 'Email - Financial Audit Report.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-audit-email-pdf/view',
        });

      const resAction = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          gmail: {
            messageId,
            threadId: 'th-rotation',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'processDocument' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-0.1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Audit Filing'] } },
            },
          },
        },
      });

      expect(resAction.statusCode).toBe(200);
      const bodyAction = JSON.parse(resAction.payload) as GoogleWorkspaceActionResponse;
      expect(bodyAction.action?.notification?.text).toBe('Document processed successfully');

      // Crucial: getAttachment must have been called with the freshest token from the hydration fetch!
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(
        messageId,
        `att-token-v${fetchCount}`,
        { auth: 'ya29.valid-oauth-token' }
      );
      expect(nock.isDone()).toBe(true);
    });

    it('files multiple email attachments sharing the same filename with distinct partIds into Google Drive', async () => {
      mockFolderResolution('Dual Invoices');

      const messageId = 'msg-same-filenames';
      const fileBytes1 = new Uint8Array([1, 1, 1]);
      const fileBytes2 = new Uint8Array([2, 2, 2]);

      mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => ({
        id: msgId,
        messageId: msgId,
        subject: 'Invoices for Order #100',
        attachments: [
          {
            partId: 'part-0.1',
            attachmentId: 'fresh-token-inv-1',
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            size: 1024,
          },
          {
            partId: 'part-0.2',
            attachmentId: 'fresh-token-inv-2',
            filename: 'invoice.pdf',
            mimeType: 'application/pdf',
            size: 2048,
          },
        ],
        inlineImages: [],
      }));

      mockGmailClient.getAttachment = vi.fn().mockImplementation(async (_msgId: string, attId: string) => {
        if (attId === 'fresh-token-inv-1') return fileBytes1;
        if (attId === 'fresh-token-inv-2') return fileBytes2;
        throw new Error(`Unexpected attId: ${attId}`);
      });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-inv-1',
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-inv-1/view',
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-inv-2',
          name: 'invoice.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-inv-2/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          gmail: {
            messageId,
            threadId: 'th-same-names',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'processDocument' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-0.1', 'part-0.2'] } },
              SaveEmailToPdf: { stringInputs: { value: ['false'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Dual Invoices'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(messageId, 'fresh-token-inv-1', expect.anything());
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(messageId, 'fresh-token-inv-2', expect.anything());
      expect(nock.isDone()).toBe(true);
    });

    it('moves Drive item and saves Email PDF without downloading or substituting email attachment when Drive URL has identical filename', async () => {
      mockFolderResolution('Signed Contract');

      const messageId = 'msg-colliding-name';
      const driveFileId = 'drive-colliding-123';
      const collidingFilename = 'Contract.pdf';

      mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => ({
        id: msgId,
        messageId: msgId,
        subject: 'Contract Signing',
        attachments: [
          {
            partId: 'part-email-contract',
            attachmentId: 'att-email-contract-token',
            filename: collidingFilename,
            mimeType: 'application/pdf',
            size: 1024,
          },
        ],
        inlineImages: [],
      }));

      // getAttachment must NOT be called for the email attachment!
      mockGmailClient.getAttachment = vi.fn();

      // Mock Drive move call for drive-colliding-123
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${driveFileId}`)
        .query(true)
        .reply(200, {
          id: driveFileId,
          name: collidingFilename,
          mimeType: 'application/pdf',
          parents: ['root-or-other-folder'],
          webViewLink: `https://drive.google.com/file/d/${driveFileId}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${driveFileId}`)
        .query(true)
        .reply(200, {
          id: driveFileId,
          name: collidingFilename,
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: `https://drive.google.com/file/d/${driveFileId}/view`,
        });

      // Mock Drive saveBuffer call for the Email PDF
      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-contract-email-pdf',
          name: 'Email - Contract Signing.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-contract-email-pdf/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          gmail: {
            messageId,
            threadId: 'th-colliding',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'processDocument' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: [`https://drive.google.com/file/d/${driveFileId}/view`] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Signed Contract'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Crucial: getAttachment should NOT have been called for the email attachment!
      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
      expect(nock.isDone()).toBe(true);
    });

    it('aborts with "Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again." when getAttachment fails, preserving target folder and form inputs', async () => {
      mockFolderResolution('Meeting Notes');

      mockGmailClient.getAttachment = vi.fn().mockRejectedValue(new Error('Gmail API attachment download failed'));

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-with-live-attachments',
            threadId: 'th-test-live',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['att-part-1'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard!.sections.find((s) =>
        s.widgets?.some((w) =>
          w.textParagraph?.text?.includes(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          )
        )
      );
      expect(errorSection).toBeDefined();

      // Form inputs preserved
      const infoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
      expect(infoSection).toBeDefined();
      const contactWidget = infoSection!.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      );
      expect(contactWidget?.textInput?.value).toBe('Acme Corp');

      // Verify destination folder creation occurred via nock
      expect(nock.isDone()).toBe(true);
    });

    it('aborts with "Could not generate the Email PDF. Please try again." when generateEmailPdf fails, preserving target folder and form inputs', async () => {
      mockFolderResolution('Meeting Notes');

      const pdfProcessorSpy = vi
        .spyOn(PdfProcessor.prototype, 'generateEmailPdf')
        .mockRejectedValueOnce(new Error('PDF generation failure'));

      try {
        const response = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-jwt-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'ya29.valid-oauth-token',
            },
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-with-live-attachments',
              threadId: 'th-test-live',
              accessToken: 'ya29.live-token',
            },
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                SaveEmailToPdf: { stringInputs: { value: ['true'] } },
                [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
                [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
                [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
              },
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
        const updateCard = body.action?.navigations?.[0]?.updateCard;
        expect(updateCard).toBeDefined();

        const errorSection = updateCard!.sections.find((s) =>
          s.widgets?.some((w) =>
            w.textParagraph?.text?.includes('Could not generate the Email PDF. Please try again.')
          )
        );
        expect(errorSection).toBeDefined();

        // Form inputs preserved
        const infoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
        expect(infoSection).toBeDefined();
        const contactWidget = infoSection!.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
        );
        expect(contactWidget?.textInput?.value).toBe('Acme Corp');

        // Target folder created in Drive
        expect(nock.isDone()).toBe(true);
      } finally {
        pdfProcessorSpy.mockRestore();
      }
    });

  });
  describe('Small Inline Gmail Attachments Filing (Ticket #205)', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    function mockFolderResolution() {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260920 IN - Meeting Notes',
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('displays small inline attachment in File Selection checkboxes on POST /workspace/gmail-contextual', async () => {
      const messageId = 'msg-with-small-inline-attachment';
      const inlineData = new Uint8Array([10, 20, 30, 40]);

      mockGmailClient.getMessage = vi.fn().mockResolvedValue({
        id: messageId,
        messageId,
        subject: 'Inline Attachment Email',
        attachments: [
          {
            partId: 'part-inline-0.1',
            attachmentId: 'inline-part-inline-0.1',
            filename: 'inline-notes.txt',
            mimeType: 'text/plain',
            size: 4,
            data: inlineData,
          },
        ],
        inlineImages: [],
      });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-test-inline',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const pushCard = body.action!.navigations![0].pushCard!;
      const fileSection = pushCard.sections.find((s) => s.header === 'File Selection');
      expect(fileSection).toBeDefined();

      const attachmentCheckboxWidget = fileSection?.widgets.find(
        (w) => w.selectionInput?.name === 'SelectAttachments'
      );
      expect(attachmentCheckboxWidget).toBeDefined();
      expect(attachmentCheckboxWidget?.selectionInput?.items).toContainEqual({
        text: 'inline-notes.txt',
        value: 'part-inline-0.1',
        selected: true,
      });
    });

    it('files checked small inline attachment into Drive destination without calling getAttachment', async () => {
      mockFolderResolution();

      const messageId = 'msg-with-small-inline-attachment';
      const inlineData = new Uint8Array([10, 20, 30, 40]);

      mockGmailClient.getMessage = vi.fn().mockResolvedValue({
        id: messageId,
        messageId,
        subject: 'Inline Attachment Email',
        attachments: [
          {
            partId: 'part-inline-0.1',
            attachmentId: 'inline-part-inline-0.1',
            filename: 'inline-notes.txt',
            mimeType: 'text/plain',
            size: 4,
            data: inlineData,
          },
        ],
        inlineImages: [],
      });

      mockGmailClient.getAttachment = vi.fn();

      let uploadedPayload: Buffer | undefined;
      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, (uri, requestBody) => {
          uploadedPayload = Buffer.isBuffer(requestBody)
            ? requestBody
            : Buffer.from(requestBody as string, 'binary');
          return {
            id: 'drive-saved-inline-note',
            name: 'inline-notes.txt',
            mimeType: 'text/plain',
            parents: [newSubfolderId],
            webViewLink: 'https://drive.google.com/file/d/drive-saved-inline-note/view',
          };
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-test-inline',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-inline-0.1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['false'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Crucial assertion: getAttachment must NOT have been called!
      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();

      // Check uploaded bytes
      expect(uploadedPayload).toBeDefined();
      expect(uploadedPayload!.includes(Buffer.from(inlineData))).toBe(true);

      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Bounded getMessage memoization across request lifecycle (Ticket #208)', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-memo-subfolder';

    function mockFolderResolution(description = 'Meeting Notes') {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      const leafFolderName = `260920 IN - ${description}`;

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes(`name = '${leafFolderName}'`))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: leafFolderName,
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('reuses memoized GmailMessageDetails across UiProcessManager and GmailSourceFileHydratorAdapter issuing only one users.messages.get call', async () => {
      mockFolderResolution('Project Scope Review');

      const messageId = 'msg-memoized-integration-test';
      const fileBytes = new Uint8Array([10, 20, 30]);

      const mockMessagesGet = vi.fn().mockResolvedValue({
        data: {
          id: messageId,
          threadId: 'th-memoized-test',
          payload: {
            headers: [
              { name: 'Subject', value: 'Project Scope Review' },
              { name: 'From', value: 'alice@example.com' },
              { name: 'Date', value: 'Mon, 18 Oct 2026 12:00:00 GMT' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: 'part-0',
                mimeType: 'application/pdf',
                filename: 'Scope.pdf',
                body: {
                  attachmentId: 'att-memo-scope-1',
                  size: 1024,
                },
              },
            ],
          },
        },
      });

      const mockAttachmentsGet = vi.fn().mockResolvedValue({
        data: {
          data: Buffer.from(fileBytes).toString('base64url'),
        },
      });

      const mockGmailApi = {
        users: {
          messages: {
            get: mockMessagesGet,
            attachments: {
              get: mockAttachmentsGet,
            },
          },
        },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmailApi);

      const memoizedGmailClient = new GoogleGmailClient({
        gmail: mockGmailApi,
      });

      const testApp = createApp({
        manifestProvider,
        authVerifier: mockAuthVerifier,
        skipSpaceValidation: true,
        storageAdapter: mockStorageAdapter,
        gmailClient: memoizedGmailClient,
      });
      await testApp.initialize();

      // Expect two uploads to Drive: one for attachment, one for email PDF
      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-scope-att',
          name: 'Scope.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-scope-att/view',
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-scope-email-pdf',
          name: 'Email - Project Scope Review.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-scope-email-pdf/view',
        });

      const response = await testApp.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-memoized-test',
            accessToken: 'ya29.valid-oauth-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-0'] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Project Scope Review'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // The critical assertion: users.messages.get was called ONLY ONCE across the entire request!
      expect(mockMessagesGet).toHaveBeenCalledTimes(1);
      expect(mockMessagesGet).toHaveBeenCalledWith({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      // Attachment was retrieved via attachment API
      expect(mockAttachmentsGet).toHaveBeenCalledTimes(1);
      expect(mockAttachmentsGet).toHaveBeenCalledWith({
        userId: 'me',
        messageId,
        id: 'att-memo-scope-1',
      });

      gmailSpy.mockRestore();
      expect(nock.isDone()).toBe(true);
    });

    it('reuses memoized GmailMessageDetails across in-card event and subsequent processDocument submission within TTL window', async () => {
      mockFolderResolution('Sequential Lifecycle Review');

      const messageId = 'msg-lifecycle-test';
      const fileBytes = new Uint8Array([40, 50, 60]);

      const mockMessagesGet = vi.fn().mockResolvedValue({
        data: {
          id: messageId,
          threadId: 'th-lifecycle',
          payload: {
            headers: [
              { name: 'Subject', value: 'Lifecycle Review' },
              { name: 'From', value: 'bob@example.com' },
              { name: 'Date', value: 'Tue, 19 Oct 2026 10:00:00 GMT' },
            ],
            mimeType: 'multipart/mixed',
            parts: [
              {
                partId: 'part-0',
                mimeType: 'application/pdf',
                filename: 'Report.pdf',
                body: {
                  attachmentId: 'att-lifecycle-1',
                  size: 2048,
                },
              },
            ],
          },
        },
      });

      const mockAttachmentsGet = vi.fn().mockResolvedValue({
        data: {
          data: Buffer.from(fileBytes).toString('base64url'),
        },
      });

      const mockGmailApi = {
        users: {
          messages: {
            get: mockMessagesGet,
            attachments: {
              get: mockAttachmentsGet,
            },
          },
        },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmailApi);

      const memoizedGmailClient = new GoogleGmailClient({
        gmail: mockGmailApi,
      });

      const testApp = createApp({
        manifestProvider,
        authVerifier: mockAuthVerifier,
        skipSpaceValidation: true,
        storageAdapter: mockStorageAdapter,
        gmailClient: memoizedGmailClient,
      });
      await testApp.initialize();

      // Step 1: In-card update / on-form-change (user changes space type or toggles switch)
      const formChangeResponse = await testApp.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-lifecycle',
            accessToken: 'ya29.valid-oauth-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onSpaceTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            },
          },
        },
      });

      expect(formChangeResponse.statusCode).toBe(200);
      expect(mockMessagesGet).toHaveBeenCalledTimes(1);

      // Step 2: User files document with attachments and SaveEmailToPdf = true
      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-report-att',
          name: 'Report.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-report-att/view',
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-report-email-pdf',
          name: 'Email - Lifecycle Review.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-report-email-pdf/view',
        });

      const actionResponse = await testApp.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          hostApp: 'GMAIL',
          gmail: {
            messageId,
            threadId: 'th-lifecycle',
            accessToken: 'ya29.valid-oauth-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'processDocument' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-0'] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Sequential Lifecycle Review'] } },
            },
          },
        },
      });

      expect(actionResponse.statusCode).toBe(200);
      const actionBody = JSON.parse(actionResponse.payload) as GoogleWorkspaceActionResponse;
      expect(actionBody.action?.notification?.text).toBe('Document processed successfully');

      // Across both the on-form-change and processDocument with hydrator + UI manager, users.messages.get was called ONLY ONCE!
      expect(mockMessagesGet).toHaveBeenCalledTimes(1);

      gmailSpy.mockRestore();
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Reactive email switching and cross-action persistence (Ticket #211)', () => {
    it('switches emails with onEmailMessageChange, resets attachments to all selected, and persists choice across other in-card actions', async () => {
      // Step 1: Initial load on multi-message thread with msg-email-1
      const resInitial = await app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-message',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resInitial.statusCode).toBe(200);
      const bodyInitial = JSON.parse(resInitial.payload) as GoogleWorkspaceActionResponse;
      const pushCard = bodyInitial.action!.navigations![0].pushCard!;
      const fileSecInitial = pushCard.sections.find((s) => s.header === 'File Selection')!;

      // Dropdown SelectEmailMessage is widget 0 with msg-email-1 selected
      const emailDropdown = fileSecInitial.widgets[0].selectionInput;
      expect(emailDropdown?.name).toBe('SelectEmailMessage');
      expect(emailDropdown?.items).toHaveLength(2);
      expect(emailDropdown?.items?.[0].value).toBe('msg-email-1');
      expect(emailDropdown?.items?.[0].selected).toBe(true);
      expect(emailDropdown?.items?.[1].value).toBe('msg-email-2');
      expect(emailDropdown?.items?.[1].selected).toBe(false);

      // Email 1 has 1 attachment (Email1Doc.pdf) checked
      const attsInitial = fileSecInitial.widgets[2].selectionInput;
      expect(attsInitial?.name).toBe('SelectAttachments');
      expect(attsInitial?.items).toEqual([
        { text: 'Email1Doc.pdf', value: 'part-email-1-att-1', selected: true },
      ]);

      // Step 2: Switch email to msg-email-2 via POST /workspace/action
      const resSwitch = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'onEmailMessageChange',
              previousMessageId: 'msg-email-1',
              previousAttachments: JSON.stringify(['part-email-1-att-1']),
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-email-2'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-email-1-att-1'] } }, // stale input from old email
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            },
          },
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-message',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resSwitch.statusCode).toBe(200);
      const bodySwitch = JSON.parse(resSwitch.payload) as GoogleWorkspaceActionResponse;
      expect(bodySwitch.action?.navigations?.[0].updateCard).toBeDefined();
      const updateCardSwitch = bodySwitch.action!.navigations![0].updateCard!;
      const fileSecSwitch = updateCardSwitch.sections.find((s) => s.header === 'File Selection')!;

      // Dropdown now has msg-email-2 selected
      const emailDropdownSwitch = fileSecSwitch.widgets[0].selectionInput;
      expect(emailDropdownSwitch?.items?.[0].selected).toBe(false);
      expect(emailDropdownSwitch?.items?.[1].selected).toBe(true);

      // Attachments for msg-email-2 are both checked (stale part-email-1-att-1 was cleansed)
      const attsSwitch = fileSecSwitch.widgets[2].selectionInput;
      expect(attsSwitch?.name).toBe('SelectAttachments');
      expect(attsSwitch?.items).toEqual([
        { text: 'Email2DocA.pdf', value: 'part-email-2-att-1', selected: true },
        { text: 'Email2DocB.pdf', value: 'part-email-2-att-2', selected: true },
      ]);

      // Verify parameters on interactive controls now propagate previousMessageId = msg-email-2
      const fileSourceParams = fileSecSwitch.widgets[1].selectionInput?.onChangeAction?.parameters;
      expect(fileSourceParams?.find((p: { key: string }) => p.key === 'previousMessageId')?.value).toBe('msg-email-2');
      expect(fileSourceParams?.find((p: { key: string }) => p.key === 'previousAttachments')?.value).toBe(
        JSON.stringify(['part-email-2-att-1', 'part-email-2-att-2'])
      );

      // Step 3: Trigger onSpaceTypeChange and verify SelectEmailMessage remains msg-email-2
      const resSpaceChange = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'onSpaceTypeChange',
              previousMessageId: 'msg-email-2',
              previousAttachments: JSON.stringify(['part-email-2-att-1', 'part-email-2-att-2']),
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-email-2'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-email-2-att-1'] } }, // user unchecked doc B
            },
          },
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-message',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resSpaceChange.statusCode).toBe(200);
      const bodySpaceChange = JSON.parse(resSpaceChange.payload) as GoogleWorkspaceActionResponse;
      const updateCardSpace = bodySpaceChange.action!.navigations![0].updateCard!;
      const fileSecSpace = updateCardSpace.sections.find((s) => s.header === 'File Selection')!;

      // SelectEmailMessage is still msg-email-2
      expect(fileSecSpace.widgets[0].selectionInput?.items?.[1].selected).toBe(true);
      // Uncheck of doc B was preserved across space type change (isEmailSwitch was false)
      expect(fileSecSpace.widgets[2].selectionInput?.items).toEqual([
        { text: 'Email2DocA.pdf', value: 'part-email-2-att-1', selected: true },
        { text: 'Email2DocB.pdf', value: 'part-email-2-att-2', selected: false },
      ]);
    });
  });

  describe('End-to-End processDocument filing for selected thread email (Ticket #212)', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    function mockFolderResolution() {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260920 IN - Meeting Notes',
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('files checked attachments from a non-initial email in a multi-message thread into Drive', async () => {
      mockFolderResolution();

      const attachmentBytes = new Uint8Array([10, 20, 30, 40]);
      mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-att-2a',
          name: 'Email2DocA.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-att-2a/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-message',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-email-2'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-email-2-att-1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['false'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Crucial: getAttachment was called with the selected email ID (msg-email-2) rather than initial trigger (msg-email-1)
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(
        'msg-email-2',
        'att-email-2-1',
        { auth: 'ya29.valid-oauth-token' }
      );
      expect(nock.isDone()).toBe(true);
    });

    it('files Email PDF from a non-initial email in a multi-message thread (renders headers, subject, body from selected email)', async () => {
      mockFolderResolution();

      const generateEmailPdfSpy = vi.spyOn(PdfProcessor.prototype, 'generateEmailPdf');

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-pdf-2',
          name: 'Email - Project Scope Revision.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-pdf-2/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-message',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-email-2'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: [] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Crucial: generateEmailPdf received headers, subject, and body from msg-email-2
      expect(generateEmailPdfSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Project Scope Revision',
          from: 'Bob <bob@example.com>',
          to: 'Team <team@example.com>',
          date: 'Mon, 19 Oct 2026 11:00:00 +0000',
          plainTextBody: 'Please find the revised project documents attached.',
        })
      );

      generateEmailPdfSpy.mockRestore();
      expect(nock.isDone()).toBe(true);
    });

    it('files both attachments and Email PDF from a non-initial email in a multi-message thread', async () => {
      mockFolderResolution();

      const attachmentBytes = new Uint8Array([50, 60, 70]);
      mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);
      const generateEmailPdfSpy = vi.spyOn(PdfProcessor.prototype, 'generateEmailPdf');

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-att-2a',
          name: 'Email2DocA.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-att-2a/view',
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-pdf-2',
          name: 'Email - Project Scope Revision.pdf',
          mimeType: 'application/pdf',
          parents: [newSubfolderId],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-pdf-2/view',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-message',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-email-2'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-email-2-att-1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      // Attachment downloaded from msg-email-2
      expect(mockGmailClient.getAttachment).toHaveBeenCalledWith(
        'msg-email-2',
        'att-email-2-1',
        { auth: 'ya29.valid-oauth-token' }
      );

      // Email PDF generated with msg-email-2 headers and body
      expect(generateEmailPdfSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: 'Project Scope Revision',
          from: 'Bob <bob@example.com>',
          to: 'Team <team@example.com>',
          date: 'Mon, 19 Oct 2026 11:00:00 +0000',
          plainTextBody: 'Please find the revised project documents attached.',
        })
      );

      generateEmailPdfSpy.mockRestore();
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Bounded Per-Message Cache Warming in getThread & skipCache Refresh Reset (Ticket #213)', () => {
    const rootSharedDriveId = 'shared-drive-proj-root';
    const adminFolderId = 'folder-admin-1';
    const commFolderId = 'folder-comm-1';
    const contactFolderId = 'folder-acme-corp';
    const newSubfolderId = 'folder-meeting-subfolder';

    function mockFolderResolution() {
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, {
          files: [{ id: adminFolderId, name: '1 Admin', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [{ id: commFolderId, name: 'Communication', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, {
          files: [{ id: contactFolderId, name: 'Acme Corp', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260920 IN - Meeting Notes',
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });
    }

    it('clicking Refresh (action: "refresh") passes skipCache: true to Gmail client/port, re-fetches thread, and resets SelectEmailMessage to trigger messageId with attachments checked and SaveEmailToPdf: false', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-message',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'refresh',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-email-2'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-email-2-att-1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['true'] } },
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;

      // Crucial: getThread called with skipCache: true
      expect(mockGmailClient.getThread).toHaveBeenCalledWith(
        'th-multi-message',
        expect.objectContaining({ skipCache: true })
      );

      const nav = body.action?.navigations?.[0];
      const card = nav?.pushCard ?? nav?.updateCard;
      expect(card).toBeDefined();

      const fileSelectionSection = card!.sections.find((s) => s.header === 'File Selection');
      expect(fileSelectionSection).toBeDefined();

      // Widget 0: SelectEmailMessage is reset to trigger msg-email-1
      const emailDropdown = fileSelectionSection?.widgets[0]?.selectionInput;
      expect(emailDropdown?.name).toBe('SelectEmailMessage');
      expect(emailDropdown?.items?.find((item) => item.value === 'msg-email-1')?.selected).toBe(true);
      expect(emailDropdown?.items?.find((item) => item.value === 'msg-email-2')?.selected).toBe(false);

      // Widget 2: Attachments checkbox group contains msg-email-1's attachment (Email1Doc.pdf) with selected: true
      const attGroup = fileSelectionSection?.widgets[2]?.selectionInput;
      expect(attGroup?.name).toBe('SelectAttachments');
      expect(attGroup?.items).toEqual([
        { text: 'Email1Doc.pdf', value: 'part-email-1-att-1', selected: true },
      ]);

      // Widget 3: SaveEmailToPdf switch is reset to false
      const savePdfSwitch = fileSelectionSection?.widgets[3]?.selectionInput;
      expect(savePdfSwitch?.name).toBe('SaveEmailToPdf');
      expect(savePdfSwitch?.items?.[0]?.selected).toBe(false);
    });

    it('submitting processDocument after getThread reuses cached GmailMessageDetails for selected email with zero additional users.messages.get calls', async () => {
      mockFolderResolution();

      const mockThreadGet = vi.fn().mockResolvedValue({
        data: {
          id: 'th-cached-thread',
          messages: [
            {
              id: 'msg-cached-1',
              threadId: 'th-cached-thread',
              payload: {
                headers: [
                  { name: 'Subject', value: 'First Email' },
                  { name: 'From', value: 'Alice <alice@example.com>' },
                  { name: 'Date', value: 'Mon, 19 Oct 2026 10:00:00 +0000' },
                ],
                body: { data: Buffer.from('Email 1 text').toString('base64url') },
                mimeType: 'text/plain',
              },
            },
            {
              id: 'msg-cached-2',
              threadId: 'th-cached-thread',
              payload: {
                headers: [
                  { name: 'Subject', value: 'Second Email' },
                  { name: 'From', value: 'Bob <bob@example.com>' },
                  { name: 'Date', value: 'Mon, 19 Oct 2026 11:00:00 +0000' },
                ],
                mimeType: 'multipart/mixed',
                parts: [
                  {
                    partId: 'part-c2',
                    filename: 'CachedDoc.pdf',
                    mimeType: 'application/pdf',
                    body: { attachmentId: 'att-c2', size: 1024 },
                  },
                ],
              },
            },
          ],
        },
      });

      const mockMessagesGet = vi.fn().mockResolvedValue({
        data: { id: 'unexpected-call', threadId: 'unexpected-call' },
      });

      const mockAttachmentsGet = vi.fn().mockResolvedValue({
        data: {
          data: Buffer.from(new Uint8Array([1, 2, 3])).toString('base64url'),
        },
      });

      const mockGmailApi = {
        users: {
          threads: { get: mockThreadGet },
          messages: {
            get: mockMessagesGet,
            attachments: { get: mockAttachmentsGet },
          },
        },
      } as unknown as gmail_v1.Gmail;

      const gmailSpy = vi.spyOn(google, 'gmail').mockReturnValue(mockGmailApi);

      const realGmailClient = new GoogleGmailClient({
        gmail: mockGmailApi,
      });

      const cachingApp = createApp({
        manifestProvider,
        authVerifier: mockAuthVerifier,
        skipSpaceValidation: true,
        storageAdapter: mockStorageAdapter,
        gmailClient: realGmailClient,
      });
      await cachingApp.initialize();

      try {
        // Step 1: Initial context load calls getThread, pre-warming per-message cache for msg-cached-1 and msg-cached-2
        const initRes = await cachingApp.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: {
            authorization: 'Bearer valid-jwt-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'ya29.valid-oauth-token',
            },
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-cached-1',
              threadId: 'th-cached-thread',
              accessToken: 'ya29.live-token',
            },
          },
        });
        expect(initRes.statusCode).toBe(200);
        expect(mockThreadGet).toHaveBeenCalledTimes(1);

        // Step 2: processDocument submitting msg-cached-2
        nock('https://www.googleapis.com')
          .post('/upload/drive/v3/files')
          .query(true)
          .reply(200, {
            id: 'drive-saved-cached-doc',
            name: 'CachedDoc.pdf',
            mimeType: 'application/pdf',
            parents: [newSubfolderId],
            webViewLink: 'https://drive.google.com/file/d/drive-saved-cached-doc/view',
          });

        const processRes = await cachingApp.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-jwt-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'ya29.valid-oauth-token',
            },
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-cached-1',
              threadId: 'th-cached-thread',
              accessToken: 'ya29.live-token',
            },
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectEmailMessage: { stringInputs: { value: ['msg-cached-2'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                SelectAttachments: { stringInputs: { value: ['part-c2'] } },
                SaveEmailToPdf: { stringInputs: { value: ['false'] } },
                [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['Acme Corp'] } },
                [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
                [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Meeting Notes'] } },
              },
            },
          },
        });

        expect(processRes.statusCode).toBe(200);
        const processBody = JSON.parse(processRes.payload) as GoogleWorkspaceActionResponse;
        expect(processBody.action?.notification?.text).toBe('Document processed successfully');

        // The critical assertion: users.messages.get was called 0 times because getThread pre-warmed msg-cached-2 in cache!
        expect(mockMessagesGet).toHaveBeenCalledTimes(0);
        expect(mockThreadGet).toHaveBeenCalledTimes(2);
        expect(mockAttachmentsGet).toHaveBeenCalledTimes(1);
        expect(nock.isDone()).toBe(true);
      } finally {
        gmailSpy.mockRestore();
      }
    });
  });

  describe('Gmail Pass 1 DocumentType and DocumentSpaceType routing across threads and attachments (Ticket #292)', () => {
    it('infers submittal-arch on Gmail initial card open (/workspace/gmail-contextual) when active email has CSI attachment', async () => {
      vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-arch-e2e') {
          return {
            id: 'th-arch-e2e',
            messages: [
              {
                id: 'msg-arch-e2e',
                threadId: 'th-arch-e2e',
                subject: 'Submittal Review',
                from: 'Architect <arch@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-arch-1',
                    attachmentId: 'att-arch-1',
                    filename: '071200-001_Waterproofing.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-arch-e2e',
            threadId: 'th-arch-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const pushCard = cardResponse.action!.navigations![0].pushCard!;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-arch');
      expect(cardJson).toContain('Active Projects');
    });

    it('infers submittal-ffe on Gmail initial card open when active email has bounded FF&E keyword in subject', async () => {
      vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-ffe-e2e') {
          return {
            id: 'th-ffe-e2e',
            messages: [
              {
                id: 'msg-ffe-e2e',
                threadId: 'th-ffe-e2e',
                subject: 'FF&E Submittal - Ballroom Seating',
                from: 'Designer <designer@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                plainTextBody: 'Please review attached specs.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-ffe-1',
                    attachmentId: 'att-ffe-1',
                    filename: 'Notes.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-ffe-e2e',
            threadId: 'th-ffe-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const pushCard = cardResponse.action!.navigations![0].pushCard!;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-ffe');
      expect(cardJson).toContain('Active Projects');
    });

    it('re-runs inferRouting on /workspace/action with action: refresh', async () => {
      vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-refresh-e2e') {
          return {
            id: 'th-refresh-e2e',
            messages: [
              {
                id: 'msg-refresh-e2e',
                threadId: 'th-refresh-e2e',
                subject: 'Submittal 071200-001 Waterproofing',
                from: 'Contractor <gc@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-ref-1',
                    attachmentId: 'att-ref-1',
                    filename: 'Drawing.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'refresh',
            },
          },
          gmail: {
            messageId: 'msg-refresh-e2e',
            threadId: 'th-refresh-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const cardJson = JSON.stringify(cardResponse);

      expect(cardJson).toContain('submittal-arch');
    });

    it('re-evaluates Pass 1 on /workspace/action with onEmailMessageChange across messages in a thread', async () => {
      vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-switch-routing-e2e') {
          return {
            id: 'th-switch-routing-e2e',
            messages: [
              {
                id: 'msg-plain-e2e',
                threadId: 'th-switch-routing-e2e',
                subject: 'Weekly Team Sync Notes',
                from: 'Alice <alice@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                plainTextBody: 'Here are the minutes.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-notes-1',
                    attachmentId: 'att-notes-1',
                    filename: 'Minutes.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
              {
                id: 'msg-submittal-e2e',
                threadId: 'th-switch-routing-e2e',
                subject: 'Submittal Package Sent for Review',
                from: 'Bob <bob@example.com>',
                date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                plainTextBody: 'Please review attached FF&E submittal.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-sub-1',
                    attachmentId: 'att-sub-1',
                    filename: 'CG104-A_Chair.pdf',
                    mimeType: 'application/pdf',
                    size: 2048,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      // 1. Initial load on msg-plain-e2e -> defaults to communication-project
      const resInitial = await app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-plain-e2e',
            threadId: 'th-switch-routing-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resInitial.statusCode).toBe(200);
      const cardResponseInitial = JSON.parse(resInitial.payload) as GoogleWorkspaceActionResponse;
      const initialJson = JSON.stringify(cardResponseInitial);
      expect(initialJson).toContain('communication-project');

      // 2. Switch to msg-submittal-e2e via onEmailMessageChange -> infers submittal-ffe
      const resSwitchToSubmittal = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'onEmailMessageChange',
              previousMessageId: 'msg-plain-e2e',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-submittal-e2e'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            },
          },
          gmail: {
            messageId: 'msg-plain-e2e',
            threadId: 'th-switch-routing-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resSwitchToSubmittal.statusCode).toBe(200);
      const cardResponseSubmittal = JSON.parse(resSwitchToSubmittal.payload) as GoogleWorkspaceActionResponse;
      const submittalJson = JSON.stringify(cardResponseSubmittal);
      expect(submittalJson).toContain('submittal-ffe');

      // 3. Switch back to msg-plain-e2e -> reverts to communication-project
      const resSwitchBack = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'onEmailMessageChange',
              previousMessageId: 'msg-submittal-e2e',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-plain-e2e'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            },
          },
          gmail: {
            messageId: 'msg-plain-e2e',
            threadId: 'th-switch-routing-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resSwitchBack.statusCode).toBe(200);
      const cardResponseBack = JSON.parse(resSwitchBack.payload) as GoogleWorkspaceActionResponse;
      const backJson = JSON.stringify(cardResponseBack);
      expect(backJson).toContain('communication-project');
    });

    describe('Gmail Pass 1 DocumentSpace candidateSpaces inference (Ticket #293)', () => {
      beforeEach(() => {
        vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-spaces-e2e') {
            return {
              id: 'th-spaces-e2e',
              messages: [
                {
                  id: 'msg-proj-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'Active Projects - Foundation Progress',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Here is the progress report for Active Projects.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-prop-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'RFP Submission for Client Proposals',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Attached is our revised cost proposal.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-collision-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'Coordination between Active Projects and Client Proposals',
                  from: 'Carol <carol@example.com>',
                  date: 'Mon, 19 Oct 2026 12:00:00 +0000',
                  plainTextBody: 'We need to coordinate both accounts.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-unmatched-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'General Team Discussion',
                  from: 'Dave <dave@example.com>',
                  date: 'Mon, 19 Oct 2026 13:00:00 +0000',
                  plainTextBody: 'No specific project or proposal.',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('infers projects DocumentSpace on initial card open with latency-bounded fetch (no proposals query)', async () => {
        const fetchSpacesSpy = vi.spyOn(mockStorageAdapter, 'fetchSpaces');
        fetchSpacesSpy.mockClear();

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates Active Projects and communication-project
        expect(json).toContain('Active Projects');
        expect(json).toContain('communication-project');

        // Bounded fetch: only projects was queried; proposals was NOT queried
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'projects');
        expect(fetchSpacesSpy).not.toHaveBeenCalledWith(expect.anything(), 'proposals');
      });

      it('infers proposals DocumentSpace when proposal/opportunity marker (RFP) appears in email', async () => {
        const fetchSpacesSpy = vi.spyOn(mockStorageAdapter, 'fetchSpaces');
        fetchSpacesSpy.mockClear();

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-prop-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates Client Proposals, selects proposals spaceType and communication-proposal
        expect(json).toContain('Client Proposals');
        expect(json).toContain('communication-proposal');

        // Both collections fetched
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'projects');
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'proposals');
      });

      it('leaves DocumentSpace blank without notFoundError when distinct spaces collide', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-collision-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Collision leaves space blank with no validation errors
        expect(json).not.toContain('was not found');
        expect(json).not.toContain('Multiple spaces match');
      });

      it('clears space input without notFoundError when switching from matched message to unmatched message', async () => {
        // 1. Initial open on msg-proj-space-e2e -> Active Projects
        const resInitial = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });
        expect(resInitial.statusCode).toBe(200);
        expect(resInitial.payload).toContain('"value":"Active Projects"');

        // 2. Switch to msg-unmatched-e2e via onEmailMessageChange
        const resSwitch = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onEmailMessageChange',
                previousMessageId: 'msg-proj-space-e2e',
              },
              formInputs: {
                SelectEmailMessage: { stringInputs: { value: ['msg-unmatched-e2e'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(resSwitch.statusCode).toBe(200);
        const switchJson = resSwitch.payload;

        // Space input value is cleared and no notFoundError is emitted
        expect(switchJson).not.toContain('"value":"Active Projects"');
        expect(switchJson).not.toContain('was not found');
      });
    });

    describe('Gmail interactive Google Drive URL routing delegation and file-source switching (Ticket #294)', () => {
      beforeEach(() => {
        vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-spaces-e2e') {
            return {
              id: 'th-spaces-e2e',
              messages: [
                {
                  id: 'msg-proj-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'Active Projects - Foundation Progress',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Here is the progress report for Active Projects.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-prop-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'RFP Submission for Client Proposals',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Attached is our revised cost proposal.',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('configures onChangeAction with action onFormChange and previousDriveUrl on InputDriveURL widget', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: 'https://drive.google.com/file/d/drive-url-existing/view',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: ['https://drive.google.com/file/d/drive-url-existing/view'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const fileSec = body.action?.navigations?.[0]?.updateCard?.sections.find((s) => s.header === 'File Selection');
        const driveUrlWidget = fileSec?.widgets.find((w) => w.textInput?.name === 'InputDriveURL')?.textInput;
        expect(driveUrlWidget).toBeDefined();
        expect(driveUrlWidget?.onChangeAction?.function).toContain('/workspace/on-form-change');
        expect(
          driveUrlWidget?.onChangeAction?.parameters?.find((p: { key: string }) => p.key === 'action')?.value
        ).toBe('onFormChange');
        expect(
          driveUrlWidget?.onChangeAction?.parameters?.find((p: { key: string }) => p.key === 'previousDriveUrl')?.value
        ).toBe('https://drive.google.com/file/d/drive-url-existing/view');
      });

      it('preserves existing space and document type selections when switching SelectFileSource to Google Drive URL with empty InputDriveURL', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [''] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);
        // Space and Document Type selections are preserved (Pass 1 skipped)
        expect(cardJson).toContain('Active Projects');
        expect(cardJson).toContain('communication-project');
      });

      it('runs Pass 1 inferRouting when InputDriveURL receives a valid Drive URL on onFormChange, resolving document type from Drive and space from email fallback', async () => {
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/drive-submittal-url-123')
          .query(true)
          .reply(200, {
            id: 'drive-submittal-url-123',
            name: '071200-001_Waterproofing.pdf',
            parents: [],
          });

        const driveUrl = 'https://drive.google.com/file/d/drive-submittal-url-123/view';
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFormChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);

        // Document type inferred from Drive filename regex
        expect(cardJson).toContain('submittal-arch');
        // Space inferred from active email subject fallback ("Active Projects - Foundation Progress")
        expect(cardJson).toContain('Active Projects');
      });

      it('re-runs Pass 1 against active email message when switching SelectFileSource back to Email Attachments', async () => {
        const driveUrl = 'https://drive.google.com/file/d/drive-submittal-url-123/view';

        // When switching back to Email Attachments, active email is msg-prop-space-e2e (RFP Submission for Client Proposals)
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: driveUrl,
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
                // Stale selections from Drive mode
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
              },
            },
            gmail: {
              messageId: 'msg-prop-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);

        // Pass 1 re-ran against msg-prop-space-e2e -> inferred Client Proposals
        expect(cardJson).toContain('Client Proposals');
      });

      it('skips Pass 1 on regular onFormChange field edits', async () => {
        const driveUrl = 'https://drive.google.com/file/d/drive-submittal-url-123/view';

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFormChange',
                // previousDriveUrl matches current InputDriveURL (no URL transition)
                previousDriveUrl: driveUrl,
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                [getDocumentSpaceWidgetName('proposals')]: { stringInputs: { value: ['Client Proposals'] } },
                notes: { stringInputs: { value: ['User manually edited notes'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);

        // Did not re-run Pass 1 against msg-proj-space-e2e (which would have forced Active Projects)
        expect(cardJson).toContain('Client Proposals');
      });
    });

    describe('Gmail Pass 1 label-aware DocumentSpace and DocumentType routing across card-open seams (Ticket #302)', () => {
      beforeEach(() => {
        vi.spyOn(mockStorageAdapter, 'fetchSpaces').mockImplementation(async (_config, typeId: string) => {
          if (typeId === 'projects') {
            return [
              {
                id: 'space-proj-123',
                typeId: 'projects',
                name: '123 Main St',
                abstractStorageId: 'drive-123',
              },
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
        });

        vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-labels-e2e') {
            return {
              id: 'th-labels-e2e',
              messages: [
                {
                  id: 'msg-labeled-submittal',
                  threadId: 'th-labels-e2e',
                  subject: 'Weekly Review',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Please find files attached.',
                  inlineImages: [],
                  attachments: [
                    {
                      partId: 'part-1',
                      attachmentId: 'att-1',
                      filename: 'GeneralNotes.pdf',
                      mimeType: 'application/pdf',
                      size: 1024,
                    },
                  ],
                  labels: ['Projects/123 Main St/Submittals', 'INBOX'],
                },
                {
                  id: 'msg-labeled-ffe-attachment',
                  threadId: 'th-labels-e2e',
                  subject: 'General Update',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Please find chair cutsheet attached.',
                  inlineImages: [],
                  attachments: [
                    {
                      partId: 'part-2',
                      attachmentId: 'att-2',
                      filename: 'CG104-A_Chair.pdf',
                      mimeType: 'application/pdf',
                      size: 2048,
                    },
                  ],
                  labels: ['Projects/123 Main St/Submittals', 'INBOX'],
                },
                {
                  id: 'msg-labeled-proposals',
                  threadId: 'th-labels-e2e',
                  subject: 'Discussion Notes',
                  from: 'Carol <carol@example.com>',
                  date: 'Mon, 19 Oct 2026 12:00:00 +0000',
                  plainTextBody: 'Review our opportunity pipeline.',
                  inlineImages: [],
                  attachments: [],
                  labels: ['Clients/Client Proposals/Opportunities', 'INBOX'],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('infers projects DocumentSpace 123 Main St and submittal-arch from hierarchical Gmail label on card open', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-labeled-submittal',
              threadId: 'th-labels-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates 123 Main St and submittal-arch from label
        expect(json).toContain('123 Main St');
        expect(json).toContain('submittal-arch');
      });

      it('lets explicit FF&E code-bearing attachment win over generic Submittals label, selecting submittal-ffe', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-labeled-ffe-attachment',
              threadId: 'th-labels-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates 123 Main St (from label) and submittal-ffe (from attachment)
        expect(json).toContain('123 Main St');
        expect(json).toContain('submittal-ffe');
      });

      it('infers proposals DocumentSpace when proposal marker appears in Gmail label', async () => {
        const fetchSpacesSpy = vi.spyOn(mockStorageAdapter, 'fetchSpaces');
        fetchSpacesSpy.mockClear();

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-labeled-proposals',
              threadId: 'th-labels-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates proposals space and communication-proposal
        expect(json).toContain('Client Proposals');
        expect(json).toContain('communication-proposal');
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'proposals');
      });
    });

    describe('Gmail card-state cleansing and universal formEvaluator reactive evaluation (Ticket #301)', () => {
      beforeEach(() => {
        vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-cleansing-e2e') {
            return {
              id: 'th-cleansing-e2e',
              messages: [
                {
                  id: 'msg-1-cleansing',
                  threadId: 'th-cleansing-e2e',
                  subject: 'Message 1 Subject',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Body 1',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-2-cleansing',
                  threadId: 'th-cleansing-e2e',
                  subject: 'Message 2 Subject',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Body 2',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('seeds default values (direction: "IN") on initial card render via universal formEvaluator', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');
        const directionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
        )?.selectionInput;

        expect(directionWidget).toBeDefined();
        const selectedItem = directionWidget?.items?.find((item) => item.selected);
        expect(selectedItem?.value).toBe('IN');
      });

      it('purges prior document fields on onEmailMessageChange switching messages in a thread', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onEmailMessageChange',
                previousMessageId: 'msg-1-cleansing',
              },
              formInputs: {
                SelectEmailMessage: { stringInputs: { value: ['msg-2-cleansing'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: {
                  stringInputs: { value: ['Prior Message Description'] },
                },
                description: { stringInputs: { value: ['Prior Message Description'] } },
              },
            },
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);
        expect(cardJson).not.toContain('Prior Message Description');
      });

      it('preserves user document fields when switching SelectFileSource to Google Drive URL with blank InputDriveURL', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [''] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: {
                  stringInputs: { value: ['User In Progress Notes'] },
                },
              },
            },
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const docInfoSec = body.action?.navigations?.[0]?.updateCard?.sections.find((s) => s.header === 'Document Data');
        const descWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
        )?.textInput;
        expect(descWidget?.value).toBe('User In Progress Notes');
      });

      it('purges prior document fields when InputDriveURL transitions to a valid Google Drive URL', async () => {
        const driveUrl = 'https://drive.google.com/file/d/drive-cleansing-file/view';
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFormChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: {
                  stringInputs: { value: ['User In Progress Notes'] },
                },
              },
            },
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);
        expect(cardJson).not.toContain('User In Progress Notes');
      });
    });

    describe('Ticket #303: Pass 2 Gmail field pre-population (communication-project & communication-proposal)', () => {
      beforeEach(() => {
        vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-pass2-e2e') {
            return {
              id: 'th-pass2-e2e',
              messages: [
                {
                  id: 'msg-pass2-incoming',
                  threadId: 'th-pass2-e2e',
                  subject: 'Re: Fwd: Site Logistics Update',
                  from: 'Vendor Partner <vendor@partner.com>',
                  date: 'Mon, 19 Oct 2026 14:30:00 +0000',
                  labels: ['INBOX'],
                  plainTextBody: 'Please find attached site notes.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-pass2-outgoing',
                  threadId: 'th-pass2-e2e',
                  subject: 'Fwd: Project Proposal Overview',
                  from: 'Project Manager <pm@inc.nyc>',
                  date: 'Tue, 20 Oct 2026 09:15:00 -04:00',
                  labels: ['SENT', 'INBOX'],
                  plainTextBody: 'Here is the proposal details.',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('pre-populates date, direction ("IN"), and description (prefix stripped) on incoming communication-project card', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-pass2-incoming',
              threadId: 'th-pass2-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

        const dateWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
        )?.textInput;
        expect(dateWidget?.value).toBe('261019');

        const descWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
        )?.textInput;
        expect(descWidget?.value).toBe('Site Logistics Update');

        const directionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
        )?.selectionInput;
        const selectedDir = directionWidget?.items?.find((item) => item.selected);
        expect(selectedDir?.value).toBe('IN');
      });

      it('pre-populates direction as "OT" for outgoing email (SENT label / inc.nyc sender) and strips prefixes', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-pass2-outgoing',
              threadId: 'th-pass2-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

        const dateWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
        )?.textInput;
        expect(dateWidget?.value).toBe('261020');

        const descWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
        )?.textInput;
        expect(descWidget?.value).toBe('Project Proposal Overview');

        const directionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
        )?.selectionInput;
        const selectedDir = directionWidget?.items?.find((item) => item.selected);
        expect(selectedDir?.value).toBe('OT');
      });

      it('pre-populates date, direction, and description when switching to communication-proposal', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onSpaceTypeChange',
              },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              },
            },
            gmail: {
              messageId: 'msg-pass2-incoming',
              threadId: 'th-pass2-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.updateCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

        const dateWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
        )?.textInput;
        expect(dateWidget?.value).toBe('261019');

        const descWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-proposal')
        )?.textInput;
        expect(descWidget?.value).toBe('Site Logistics Update');

        const directionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-proposal')
        )?.selectionInput;
        const selectedDir = directionWidget?.items?.find((item) => item.selected);
        expect(selectedDir?.value).toBe('IN');
      });
    });

    describe('Ticket #304: 3-tier LookupField resolution, single listFolders execution, and counterparty contact pre-population', () => {
      beforeEach(() => {
        vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-pass2-ticket-304') {
            return {
              id: 'th-pass2-ticket-304',
              messages: [
                {
                  id: 'msg-304-outgoing-matched',
                  threadId: 'th-pass2-ticket-304',
                  subject: 'Project Logistics & Schedule Update',
                  from: 'Project Manager <pm@inc.nyc>',
                  to: 'colleague@inc.nyc, "McGovern, James (Pavarini)" <jmcgovern@pavarini.com>',
                  date: 'Tue, 20 Oct 2026 14:00:00 -04:00',
                  labels: ['SENT', 'INBOX', 'Active Projects'],
                  plainTextBody: 'Please find the schedule attached.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-304-outgoing-unmatched',
                  threadId: 'th-pass2-ticket-304',
                  subject: 'Unregistered Vendor Email',
                  from: 'Project Manager <pm@inc.nyc>',
                  to: 'colleague@inc.nyc, Unregistered Person <unregistered@somewhere.com>',
                  date: 'Tue, 20 Oct 2026 15:00:00 -04:00',
                  labels: ['SENT', 'INBOX', 'Active Projects'],
                  plainTextBody: 'Hello world.',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('filters internal colleagues from email.to, resolves external counterparty contact, executes listFolders at most once per (spaceId, sourceKey), and emits zero duplicate status banners', async () => {
        // Step 1: list folders in space root
        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes(`'space-projects-1' in parents`))
          .reply(200, { files: [{ id: 'admin-id', name: '1 Admin' }] });

        // Step 2: list folders in 1 Admin
        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes(`'admin-id' in parents`))
          .reply(200, { files: [{ id: 'comm-id', name: 'Communication' }] });

        // Step 3: list folders in Communication
        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes(`'comm-id' in parents`))
          .reply(200, { files: [{ id: 'pavarini-id', name: 'Pavarini' }] });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-304-outgoing-matched',
              threadId: 'th-pass2-ticket-304',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

        const contactWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
        )?.textInput;
        expect(contactWidget?.value).toBe('Pavarini');

        const directionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
        )?.selectionInput;
        const selectedDir = directionWidget?.items?.find((item) => item.selected);
        expect(selectedDir?.value).toBe('OT');

        // Verify single-execution: each nock interceptor was called exactly ONCE across SourceParser and SchemaDrivenUi
        expect(nock.isDone()).toBe(true);

        // Verify zero duplicate status banners
        const allTextParagraphs = card?.sections.flatMap((s) =>
          s.widgets.map((w) => w.textParagraph?.text).filter(Boolean)
        ) ?? [];
        const statusBanners = allTextParagraphs.filter((t) => t?.includes('Status:'));
        const uniqueStatusBanners = new Set(statusBanners);
        expect(statusBanners.length).toBe(uniqueStatusBanners.size);
      });

      it('leaves allowUserInput LookupField blank when no canonical option or alias matches', async () => {
        // Step 1: list folders in space root
        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes(`'space-projects-1' in parents`))
          .reply(200, { files: [{ id: 'admin-id', name: '1 Admin' }] });

        // Step 2: list folders in 1 Admin
        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes(`'admin-id' in parents`))
          .reply(200, { files: [{ id: 'comm-id', name: 'Communication' }] });

        // Step 3: list folders in Communication
        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes(`'comm-id' in parents`))
          .reply(200, { files: [{ id: 'pavarini-id', name: 'Pavarini' }] });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-304-outgoing-unmatched',
              threadId: 'th-pass2-ticket-304',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

        const contactWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
        )?.textInput;
        expect(contactWidget?.value ?? '').toBe('');
        expect(nock.isDone()).toBe(true);
      });
    });

    describe('Ticket #305: End-to-end Gmail Workspace Add-on pre-population and Document submission for Submittal Arch & FF&E', () => {
      beforeEach(() => {
        vi.spyOn(mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-pass2-ticket-305-arch') {
            return {
              id: 'th-pass2-ticket-305-arch',
              messages: [
                {
                  id: 'msg-305-arch-1',
                  threadId: 'th-pass2-ticket-305-arch',
                  subject: 'Submittal 071200-001-A Waterproofing Specs',
                  from: 'James McGovern <jmcgovern@pavarini.com>',
                  to: 'Architect <pm@inc.nyc>',
                  date: 'Tue, 20 Oct 2026 14:00:00 -04:00',
                  labels: ['INBOX', 'Active Projects'],
                  plainTextBody: 'Please find the waterproofing submittal attached for review.',
                  inlineImages: [],
                  attachments: [
                    {
                      partId: 'part-arch-1',
                      attachmentId: 'att-arch-1',
                      filename: '071200-001-A Waterproofing Specs.pdf',
                      mimeType: 'application/pdf',
                      size: 2048,
                    },
                  ],
                },
              ],
            };
          }
          if (threadId === 'th-pass2-ticket-305-ffe') {
            return {
              id: 'th-pass2-ticket-305-ffe',
              messages: [
                {
                  id: 'msg-305-ffe-1',
                  threadId: 'th-pass2-ticket-305-ffe',
                  subject: 'CG104-A Berman Falk King Bed Submittal',
                  from: 'Berman Rep <rep@bermanfalk.com>',
                  to: 'Designer <designer@inc.nyc>, Benjamin West <procurement@benjaminwest.com>',
                  date: 'Wed, 21 Oct 2026 10:00:00 -04:00',
                  labels: ['INBOX', 'Active Projects'],
                  plainTextBody: 'Attached is the CG104 King Bed submittal cut sheet.',
                  inlineImages: [],
                  attachments: [
                    {
                      partId: 'part-ffe-1',
                      attachmentId: 'att-ffe-1',
                      filename: 'CG104-A Berman Falk Cut Sheet.pdf',
                      mimeType: 'application/pdf',
                      size: 1024,
                    },
                  ],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });

        vi.spyOn(mockGmailClient, 'getMessage').mockImplementation(async (messageId: string) => {
          if (messageId === 'msg-305-arch-1') {
            return {
              id: 'msg-305-arch-1',
              messageId: 'msg-305-arch-1',
              inlineImages: [],
              attachments: [
                {
                  partId: 'part-arch-1',
                  attachmentId: 'att-arch-1',
                  filename: '071200-001-A Waterproofing Specs.pdf',
                  mimeType: 'application/pdf',
                  size: 2048,
                },
              ],
            };
          }
          if (messageId === 'msg-305-ffe-1') {
            return {
              id: 'msg-305-ffe-1',
              messageId: 'msg-305-ffe-1',
              inlineImages: [],
              attachments: [
                {
                  partId: 'part-ffe-1',
                  attachmentId: 'att-ffe-1',
                  filename: 'CG104-A Berman Falk Cut Sheet.pdf',
                  mimeType: 'application/pdf',
                  size: 1024,
                },
              ],
            };
          }
          return { id: messageId, messageId, inlineImages: [], attachments: [] };
        });
      });

      it('renders Submittal Arch card with pre-populated compound attachment fields, contact alias, action: REC, and submits document successfully', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-305-arch-1',
              threadId: 'th-pass2-ticket-305-arch',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

        const sectionWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput;
        expect(sectionWidget?.value).toBe('071200');

        const numberWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput;
        expect(numberWidget?.value).toBe('001');

        const revisionWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
        )?.textInput;
        expect(revisionWidget?.value).toBe('A');

        const titleWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch')
        )?.textInput;
        expect(titleWidget?.value).toBe('Waterproofing Specs');

        const dateWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
        )?.textInput;
        expect(dateWidget?.value).toBe('261020');

        const contactWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch')
        )?.textInput;
        expect(contactWidget?.value).toBe('PMG');

        const actionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
        )?.selectionInput;
        const selectedAction = actionWidget?.items?.find((i) => i.selected);
        expect(selectedAction?.value).toBe('REC');

        // Now submit processDocument
        const attachmentBytes = new Uint8Array([1, 2, 3, 4]);
        mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '6 Construction'"))
          .reply(200, {
            files: [{ id: 'const-folder-id', name: '6 Construction', mimeType: 'application/vnd.google-apps.folder' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes('const-folder-id') && q.q.includes("name = 'Submittals'"))
          .reply(200, {
            files: [{ id: 'submittals-folder-id', name: 'Submittals', mimeType: 'application/vnd.google-apps.folder' }],
          });

        nock('https://www.googleapis.com')
          .post('/upload/drive/v3/files')
          .query(true)
          .reply(200, {
            id: 'drive-saved-submittal-arch',
            name: '071200-001-A Waterproofing Specs - 261020 PMG.pdf',
            mimeType: 'application/pdf',
            parents: ['submittals-folder-id'],
            webViewLink: 'https://drive.google.com/file/d/drive-saved-submittal-arch/view',
          });

        const submitRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-305-arch-1',
              threadId: 'th-pass2-ticket-305-arch',
              accessToken: 'ya29.live-token',
            },
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: { action: 'processDocument' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
                SaveEmailToPdf: { stringInputs: { value: ['false'] } },
                [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
                [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
                [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['A'] } },
                [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing Specs'] } },
                [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261020'] } },
                [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
                [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
                [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
              },
            },
          },
        });

        expect(submitRes.statusCode).toBe(200);
        const submitBody = JSON.parse(submitRes.payload) as GoogleWorkspaceActionResponse;
        expect(submitBody.action?.notification?.text).toBe('Document processed successfully');
        expect(nock.isDone()).toBe(true);
      });

      it('renders Submittal FF&E card with pre-populated specTag, auto-derived specTitle, vendor alias, action: REC, and submits document successfully', async () => {
        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-305-ffe-1',
              threadId: 'th-pass2-ticket-305-ffe',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

        const specTagWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe')
        )?.textInput;
        expect(specTagWidget?.value).toBe('CG104');

        const specTitleWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
        )?.textInput;
        expect(specTitleWidget?.value).toBe('BED - KING'); // auto-derived LinkedField!

        const revisionWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe')
        )?.textInput;
        expect(revisionWidget?.value).toBe('A');

        const vendorWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('vendor', 'submittal-ffe')
        )?.textInput;
        expect(vendorWidget?.value).toBe('BM');

        const dateWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-ffe')
        )?.textInput;
        expect(dateWidget?.value).toBe('261021');

        const actionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-ffe')
        )?.selectionInput;
        const selectedAction = actionWidget?.items?.find((i) => i.selected);
        expect(selectedAction?.value).toBe('REC');

        // Now submit processDocument for submittal-ffe
        const attachmentBytes = new Uint8Array([5, 6, 7, 8]);
        mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '3 FFE'"))
          .reply(200, {
            files: [{ id: 'ffe-folder-id', name: '3 FFE', mimeType: 'application/vnd.google-apps.folder' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files')
          .query((q) => typeof q.q === 'string' && q.q.includes('ffe-folder-id') && q.q.includes("name = '05 Submittals'"))
          .reply(200, {
            files: [{ id: 'ffe-submittals-id', name: '05 Submittals', mimeType: 'application/vnd.google-apps.folder' }],
          });

        nock('https://www.googleapis.com')
          .post('/upload/drive/v3/files')
          .query(true)
          .reply(200, {
            id: 'drive-saved-submittal-ffe',
            name: 'CG104-A Berman Falk - 261021 INC.pdf',
            mimeType: 'application/pdf',
            parents: ['ffe-submittals-id'],
            webViewLink: 'https://drive.google.com/file/d/drive-saved-submittal-ffe/view',
          });

        const submitRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-305-ffe-1',
              threadId: 'th-pass2-ticket-305-ffe',
              accessToken: 'ya29.live-token',
            },
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: { action: 'processDocument' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                SelectAttachments: { stringInputs: { value: ['part-ffe-1'] } },
                SaveEmailToPdf: { stringInputs: { value: ['false'] } },
                [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: ['CG104'] } },
                [getDocumentInfoWidgetName('specTitle', 'submittal-ffe')]: { stringInputs: { value: ['BED - KING'] } },
                [getDocumentInfoWidgetName('revision', 'submittal-ffe')]: { stringInputs: { value: ['A'] } },
                [getDocumentInfoWidgetName('vendor', 'submittal-ffe')]: { stringInputs: { value: ['BM'] } },
                [getDocumentInfoWidgetName('date', 'submittal-ffe')]: { stringInputs: { value: ['261021'] } },
                [getDocumentInfoWidgetName('contact', 'submittal-ffe')]: { stringInputs: { value: ['INC'] } },
                [getDocumentInfoWidgetName('action', 'submittal-ffe')]: { stringInputs: { value: ['REC'] } },
                [getDocumentInfoWidgetName('status', 'submittal-ffe')]: { stringInputs: { value: ['Open'] } },
              },
            },
          },
        });

        expect(submitRes.statusCode).toBe(200);
        const submitBody = JSON.parse(submitRes.payload) as GoogleWorkspaceActionResponse;
        expect(submitBody.action?.notification?.text).toBe('Document processed successfully');
        expect(nock.isDone()).toBe(true);
      });

      it('does not fall back to email.from ("INC") for contact on outgoing submittal-arch emails to unregistered external recipients (Spec #6)', async () => {
        vi.spyOn(mockGmailClient, 'getThread').mockResolvedValueOnce({
          id: 'th-spec6-outgoing',
          messages: [
            {
              id: 'msg-spec6-1',
              threadId: 'th-spec6-outgoing',
              subject: '071200-001 Waterproofing Submittal',
              from: 'INC PM <pm@inc.nyc>',
              to: 'colleague@inc.nyc, Stranger <stranger@unknown-vendor.com>',
              date: 'Wed, 21 Oct 2026 10:00:00 GMT',
              labels: ['SENT'],
              inlineImages: [],
              attachments: [
                {
                  partId: 'part-arch-1',
                  attachmentId: 'att-arch-1',
                  filename: '071200-001-A_Waterproofing.pdf',
                  mimeType: 'application/pdf',
                  size: 1024,
                },
              ],
            },
          ],
        });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-spec6-1',
              threadId: 'th-spec6-outgoing',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');
        const contactWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch')
        )?.textInput;
        expect(contactWidget?.value ?? '').toBe('');
      });
    });
  });
});


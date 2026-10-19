import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import type { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';

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

    // Section 2: File Selection (non-collapsible, SelectFileSource dropdown, empty text, SaveEmailToPdf)
    const fileSelectionSection = sections.find((s) => s.header === 'File Selection');
    expect(fileSelectionSection).toBeDefined();
    expect(fileSelectionSection?.collapsible).toBe(false);
    expect(fileSelectionSection?.widgets).toHaveLength(3);
    expect(fileSelectionSection?.widgets[0].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSelectionSection?.widgets[0].selectionInput?.type).toBe('DROPDOWN');
    expect(fileSelectionSection?.widgets[1].textParagraph?.text).toBe('No attachments found.');
    expect(fileSelectionSection?.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
    expect(fileSelectionSection?.widgets[2].selectionInput?.type).toBe('SWITCH');
    expect(fileSelectionSection?.widgets[2].selectionInput?.items).toEqual([
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
    expect(fileSection?.widgets[0].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSection?.widgets[1].textParagraph?.text).toBe('No attachments found.');
    expect(fileSection?.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
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
    expect(fileSection?.widgets).toHaveLength(3);
    expect(fileSection?.widgets[0].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSection?.widgets[0].selectionInput?.type).toBe('DROPDOWN');
    expect(fileSection?.widgets[1].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSection?.widgets[1].selectionInput?.items).toHaveLength(2);
    expect(fileSection?.widgets[1].selectionInput?.items[0]).toEqual({
      text: 'Invoice.pdf',
      value: 'att-1',
      selected: true,
    });
    expect(fileSection?.widgets[1].selectionInput?.items[1]).toEqual({
      text: 'Statement.pdf',
      value: 'att-2',
      selected: true,
    });
    expect(fileSection?.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
    expect(mockGmailClient.getMessage).toHaveBeenCalledWith('msg-with-live-attachments', {
      auth: 'ya29.live-token',
    });
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
    expect(fileSecInitial.widgets[0].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSecInitial.widgets[0].selectionInput?.items?.[0]).toEqual({
      text: 'Email Attachments',
      value: 'Email Attachments',
      selected: true,
    });
    expect(fileSecInitial.widgets[1].selectionInput?.name).toBe('SelectAttachments');

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

    // Widget 0: Dropdown with Google Drive URL active
    expect(fileSecDrive.widgets[0].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSecDrive.widgets[0].selectionInput?.items?.[1]).toEqual({
      text: 'Google Drive URL',
      value: 'Google Drive URL',
      selected: true,
    });

    // Widget 1: InputDriveURL text input is swapped in!
    expect(fileSecDrive.widgets[1].textInput).toBeDefined();
    expect(fileSecDrive.widgets[1].textInput?.name).toBe('InputDriveURL');
    expect(fileSecDrive.widgets[1].textInput?.label).toBe('Google Drive URL');
    expect(fileSecDrive.widgets[1].textInput?.value).toBe('');

    // Widget 2: SaveEmailToPdf SWITCH
    expect(fileSecDrive.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');

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
            previousAttachments: JSON.stringify(['att-1']),
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

    // Widget 0: Dropdown with Email Attachments active
    expect(fileSecEmail.widgets[0].selectionInput?.name).toBe('SelectFileSource');
    expect(fileSecEmail.widgets[0].selectionInput?.items?.[0]).toEqual({
      text: 'Email Attachments',
      value: 'Email Attachments',
      selected: true,
    });
    // parameters preserved the previousDriveUrl
    const onChangeParams = fileSecEmail.widgets[0].selectionInput?.onChangeAction?.parameters;
    const previousDriveUrlParam = onChangeParams?.find((p: { key: string }) => p.key === 'previousDriveUrl')?.value;
    expect(previousDriveUrlParam).toBe(testDriveUrl);

    // Widget 1: SelectAttachments checkboxes restored with att-1 checked and att-2 unchecked!
    expect(fileSecEmail.widgets[1].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSecEmail.widgets[1].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-1', selected: true },
      { text: 'Statement.pdf', value: 'att-2', selected: false },
    ]);

    // Widget 2: SaveEmailToPdf SWITCH
    expect(fileSecEmail.widgets[2].selectionInput?.name).toBe('SaveEmailToPdf');
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
            SelectAttachments: { stringInputs: { value: ['att-2'] } },
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
    expect(fileSec.widgets[1].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSec.widgets[1].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-1', selected: false },
      { text: 'Statement.pdf', value: 'att-2', selected: true },
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
    expect(fileSec.widgets[1].selectionInput?.name).toBe('SelectAttachments');
    expect(fileSec.widgets[1].selectionInput?.items).toEqual([
      { text: 'Invoice.pdf', value: 'att-1', selected: false },
      { text: 'Statement.pdf', value: 'att-2', selected: false },
    ]);
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
});


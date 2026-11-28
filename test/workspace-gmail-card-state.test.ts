import { describe, it, expect, vi } from 'vitest';
import nock from 'nock';
import { Value } from '@sinclair/typebox/value';
import {
  GoogleWorkspaceActionResponseSchema,
  type GoogleWorkspaceActionResponse,
  type GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import {
  setupWorkspaceGmailIntegrationSuite,
  mockDocumentLogSearch,
  mockDynamicValidationProject,
} from './utils/workspace-gmail-test-helper';

describe('Workspace Gmail Card Lifecycle, Auth & State Preservation Integration', () => {
  const ctx = setupWorkspaceGmailIntegrationSuite();
  it('rejects POST /workspace/gmail-contextual without auth with 401', async () => {
    const res = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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
    expect(ctx.mockGmailClient.getMessage).toHaveBeenCalledWith(
      'msg-with-live-attachments',
      expect.objectContaining({
        auth: 'ya29.live-token',
      })
    );
  });

  it('simulates switching from Email Attachments to Google Drive URL, entering URL, switching back, and verifying state retention and updateCard', async () => {
    // Step 1: Initial trigger with 2 live attachments
    const resInitial = await ctx.app.server.inject({
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
    const resSwitchToDrive = await ctx.app.server.inject({
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
    const resSwitchBack = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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
    const resStep1 = await ctx.app.server.inject({
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
    const resStep2 = await ctx.app.server.inject({
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
    const resStep3 = await ctx.app.server.inject({
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
    const resStep1 = await ctx.app.server.inject({
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
    const resStep2 = await ctx.app.server.inject({
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
    const resStep3 = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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
    const originalRead = ctx.manifestProvider.readParsedSchema.bind(ctx.manifestProvider);
    vi.spyOn(ctx.manifestProvider, 'readParsedSchema').mockImplementation(async (relPath: string) => {
      const parsed = (await originalRead(relPath)) as Record<string, unknown>;
      return {
        ...parsed,
        allowEmptySourceFiles: false,
      };
    });

    const response = await ctx.app.server.inject({
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
    const res = await ctx.app.server.inject({
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

    const response = await ctx.app.server.inject({
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
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
    expect(body.action?.notification).toBeUndefined();
    expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');
    expect(nock.isDone()).toBe(true);
  });

  it('rejects zero files in Gmail context when allowEmptySourceFiles is false or omitted with message "Please select at least one file to process or enable Save Email to PDF."', async () => {
    const originalRead = ctx.manifestProvider.readParsedSchema.bind(ctx.manifestProvider);
    vi.spyOn(ctx.manifestProvider, 'readParsedSchema').mockImplementation(async (relPath: string) => {
      const parsed = (await originalRead(relPath)) as Record<string, unknown>;
      return {
        ...parsed,
        allowEmptySourceFiles: false,
      };
    });

    const response = await ctx.app.server.inject({
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


  describe('Initial-load SelectAttachments preservation across Pass 1 routing mutations', () => {
    it('renders SelectAttachments checkboxes selected: true and populates previousAttachments on dropdown onChangeAction parameters when Pass 1 infers projects + space + submittal-arch', async () => {
      const attachments = [
        {
          partId: 'part-init-1',
          attachmentId: 'att-init-1',
          filename: '071200-001-A Waterproofing Specs.pdf',
          mimeType: 'application/pdf',
          size: 2048,
        },
        {
          partId: 'part-init-2',
          attachmentId: 'att-init-2',
          filename: 'Cover_Notes.pdf',
          mimeType: 'application/pdf',
          size: 1024,
        },
      ];

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValue({
        id: 'th-initial-pass1-sel',
        messages: [
          {
            id: 'msg-initial-pass1-sel',
            threadId: 'th-initial-pass1-sel',
            subject: 'Submittal 071200-001-A Waterproofing Specs',
            from: 'James McGovern <jmcgovern@pavarini.com>',
            to: 'Architect <pm@inc.nyc>',
            date: 'Tue, 20 Oct 2026 14:00:00 -04:00',
            labels: ['INBOX', 'Active Projects'],
            plainTextBody: 'Please find the waterproofing submittal attached.',
            inlineImages: [],
            attachments,
          },
        ],
      });

      vi.spyOn(ctx.mockGmailClient, 'getMessage').mockResolvedValue({
        id: 'msg-initial-pass1-sel',
        messageId: 'msg-initial-pass1-sel',
        inlineImages: [],
        attachments,
      });

      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-initial-pass1-sel',
            threadId: 'th-initial-pass1-sel',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const pushCard = body.action?.navigations?.[0]?.pushCard;
      expect(pushCard).toBeDefined();

      const docTypeSec = pushCard!.sections.find((s) => s.header === 'Document Type')!;
      expect(
        docTypeSec.widgets[0].selectionInput?.items.find((i) => i.selected)?.value
      ).toBe('projects');
      expect(docTypeSec.widgets[1].textInput?.value).toBe('Active Projects');
      expect(
        docTypeSec.widgets[2].selectionInput?.items.find((i) => i.selected)?.value
      ).toBe('submittal-arch');

      const fileSec = pushCard!.sections.find((s) => s.header === 'File Selection')!;
      const selectAttachments = fileSec.widgets.find(
        (w) => w.selectionInput?.name === 'SelectAttachments'
      )?.selectionInput;
      expect(selectAttachments?.items).toEqual([
        { text: '071200-001-A Waterproofing Specs.pdf', value: 'part-init-1', selected: true },
        { text: 'Cover_Notes.pdf', value: 'part-init-2', selected: true },
      ]);

      const expectedPrevAttachments = JSON.stringify(['part-init-1', 'part-init-2']);
      const getPrevAttachmentsParam = (
        params?: Array<{ key: string; value: string }>
      ) => params?.find((p) => p.key === 'previousAttachments')?.value;

      const spaceTypeParams = docTypeSec.widgets[0].selectionInput?.onChangeAction?.parameters;
      const docTypeParams = docTypeSec.widgets[2].selectionInput?.onChangeAction?.parameters;
      const fileSourceParams = fileSec.widgets
        .find((w) => w.selectionInput?.name === 'SelectFileSource')
        ?.selectionInput?.onChangeAction?.parameters;

      expect(getPrevAttachmentsParam(spaceTypeParams)).toBe(expectedPrevAttachments);
      expect(getPrevAttachmentsParam(docTypeParams)).toBe(expectedPrevAttachments);
      expect(getPrevAttachmentsParam(fileSourceParams)).toBe(expectedPrevAttachments);
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import nock from 'nock';
import { Value } from '@sinclair/typebox/value';
import { createApp } from '../src/app/server';
import { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
// nosemgrep: adapter-leakage-warning
import { google, type gmail_v1 } from 'googleapis';
import {
  GoogleWorkspaceActionResponseSchema,
  type GoogleWorkspaceActionResponse,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { PdfProcessor } from '../src/infrastructure/pdf/pdf-processor';
import {
  setupWorkspaceGmailIntegrationSuite,
  mockDynamicValidationProject,
} from './utils/workspace-gmail-test-helper';

describe('Workspace Gmail Thread Switching & Caching Integration', () => {
  const ctx = setupWorkspaceGmailIntegrationSuite();
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
        manifestProvider: ctx.manifestProvider,
        authVerifier: ctx.mockAuthVerifier,
        skipSpaceValidation: true,
        storageAdapter: ctx.mockStorageAdapter,
        gmailClient: memoizedGmailClient,
      });
      await testApp.initialize();
      try {
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
        expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
        expect(body.action?.notification).toBeUndefined();
        expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

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

        expect(nock.isDone()).toBe(true);
      } finally {
        gmailSpy.mockRestore();
        await testApp.server.stop();
      }
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
        manifestProvider: ctx.manifestProvider,
        authVerifier: ctx.mockAuthVerifier,
        skipSpaceValidation: true,
        storageAdapter: ctx.mockStorageAdapter,
        gmailClient: memoizedGmailClient,
      });
      await testApp.initialize();
      try {
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
        expect(Value.Check(GoogleWorkspaceActionResponseSchema, actionBody)).toBe(true);
        expect(actionBody.action?.notification).toBeUndefined();
        expect(actionBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

        // Across both the on-form-change and processDocument with hydrator + UI manager, users.messages.get was called ONLY ONCE!
        expect(mockMessagesGet).toHaveBeenCalledTimes(1);

        expect(nock.isDone()).toBe(true);
      } finally {
        gmailSpy.mockRestore();
        await testApp.server.stop();
      }
    });
  });

  describe('Reactive email switching and cross-action persistence (Ticket #211)', () => {
    it('switches emails with onEmailMessageChange, resets attachments to all selected, and persists choice across other in-card actions', async () => {
      // Step 1: Initial load on multi-message thread with msg-email-1
      const resInitial = await ctx.app.server.inject({
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
      const resSwitch = await ctx.app.server.inject({
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
      const resSpaceChange = await ctx.app.server.inject({
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
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Crucial: getAttachment was called with the selected email ID (msg-email-2) rather than initial trigger (msg-email-1)
      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(
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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

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
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);
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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Attachment downloaded from msg-email-2
      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(
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
      expect(ctx.mockGmailClient.getThread).toHaveBeenCalledWith(
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
        manifestProvider: ctx.manifestProvider,
        authVerifier: ctx.mockAuthVerifier,
        skipSpaceValidation: true,
        storageAdapter: ctx.mockStorageAdapter,
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
        expect(Value.Check(GoogleWorkspaceActionResponseSchema, processBody)).toBe(true);
        expect(processBody.action?.notification).toBeUndefined();
        expect(processBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

        // The critical assertion: users.messages.get was called 0 times because getThread pre-warmed msg-cached-2 in cache!
        expect(mockMessagesGet).toHaveBeenCalledTimes(0);
        expect(mockThreadGet).toHaveBeenCalledTimes(2);
        expect(mockAttachmentsGet).toHaveBeenCalledTimes(1);
        expect(nock.isDone()).toBe(true);
      } finally {
        gmailSpy.mockRestore();
        await cachingApp.server.stop();
      }
    });
  });
});

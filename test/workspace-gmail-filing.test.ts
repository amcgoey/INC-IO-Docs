import { describe, it, expect, vi } from 'vitest';
import nock from 'nock';
import { Value } from '@sinclair/typebox/value';
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

describe('Workspace Gmail Filing Integration (Drive URL, Attachments, SaveEmailToPdf & Inline)', () => {
  const ctx = setupWorkspaceGmailIntegrationSuite();
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
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');
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
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');
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
      const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');
      expect(nock.isDone()).toBe(true);
    });

    it('aborts with "Invalid Google Drive URL. Please enter a valid Google Drive file or folder link." preserving inputs when URL is malformed', async () => {
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
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Verify attachment was downloaded from Gmail preserving metadata
      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(
        'msg-with-live-attachments',
        'att-1',
        { auth: 'ya29.valid-oauth-token' }
      );
    });

    it('pre-validation guard: aborts when document validation fails, asserting ZERO calls to gmailClient.getAttachment and ZERO Drive mutations', async () => {
      ctx.mockGmailClient.getAttachment = vi.fn();

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
      expect(ctx.mockGmailClient.getAttachment).not.toHaveBeenCalled();

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
      ctx.mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
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
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(samplePng);

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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Verify inline CID image was downloaded
      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(
        messageId,
        'att-inline-chart',
        { auth: 'ya29.valid-oauth-token' }
      );
      expect(nock.isDone()).toBe(true);
    });

    it('falls back to "Email - <messageId>.pdf" when subject is blank or whitespace', async () => {
      mockFolderResolution();

      const messageId = 'msg-save-pdf-blank-subject';
      ctx.mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');
      expect(nock.isDone()).toBe(true);
    });

    it('files communication-project with checked SelectAttachments AND SaveEmailToPdf = true, saving both into the same folder', async () => {
      mockFolderResolution();

      const messageId = 'msg-combo-att-pdf';
      const attachmentBytes = new Uint8Array([11, 22, 33]);
      ctx.mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
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
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Verify attachment was downloaded
      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(
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

      ctx.mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');
      expect(nock.isDone()).toBe(true);
    });

    it('pre-validation guard: aborts when document validation fails with SaveEmailToPdf = true, asserting ZERO calls to generateEmailPdf and ZERO Drive mutations', async () => {
      const generateEmailPdfSpy = vi.spyOn(PdfProcessor.prototype, 'generateEmailPdf');
      ctx.mockGmailClient.getAttachment = vi.fn();

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
      expect(ctx.mockGmailClient.getAttachment).not.toHaveBeenCalled();

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
      ctx.mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => {
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
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(auditPdfBytes);

      // --- Step 1: Initial load POST /workspace/gmail-contextual ---
      const resContextual = await ctx.app.server.inject({
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
      const resFormChange = await ctx.app.server.inject({
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

      const resAction = await ctx.app.server.inject({
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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, bodyAction)).toBe(true);
      expect(bodyAction.action?.notification).toBeUndefined();
      expect(bodyAction.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Crucial: getAttachment must have been called with the freshest token from the hydration fetch!
      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(
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

      ctx.mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => ({
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

      ctx.mockGmailClient.getAttachment = vi.fn().mockImplementation(async (_msgId: string, attId: string) => {
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

      const response = await ctx.app.server.inject({
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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(messageId, 'fresh-token-inv-1', expect.anything());
      expect(ctx.mockGmailClient.getAttachment).toHaveBeenCalledWith(messageId, 'fresh-token-inv-2', expect.anything());
      expect(nock.isDone()).toBe(true);
    });

    it('moves Drive item and saves Email PDF without downloading or substituting email attachment when Drive URL has identical filename', async () => {
      mockFolderResolution('Signed Contract');

      const messageId = 'msg-colliding-name';
      const driveFileId = 'drive-colliding-123';
      const collidingFilename = 'Contract.pdf';

      ctx.mockGmailClient.getMessage = vi.fn().mockImplementation(async (msgId: string) => ({
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
      ctx.mockGmailClient.getAttachment = vi.fn();

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

      const response = await ctx.app.server.inject({
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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Crucial: getAttachment should NOT have been called for the email attachment!
      expect(ctx.mockGmailClient.getAttachment).not.toHaveBeenCalled();
      expect(nock.isDone()).toBe(true);
    });

    it('aborts with "Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again." when getAttachment fails, preserving target folder and form inputs', async () => {
      mockFolderResolution('Meeting Notes');

      ctx.mockGmailClient.getAttachment = vi.fn().mockRejectedValue(new Error('Gmail API attachment download failed'));

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

      ctx.mockGmailClient.getMessage = vi.fn().mockResolvedValue({
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

      const res = await ctx.app.server.inject({
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

      ctx.mockGmailClient.getMessage = vi.fn().mockResolvedValue({
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

      ctx.mockGmailClient.getAttachment = vi.fn();

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
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification).toBeUndefined();
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Communication Project Filed');

      // Crucial assertion: getAttachment must NOT have been called!
      expect(ctx.mockGmailClient.getAttachment).not.toHaveBeenCalled();

      // Check uploaded bytes
      expect(uploadedPayload).toBeDefined();
      expect(uploadedPayload!.includes(Buffer.from(inlineData))).toBe(true);

      expect(nock.isDone()).toBe(true);
    });
  });
});

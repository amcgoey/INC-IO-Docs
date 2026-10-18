import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';

describe('Workspace-to-Drive E2E Integration (Ticket #171 Tracer Bullet)', () => {
  let app: AppInstance;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockStorageAdapter: DocumentSpaceStoragePort;

  beforeEach(async () => {
    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return {
            isValid: true,
            payload: { email: 'test-user@example.com', sub: 'user-123' },
          };
        }
        return {
          isValid: false,
          error: 'Invalid ID token signature',
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
    });

    await app.initialize();
  });

  afterEach(() => {
    nock.cleanAll();
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

  function mockDynamicValidationProposal({
    oppFolderId,
    commFolderId,
    contactFolderId,
    contactName,
  }: {
    oppFolderId: string;
    commFolderId: string;
    contactFolderId: string;
    contactName: string;
  }) {
    // resolveTargetFolder step 1: list folders in opp folder root
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${oppFolderId}' in parents`) && !q.q.includes('name ='))
      .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

    // executeValidationQuery: check contact folder exists
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${commFolderId}' in parents`) && q.q.includes(`name = '${contactName}'`))
      .reply(200, { files: [{ id: contactFolderId, name: contactName }] });
  }

  describe('Driving Adapter: POST /workspace/drive-items-selected', () => {
    it('returns a DriveDocumentProcessCard when authorized and items are selected', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.sample-token',
          },
          drive: {
            selectedItems: [
              {
                id: 'file-123',
                title: 'Contract_Agreement.pdf',
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);

      expect(cardResponse.action).toBeDefined();
      const pushCard = cardResponse.action.navigations[0].pushCard;
      expect(pushCard.header.title).toBe('INC-IO Engine');
      expect(pushCard.sections[0].header).toBe('Document Type');
    });

    it('returns 401 Unauthorized when JWT token is invalid or missing', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
    });

    it('returns drive document process card even when userOAuthToken is missing', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          drive: {
            selectedItems: [
              {
                id: 'file-123',
                title: 'Contract_Agreement.pdf',
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action?.navigations).toBeDefined();
      expect(body.action.navigations[0].pushCard.header.title).toBe('INC-IO Engine');
    });
  });

  describe('Driving Adapter: POST /workspace/action (processDocument)', () => {
    it('files communication-project into existing <contact> folder under projects Shared Drive space', async () => {
      const fileId = 'file-proj-123';
      const fileName = 'Site_Meeting_Notes.docx';
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
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. DriveActivityHandler: findOrCreateFolder(commFolderId, 'Acme Corp') -> exists
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, { files: [{ id: contactFolderId, name: 'Acme Corp' }] });

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

      // 5. DriveActivityHandler: move(fileId, newSubfolderId)
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: ['initial-inbox-folder'],
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [newSubfolderId],
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
          drive: {
            selectedItems: [
              {
                id: fileId,
                title: fileName,
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              },
            ],
          },
          commonEventObject: {
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

    it('files communication-proposal into existing <contact> folder under proposals Opportunity folder space', async () => {
      const fileId = 'file-prop-456';
      const fileName = 'RFP_Proposal_Response.pdf';
      const rootOppFolderId = 'folder-opp-root';
      const commFolderId = 'folder-prop-comm-1';
      const contactFolderId = 'folder-beta-arch';
      const newSubfolderId = 'folder-rfp-subfolder';

      // 1. Dynamic Options Validation
      mockDynamicValidationProposal({
        oppFolderId: rootOppFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Beta Architects',
      });

      // 2. DriveActivityHandler: resolveFolderPath('folder-opp-root', ['Communication'])
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootOppFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. DriveActivityHandler: findOrCreateFolder(commFolderId, 'Beta Architects') -> exists
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Beta Architects'"))
        .reply(200, { files: [{ id: contactFolderId, name: 'Beta Architects' }] });

      // 4. DriveActivityHandler: findOrCreateFolder(contactFolderId, '260715 OT - RFP Response') -> creates new
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260715 OT - RFP Response'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260715 OT - RFP Response',
          parents: [contactFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });

      // 5. DriveActivityHandler: move(fileId, newSubfolderId)
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: ['initial-inbox-folder'],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: fileName,
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
          drive: {
            selectedItems: [
              {
                id: fileId,
                title: fileName,
                mimeType: 'application/pdf',
              },
            ],
          },
          commonEventObject: {
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
              [getDocumentSpaceWidgetName('proposals')]: { stringInputs: { value: ['Client Proposals'] } },
              [getDocumentTypeWidgetName('proposals')]: { stringInputs: { value: ['communication-proposal'] } },
              [getDocumentInfoWidgetName('contact', 'communication-proposal')]: { stringInputs: { value: ['Beta Architects'] } },
              [getDocumentInfoWidgetName('date', 'communication-proposal')]: { stringInputs: { value: ['260715'] } },
              [getDocumentInfoWidgetName('direction', 'communication-proposal')]: { stringInputs: { value: ['OT'] } },
              [getDocumentInfoWidgetName('description', 'communication-proposal')]: { stringInputs: { value: ['RFP Response'] } },
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

    it('reuses existing subfolder when filing into already-created commFolderName folder', async () => {
      const fileId = 'file-reuse-123';
      const fileName = 'Followup.docx';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';
      const existingSubfolderId = 'folder-existing-comm';

      // 1. Dynamic validation
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      // 2. resolveFolderPath
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. findOrCreateFolder contact
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, { files: [{ id: contactFolderId, name: 'Acme Corp' }] });

      // 4. findOrCreateFolder comm folder -> ALREADY EXISTS! No POST /drive/v3/files!
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, {
          files: [{ id: existingSubfolderId, name: '260920 IN - Meeting Notes' }],
        });

      // 5. move
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: ['initial-inbox-folder'],
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [existingSubfolderId],
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
          drive: {
            selectedItems: [
              {
                id: fileId,
                title: fileName,
              },
            ],
          },
          commonEventObject: {
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

    it('returns pre-submit validation error card when submitting processDocument with zero selected files', async () => {
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
          drive: {
            selectedItems: [],
          },
          commonEventObject: {
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
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard.sections.find((s: { widgets?: Array<{ textParagraph?: { text?: string } }> }) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Please select at least one file in Google Drive to process.'))
      );
      expect(errorSection).toBeDefined();
    });

    it('returns error card when parentPath segment is missing (FileNotFoundError)', async () => {
      const fileId = 'file-missing-parent';
      const fileName = 'Doc.pdf';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';

      // 1. Dynamic validation succeeds
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      // 2. resolveFolderPath fails on segment 'Communication'
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [] });

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
          drive: {
            selectedItems: [{ id: fileId, title: fileName }],
          },
          commonEventObject: {
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
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard.sections.find((s: { widgets?: Array<{ textParagraph?: { text?: string } }> }) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes("Folder segment 'Communication' not found under parent"))
      );
      expect(errorSection).toBeDefined();
    });

    it('returns error card when parentPath segment has multiple matching folders (AmbiguousPathSpecError)', async () => {
      const fileId = 'file-ambiguous-parent';
      const fileName = 'Doc.pdf';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';

      // 1. Dynamic validation succeeds
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      // 2. resolveFolderPath returns 2 matches for 'Communication'
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, {
          files: [
            { id: 'folder-comm-dup-1', name: 'Communication' },
            { id: 'folder-comm-dup-2', name: 'Communication' },
          ],
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
          drive: {
            selectedItems: [{ id: fileId, title: fileName }],
          },
          commonEventObject: {
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
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard.sections.find((s: { widgets?: Array<{ textParagraph?: { text?: string } }> }) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('AmbiguousPathSpecError'))
      );
      expect(errorSection).toBeDefined();
    });

    it('handles Google Drive API error during move gracefully and returns error card', async () => {
      const fileId = 'file-error-500';
      const fileName = 'Contract.docx';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';
      const subfolderId = 'folder-meeting-sub';

      // 1. Dynamic validation
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      // 2. resolveFolderPath
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. findOrCreateFolder contact
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, { files: [{ id: contactFolderId, name: 'Acme Corp' }] });

      // 4. findOrCreateFolder comm folder
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [{ id: subfolderId, name: '260920 IN - Meeting Notes' }] });

      // 5. move fails on files.get with 403 Forbidden
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}`)
        .query(true)
        .reply(403, {
          error: {
            code: 403,
            message: 'User does not have permission to move this file',
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
          drive: {
            selectedItems: [{ id: fileId, title: fileName }],
          },
          commonEventObject: {
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
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard.sections.find((s: { widgets?: Array<{ textParagraph?: { text?: string } }> }) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Drive service error (403) in move'))
      );
      expect(errorSection).toBeDefined();
    });

    it('files multiple selected SourceFiles in a single submission into the resolved communication subfolder preserving filenames', async () => {
      const file1Id = 'file-batch-1';
      const file1Name = 'Architectural_Plans.pdf';
      const file2Id = 'file-batch-2';
      const file2Name = 'Engineering_Calculations.pdf';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';
      const newSubfolderId = 'folder-batch-meeting-sub';

      // 1. Dynamic validation
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      // 2. resolveFolderPath
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. findOrCreateFolder contact
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, { files: [{ id: contactFolderId, name: 'Acme Corp' }] });

      // 4. findOrCreateFolder comm folder (creates new)
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

      // 5. move file 1
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${file1Id}`)
        .query(true)
        .reply(200, {
          id: file1Id,
          name: file1Name,
          parents: ['initial-inbox-folder'],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file1Id}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${file1Id}`)
        .query(true)
        .reply(200, {
          id: file1Id,
          name: file1Name,
          parents: [newSubfolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file1Id}/view`,
        });

      // 6. move file 2
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${file2Id}`)
        .query(true)
        .reply(200, {
          id: file2Id,
          name: file2Name,
          parents: ['initial-inbox-folder'],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file2Id}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${file2Id}`)
        .query(true)
        .reply(200, {
          id: file2Id,
          name: file2Name,
          parents: [newSubfolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file2Id}/view`,
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
          drive: {
            selectedItems: [
              { id: file1Id, title: file1Name, mimeType: 'application/pdf' },
              { id: file2Id, title: file2Name, mimeType: 'application/pdf' },
            ],
          },
          commonEventObject: {
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

    it('halts immediately on partial failure during batch filing, returning error card while earlier file remains moved', async () => {
      const file1Id = 'file-partial-1';
      const file1Name = 'First_File.pdf';
      const file2Id = 'file-partial-2';
      const file2Name = 'Second_File_Fails.pdf';
      const file3Id = 'file-partial-3';
      const file3Name = 'Third_File_Never_Called.pdf';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';
      const subfolderId = 'folder-batch-meeting-sub';

      // 1. Dynamic validation
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      // 2. resolveFolderPath
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. findOrCreateFolder contact
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, { files: [{ id: contactFolderId, name: 'Acme Corp' }] });

      // 4. findOrCreateFolder comm folder (already exists or creates)
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [{ id: subfolderId, name: '260920 IN - Meeting Notes' }] });

      // 5. move file 1 succeeds
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${file1Id}`)
        .query(true)
        .reply(200, {
          id: file1Id,
          name: file1Name,
          parents: ['initial-inbox-folder'],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file1Id}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${file1Id}`)
        .query(true)
        .reply(200, {
          id: file1Id,
          name: file1Name,
          parents: [subfolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file1Id}/view`,
        });

      // 6. move file 2 fails with 403 Forbidden on files.get
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${file2Id}`)
        .query(true)
        .reply(403, {
          error: {
            code: 403,
            message: 'User does not have permission to move file 2',
          },
        });

      // file 3 is never called!

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
          drive: {
            selectedItems: [
              { id: file1Id, title: file1Name },
              { id: file2Id, title: file2Name },
              { id: file3Id, title: file3Name },
            ],
          },
          commonEventObject: {
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
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const errorSection = updateCard.sections.find((s: { widgets?: Array<{ textParagraph?: { text?: string } }> }) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Drive service error (403) in move'))
      );
      expect(errorSection).toBeDefined();
      expect(nock.isDone()).toBe(true);
    });

    it('allows idempotent retry after partial failure, skipping already-moved file and completing remaining file', async () => {
      const file1Id = 'file-retry-1';
      const file1Name = 'First_File_Already_Moved.pdf';
      const file2Id = 'file-retry-2';
      const file2Name = 'Second_File_Retried.pdf';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';
      const subfolderId = 'folder-batch-meeting-sub';

      // 1. Dynamic validation
      mockDynamicValidationProject({
        sharedDriveId: rootSharedDriveId,
        adminFolderId,
        commFolderId,
        contactFolderId,
        contactName: 'Acme Corp',
      });

      // 2. resolveFolderPath
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. findOrCreateFolder contact
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes("name = 'Acme Corp'"))
        .reply(200, { files: [{ id: contactFolderId, name: 'Acme Corp' }] });

      // 4. findOrCreateFolder comm folder (finds existing subfolder created during previous attempt)
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(contactFolderId) && q.q.includes("name = '260920 IN - Meeting Notes'"))
        .reply(200, { files: [{ id: subfolderId, name: '260920 IN - Meeting Notes' }] });

      // 5. move file 1: file already has subfolderId in parents, so getFile returns it and NO patch request is issued!
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${file1Id}`)
        .query(true)
        .reply(200, {
          id: file1Id,
          name: file1Name,
          parents: [subfolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file1Id}/view`,
        });

      // 6. move file 2: moves normally to subfolderId
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${file2Id}`)
        .query(true)
        .reply(200, {
          id: file2Id,
          name: file2Name,
          parents: ['initial-inbox-folder'],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file2Id}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${file2Id}`)
        .query(true)
        .reply(200, {
          id: file2Id,
          name: file2Name,
          parents: [subfolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${file2Id}/view`,
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
          drive: {
            selectedItems: [
              { id: file1Id, title: file1Name },
              { id: file2Id, title: file2Name },
            ],
          },
          commonEventObject: {
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
  });
});

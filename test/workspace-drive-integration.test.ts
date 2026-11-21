import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import { mockAllowedDocumentTypes } from './utils/manifest-test-helper';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { GoogleDriveClient, GoogleDriveApiError } from '../src/infrastructure/drive/drive-client';

describe('Workspace-to-Drive E2E Integration (Ticket #171 Tracer Bullet)', () => {
  let app: AppInstance;
  let manifestProvider: AppManifestProvider;
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
            {
              id: 'projects-shared-drive-001',
              typeId: 'projects',
              name: 'Projects Shared Drive 001',
              abstractStorageId: 'projects-shared-drive-001',
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
      .reply(200, { files: [{ id: commFolderId, name: 'Communications' }] });

    // executeValidationQuery: check contact folder exists
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${commFolderId}' in parents`) && q.q.includes(`name = '${contactName}'`))
      .reply(200, { files: [{ id: contactFolderId, name: contactName }] });
  }

  describe('Driving Adapter: POST /workspace/drive-items-selected', () => {
    it('returns a DriveDocumentProcessCard when authorized and items are selected', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-123')
        .query(true)
        .reply(200, {
          id: 'file-123',
          name: 'Contract_Agreement.pdf',
          parents: ['root'],
        });

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
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-123')
        .query(true)
        .reply(200, {
          id: 'file-123',
          name: 'Contract_Agreement.pdf',
          parents: ['root'],
        });

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

    it('infers Space and DocumentType from folder hierarchy on drive-items-selected', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(async (fileId: string) => {
        if (fileId === 'file-proj-doc') {
          return {
            id: 'file-proj-doc',
            name: 'Meeting_Notes.docx',
            parents: ['folder-comm-1'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/vnd.google-apps.document',
          };
        }
        if (fileId === 'folder-comm-1') {
          return {
            id: 'folder-comm-1',
            name: 'Communication',
            parents: ['folder-admin-1'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/vnd.google-apps.folder',
          };
        }
        if (fileId === 'folder-admin-1') {
          return {
            id: 'folder-admin-1',
            name: '1 Admin',
            parents: ['shared-drive-proj-root'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/vnd.google-apps.folder',
          };
        }
        return {
          id: fileId,
          name: fileId,
          parents: [],
        };
      });

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
                id: 'file-proj-doc',
                title: 'Meeting_Notes.docx',
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);
      expect(cardResponse.action).toBeDefined();
      const pushCard = cardResponse.action.navigations[0].pushCard;

      const cardJson = JSON.stringify(pushCard);
      expect(cardJson).not.toContain('notFoundError');
      expect(cardJson).toContain('communication-project');
      expect(cardJson).toContain('Active Projects');
    });

    it('infers submittal-arch from CSI filename in unmatched folder on drive-items-selected (Ticket #291)', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(async (fileId: string) => {
        if (fileId === 'file-csi-unfiled') {
          return {
            id: 'file-csi-unfiled',
            name: '071200-001_Waterproofing.pdf',
            parents: ['folder-unfiled'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/pdf',
          };
        }
        if (fileId === 'folder-unfiled') {
          return {
            id: 'folder-unfiled',
            name: 'Unfiled Documents',
            parents: ['shared-drive-proj-root'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/vnd.google-apps.folder',
          };
        }
        return { id: fileId, name: fileId, parents: [] };
      });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.sample-token' },
          drive: {
            selectedItems: [
              { id: 'file-csi-unfiled', title: '071200-001_Waterproofing.pdf' },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);
      const pushCard = cardResponse.action.navigations[0].pushCard;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-arch');
      expect(cardJson).toContain('Active Projects');
    });

    it('resolves shortcut target hierarchy and drive on drive-items-selected (Ticket #291)', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(async (fileId: string) => {
        if (fileId === 'shortcut-ffe-1') {
          return {
            id: 'shortcut-ffe-1',
            name: 'Shortcut to Chairs.pdf',
            mimeType: 'application/vnd.google-apps.shortcut',
            parents: ['root'],
            shortcutDetails: {
              targetId: 'target-chair-doc',
              targetMimeType: 'application/pdf',
            },
          };
        }
        if (fileId === 'target-chair-doc') {
          return {
            id: 'target-chair-doc',
            name: 'CG104-A_Chair.pdf',
            parents: ['folder-ffe-sub'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/pdf',
          };
        }
        if (fileId === 'folder-ffe-sub') {
          return {
            id: 'folder-ffe-sub',
            name: '3 FFE',
            parents: ['shared-drive-proj-root'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/vnd.google-apps.folder',
          };
        }
        return { id: fileId, name: fileId, parents: [] };
      });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.sample-token' },
          drive: {
            selectedItems: [
              { id: 'shortcut-ffe-1', title: 'Shortcut to Chairs.pdf' },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);
      const pushCard = cardResponse.action.navigations[0].pushCard;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-ffe');
      expect(cardJson).toContain('Active Projects');
    });

    it('applies multi-item selection precedence on drive-items-selected (Ticket #291)', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(async (fileId: string) => {
        if (fileId === 'item-csi-my-drive') {
          return {
            id: 'item-csi-my-drive',
            name: '071200-001-A Waterproofing.pdf',
            parents: ['root'],
            mimeType: 'application/pdf',
          };
        }
        if (fileId === 'item-proj-notes') {
          return {
            id: 'item-proj-notes',
            name: 'Meeting_Notes.docx',
            parents: ['shared-drive-proj-root'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/vnd.google-apps.document',
          };
        }
        return { id: fileId, name: fileId, parents: [] };
      });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.sample-token' },
          drive: {
            selectedItems: [
              { id: 'item-csi-my-drive', title: '071200-001-A Waterproofing.pdf' },
              { id: 'item-proj-notes', title: 'Meeting_Notes.docx' },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);
      const pushCard = cardResponse.action.navigations[0].pushCard;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-arch');
      expect(cardJson).toContain('Active Projects');
    });

    it('retains partial hierarchy and falls back to filename without warning on parent folder 403 (Ticket #291)', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(async (fileId: string) => {
        if (fileId === 'file-csi-restricted-parent') {
          return {
            id: 'file-csi-restricted-parent',
            name: '071200-001_Waterproofing.pdf',
            parents: ['folder-forbidden-403'],
            driveId: 'shared-drive-proj-root',
            mimeType: 'application/pdf',
          };
        }
        if (fileId === 'folder-forbidden-403') {
          throw new GoogleDriveApiError('Forbidden', { statusCode: 403 });
        }
        return { id: fileId, name: fileId, parents: [] };
      });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.sample-token' },
          drive: {
            selectedItems: [
              { id: 'file-csi-restricted-parent', title: '071200-001_Waterproofing.pdf' },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);
      const pushCard = cardResponse.action.navigations[0].pushCard;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-arch');
      expect(cardJson).toContain('Active Projects');
      expect(cardJson).not.toContain('Could not inspect Google Drive folder hierarchy');
    });

    it('renders Manifest defaults with non-blocking status notice on systemic Drive API error (Ticket #291)', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockRejectedValue(
        new GoogleDriveApiError('Rate limit exceeded', { statusCode: 429 })
      );

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.sample-token' },
          drive: {
            selectedItems: [
              { id: 'file-throttled', title: 'File.pdf' },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);
      const pushCard = cardResponse.action.navigations[0].pushCard;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.');
      expect(cardJson).toContain('communication-project');
      expect(cardJson).toContain('Active Projects');
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
              SelectFiles: { stringInputs: { value: [fileId] } },
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

      // 2. DriveActivityHandler: resolveFolderPath('folder-opp-root', ['Communications'])
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootOppFolderId) && q.q.includes("name = 'Communications'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communications' }] });

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
              SelectFiles: { stringInputs: { value: [fileId] } },
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

    it('files communication-proposal into existing <contact> folder under projects Shared Drive space', async () => {
      // Inject test-scoped Manifest override at AppManifestProvider seam to allow communication-proposal under projects space
      mockAllowedDocumentTypes(manifestProvider, 'projects', ['communication-project', 'communication-proposal']);

      const fileId = 'file-prop-proj-456';
      const fileName = 'RFP_Proposal_Response.pdf';
      const rootSharedDriveId = 'projects-shared-drive-001';
      const commFolderId = 'folder-proj-comm-1';
      const contactFolderId = 'folder-beta-arch';
      const newSubfolderId = 'folder-rfp-subfolder';

      // 1. Dynamic Options Validation: resolves relativePath "Communications" under Shared Drive root
      mockDynamicValidationProposal({
        oppFolderId: rootSharedDriveId,
        commFolderId,
        contactFolderId,
        contactName: 'Beta Architects',
      });

      // 2. DriveActivityHandler: resolveFolderPath('projects-shared-drive-001', ['Communications'])
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(rootSharedDriveId) && q.q.includes("name = 'Communications'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communications' }] });

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
              SelectFiles: { stringInputs: { value: [fileId] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['projects-shared-drive-001'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-proposal'] } },
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
              SelectFiles: { stringInputs: { value: [fileId] } },
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

    it('files communication-project with a brand-new user-entered <contact> name, creating both <contact> and <commFolderName> folders in Drive', async () => {
      const fileId = 'file-brand-new-123';
      const fileName = 'Welcome_Package.docx';
      const sharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const newContactName = 'Brand New Client Inc';
      const newContactFolderId = 'folder-new-client-456';
      const newSubfolderId = 'folder-welcome-subfolder-789';

      // 1. Dynamic Options Validation:
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

      // executeValidationQuery: check contact folder exists -> returns 0 matching folders (new contact)
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'${commFolderId}' in parents`) && q.q.includes(`name = '${newContactName}'`))
        .reply(200, { files: [] });

      // 2. DriveActivityHandler: resolveFolderPath('shared-drive-proj-root', ['1 Admin', 'Communication'])
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(sharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. DriveActivityHandler: findOrCreateFolder(commFolderId, 'Brand New Client Inc') -> creates new contact folder
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes(`name = '${newContactName}'`))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newContactFolderId,
          name: newContactName,
          parents: [commFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });

      // 4. DriveActivityHandler: findOrCreateFolder(newContactFolderId, '260920 IN - Welcome Package') -> creates new subfolder
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(newContactFolderId) && q.q.includes("name = '260920 IN - Welcome Package'"))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files')
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: '260920 IN - Welcome Package',
          parents: [newContactFolderId],
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
              SelectFiles: { stringInputs: { value: [fileId] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: [newContactName] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: ['Welcome Package'] } },
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

    it('files communication-project with disallowed path characters in contact and description, creating sanitized folders in Drive', async () => {
      const fileId = 'file-disallowed-123';
      const fileName = 'Contract.docx';
      const sharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const rawContact = '  Client: /Bad*Name?|With<Disallowed>"Chars\\And\x07Control. . ';
      const sanitizedContact = 'Client- -Bad-Name--With-Disallowed--Chars-And-Control';
      const rawDescription = '  Meeting / Discussion: Issue *123? ...  ';
      const sanitizedDescription = 'Meeting - Discussion- Issue -123-';
      const expectedCommFolder = `260920 IN - ${sanitizedDescription}`;
      const sanitizedContactFolderId = 'folder-sanitized-client-123';
      const newSubfolderId = 'folder-sanitized-subfolder-456';

      // 1. Dynamic Options Validation:
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'${sharedDriveId}' in parents`) && !q.q.includes('name ='))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'${adminFolderId}' in parents`) && !q.q.includes('name ='))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // Dynamic validation receives raw input and returns 0 matching folders (allowUserInput passes)
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'${commFolderId}' in parents`) && q.q.includes('name ='))
        .reply(200, { files: [] });

      // 2. DriveActivityHandler: resolveFolderPath('shared-drive-proj-root', ['1 Admin', 'Communication'])
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(sharedDriveId) && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(adminFolderId) && q.q.includes("name = 'Communication'"))
        .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

      // 3. DriveActivityHandler: findOrCreateFolder with sanitized contact folder name
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(commFolderId) && q.q.includes(`name = '${sanitizedContact}'`))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files', (reqBody) => reqBody.name === sanitizedContact && reqBody.parents[0] === commFolderId)
        .query(true)
        .reply(200, {
          id: sanitizedContactFolderId,
          name: sanitizedContact,
          parents: [commFolderId],
          mimeType: 'application/vnd.google-apps.folder',
        });

      // 4. DriveActivityHandler: findOrCreateFolder with sanitized commFolderName
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(sanitizedContactFolderId) && q.q.includes(`name = '${expectedCommFolder}'`))
        .reply(200, { files: [] });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files', (reqBody) => reqBody.name === expectedCommFolder && reqBody.parents[0] === sanitizedContactFolderId)
        .query(true)
        .reply(200, {
          id: newSubfolderId,
          name: expectedCommFolder,
          parents: [sanitizedContactFolderId],
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
              SelectFiles: { stringInputs: { value: [fileId] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: [rawContact] } },
              [getDocumentInfoWidgetName('date', 'communication-project')]: { stringInputs: { value: ['260920'] } },
              [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
              [getDocumentInfoWidgetName('description', 'communication-project')]: { stringInputs: { value: [rawDescription] } },
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

    it('files communication-project with zero selected files, creating folder hierarchy in Drive and succeeding with notification', async () => {
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
      expect(body).toEqual({
        action: {
          notification: {
            text: 'Document processed successfully',
          },
        },
      });
      expect(nock.isDone()).toBe(true);
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
              SelectFiles: { stringInputs: { value: [fileId] } },
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
              SelectFiles: { stringInputs: { value: [fileId] } },
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
        s.widgets?.some((w) => w.textParagraph?.text?.includes('could not be uniquely resolved'))
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
              SelectFiles: { stringInputs: { value: [fileId] } },
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
        s.widgets?.some(
          (w) =>
            w.textParagraph?.text?.includes('Access denied. You do not have permission to access this Google Drive file or folder.') ||
            w.textParagraph?.text?.includes('Drive service error (403) in move')
        )
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
              SelectFiles: { stringInputs: { value: [file1Id, file2Id] } },
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

    it('files only checked subset of selected SourceFiles when the first Drive item is unchecked, preserving mimeType and moving only checked file', async () => {
      const file1Id = 'file-first-unchecked';
      const file1Name = 'First_Unchecked.pdf';
      const file2Id = 'file-second-checked';
      const file2Name = 'Second_Checked.png';
      const rootSharedDriveId = 'shared-drive-proj-root';
      const adminFolderId = 'folder-admin-1';
      const commFolderId = 'folder-comm-1';
      const contactFolderId = 'folder-acme-corp';
      const newSubfolderId = 'folder-subset-subfolder';

      // 1. Dynamic Options Validation
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

      // 5. move ONLY file 2 (file 1 was unchecked!)
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${file2Id}`)
        .query(true)
        .reply(200, {
          id: file2Id,
          name: file2Name,
          parents: ['initial-inbox-folder'],
          mimeType: 'image/png',
          webViewLink: `https://drive.google.com/file/d/${file2Id}/view`,
        });

      nock('https://www.googleapis.com')
        .patch(`/drive/v3/files/${file2Id}`)
        .query(true)
        .reply(200, {
          id: file2Id,
          name: file2Name,
          parents: [newSubfolderId],
          mimeType: 'image/png',
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
              { id: file2Id, title: file2Name, mimeType: 'image/png' },
            ],
          },
          commonEventObject: {
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectFiles: { stringInputs: { value: [file2Id] } }, // Only file 2 checked!
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

    it('aborts submission and returns error update card when all items in SelectFiles are unchecked on a document type where allowEmptySourceFiles is false, without invoking Drive move', async () => {
      const file1Id = 'file-unchecked-1';
      const file1Name = 'First.pdf';
      const file2Id = 'file-unchecked-2';
      const file2Name = 'Second.png';

      const originalRead = manifestProvider.readParsedSchema.bind(manifestProvider);
      vi.spyOn(manifestProvider, 'readParsedSchema').mockImplementation(async (relPath: string) => {
        const parsed = (await originalRead(relPath)) as Record<string, unknown>;
        return {
          ...parsed,
          allowEmptySourceFiles: false,
        };
      });

      // No dynamic validation or Drive nocks since submission is blocked before activity engine is invoked!

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
              { id: file2Id, title: file2Name, mimeType: 'image/png' },
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
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Please select at least one file in Google Drive to process.'))
      );
      expect(errorSection).toBeDefined();

      const fileSelectionSection = updateCard.sections.find((s: { header?: string }) => s.header === 'File Selection');
      expect(fileSelectionSection).toBeDefined();
      const selectFilesWidget = fileSelectionSection?.widgets?.find((w: { selectionInput?: { name?: string } }) => w.selectionInput?.name === 'SelectFiles');
      expect(selectFilesWidget?.selectionInput?.items).toEqual([
        { text: file1Name, value: file1Id, selected: false },
        { text: file2Name, value: file2Id, selected: false },
      ]);
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
              SelectFiles: { stringInputs: { value: [file1Id, file2Id, file3Id] } },
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
        s.widgets?.some(
          (w) =>
            w.textParagraph?.text?.includes('Access denied. You do not have permission to access this Google Drive file or folder.') ||
            w.textParagraph?.text?.includes('Drive service error (403) in move')
        )
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
              SelectFiles: { stringInputs: { value: [file1Id, file2Id] } },
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

  describe('Ticket #307: Pass 2 Drive timestamp date pre-population on Communications in workspace timeZone', () => {
    it('pre-populates communication-project date in yyMMdd from evening UTC-Z modifiedTime in America/New_York, leaving description/contact blank and direction IN', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-comm-evening')
        .query(true)
        .reply(200, {
          id: 'file-comm-evening',
          name: 'Client_Meeting_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-comm'],
          driveId: 'projects-shared-drive-001',
          // 2026-03-16 02:30Z = 2026-03-15 22:30 EDT in America/New_York
          modifiedTime: '2026-03-16T02:30:00Z',
          createdTime: '2026-03-10T12:00:00Z',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-comm')
        .query(true)
        .reply(200, {
          id: 'folder-comm',
          name: '1 Admin/Communication',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-comm-evening', title: 'Client_Meeting_Notes.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const card = body.action.navigations[0].pushCard;
      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');

      const dateWidget = docDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      );
      expect(dateWidget?.textInput?.value).toBe('260315');

      const descWidget = docDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
      );
      expect(descWidget?.textInput?.value ?? '').toBe('');

      const contactWidget = docDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      );
      expect(contactWidget?.textInput?.value ?? '').toBe('');

      const dirWidget = docDataSec.widgets.find(
        (w: { selectionInput?: { name: string } }) =>
          w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
      );
      expect(
        dirWidget?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
      ).toBe('IN');
    });

    it('pre-populates communication-proposal date from Drive shortcut target createdTime across DST fall-back boundary', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/shortcut-prop')
        .query(true)
        .reply(200, {
          id: 'shortcut-prop',
          name: 'Proposal Shortcut',
          mimeType: 'application/vnd.google-apps.shortcut',
          shortcutDetails: {
            targetId: 'target-prop-file',
            targetMimeType: 'application/pdf',
          },
          parents: ['root'],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/target-prop-file')
        .query(true)
        .reply(200, {
          id: 'target-prop-file',
          name: 'Proposal_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['proposal-space-folder'],
          driveId: 'drive-marketing-1',
          // 2026-11-02 04:30Z = 2026-11-01 23:30 EST in America/New_York
          createdTime: '2026-11-02T04:30:00Z',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'drive-marketing-1', name: 'INC Marketing' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/proposal-space-folder')
        .query(true)
        .reply(200, {
          id: 'proposal-space-folder',
          name: 'Client Proposals',
          parents: ['opp-folder'],
          driveId: 'drive-marketing-1',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/opp-folder')
        .query(true)
        .reply(200, {
          id: 'opp-folder',
          name: 'Opportunities',
          parents: ['drive-marketing-1'],
          driveId: 'drive-marketing-1',
        });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'shortcut-prop', title: 'Proposal Shortcut' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const card = body.action.navigations[0].pushCard;
      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const dateWidget = docDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
      );
      expect(dateWidget?.textInput?.value).toBe('261101');
    });
  });

  describe('Ticket #308: Explicit filename yymmdd date extraction ([today - 12 months, today]) and Google Workspace stem handling', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('pre-populates communication-project and communication-proposal date from INC yyMMdd and delimited filename dates within [today - 12 months, today] ahead of modifiedTime', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));

      // Case 1: communication-project with INC yyMMdd filename
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-comm-yymmdd')
        .query(true)
        .reply(200, {
          id: 'file-comm-yymmdd',
          name: '261115_Client_Meeting_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-comm-308'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T14:00:00Z',
          createdTime: '2026-11-10T12:00:00Z',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-comm-308')
        .query(true)
        .reply(200, {
          id: 'folder-comm-308',
          name: '1 Admin/Communication',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
        });

      const projResp = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-comm-yymmdd', title: '261115_Client_Meeting_Notes.pdf' }],
          },
        },
      });

      expect(projResp.statusCode).toBe(200);
      const projBody = JSON.parse(projResp.payload);
      const projCard = projBody.action.navigations[0].pushCard;
      const projDocDataSec = projCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const projDateWidget = projDocDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      );
      expect(projDateWidget?.textInput?.value).toBe('261115');

      // Case 2: communication-proposal with delimited YYYY-MM-DD filename
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-prop-delimited')
        .query(true)
        .reply(200, {
          id: 'file-prop-delimited',
          name: 'Proposal_Notes_2026-11-12.pdf',
          mimeType: 'application/pdf',
          parents: ['proposal-space-folder-308'],
          driveId: 'drive-marketing-1',
          modifiedTime: '2026-11-18T14:00:00Z',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'drive-marketing-1', name: 'INC Marketing' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/proposal-space-folder-308')
        .query(true)
        .reply(200, {
          id: 'proposal-space-folder-308',
          name: 'Client Proposals',
          parents: ['opp-folder-308'],
          driveId: 'drive-marketing-1',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/opp-folder-308')
        .query(true)
        .reply(200, {
          id: 'opp-folder-308',
          name: 'Opportunities',
          parents: ['drive-marketing-1'],
          driveId: 'drive-marketing-1',
        });

      const propResp = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-prop-delimited', title: 'Proposal_Notes_2026-11-12.pdf' }],
          },
        },
      });

      expect(propResp.statusCode).toBe(200);
      const propBody = JSON.parse(propResp.payload);
      const propCard = propBody.action.navigations[0].pushCard;
      const propDocDataSec = propCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const propDateWidget = propDocDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
      );
      expect(propDateWidget?.textInput?.value).toBe('261112');

      // Case 3: late-December yyMMdd filename in early January
      vi.setSystemTime(new Date('2026-01-05T15:00:00Z'));

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-comm-jan-dec')
        .query(true)
        .reply(200, {
          id: 'file-comm-jan-dec',
          name: '251228_Year_End_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-comm-308'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-01-05T14:00:00Z',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-comm-308')
        .query(true)
        .reply(200, {
          id: 'folder-comm-308',
          name: '1 Admin/Communication',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
        });

      const janResp = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-comm-jan-dec', title: '251228_Year_End_Notes.pdf' }],
          },
        },
      });

      expect(janResp.statusCode).toBe(200);
      const janBody = JSON.parse(janResp.payload);
      const janCard = janBody.action.navigations[0].pushCard;
      const janDocDataSec = janCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const janDateWidget = janDocDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      );
      expect(janDateWidget?.textInput?.value).toBe('251228');
    });

    it('falls back to modifiedTime when filename has rejected date (> today, < today - 12 months, 260519-001, 260230) or extensionless Google Workspace doc (07.12.00, Spec_v1.2)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));

      for (const testCase of [
        { id: 'file-future-308', name: '261125_Future_Notes.pdf', mimeType: 'application/pdf' },
        { id: 'file-stale-308', name: '251110_Stale_Notes.pdf', mimeType: 'application/pdf' },
        { id: 'file-div26-308', name: '260519-001_Lighting_Submittal.pdf', mimeType: 'application/pdf' },
        { id: 'file-invalid-308', name: '260230_Invalid_Calendar.pdf', mimeType: 'application/pdf' },
        { id: 'file-gdoc-csi-308', name: '07.12.00', mimeType: 'application/vnd.google-apps.document' },
        { id: 'file-gdoc-spec-308', name: 'Spec_v1.2', mimeType: 'application/vnd.google-apps.document' },
      ]) {
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${testCase.id}`)
          .query(true)
          .reply(200, {
            id: testCase.id,
            name: testCase.name,
            mimeType: testCase.mimeType,
            parents: ['folder-comm-308'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T14:00:00Z',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-comm-308')
          .query(true)
          .reply(200, {
            id: 'folder-comm-308',
            name: '1 Admin/Communication',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
          });

        const resp = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: testCase.id, title: testCase.name }],
            },
          },
        });

        expect(resp.statusCode).toBe(200);
        const body = JSON.parse(resp.payload);
        const card = body.action.navigations[0].pushCard;
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const dateWidget = docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
        );
        expect(dateWidget?.textInput?.value, testCase.name).toBe('261118');
      }
    });
  });
});

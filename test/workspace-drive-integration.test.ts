import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
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
import { PdfProcessor } from '../src/infrastructure/pdf/pdf-processor';
import { PdfEncryptionError } from '../src/infrastructure/pdf/errors';
import {
  PDF_FORM_ENCRYPTED_ERROR_MESSAGE,
  DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE,
  DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
  formatAmbiguousFormFieldMessage,
} from '../src/features/source-parser/domain';
import { DRIVE_ROUTING_FALLBACK_NOTICE } from '../src/features/ui-process-manager/domain';
import { DriveFormExtractorAdapter } from '../src/features/source-parser/adapters/drive-form-extractor.adapter';

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
      const flatPdfBytes = await (await PDFDocument.create()).save();
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(flatPdfBytes);
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
      const flatPdfBytes = await (await PDFDocument.create()).save();
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(flatPdfBytes);
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
      expect(cardJson).not.toContain('Could not read Google Drive file metadata');
    });

    it('applies multi-item selection precedence on drive-items-selected (Ticket #291)', async () => {
      nock.disableNetConnect();
      try {
        const flatPdfBytes = await (await PDFDocument.create()).save();
        vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(flatPdfBytes);
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
        nock('https://docs.googleapis.com')
          .get('/v1/documents/item-proj-notes')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, {
            documentId: 'item-proj-notes',
            tabs: [
              {
                documentTab: {
                  body: {
                    content: [
                      { paragraph: { elements: [{ textRun: { content: 'Plain meeting notes.\n' } }] } },
                    ],
                  },
                },
              },
            ],
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
        expect(cardJson).not.toContain('Could not read Google Drive file metadata');
        expect(nock.isDone()).toBe(true);
      } finally {
        nock.enableNetConnect();
      }
    });

    it('retains partial hierarchy and falls back to filename without warning on parent folder 403 (Ticket #291)', async () => {
      const flatPdfBytes = await (await PDFDocument.create()).save();
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(flatPdfBytes);
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


  describe('Ticket #309: End-to-end SelectFiles filtering, type-switch edit preservation & single-banner Drive error degradation', () => {
    it('silently retains partial ancestors on parent-folder 403 with zero warning banners and still populates date from file metadata', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-restricted-parent')
        .query(true)
        .reply(200, {
          id: 'file-restricted-parent',
          name: 'Restricted_Parent_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['forbidden-parent'],
          driveId: 'projects-shared-drive-001',
          // 2026-03-16 02:30Z -> 260315 in America/New_York
          modifiedTime: '2026-03-16T02:30:00Z',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/forbidden-parent')
        .query(true)
        .reply(403, { error: { code: 403, message: 'Forbidden' } });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-restricted-parent', title: 'Restricted_Parent_Notes.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const card = body.action.navigations[0].pushCard;
      const cardJson = JSON.stringify(card);

      expect(cardJson).not.toContain('Could not inspect Google Drive folder hierarchy');
      expect(cardJson).not.toContain('Could not read Google Drive file metadata');

      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const dateWidget = docDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      );
      expect(dateWidget?.textInput?.value).toBe('260315');
    });

    it('suppresses Pass 2 Drive metadata notice on initial load when Drive fails (503) and memoizes getFile per request, while surfacing Pass 2 notice standalone on manual onDocumentTypeChange', async () => {
      mockAllowedDocumentTypes(manifestProvider, 'projects', ['communication-project', 'communication-proposal']);
      const getFileSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'getFile')
        .mockRejectedValue(new GoogleDriveApiError('Service Unavailable', { statusCode: 503 }));

      // 1. Initial load -> Pass 1 + Pass 2 share memoized rejected promise (1 getFile call) & emit only 1 banner
      const initialRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-503', title: 'Outage.pdf' }],
          },
        },
      });

      expect(initialRes.statusCode).toBe(200);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      const initialJson = JSON.stringify(JSON.parse(initialRes.payload).action.navigations[0].pushCard);
      expect(initialJson).toContain(
        'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.'
      );
      expect(initialJson).not.toContain(
        'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.'
      );

      // 2. Manual onDocumentTypeChange -> Pass 1 does not run, Pass 2 notice surfaces standalone
      getFileSpy.mockClear();
      const switchRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-503', title: 'Outage.pdf' }],
          },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['communication-proposal'] },
              },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Active Projects'] },
              },
              SelectFiles: { stringInputs: { value: ['file-503'] } },
            },
          },
        },
      });

      expect(switchRes.statusCode).toBe(200);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      const switchJson = JSON.stringify(JSON.parse(switchRes.payload).action.navigations[0].updateCard);
      expect(switchJson).not.toContain('Could not inspect Google Drive folder hierarchy');
      expect(switchJson).toContain(
        'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.'
      );
    });

    it('filters checked SelectFiles items on manual type switches (treating omitted SelectFiles as []), preserves active-type edits, and evaluates defaults', async () => {
      mockAllowedDocumentTypes(manifestProvider, 'projects', ['communication-project', 'communication-proposal']);
      const getFileSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'getFile')
        .mockImplementation(async (fileId: string) => ({
          id: fileId,
          name: `${fileId}.pdf`,
          mimeType: 'application/pdf',
          parents: [],
          modifiedTime: fileId === 'file-checked' ? '2026-10-22T14:00:00Z' : '2026-10-10T14:00:00Z',
        }));

      // 1. Partial SelectFiles on onDocumentTypeChange -> fetches only file-checked, preserves user edit, defaults direction IN
      const partialRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-unchecked', title: 'Unchecked.pdf' },
              { id: 'file-checked', title: 'Checked.pdf' },
            ],
          },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['communication-proposal'] },
              },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Active Projects'] },
              },
              SelectFiles: { stringInputs: { value: ['file-checked'] } },
              [getDocumentInfoWidgetName('description', 'communication-proposal')]: {
                stringInputs: { value: ['Custom User Note'] },
              },
            },
          },
        },
      });

      expect(partialRes.statusCode).toBe(200);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(getFileSpy).toHaveBeenCalledWith('file-checked');

      const partialCard = JSON.parse(partialRes.payload).action.navigations[0].updateCard;
      const partialDocSec = partialCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        partialDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
        )?.textInput?.value
      ).toBe('261022');
      expect(
        partialDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-proposal')
        )?.textInput?.value
      ).toBe('Custom User Note');
      expect(
        partialDocSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-proposal')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
      ).toBe('IN');

      // 2. All checkboxes unchecked (SelectFiles omitted) on onSpaceTypeChange -> 0 Drive API calls, items stay unselected
      getFileSpy.mockClear();
      const allUncheckedRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-unchecked', title: 'Unchecked.pdf' },
              { id: 'file-checked', title: 'Checked.pdf' },
            ],
          },
          commonEventObject: {
            parameters: { action: 'onSpaceTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            },
          },
        },
      });

      expect(allUncheckedRes.statusCode).toBe(200);
      expect(getFileSpy).not.toHaveBeenCalled();

      const uncheckedCard = JSON.parse(allUncheckedRes.payload).action.navigations[0].updateCard;
      const fileSelSec = uncheckedCard.sections.find((s: { header?: string }) => s.header === 'File Selection');
      const selectFilesWidget = fileSelSec.widgets.find(
        (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectFiles'
      );
      expect(selectFilesWidget?.selectionInput?.items.every((i: { selected?: boolean }) => i.selected === false)).toBe(
        true
      );
    });
  });

  describe('Ticket #310: Flexible Submittal Arch routing and Drive pre-population', () => {
    it('binds multi-file selection [Cover_Notes.pdf, 07 12 00 - 1_v1_Waterproofing.pdf] to the submittal file and populates section, number, 0-based revision, title, date, action, and status', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
      const flatPdfBuffer = Buffer.from(await (await PDFDocument.create()).save());

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-cover-310')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'file-cover-310',
          name: 'Cover_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-unfiled-310'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-01T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-cover-310')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-unfiled-310')
        .query(true)
        .reply(200, {
          id: 'folder-unfiled-310',
          name: 'Unfiled',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-submittal-310')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'file-submittal-310',
          name: '07 12 00 - 1_v1_Waterproofing.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-unfiled-310'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-submittal-310')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-cover-310', title: 'Cover_Notes.pdf' },
              { id: 'file-submittal-310', title: '07 12 00 - 1_v1_Waterproofing.pdf' },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const card = JSON.parse(response.payload).action.navigations[0].pushCard;
      const cardJson = JSON.stringify(card);
      expect(cardJson).toContain('submittal-arch');

      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const getTextVal = (field: string) =>
        docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
        )?.textInput?.value;
      const getSelVal = (field: string) =>
        docDataSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

      expect(getTextVal('section')).toBe('071200');
      expect(getTextVal('number')).toBe('001');
      expect(getTextVal('revision')).toBe('0');
      expect(getTextVal('title')).toBe('Waterproofing');
      expect(getTextVal('date')).toBe('261118');
      expect(getSelVal('action')).toBe('REC');
      expect(getSelVal('status')).toBe('Open');
      expect(cardJson).not.toContain('Could not read Google Drive file metadata');
      expect(nock.isDone()).toBe(true);
    });

    it('extracts varied contractor submittal formats, strips trailing stamps, protects R-19/120V/v1.2, and does not route ISO-date files to submittal-arch', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
      const flatPdfBuffer = Buffer.from(await (await PDFDocument.create()).save());

      const submittalCases = [
        {
          id: 'arch-case-1',
          name: '07.12.00_Submittal_002_Rev1_Waterproofing_2026-11-15.pdf',
          section: '071200',
          number: '002',
          revision: '1',
          title: 'Waterproofing',
          date: '261115',
        },
        {
          id: 'arch-case-2',
          name: 'Section 07-12-00 Submittal #12 - Fluid Applied Waterproofing.pdf',
          section: '071200',
          number: '012',
          revision: undefined,
          title: 'Fluid Applied Waterproofing',
          date: '261118',
        },
        {
          id: 'arch-case-3',
          name: '071200-001-A Fluid Applied Waterproofing - 261115 PMG_NET.pdf',
          section: '071200',
          number: '001',
          revision: 'A',
          title: 'Fluid Applied Waterproofing',
          date: '261115',
        },
        {
          id: 'arch-case-4',
          name: '071200-001-R R-19 Insulation.pdf',
          section: '071200',
          number: '001',
          revision: 'R',
          title: 'R-19 Insulation',
          date: '261118',
        },
        {
          id: 'arch-case-5',
          name: '071200-001_v1.2_120V_Review.pdf',
          section: '071200',
          number: '001',
          revision: undefined,
          title: 'v1.2 120V Review',
          date: '261118',
        },
      ];

      for (const tc of submittalCases) {
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: tc.id,
            name: tc.name,
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: tc.id, title: tc.name }] },
          },
        });
        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        expect(JSON.stringify(card), tc.name).toContain('submittal-arch');
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getTextVal = (field: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
          )?.textInput?.value;

        expect(getTextVal('section'), tc.name).toBe(tc.section);
        expect(getTextVal('number'), tc.name).toBe(tc.number);
        expect(getTextVal('revision'), tc.name).toBe(tc.revision);
        expect(getTextVal('title'), tc.name).toBe(tc.title);
        expect(getTextVal('date'), tc.name).toBe(tc.date);
      }

      // ISO date filename must NOT route to submittal-arch
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/iso-date-only')
        .query(true)
        .reply(200, {
          id: 'iso-date-only',
          name: '2026-11-15_Meeting_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });

      const isoRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'iso-date-only', title: '2026-11-15_Meeting_Notes.pdf' }] },
        },
      });
      expect(isoRes.statusCode).toBe(200);
      const isoCard = JSON.parse(isoRes.payload).action.navigations[0].pushCard;
      const docTypeSec = isoCard.sections.find((s: { header?: string }) => s.header === 'Document Type');
      const selectedDocType = docTypeSec.widgets
        .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
        ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
      expect(selectedDocType).toBe('communication-project');
      const isoDocDataSec = isoCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        isoDocDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
        )?.textInput?.value
      ).toBe('261115');
    });
  });

  describe('Ticket #311: Flexible Submittal FF&E routing and Drive pre-population', () => {
    it('binds multi-file selection [Berman_Cover.pdf, CG-104_v2_Fil_Doux.pdf] to item 2 and populates specTag, LinkedField specTitle, 0-based revision, vendor, date, action, and status', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
      const flatPdfBuffer = Buffer.from(await (await PDFDocument.create()).save());

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-cover-311')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'file-cover-311',
          name: 'Berman_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-unfiled-311'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-01T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-cover-311')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-unfiled-311')
        .query(true)
        .reply(200, {
          id: 'folder-unfiled-311',
          name: 'Unfiled',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-submittal-311')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'file-submittal-311',
          name: 'CG-104_v2_Fil_Doux.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-unfiled-311'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-submittal-311')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-cover-311', title: 'Berman_Cover.pdf' },
              { id: 'file-submittal-311', title: 'CG-104_v2_Fil_Doux.pdf' },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const card = JSON.parse(response.payload).action.navigations[0].pushCard;
      const docTypeSec = card.sections.find((s: { header?: string }) => s.header === 'Document Type');
      const selectedDocType = docTypeSec.widgets
        .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
        ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
      expect(selectedDocType).toBe('submittal-ffe');

      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const getTextVal = (field: string) =>
        docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-ffe')
        )?.textInput?.value;
      const getSelVal = (field: string) =>
        docDataSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName(field, 'submittal-ffe')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

      expect(getTextVal('specTag')).toBe('CG104');
      expect(getTextVal('specTitle')).toBe('BED - KING');
      expect(getTextVal('revision')).toBe('1');
      expect(getTextVal('vendor')).toBe('FDT');
      expect(getTextVal('date')).toBe('261118');
      expect(getSelVal('action')).toBe('REC');
      expect(getSelVal('status')).toBe('Open');
      expect(JSON.stringify(card)).not.toContain('Could not read Google Drive file metadata');
      expect(nock.isDone()).toBe(true);
    });

    it('extracts varied FF&E formats (CG104-A_Berman_Falk, LT 159A_R0, Light_Annex without rev) and rejects lowercase prose ("in 100 days at 120V panel")', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
      const flatPdfBuffer = Buffer.from(await (await PDFDocument.create()).save());

      const ffeCases = [
        {
          id: 'ffe-case-1',
          name: 'CG104-A_Berman_Falk.pdf',
          specTag: 'CG104',
          specTitle: 'BED - KING',
          revision: 'A',
          vendor: 'BM',
          date: '261118',
        },
        {
          id: 'ffe-case-2',
          name: 'LT 159A_R0.pdf',
          specTag: 'LT159A',
          specTitle: 'SCONCE - CORRIDOR',
          revision: '0',
          vendor: undefined,
          date: '261118',
        },
        {
          id: 'ffe-case-3',
          name: 'CG-104_Light_Annex_2026-11-15.pdf',
          specTag: 'CG104',
          specTitle: 'BED - KING',
          revision: undefined,
          vendor: 'LA',
          date: '261115',
        },
      ];

      for (const tc of ffeCases) {
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: tc.id,
            name: tc.name,
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: tc.id, title: tc.name }] },
          },
        });
        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const docTypeSec = card.sections.find((s: { header?: string }) => s.header === 'Document Type');
        const selectedDocType = docTypeSec.widgets
          .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(selectedDocType, tc.name).toBe('submittal-ffe');

        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getTextVal = (field: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-ffe')
          )?.textInput?.value;

        expect(getTextVal('specTag'), tc.name).toBe(tc.specTag);
        expect(getTextVal('specTitle'), tc.name).toBe(tc.specTitle);
        expect(getTextVal('revision'), tc.name).toBe(tc.revision);
        expect(getTextVal('vendor'), tc.name).toBe(tc.vendor);
        expect(getTextVal('date'), tc.name).toBe(tc.date);
        expect(JSON.stringify(card), tc.name).not.toContain('Could not read Google Drive file metadata');
      }
      expect(nock.isDone()).toBe(true);

      // Lowercase prose ("in 100 days", "at 120V panel") must NOT route to submittal-ffe
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/ffe-prose-neg')
        .query(true)
        .reply(200, {
          id: 'ffe-prose-neg',
          name: 'Work in 100 days at 120V panel.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });

      const negRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'ffe-prose-neg', title: 'Work in 100 days at 120V panel.pdf' }] },
        },
      });
      expect(negRes.statusCode).toBe(200);
      const negCard = JSON.parse(negRes.payload).action.navigations[0].pushCard;
      const negDocTypeSec = negCard.sections.find((s: { header?: string }) => s.header === 'Document Type');
      const negSelectedDocType = negDocTypeSec.widgets
        .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
        ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
      expect(negSelectedDocType).toBe('communication-project');
    });
  });

  describe('Ticket #315: Submittal Arch PDF AcroForm pre-population via source: "form"', () => {
    async function buildStampedArchPdfBuffer(selectedOption?: string): Promise<Buffer> {
      const doc = await PDFDocument.create();
      doc.addPage([600, 400]);
      const form = doc.getForm();
      const radio = form.createRadioGroup('Submittal Response');
      for (const [idx, label] of [
        'No Exceptions Taken',
        'No Objections As Corrected',
        'Revise and Resubmit',
        'Rejected',
        'Not Reviewed',
      ].entries()) {
        radio.addOptionToPage(label, doc.getPage(0), {
          x: 50,
          y: 300 - idx * 20,
          width: 12,
          height: 12,
        });
      }
      if (selectedOption !== undefined) {
        radio.select(selectedOption);
      }
      return Buffer.from(await doc.save());
    }

    it('pre-populates action (NET, NOC, RR via valueMap, REJ, NR) and leaves REC when unchecked using single metadata + single alt=media download', async () => {
      const cases = [
        { id: 'arch-315-net', label: 'No Exceptions Taken', expectedAction: 'NET' },
        { id: 'arch-315-noc', label: 'No Objections As Corrected', expectedAction: 'NOC' },
        { id: 'arch-315-rr', label: 'Revise and Resubmit', expectedAction: 'RR' },
        { id: 'arch-315-rej', label: 'Rejected', expectedAction: 'REJ' },
        { id: 'arch-315-nr', label: 'Not Reviewed', expectedAction: 'NR' },
        { id: 'arch-315-blank', label: undefined, expectedAction: 'REC' },
      ];

      for (const tc of cases) {
        const pdfBuffer = await buildStampedArchPdfBuffer(tc.label);

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: tc.id,
            name: '071200-001_Waterproofing.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt === 'media')
          .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: tc.id, title: '071200-001_Waterproofing.pdf' }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const cardJson = JSON.stringify(card);
        expect(cardJson).not.toContain('Could not read Google Drive file metadata');

        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const selectedAction = docDataSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(selectedAction, String(tc.label)).toBe(tc.expectedAction);
        expect(nock.isDone()).toBe(true);
      }
    });

    it('resolves Drive shortcut to stamped Submittal Arch PDF and skips flat 0-widget drawing in [Flat_Drawing.pdf, Stamped_Cover.pdf]', async () => {
      const flatPdfBuffer = Buffer.from(await (await PDFDocument.create()).save());
      const stampedPdfBuffer = await buildStampedArchPdfBuffer('Revise and Resubmit');

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/flat-315')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'flat-315',
          name: '071200-001_Waterproofing.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/flat-315')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/shortcut-stamped-315')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'shortcut-stamped-315',
          name: 'Shortcut to Cover.pdf',
          mimeType: 'application/vnd.google-apps.shortcut',
          parents: ['root'],
          shortcutDetails: {
            targetId: 'target-stamped-315',
            targetMimeType: 'application/pdf',
          },
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/target-stamped-315')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'target-stamped-315',
          name: 'Stamped_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/target-stamped-315')
        .query((q) => q.alt === 'media')
        .reply(200, stampedPdfBuffer, { 'content-type': 'application/pdf' });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'flat-315', title: '071200-001_Waterproofing.pdf' },
              { id: 'shortcut-stamped-315', title: 'Shortcut to Cover.pdf' },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.payload).action.navigations[0].pushCard;
      const cardJson = JSON.stringify(card);
      expect(cardJson).not.toContain('Could not read Google Drive file metadata');

      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const selectedAction = docDataSec.widgets
        .find(
          (w: { selectionInput?: { name: string } }) =>
            w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
        )
        ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
      expect(selectedAction).toBe('RR');
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #316: Stamped Submittal Arch Date pre-population via formDate (format: "date")', () => {
    async function buildArchPdfWithDate(options: {
      dateText?: string | undefined;
      selectedAction?: string | undefined;
    }): Promise<Buffer> {
      const doc = await PDFDocument.create();
      doc.addPage([600, 400]);
      const form = doc.getForm();
      const radio = form.createRadioGroup('Submittal Response');
      for (const [idx, label] of [
        'No Exceptions Taken',
        'No Objections As Corrected',
        'Revise and Resubmit',
        'Rejected',
        'Not Reviewed',
      ].entries()) {
        radio.addOptionToPage(label, doc.getPage(0), {
          x: 50,
          y: 300 - idx * 20,
          width: 12,
          height: 12,
        });
      }
      if (options.selectedAction !== undefined) {
        radio.select(options.selectedAction);
      }
      if (options.dateText !== undefined) {
        const dateField = form.createTextField('Date');
        dateField.addToPage(doc.getPage(0), { x: 200, y: 300, width: 120, height: 20 });
        dateField.setText(options.dateText);
      }
      return Buffer.from(await doc.save());
    }

    it('pre-populates date from stamped Date widget in varied human/ISO formats ahead of drive.modifiedTime and falls back to drive.modifiedTime for "DATE"', async () => {
      const cases = [
        { id: 'arch-316-iso', rawDate: '2026-11-21', expectedDate: '261121' },
        { id: 'arch-316-us2', rawDate: '5/8/26', expectedDate: '260508' },
        { id: 'arch-316-sept', rawDate: 'Sept 8, 2026', expectedDate: '260908' },
        { id: 'arch-316-ord', rawDate: 'May 8th, 2026', expectedDate: '260508' },
        { id: 'arch-316-dmy', rawDate: '8 May 2026', expectedDate: '260508' },
        { id: 'arch-316-arch', rawDate: '2023-09-13', expectedDate: '230913' },
        { id: 'arch-316-yymmdd', rawDate: '261121', expectedDate: '261121' },
        { id: 'arch-316-placeholder', rawDate: 'DATE', expectedDate: '261118' },
      ];

      for (const tc of cases) {
        const pdfBuffer = await buildArchPdfWithDate({
          dateText: tc.rawDate,
          selectedAction: tc.rawDate === 'DATE' ? undefined : 'No Exceptions Taken',
        });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: tc.id,
            name: '071200-001_Waterproofing.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt === 'media')
          .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: tc.id, title: '071200-001_Waterproofing.pdf' }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const dateValue = docDataSec.widgets
          .find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
          )
          ?.textInput?.value;
        expect(dateValue, tc.rawDate).toBe(tc.expectedDate);
        expect(nock.isDone()).toBe(true);
      }
    });

    it('falls through [Unfillable_DATE.pdf, Stamped_Cover.pdf] when first PDF has placeholder "DATE"', async () => {
      const unfillableBuffer = await buildArchPdfWithDate({ dateText: 'DATE' });
      const stampedBuffer = await buildArchPdfWithDate({
        dateText: 'Sept 8, 2026',
        selectedAction: 'Revise and Resubmit',
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/unfillable-316')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'unfillable-316',
          name: '071200-001_Waterproofing.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/unfillable-316')
        .query((q) => q.alt === 'media')
        .reply(200, unfillableBuffer, { 'content-type': 'application/pdf' });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-316')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'stamped-316',
          name: 'Stamped_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-316')
        .query((q) => q.alt === 'media')
        .reply(200, stampedBuffer, { 'content-type': 'application/pdf' });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'unfillable-316', title: '071200-001_Waterproofing.pdf' },
              { id: 'stamped-316', title: 'Stamped_Cover.pdf' },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.payload).action.navigations[0].pushCard;
      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const dateValue = docDataSec.widgets
        .find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
        )
        ?.textInput?.value;
      const selectedAction = docDataSec.widgets
        .find(
          (w: { selectionInput?: { name: string } }) =>
            w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
        )
        ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
      expect(dateValue).toBe('260908');
      expect(selectedAction).toBe('RR');
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #317: Multi-token Submittal No decomposition and full Submittal Arch pre-population', () => {
    async function buildFullArchCoverPdf(options: {
      submittalNo?: string;
      selectedAction?: string;
      dateText?: string;
      reviewedBy?: string;
      includeFreeTextRemark?: boolean;
    }): Promise<Buffer> {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 400]);
      const form = doc.getForm();

      if (options.submittalNo !== undefined) {
        const subNoField = form.createTextField('Submittal No');
        subNoField.addToPage(page, { x: 50, y: 340, width: 180, height: 20 });
        subNoField.setText(options.submittalNo);
      }

      const radio = form.createRadioGroup('Submittal Response');
      for (const [idx, label] of [
        'No Exceptions Taken',
        'No Objections As Corrected',
        'Revise and Resubmit',
        'Rejected',
        'Not Reviewed',
      ].entries()) {
        radio.addOptionToPage(label, page, {
          x: 50,
          y: 300 - idx * 20,
          width: 12,
          height: 12,
        });
      }
      if (options.selectedAction !== undefined) {
        radio.select(options.selectedAction);
      }

      if (options.dateText !== undefined) {
        const dateField = form.createTextField('Date');
        dateField.addToPage(page, { x: 200, y: 300, width: 120, height: 20 });
        dateField.setText(options.dateText);
      }

      if (options.reviewedBy !== undefined) {
        const revBy = form.createTextField('Reviewed By');
        revBy.addToPage(page, { x: 200, y: 260, width: 140, height: 20 });
        revBy.setText(options.reviewedBy);
      }

      if (options.includeFreeTextRemark) {
        const freeTextAnnot = doc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('FreeText'),
          Rect: [20, 20, 200, 60],
          Contents: PDFString.of('REMARK: Verify flashing detail'),
        });
        const annotRef = doc.context.register(freeTextAnnot);
        page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
      }

      return Buffer.from(await doc.save());
    }

    it('pre-populates section, number, revision, action, and date from stamped Submittal Arch PDF (including 4-digit external numbers) while filling title from drive.fileNameStem, defaulting status Open, and leaving contact blank', async () => {
      const pdfBuffer = await buildFullArchCoverPdf({
        submittalNo: '07 12 00 - 001 - Rev. B',
        selectedAction: 'Revise and Resubmit',
        dateText: 'May 8th, 2026',
        reviewedBy: 'Alice Architect',
        includeFreeTextRemark: true,
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/arch-317-full')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'arch-317-full',
          name: '071200-001_Waterproofing_Review.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/arch-317-full')
        .query((q) => q.alt === 'media')
        .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'arch-317-full', title: '071200-001_Waterproofing_Review.pdf' }],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.payload).action.navigations[0].pushCard;
      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');

      const getText = (fieldKey: string) =>
        docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
        )?.textInput?.value;
      const getSelected = (fieldKey: string) =>
        docDataSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

      expect(getSelected('status')).toBe('Open');
      expect(getText('section')).toBe('071200');
      expect(getText('number')).toBe('001');
      expect(getText('revision')).toBe('B');
      expect(getText('title')).toBe('Waterproofing Review');
      expect(getText('date')).toBe('260508');
      expect(getText('contact')).toBeUndefined();
      expect(getSelected('action')).toBe('RR');
      expect(nock.isDone()).toBe(true);

      // 4-digit external submittal sequence number in Submittal No
      const fourDigitBuffer = await buildFullArchCoverPdf({
        submittalNo: '071200-1042-B',
        selectedAction: 'No Exceptions Taken',
        dateText: '2026-11-21',
      });
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/arch-317-1042')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'arch-317-1042',
          name: '071200-001_Stamped_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/arch-317-1042')
        .query((q) => q.alt === 'media')
        .reply(200, fourDigitBuffer, { 'content-type': 'application/pdf' });

      const res1042 = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'arch-317-1042', title: '071200-001_Stamped_Cover.pdf' }],
          },
        },
      });
      expect(res1042.statusCode).toBe(200);
      const card1042 = JSON.parse(res1042.payload).action.navigations[0].pushCard;
      const docSec1042 = card1042.sections.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      expect(
        docSec1042.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput?.value
      ).toBe('1042');
      expect(
        docSec1042.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
        )?.textInput?.value
      ).toBe('B');
      expect(nock.isDone()).toBe(true);
    });

    it('preserves user edits on manual onDocumentTypeChange and onSpaceTypeChange while advancing multi-token cursor to fill remaining blank fields', async () => {
      const allowedSpy = mockAllowedDocumentTypes(manifestProvider, 'projects', [
        'communication-project',
        'submittal-arch',
      ]);
      const pdfBuffer = await buildFullArchCoverPdf({
        submittalNo: '081100-002-C',
        selectedAction: 'No Exceptions Taken',
        dateText: '2026-11-21',
      });

      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'arch-317-switch',
        name: '071200-001_Metal_Doors.pdf',
        mimeType: 'application/pdf',
        parents: ['space-projects-1'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(pdfBuffer);

      // 1. onDocumentTypeChange to submittal-arch with user-edited section and number
      const typeSwitchRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'arch-317-switch', title: '071200-001_Metal_Doors.pdf' }],
          },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['submittal-arch'] },
              },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Active Projects'] },
              },
              SelectFiles: { stringInputs: { value: ['arch-317-switch'] } },
              [getDocumentInfoWidgetName('section', 'submittal-arch')]: {
                stringInputs: { value: ['071200'] },
              },
              [getDocumentInfoWidgetName('number', 'submittal-arch')]: {
                stringInputs: { value: ['001'] },
              },
            },
          },
        },
      });

      expect(typeSwitchRes.statusCode).toBe(200);
      const switchCard = JSON.parse(typeSwitchRes.payload).action.navigations[0].updateCard;
      const switchDocSec = switchCard.sections.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      const getSwitchText = (fieldKey: string) =>
        switchDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
        )?.textInput?.value;
      const getSwitchSelected = (fieldKey: string) =>
        switchDocSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

      expect(getSwitchText('section')).toBe('071200');
      expect(getSwitchText('number')).toBe('001');
      expect(getSwitchText('revision')).toBe('C');
      expect(getSwitchText('date')).toBe('261121');
      expect(getSwitchText('title')).toBe('Metal Doors');
      expect(getSwitchSelected('action')).toBe('NET');

      // 2. onSpaceTypeChange targeting projects (with submittal-arch resolved as space default) preserves user edits and re-evaluates reactive UiView
      allowedSpy.mockRestore();
      mockAllowedDocumentTypes(manifestProvider, 'projects', ['submittal-arch']);
      const spaceSwitchRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'arch-317-switch', title: '071200-001_Metal_Doors.pdf' }],
          },
          commonEventObject: {
            parameters: { action: 'onSpaceTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Active Projects'] },
              },
              SelectFiles: { stringInputs: { value: ['arch-317-switch'] } },
              [getDocumentInfoWidgetName('section', 'submittal-arch')]: {
                stringInputs: { value: ['071200'] },
              },
              [getDocumentInfoWidgetName('number', 'submittal-arch')]: {
                stringInputs: { value: ['001'] },
              },
            },
          },
        },
      });

      expect(spaceSwitchRes.statusCode).toBe(200);
      const spaceCard = JSON.parse(spaceSwitchRes.payload).action.navigations[0].updateCard;
      const spaceDocSec = spaceCard.sections.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      expect(
        spaceDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
        )?.textInput?.value
      ).toBe('C');
      expect(
        spaceDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');
    });
  });

  describe('Ticket #319: Pass 2 form error degradation & multi-selection resilience (UiView)', () => {
    async function buildStampedArchPdfBuffer(selectedOption?: string): Promise<Buffer> {
      const doc = await PDFDocument.create();
      doc.addPage([600, 400]);
      const form = doc.getForm();
      const radio = form.createRadioGroup('Submittal Response');
      for (const [idx, label] of [
        'No Exceptions Taken',
        'No Objections As Corrected',
        'Revise and Resubmit',
        'Rejected',
        'Not Reviewed',
      ].entries()) {
        radio.addOptionToPage(label, doc.getPage(0), {
          x: 50,
          y: 300 - idx * 20,
          width: 12,
          height: 12,
        });
      }
      if (selectedOption !== undefined) {
        radio.select(selectedOption);
      }
      return Buffer.from(await doc.save());
    }

    it('renders PDF_FORM_ENCRYPTED_ERROR_MESSAGE and DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE in UiView while still populating Drive filename/date fields', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/enc-arch-319')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'enc-arch-319',
          name: '071200-001_Encrypted_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/enc-arch-319')
        .query((q) => q.alt === 'media')
        .reply(200, Buffer.from('%PDF-1.4-encrypted'), { 'content-type': 'application/pdf' });

      const extractSpy = vi
        .spyOn(PdfProcessor.prototype, 'extractFormData')
        .mockRejectedValueOnce(new PdfEncryptionError());

      const encRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'enc-arch-319', title: '071200-001_Encrypted_Cover.pdf' }] },
        },
      });
      extractSpy.mockRestore();

      expect(encRes.statusCode).toBe(200);
      const encCard = JSON.parse(encRes.payload).action.navigations[0].pushCard;
      const encCardJson = JSON.stringify(encCard);
      expect(encCardJson).toContain(PDF_FORM_ENCRYPTED_ERROR_MESSAGE);
      const encDocSec = encCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        encDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');
      expect(
        encDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput?.value
      ).toBe('001');
      expect(nock.isDone()).toBe(true);

      // Corrupted PDF -> real PdfProcessor throws PdfCorruptedError on malformed bytes
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/corrupt-arch-319')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'corrupt-arch-319',
          name: '071200-002_Corrupted_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/corrupt-arch-319')
        .query((q) => q.alt === 'media')
        .reply(200, Buffer.from('not-a-valid-pdf'), { 'content-type': 'application/pdf' });

      const corruptRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'corrupt-arch-319', title: '071200-002_Corrupted_Cover.pdf' }] },
        },
      });

      expect(corruptRes.statusCode).toBe(200);
      const corruptCard = JSON.parse(corruptRes.payload).action.navigations[0].pushCard;
      const corruptCardJson = JSON.stringify(corruptCard);
      expect(corruptCardJson).toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
      const corruptDocSec = corruptCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        corruptDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');
      expect(
        corruptDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput?.value
      ).toBe('002');
      expect(nock.isDone()).toBe(true);
    });

    it('recovers from [Forbidden.pdf, Stamped_Cover.pdf] in source: "form" on onDocumentTypeChange and surfaces generalized Pass 2 Drive notice on downloadFileMedia 503', async () => {
      mockAllowedDocumentTypes(manifestProvider, 'projects', ['communication-project', 'submittal-arch']);
      const stampedPdfBuffer = await buildStampedArchPdfBuffer('Revise and Resubmit');

      // 1. [Forbidden.pdf, Stamped_Cover.pdf] on onDocumentTypeChange -> form populates action RR + generalized notice
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/forbidden-319')
        .query((q) => q.alt !== 'media')
        .reply(403, { error: { code: 403, message: 'Forbidden' } });
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-319')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'stamped-319',
          name: '071200-003_Stamped_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-319')
        .query((q) => q.alt === 'media')
        .reply(200, stampedPdfBuffer, { 'content-type': 'application/pdf' });

      const multiRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'forbidden-319', title: 'Forbidden.pdf' },
              { id: 'stamped-319', title: '071200-003_Stamped_Cover.pdf' },
            ],
          },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['submittal-arch'] },
              },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Active Projects'] },
              },
              SelectFiles: { stringInputs: { value: ['forbidden-319', 'stamped-319'] } },
            },
          },
        },
      });

      expect(multiRes.statusCode).toBe(200);
      const multiCard = JSON.parse(multiRes.payload).action.navigations[0].updateCard;
      const multiCardJson = JSON.stringify(multiCard);
      expect(multiCardJson).toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
      const multiDocSec = multiCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const selectedAction = multiDocSec.widgets
        .find(
          (w: { selectionInput?: { name: string } }) =>
            w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
        )
        ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
      expect(selectedAction).toBe('RR');
      expect(nock.isDone()).toBe(true);

      // 2. Drive 503 on downloadFileMedia during initial load (Pass 1 succeeds -> Pass 2 generalized notice appears once)
      const getFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'media-503-319',
        name: '071200-004_Outage_Cover.pdf',
        mimeType: 'application/pdf',
        parents: ['projects-shared-drive-001'],
        driveId: 'projects-shared-drive-001',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      const listDrivesSpy = vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
      });
      const downloadSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'downloadFileMedia')
        .mockRejectedValue(new GoogleDriveApiError('Service Unavailable', { statusCode: 503 }));

      const mediaOutageRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'media-503-319', title: '071200-004_Outage_Cover.pdf' }] },
        },
      });
      getFileSpy.mockRestore();
      listDrivesSpy.mockRestore();
      downloadSpy.mockRestore();

      expect(mediaOutageRes.statusCode).toBe(200);
      const outageCard = JSON.parse(mediaOutageRes.payload).action.navigations[0].pushCard;
      const outageCardJson = JSON.stringify(outageCard);
      expect(outageCardJson).toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
      const outageDocSec = outageCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        outageDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');
    });

    it('renders formatAmbiguousFormFieldMessage in UiView for ambiguous form widgets while still populating Drive metadata fields', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/ambig-gdoc-319')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'ambig-gdoc-319',
          name: '071200-005_Ambiguous_Cover',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });

      const extractFormSpy = vi
        .spyOn(DriveFormExtractorAdapter.prototype, 'extractFormFields')
        .mockResolvedValueOnce({
          status: 'ok',
          widgetCount: 2,
          fields: {},
          ambiguousFields: ['Submittal Response'],
        });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'ambig-gdoc-319', title: '071200-005_Ambiguous_Cover' }],
          },
        },
      });
      extractFormSpy.mockRestore();

      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.payload).action.navigations[0].pushCard;
      expect(card.sections[0]?.widgets?.[0]?.textParagraph?.text).toContain(
        formatAmbiguousFormFieldMessage('Submittal Response')
      );
      const docSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        docSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #318: Submittal FF&E PDF AcroForm pre-population and LinkedField derivation via source: "form"', () => {
    async function buildFullFfeCoverPdf(options: {
      submittalNo?: string;
      selectedAction?: string;
      dateText?: string;
      reviewedBy?: string;
      includeFreeTextRemark?: boolean;
    }): Promise<Buffer> {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 400]);
      const form = doc.getForm();

      if (options.submittalNo !== undefined) {
        const subNoField = form.createTextField('Submittal No');
        subNoField.addToPage(page, { x: 50, y: 340, width: 180, height: 20 });
        subNoField.setText(options.submittalNo);
      }

      const radio = form.createRadioGroup('Submittal Response');
      for (const [idx, label] of [
        'No Exceptions Taken',
        'No Objections As Corrected',
        'Revise and Resubmit',
        'Rejected',
        'Not Reviewed',
      ].entries()) {
        radio.addOptionToPage(label, page, {
          x: 50,
          y: 300 - idx * 20,
          width: 12,
          height: 12,
        });
      }
      if (options.selectedAction !== undefined) {
        radio.select(options.selectedAction);
      }

      if (options.dateText !== undefined) {
        const dateField = form.createTextField('Date');
        dateField.addToPage(page, { x: 200, y: 300, width: 120, height: 20 });
        dateField.setText(options.dateText);
      }

      if (options.reviewedBy !== undefined) {
        const revBy = form.createTextField('Reviewed By');
        revBy.addToPage(page, { x: 200, y: 260, width: 140, height: 20 });
        revBy.setText(options.reviewedBy);
      }

      if (options.includeFreeTextRemark) {
        const freeTextAnnot = doc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('FreeText'),
          Rect: [20, 20, 200, 60],
          Contents: PDFString.of('REMARK: Verify upholstery COM'),
        });
        const annotRef = doc.context.register(freeTextAnnot);
        page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
      }

      return Buffer.from(await doc.save());
    }

    it('pre-populates specTag, LinkedField specTitle, revision, action, and date from stamped Submittal FF&E PDF while filling vendor from drive, defaulting status Open, and leaving contact blank', async () => {
      const pdfBuffer = await buildFullFfeCoverPdf({
        submittalNo: 'CG-104 - A',
        selectedAction: 'Revise and Resubmit',
        dateText: '5/8/26',
        reviewedBy: 'Jane Designer',
        includeFreeTextRemark: true,
      });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-3ffe-318')
        .query(true)
        .reply(200, {
          id: 'folder-3ffe-318',
          name: '3 FFE',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-ffe-318')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'stamped-ffe-318',
          name: 'Berman_Falk.pdf',
          mimeType: 'application/pdf',
          parents: ['folder-3ffe-318'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-ffe-318')
        .query((q) => q.alt === 'media')
        .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'stamped-ffe-318', title: 'Berman_Falk.pdf' }],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.payload).action.navigations[0].pushCard;
      const cardJson = JSON.stringify(card);
      expect(cardJson).not.toContain('Could not read Google Drive file metadata');

      const docTypeSec = card.sections.find((s: { header?: string }) => s.header === 'Document Type');
      const selectedDocType = docTypeSec.widgets
        .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
        ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
      expect(selectedDocType).toBe('submittal-ffe');

      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const getTextVal = (fieldKey: string) =>
        docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
        )?.textInput?.value;
      const getSelVal = (fieldKey: string) =>
        docDataSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

      expect(getTextVal('specTag')).toBe('CG104');
      expect(getTextVal('specTitle')).toBe('BED - KING');
      expect(getTextVal('revision')).toBe('A');
      expect(getSelVal('action')).toBe('RR');
      expect(getTextVal('date')).toBe('260508');
      expect(getTextVal('vendor')).toBe('BM');
      expect(getSelVal('status')).toBe('Open');
      expect(getTextVal('contact')).toBeUndefined();
      expect(nock.isDone()).toBe(true);
    });

    it('extracts CG104 without revision, CG104_A, CG 104 - A, NOC label, and leaves unlisted specTag XX999 - A blank across UiView renders', async () => {
      const cases = [
        {
          id: 'ffe-form-case-1',
          submittalNo: 'CG104',
          selectedAction: 'No Objections As Corrected',
          expectedSpecTag: 'CG104',
          expectedSpecTitle: 'BED - KING',
          expectedRevision: undefined,
          expectedAction: 'NOC',
        },
        {
          id: 'ffe-form-case-2',
          submittalNo: 'CG104_A',
          selectedAction: 'No Exceptions Taken',
          expectedSpecTag: 'CG104',
          expectedSpecTitle: 'BED - KING',
          expectedRevision: 'A',
          expectedAction: 'NET',
        },
        {
          id: 'ffe-form-case-3',
          submittalNo: 'CG 104 - A',
          selectedAction: 'Revise and Resubmit',
          expectedSpecTag: 'CG104',
          expectedSpecTitle: 'BED - KING',
          expectedRevision: 'A',
          expectedAction: 'RR',
        },
        {
          id: 'ffe-form-case-4',
          submittalNo: 'XX999 - A',
          selectedAction: 'No Objections As Corrected',
          expectedSpecTag: undefined,
          expectedSpecTitle: undefined,
          expectedRevision: undefined,
          expectedAction: 'NOC',
        },
      ];

      for (const tc of cases) {
        const pdfBuffer = await buildFullFfeCoverPdf({
          submittalNo: tc.submittalNo,
          selectedAction: tc.selectedAction,
          dateText: '2026-11-21',
        });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/folder-${tc.id}`)
          .query(true)
          .reply(200, {
            id: `folder-${tc.id}`,
            name: '3 FFE',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: tc.id,
            name: 'Stamped_Submittal.pdf',
            mimeType: 'application/pdf',
            parents: [`folder-${tc.id}`],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt === 'media')
          .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: tc.id, title: 'Stamped_Submittal.pdf' }] },
          },
        });
        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getTextVal = (fieldKey: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
          )?.textInput?.value;
        const getSelVal = (fieldKey: string) =>
          docDataSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

        expect(getTextVal('specTag'), tc.id).toBe(tc.expectedSpecTag);
        expect(getTextVal('specTitle'), tc.id).toBe(tc.expectedSpecTitle);
        expect(getTextVal('revision'), tc.id).toBe(tc.expectedRevision);
        expect(getSelVal('action'), tc.id).toBe(tc.expectedAction);
        expect(getTextVal('date'), tc.id).toBe('261121');
      }
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #321: Google Docs N×2 Key/Value pre-population, shortcuts, multi-item fallback, and non-blocking degradation', () => {
    beforeEach(() => {
      nock.disableNetConnect();
    });

    afterEach(() => {
      nock.enableNetConnect();
    });

    function buildNx2GoogleDocPayload(documentId: string, submittalNoText?: string) {
      return {
        documentId,
        body: null,
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  {
                    table: {
                      rows: 1,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            { content: [{ paragraph: { elements: [{ textRun: { content: 'Submittal No.\n' } }] } }] },
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [{ textRun: { content: `${submittalNoText ?? ''}\n` } }],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      };
    }

    function buildProseGoogleDocPayload(documentId: string, bodyText = 'Plain meeting notes without form tables.\n') {
      return {
        documentId,
        body: null,
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  { paragraph: { elements: [{ textRun: { content: bodyText } }] } },
                ],
              },
            },
          },
        ],
      };
    }

    it('pre-populates full and partial Submittal No from N×2 table on Submittal Arch Google Doc cover sheets via nock', async () => {
      const cases = [
        {
          id: 'gdoc-arch-full',
          fileName: '071200-001_Waterproofing_Cover_Sheet',
          subNo: '071200-001-1',
          section: '071200',
          number: '001',
          revision: '1',
          title: 'Waterproofing Cover Sheet',
        },
        {
          id: 'gdoc-arch-no-rev',
          fileName: '071200-001_Waterproofing_Cover_Sheet',
          subNo: '071200-001',
          section: '071200',
          number: '001',
          revision: undefined,
          title: 'Waterproofing Cover Sheet',
        },
        {
          id: 'gdoc-arch-4digit',
          fileName: '071200-001_Waterproofing_Cover_Sheet',
          subNo: '071200-1042',
          section: '071200',
          number: '1042',
          revision: undefined,
          title: undefined,
        },
        {
          id: 'gdoc-arch-csi',
          fileName: 'Waterproofing_Cover_Sheet',
          subNo: '07 12 00',
          section: '071200',
          number: undefined,
          revision: undefined,
          title: undefined,
        },
        {
          id: 'gdoc-arch-num-rev',
          fileName: 'Waterproofing_Cover_Sheet',
          subNo: '42 Rev B',
          section: undefined,
          number: '042',
          revision: 'B',
          title: undefined,
        },
        {
          id: 'gdoc-arch-rev-only',
          fileName: 'Waterproofing_Cover_Sheet',
          subNo: 'R1',
          section: undefined,
          number: undefined,
          revision: '1',
          title: undefined,
        },
      ];

      for (const tc of cases) {
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/folder-${tc.id}`)
          .query(true)
          .reply(200, {
            id: `folder-${tc.id}`,
            name: '6 Construction',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${tc.id}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: tc.id,
            name: tc.fileName,
            mimeType: 'application/vnd.google-apps.document',
            parents: [`folder-${tc.id}`],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com', {
          reqheaders: { authorization: 'Bearer ya29.valid-oauth-token' },
        })
          .get(`/v1/documents/${tc.id}`)
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, buildNx2GoogleDocPayload(tc.id, tc.subNo));

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: tc.id, title: tc.fileName }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        expect(JSON.stringify(card)).not.toContain('Could not read Google Drive file metadata');

        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getText = (fieldKey: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
          )?.textInput?.value;
        const getSel = (fieldKey: string) =>
          docDataSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

        expect(getText('section'), tc.id).toBe(tc.section);
        expect(getText('number'), tc.id).toBe(tc.number);
        expect(getText('revision'), tc.id).toBe(tc.revision);
        expect(getText('title'), tc.id).toBe(tc.title);
        expect(getText('date'), tc.id).toBe('261118');
        expect(getSel('status'), tc.id).toBe('Open');
        expect(getSel('action'), tc.id).toBe('REC');
      }
      expect(nock.isDone()).toBe(true);
    });

    it('pre-populates specTag, derived LinkedField specTitle, and revision on Submittal FF&E Google Doc cover sheet and handles 0-widget prose doc silently', async () => {
      // 1. Submittal FF&E cover sheet with CG104-A
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-ffe-321')
        .query(true)
        .reply(200, {
          id: 'folder-ffe-321',
          name: '3 FFE',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/gdoc-ffe-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'gdoc-ffe-321',
          name: 'Berman_Falk',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['folder-ffe-321'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/gdoc-ffe-321')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, buildNx2GoogleDocPayload('gdoc-ffe-321', 'CG104-A'));

      const ffeRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'gdoc-ffe-321', title: 'Berman_Falk' }] },
        },
      });

      expect(ffeRes.statusCode).toBe(200);
      const ffeCard = JSON.parse(ffeRes.payload).action.navigations[0].pushCard;
      const ffeSec = ffeCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const getFfeText = (fieldKey: string) =>
        ffeSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
        )?.textInput?.value;
      const getFfeSel = (fieldKey: string) =>
        ffeSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

      expect(getFfeText('specTag')).toBe('CG104');
      expect(getFfeText('specTitle')).toBe('BED - KING');
      expect(getFfeText('revision')).toBe('A');
      expect(getFfeText('vendor')).toBe('BM');
      expect(getFfeText('date')).toBe('261118');
      expect(getFfeSel('status')).toBe('Open');
      expect(getFfeSel('action')).toBe('REC');

      // 2. Plain 0-widget prose Google Doc silently falls through to drive rules with zero error banners
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/gdoc-prose-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'gdoc-prose-321',
          name: '071200-003_Prose_Narrative',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/gdoc-prose-321')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, buildProseGoogleDocPayload('gdoc-prose-321'));

      const proseRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'gdoc-prose-321', title: '071200-003_Prose_Narrative' }] },
        },
      });

      expect(proseRes.statusCode).toBe(200);
      const proseCard = JSON.parse(proseRes.payload).action.navigations[0].pushCard;
      expect(JSON.stringify(proseCard)).not.toContain('Could not read Google Drive file metadata');
      expect(JSON.stringify(proseCard)).not.toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
      const proseSec = proseCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        proseSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');
      expect(
        proseSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput?.value
      ).toBe('003');
      expect(nock.isDone()).toBe(true);
    });

    it('resolves Drive shortcut to Google Doc and skips 0-widget candidates in multi-item selection', async () => {
      // 1. Shortcut pointing to a Google Doc cover sheet
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/shortcut-gdoc-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'shortcut-gdoc-321',
          name: 'Shortcut to Cover',
          mimeType: 'application/vnd.google-apps.shortcut',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          shortcutDetails: {
            targetId: 'target-gdoc-321',
            targetMimeType: 'application/vnd.google-apps.document',
          },
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/target-gdoc-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'target-gdoc-321',
          name: 'Submittal_Cover_Doc',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['folder-target-arch-321'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-target-arch-321')
        .query(true)
        .reply(200, {
          id: 'folder-target-arch-321',
          name: '6 Construction',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/target-gdoc-321')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, buildNx2GoogleDocPayload('target-gdoc-321', '092900-007-2'));

      const shortcutRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'shortcut-gdoc-321', title: 'Shortcut to Cover' }] },
        },
      });
      expect(shortcutRes.statusCode).toBe(200);
      const shortcutCard = JSON.parse(shortcutRes.payload).action.navigations[0].pushCard;
      const shortcutSec = shortcutCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        shortcutSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('092900');
      expect(
        shortcutSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput?.value
      ).toBe('007');
      expect(
        shortcutSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
        )?.textInput?.value
      ).toBe('2');

      // 2. Multi-item [Flat_Drawing.pdf, Stamped_Cover_Doc] skips 0-widget PDF and binds to Stamped_Cover_Doc
      const flatPdfBytes = Buffer.from(await (await PDFDocument.create()).save());
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/flat-pdf-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'flat-pdf-321',
          name: '071200-001_Flat_Drawing.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/flat-pdf-321')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBytes, { 'content-type': 'application/pdf' });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-gdoc-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'stamped-gdoc-321',
          name: 'Stamped_Cover_Doc',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/stamped-gdoc-321')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, buildNx2GoogleDocPayload('stamped-gdoc-321', '081100-012-A'));

      const multiRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'flat-pdf-321', title: '071200-001_Flat_Drawing.pdf' },
              { id: 'stamped-gdoc-321', title: 'Stamped_Cover_Doc' },
            ],
          },
        },
      });
      expect(multiRes.statusCode).toBe(200);
      const multiCard = JSON.parse(multiRes.payload).action.navigations[0].pushCard;
      const multiSec = multiCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        multiSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('081100');
      expect(
        multiSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput?.value
      ).toBe('012');
      expect(
        multiSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
        )?.textInput?.value
      ).toBe('A');
      expect(nock.isDone()).toBe(true);
    });

    it('degrades non-blockingly on Docs 403/503 transport failure and malformed 200 payload', async () => {
      // 1. Docs 403 -> single deduplicated DRIVE_METADATA_EXTRACT_ERROR_MESSAGE + Drive fallback still populates
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/gdoc-403-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'gdoc-403-321',
          name: '071200-004_Restricted_Cover',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/gdoc-403-321')
        .query(true)
        .reply(403, { error: { code: 403, message: 'Forbidden' } });

      const errRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'gdoc-403-321', title: '071200-004_Restricted_Cover' }] },
        },
      });
      expect(errRes.statusCode).toBe(200);
      const errCard = JSON.parse(errRes.payload).action.navigations[0].pushCard;
      const errCardJson = JSON.stringify(errCard);
      expect(errCardJson.split(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE).length - 1).toBe(1);
      const errSec = errCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        errSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');

      // 2. Malformed 200 payload -> DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE + Drive fallback still populates
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/gdoc-corrupt-321')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'gdoc-corrupt-321',
          name: '071200-005_Corrupt_Cover',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/gdoc-corrupt-321')
        .query(true)
        .reply(200, { documentId: 'gdoc-corrupt-321' });

      const corruptRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: 'gdoc-corrupt-321', title: '071200-005_Corrupt_Cover' }] },
        },
      });
      expect(corruptRes.statusCode).toBe(200);
      const corruptCard = JSON.parse(corruptRes.payload).action.navigations[0].pushCard;
      expect(JSON.stringify(corruptCard)).toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
      const corruptSec = corruptCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(corruptSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
      )?.textInput?.value).toBe('071200');
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #324: GoogleDocsClient resiliency & non-blocking source_error / corrupted degradation', () => {
    beforeEach(() => {
      nock.disableNetConnect();
    });

    afterEach(() => {
      nock.enableNetConnect();
    });

    it('renders DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE on malformed 200 Docs payload while Drive metadata still populates', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/gdoc-corrupt-324')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'gdoc-corrupt-324',
          name: '071200-008_Corrupt_Cover',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/gdoc-corrupt-324')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, { documentId: 'gdoc-corrupt-324', body: { content: null } });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-cred' },
          drive: { selectedItems: [{ id: 'gdoc-corrupt-324', title: '071200-008_Corrupt_Cover' }] },
        },
      });

      expect(res.statusCode).toBe(200);
      const pushCard = JSON.parse(res.payload).action.navigations[0].pushCard;
      const cardJson = JSON.stringify(pushCard);
      expect(cardJson).toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
      expect(cardJson).not.toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);

      const docSec = pushCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        docSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value
      ).toBe('071200');
      expect(
        docSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
        )?.textInput?.value
      ).toBe('008');
      expect(
        docSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
        )?.textInput?.value
      ).toBe('261118');
      expect(nock.isDone()).toBe(true);
    });

    it('renders at most one deduplicated DRIVE_METADATA_EXTRACT_ERROR_MESSAGE on permanent docs.googleapis.com 403 and 503 failures', async () => {
      for (const failure of [
        {
          id: 'gdoc-403-324',
          name: '071200-009_Forbidden_Cover',
          expectedNumber: '009',
          status: 403,
          body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } },
        },
        {
          id: 'gdoc-503-324',
          name: '071200-010_Unavailable_Cover',
          expectedNumber: '010',
          status: 503,
          body: { error: { code: 503, message: 'Service Unavailable' } },
        },
      ]) {
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${failure.id}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: failure.id,
            name: failure.name,
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get(`/v1/documents/${failure.id}`)
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(failure.status, failure.body);

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-cred' },
            drive: { selectedItems: [{ id: failure.id, title: failure.name }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const pushCard = JSON.parse(res.payload).action.navigations[0].pushCard;
        const cardJson = JSON.stringify(pushCard);
        expect(cardJson.split(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE).length - 1).toBe(1);

        const docSec = pushCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          docSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
        expect(
          docSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe(failure.expectedNumber);
        expect(nock.isDone()).toBe(true);
      }
    });

    it('suppresses Pass 2 source_error notice when Pass 1 already emitted DRIVE_ROUTING_FALLBACK_NOTICE and leaves manual card entry unblocked', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/gdoc-pass1-503-324')
        .query((q) => q.alt !== 'media')
        .reply(503, { error: { code: 503, message: 'Service Unavailable' } });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-cred' },
          drive: { selectedItems: [{ id: 'gdoc-pass1-503-324', title: '071200-011_Unavailable' }] },
        },
      });

      expect(res.statusCode).toBe(200);
      const pushCard = JSON.parse(res.payload).action.navigations[0].pushCard;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson.split(DRIVE_ROUTING_FALLBACK_NOTICE).length - 1).toBe(1);
      expect(cardJson).not.toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
      expect(cardJson).toContain('communication-project');
      expect(cardJson).toContain('Active Projects');
      expect(pushCard.sections.some((s: { header?: string }) => s.header === 'Document Data')).toBe(true);
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #322: Google Docs Submittal Response checkbox table pre-population, 0-checked REC preservation, cross-tab ambiguity & warning suppression', () => {
    const RESPONSE_LABELS = [
      'NO EXCEPTIONS TAKEN',
      'NO OBJECTIONS AS CORRECTED',
      'REVISE AND RESUBMIT',
      'REJECTED',
      'NOT REVIEWED',
    ] as const;

    beforeEach(() => {
      nock.disableNetConnect();
    });

    afterEach(() => {
      nock.enableNetConnect();
    });

    function buildSubmittalTab(options: {
      submittalNo?: string;
      checkedIndices?: number[];
      omitDisplayValue?: boolean;
      date?: string;
    }) {
      const checked = new Set(options.checkedIndices ?? []);
      const cell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
        content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
        ...(style ? { tableCellStyle: style } : {}),
      });

      return {
        documentTab: {
          dropdownDefinitions: {
            'kix.cb': {
              dropdownDefinitionId: 'kix.cb',
              dropdownDefinitionProperties: {
                title: 'Checkbox',
                options: [
                  { optionId: 'opt.off', displayValue: '☐' },
                  { optionId: 'opt.on', displayValue: '☑' },
                ],
              },
            },
          },
          body: {
            content: [
              { sectionBreak: {} },
              {
                table: {
                  rows: 1,
                  columns: 2,
                  tableRows: [
                    {
                      tableCells: [
                        cell('Submittal No.\n'),
                        cell(`${options.submittalNo ?? ''}\n`),
                      ],
                    },
                  ],
                },
              },
              { paragraph: { elements: [{ textRun: { content: '––––\n' } }] } },
              { paragraph: { elements: [{ textRun: { content: 'Submittal Response\n' } }] } },
              {
                table: {
                  rows: 6,
                  columns: 3,
                  tableRows: [
                    ...RESPONSE_LABELS.map((label, idx) => {
                      const isChecked = checked.has(idx);
                      const col2Cell =
                        idx === 0
                          ? cell('NET/NOC\n', { rowSpan: 2 })
                          : idx === 1
                            ? cell('\n')
                            : idx === 2
                              ? cell('RR/REJ\n', { rowSpan: 2 })
                              : cell('\n');
                      return {
                        tableCells: [
                          {
                            tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                            content: [
                              {
                                paragraph: {
                                  elements: [
                                    {
                                      dropdown: {
                                        dropdownId: `kix.dd.${idx}`,
                                        dropdownProperties: {
                                          dropdownDefinitionId: 'kix.cb',
                                          selectedOptionId: isChecked ? 'opt.on' : 'opt.off',
                                          displayValue: options.omitDisplayValue
                                            ? null
                                            : isChecked
                                              ? '☑'
                                              : '☐',
                                        },
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                          cell(`${label}\n`, { columnSpan: 1, rowSpan: 1 }),
                          col2Cell,
                        ],
                      };
                    }),
                    {
                      tableCells: [
                        cell('Disclaimer banner.\n', { columnSpan: 3, rowSpan: 1 }),
                        cell('\n'),
                        cell('\n'),
                      ],
                    },
                  ],
                },
              },
              ...(options.date !== undefined
                ? [
                    {
                      table: {
                        rows: 2,
                        columns: 2,
                        tableRows: [
                          {
                            tableCells: [cell('\n'), cell(`${options.date}\n`)],
                          },
                          {
                            tableCells: [cell('Reviewed By\n'), cell('Date\n')],
                          },
                        ],
                      },
                    },
                  ]
                : []),
            ],
          },
        },
      };
    }

    function mockDriveAndDocsForSubmittal(options: {
      docId: string;
      fileName: string;
      folderName: '6 Construction' | '3 FFE';
      tabs: Array<ReturnType<typeof buildSubmittalTab>>;
      mockDocs?: boolean;
    }) {
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/folder-${options.docId}`)
        .query(true)
        .reply(200, {
          id: `folder-${options.docId}`,
          name: options.folderName,
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${options.docId}`)
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: options.docId,
          name: options.fileName,
          mimeType: 'application/vnd.google-apps.document',
          parents: [`folder-${options.docId}`],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      if (options.mockDocs !== false) {
        nock('https://docs.googleapis.com', {
          reqheaders: { authorization: 'Bearer ya29.valid-oauth-token' },
        })
          .get(`/v1/documents/${options.docId}`)
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, {
            documentId: options.docId,
            body: null,
            tabs: options.tabs,
          });
      }
    }

    const readSelectedValue = (
      card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
      fieldKey: string,
      docTypeKey: string
    ) => {
      const docSec = card.sections.find((s) => s.header === 'Document Data');
      const widget = docSec?.widgets.find(
        (w) =>
          (w.selectionInput as { name?: string } | undefined)?.name ===
          getDocumentInfoWidgetName(fieldKey, docTypeKey)
      ) as { selectionInput?: { items: Array<{ value: string; selected?: boolean }> } } | undefined;
      return widget?.selectionInput?.items.find((i) => i.selected)?.value;
    };

    const readTextValue = (
      card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
      fieldKey: string,
      docTypeKey: string
    ) => {
      const docSec = card.sections.find((s) => s.header === 'Document Data');
      const widget = docSec?.widgets.find(
        (w) =>
          (w.textInput as { name?: string } | undefined)?.name ===
          getDocumentInfoWidgetName(fieldKey, docTypeKey)
      ) as { textInput?: { value?: string } } | undefined;
      return widget?.textInput?.value;
    };

    const readStatusText = (
      card: { sections: Array<{ widgets?: Array<{ textParagraph?: { text?: string } }> }> }
    ) =>
      card.sections
        .flatMap((s) => s.widgets ?? [])
        .map((w) => w.textParagraph?.text ?? '')
        .join('\n');

    it('pre-populates all 5 Submittal Response actions (NET, NOC, RR via valueMap, REJ, NR) across Submittal Arch and Submittal FF&E and preserves action: REC when 0-checked', async () => {
      const actionCases = [
        { checkedIndices: [], expectedAction: 'REC' },
        { checkedIndices: [0], expectedAction: 'NET' },
        { checkedIndices: [1], expectedAction: 'NOC' },
        { checkedIndices: [2], expectedAction: 'RR' },
        { checkedIndices: [3], expectedAction: 'REJ' },
        { checkedIndices: [4], expectedAction: 'NR' },
      ];

      for (const [idx, tc] of actionCases.entries()) {
        // Submittal Arch
        const archId = `gdoc-322-arch-${idx}`;
        mockDriveAndDocsForSubmittal({
          docId: archId,
          fileName: '071200-001_Waterproofing',
          folderName: '6 Construction',
          tabs: [
            buildSubmittalTab({
              submittalNo: '071200-001-1',
              checkedIndices: tc.checkedIndices,
              omitDisplayValue: idx % 2 === 1,
            }),
          ],
        });

        const archRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: archId, title: '071200-001_Waterproofing' }] },
          },
        });
        expect(archRes.statusCode).toBe(200);
        const archCard = JSON.parse(archRes.payload).action.navigations[0].pushCard;
        expect(readSelectedValue(archCard, 'action', 'submittal-arch'), archId).toBe(tc.expectedAction);
        expect(readTextValue(archCard, 'section', 'submittal-arch'), archId).toBe('071200');
        expect(readTextValue(archCard, 'number', 'submittal-arch'), archId).toBe('001');
        expect(readTextValue(archCard, 'revision', 'submittal-arch'), archId).toBe('1');
        expect(readStatusText(archCard)).not.toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );

        // Submittal FF&E
        const ffeId = `gdoc-322-ffe-${idx}`;
        mockDriveAndDocsForSubmittal({
          docId: ffeId,
          fileName: 'Berman_Falk',
          folderName: '3 FFE',
          tabs: [
            buildSubmittalTab({
              submittalNo: 'CG104-A',
              checkedIndices: tc.checkedIndices,
              omitDisplayValue: idx % 2 === 0,
            }),
          ],
        });

        const ffeRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: ffeId, title: 'Berman_Falk' }] },
          },
        });
        expect(ffeRes.statusCode).toBe(200);
        const ffeCard = JSON.parse(ffeRes.payload).action.navigations[0].pushCard;
        expect(readSelectedValue(ffeCard, 'action', 'submittal-ffe'), ffeId).toBe(tc.expectedAction);
        expect(readTextValue(ffeCard, 'specTag', 'submittal-ffe'), ffeId).toBe('CG104');
        expect(readTextValue(ffeCard, 'specTitle', 'submittal-ffe'), ffeId).toBe('BED - KING');
        expect(readTextValue(ffeCard, 'revision', 'submittal-ffe'), ffeId).toBe('A');
        expect(readStatusText(ffeCard)).not.toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );
      }

      expect(nock.isDone()).toBe(true);
    });

    it('renders formatAmbiguousFormFieldMessage for 2+ checked rows and cross-tab conflicts while still pre-populating Submittal No and Date', async () => {
      const ambiguousCases = [
        {
          id: 'gdoc-322-multi',
          tabs: [
            buildSubmittalTab({
              submittalNo: '071200-001-2',
              checkedIndices: [0, 3],
              date: '2026-11-21',
            }),
          ],
        },
        {
          id: 'gdoc-322-conflict-tabs',
          tabs: [
            buildSubmittalTab({
              submittalNo: '071200-001-2',
              checkedIndices: [0],
              date: '2026-11-21',
            }),
            buildSubmittalTab({ checkedIndices: [3] }),
          ],
        },
        {
          id: 'gdoc-322-one-then-multi',
          tabs: [
            buildSubmittalTab({
              submittalNo: '071200-001-2',
              checkedIndices: [0],
              date: '2026-11-21',
            }),
            buildSubmittalTab({ checkedIndices: [1, 2] }),
          ],
        },
        {
          id: 'gdoc-322-multi-then-one',
          tabs: [
            buildSubmittalTab({
              submittalNo: '071200-001-2',
              checkedIndices: [1, 2],
              date: '2026-11-21',
            }),
            buildSubmittalTab({ checkedIndices: [0] }),
          ],
        },
      ];

      for (const tc of ambiguousCases) {
        mockDriveAndDocsForSubmittal({
          docId: tc.id,
          fileName: 'Waterproofing_Stamped',
          folderName: '6 Construction',
          tabs: tc.tabs,
        });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: tc.id, title: 'Waterproofing_Stamped' }] },
          },
        });
        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        expect(readStatusText(card), tc.id).toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );
        expect(readSelectedValue(card, 'action', 'submittal-arch'), tc.id).toBe('REC');
        expect(readTextValue(card, 'section', 'submittal-arch'), tc.id).toBe('071200');
        expect(readTextValue(card, 'number', 'submittal-arch'), tc.id).toBe('001');
        expect(readTextValue(card, 'revision', 'submittal-arch'), tc.id).toBe('2');
        expect(readTextValue(card, 'date', 'submittal-arch'), tc.id).toBe('261121');
      }

      expect(nock.isDone()).toBe(true);
    });

    it('suppresses Submittal Response ambiguity warning when existingData.action is already populated (manual edit or round-trip revisit) while surfacing on initial load and fresh cross-type switch', async () => {
      mockAllowedDocumentTypes(manifestProvider, 'projects', [
        'communication-project',
        'submittal-arch',
        'submittal-ffe',
      ]);

      const docId = 'gdoc-322-switch-ambig';
      const ambigTabs = [
        buildSubmittalTab({ submittalNo: '071200-001-1', checkedIndices: [0, 3] }),
      ];

      // 1. Initial load -> warning surfaces
      mockDriveAndDocsForSubmittal({
        docId,
        fileName: '071200-001_Waterproofing',
        folderName: '6 Construction',
        tabs: ambigTabs,
      });

      const initialRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
        },
      });
      expect(initialRes.statusCode).toBe(200);
      const initialCard = JSON.parse(initialRes.payload).action.navigations[0].pushCard;
      expect(readStatusText(initialCard)).toContain(
        formatAmbiguousFormFieldMessage('Submittal Response')
      );

      // 2. Round-trip revisit (Submittal Arch -> Communication - Project -> Submittal Arch) where submittal-arch action='REC' is in formInputs -> suppressed
      mockDriveAndDocsForSubmittal({
        docId,
        fileName: '071200-001_Waterproofing',
        folderName: '6 Construction',
        tabs: ambigTabs,
        mockDocs: false,
      });
      const toCommRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Projects Shared Drive 001'] },
              },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['communication-project'] },
              },
              SelectFiles: { stringInputs: { value: [docId] } },
              [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                stringInputs: { value: ['REC'] },
              },
            },
          },
        },
      });
      expect(toCommRes.statusCode).toBe(200);
      const toCommCard = JSON.parse(toCommRes.payload).action.navigations[0].updateCard;
      expect(readStatusText(toCommCard)).not.toContain(
        formatAmbiguousFormFieldMessage('Submittal Response')
      );

      mockDriveAndDocsForSubmittal({
        docId,
        fileName: '071200-001_Waterproofing',
        folderName: '6 Construction',
        tabs: ambigTabs,
      });

      const revisitRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Projects Shared Drive 001'] },
              },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['submittal-arch'] },
              },
              SelectFiles: { stringInputs: { value: [docId] } },
              [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                stringInputs: { value: ['REC'] },
              },
            },
          },
        },
      });
      expect(revisitRes.statusCode).toBe(200);
      const revisitCard = JSON.parse(revisitRes.payload).action.navigations[0].updateCard;
      expect(readStatusText(revisitCard)).not.toContain(
        formatAmbiguousFormFieldMessage('Submittal Response')
      );

      // 3. Manual edit (user chose action='NET' on submittal-arch) -> suppressed and preserves 'NET'
      mockDriveAndDocsForSubmittal({
        docId,
        fileName: '071200-001_Waterproofing',
        folderName: '6 Construction',
        tabs: ambigTabs,
      });

      const manualEditRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Projects Shared Drive 001'] },
              },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['submittal-arch'] },
              },
              SelectFiles: { stringInputs: { value: [docId] } },
              [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                stringInputs: { value: ['NET'] },
              },
            },
          },
        },
      });
      expect(manualEditRes.statusCode).toBe(200);
      const manualEditCard = JSON.parse(manualEditRes.payload).action.navigations[0].updateCard;
      expect(readStatusText(manualEditCard)).not.toContain(
        formatAmbiguousFormFieldMessage('Submittal Response')
      );
      expect(readSelectedValue(manualEditCard, 'action', 'submittal-arch')).toBe('NET');

      // 4. Fresh cross-type switch (Submittal Arch -> Submittal FF&E, where submittal-ffe has no existingData.action) -> warning surfaces!
      mockDriveAndDocsForSubmittal({
        docId,
        fileName: 'Berman_Falk',
        folderName: '6 Construction',
        tabs: [buildSubmittalTab({ submittalNo: 'CG104-A', checkedIndices: [0, 3] })],
      });

      const crossSwitchRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: docId, title: 'Berman_Falk' }] },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Projects Shared Drive 001'] },
              },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['submittal-ffe'] },
              },
              SelectFiles: { stringInputs: { value: [docId] } },
              // Previous submittal-arch inputs present, none for submittal-ffe
              [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                stringInputs: { value: ['REC'] },
              },
            },
          },
        },
      });
      expect(crossSwitchRes.statusCode).toBe(200);
      const crossSwitchCard = JSON.parse(crossSwitchRes.payload).action.navigations[0].updateCard;
      expect(readStatusText(crossSwitchCard)).toContain(
        formatAmbiguousFormFieldMessage('Submittal Response')
      );
      expect(readTextValue(crossSwitchCard, 'specTag', 'submittal-ffe')).toBe('CG104');
      expect(readSelectedValue(crossSwitchCard, 'action', 'submittal-ffe')).toBe('REC');

      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #323: Full 5-pattern live Google Docs cover-sheet pre-population, DateElement/typed dates, and multi-item memoization', () => {
    const RESPONSE_LABELS = [
      'NO EXCEPTIONS TAKEN',
      'NO OBJECTIONS AS CORRECTED',
      'REVISE AND RESUBMIT',
      'REJECTED',
      'NOT REVIEWED',
    ] as const;

    beforeEach(() => {
      nock.disableNetConnect();
    });

    afterEach(() => {
      nock.enableNetConnect();
    });

    function buildFullCoverSheetDoc(options: {
      documentId: string;
      submittalNo?: string;
      checkedIndex?: number;
      remarks?: string;
      reviewerName?: string;
      dateCellElements?: Array<Record<string, unknown>>;
    }) {
      const cell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
        content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
        ...(style ? { tableCellStyle: style } : {}),
      });

      return {
        documentId: options.documentId,
        body: null,
        tabs: [
          {
            documentTab: {
              dropdownDefinitions: {
                'kix.cb': {
                  dropdownDefinitionId: 'kix.cb',
                  dropdownDefinitionProperties: {
                    title: 'Checkbox',
                    options: [
                      { optionId: 'opt.off', displayValue: '☐' },
                      { optionId: 'opt.on', displayValue: '☑' },
                    ],
                  },
                },
              },
              body: {
                content: [
                  { sectionBreak: {} },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 1,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            cell('Submittal No.\n', { columnSpan: 1, rowSpan: 1 }),
                            cell(`${options.submittalNo ?? ''}\n`, { columnSpan: 1, rowSpan: 1 }),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '––––\n' } }] } },
                  { paragraph: { elements: [{ textRun: { content: 'Submittal Response\n' } }] } },
                  {
                    table: {
                      rows: 6,
                      columns: 3,
                      tableRows: [
                        ...RESPONSE_LABELS.map((label, idx) => {
                          const isChecked = options.checkedIndex === idx;
                          const col2 =
                            idx === 0
                              ? cell('NET/NOC Legend\n', { rowSpan: 2 })
                              : idx === 2
                                ? cell('RR/REJ Legend\n', { rowSpan: 2 })
                                : cell('\n');
                          return {
                            tableCells: [
                              {
                                tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                content: [
                                  {
                                    paragraph: {
                                      elements: [
                                        {
                                          dropdown: {
                                            dropdownId: `kix.dd.${idx}`,
                                            dropdownProperties: {
                                              dropdownDefinitionId: 'kix.cb',
                                              selectedOptionId: isChecked ? 'opt.on' : 'opt.off',
                                              displayValue: isChecked ? '☑' : '☐',
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                ],
                              },
                              cell(`${label}\n`, { columnSpan: 1, rowSpan: 1 }),
                              col2,
                            ],
                          };
                        }),
                        {
                          tableCells: [
                            cell('Disclaimer banner.\n', { columnSpan: 3, rowSpan: 1 }),
                            cell('\n'),
                            cell('\n'),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [cell('REMARKS\n', { columnSpan: 1, rowSpan: 1 })] },
                        { tableCells: [cell(`${options.remarks ?? ''}\n`, { columnSpan: 1, rowSpan: 1 })] },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 2,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            options.reviewerName
                              ? {
                                  tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                  content: [
                                    {
                                      paragraph: {
                                        elements: [
                                          { person: { personProperties: { name: options.reviewerName } } },
                                        ],
                                      },
                                    },
                                  ],
                                }
                              : cell('\n', { columnSpan: 1, rowSpan: 1 }),
                            {
                              tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                              content: [
                                {
                                  paragraph: {
                                    elements: options.dateCellElements ?? [{ textRun: { content: '\uE907\n' } }],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            cell('Reviewed By\n', { columnSpan: 1, rowSpan: 1 }),
                            cell('Date\n', { columnSpan: 1, rowSpan: 1 }),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                ],
              },
            },
          },
        ],
      };
    }

    function mockDriveAndDocsForCoverSheet(options: {
      docId: string;
      fileName: string;
      folderName: '6 Construction' | '3 FFE';
      modifiedTime?: string;
      docPayload: Record<string, unknown>;
    }) {
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/folder-${options.docId}`)
        .query(true)
        .reply(200, {
          id: `folder-${options.docId}`,
          name: options.folderName,
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${options.docId}`)
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: options.docId,
          name: options.fileName,
          mimeType: 'application/vnd.google-apps.document',
          parents: [`folder-${options.docId}`],
          driveId: 'projects-shared-drive-001',
          modifiedTime: options.modifiedTime ?? '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com', {
        reqheaders: { authorization: 'Bearer ya29.valid-oauth-token' },
      })
        .get(`/v1/documents/${options.docId}`)
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, options.docPayload);
    }

    const readText = (
      card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
      fieldKey: string,
      docTypeKey: string
    ) => {
      const docSec = card.sections.find((s) => s.header === 'Document Data');
      const widget = docSec?.widgets.find(
        (w) =>
          (w.textInput as { name?: string } | undefined)?.name ===
          getDocumentInfoWidgetName(fieldKey, docTypeKey)
      ) as { textInput?: { value?: string } } | undefined;
      return widget?.textInput?.value;
    };

    const readSelected = (
      card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
      fieldKey: string,
      docTypeKey: string
    ) => {
      const docSec = card.sections.find((s) => s.header === 'Document Data');
      const widget = docSec?.widgets.find(
        (w) =>
          (w.selectionInput as { name?: string } | undefined)?.name ===
          getDocumentInfoWidgetName(fieldKey, docTypeKey)
      ) as { selectionInput?: { items: Array<{ value: string; selected?: boolean }> } } | undefined;
      return widget?.selectionInput?.items.find((i) => i.selected)?.value;
    };

    it('pre-populates stamped Submittal Arch cover sheet (DateElement, Submittal No, NOC action, title from drive, REMARKS/Reviewed By unmapped, single documents.get call)', async () => {
      const docId = 'gdoc-323-stamped-arch';
      mockDriveAndDocsForCoverSheet({
        docId,
        fileName: '071200-001_Waterproofing_Cover_Sheet',
        folderName: '6 Construction',
        modifiedTime: '2026-11-18T15:00:00Z',
        docPayload: buildFullCoverSheetDoc({
          documentId: docId,
          submittalNo: '071200-001-1',
          checkedIndex: 1,
          remarks: 'Confirm membrane overlap at parapet.',
          reviewerName: 'Jane Architect',
          dateCellElements: [
            {
              dateElement: {
                dateElementProperties: {
                  timestamp: '2026-11-21T00:00:00Z',
                  timeZoneId: 'UTC',
                },
              },
            },
          ],
        }),
      });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing_Cover_Sheet' }] },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = JSON.parse(res.payload).action.navigations[0].pushCard;
      expect(readText(card, 'section', 'submittal-arch')).toBe('071200');
      expect(readText(card, 'number', 'submittal-arch')).toBe('001');
      expect(readText(card, 'revision', 'submittal-arch')).toBe('1');
      expect(readSelected(card, 'action', 'submittal-arch')).toBe('NOC');
      expect(readText(card, 'date', 'submittal-arch')).toBe('261121');
      expect(readText(card, 'title', 'submittal-arch')).toBe('Waterproofing Cover Sheet');
      expect(readSelected(card, 'status', 'submittal-arch')).toBe('Open');
      expect(readText(card, 'notes', 'submittal-arch') ?? '').toBe('');
      expect(nock.isDone()).toBe(true);
    });

    it('pre-populates stamped Submittal FF&E cover sheet across typed date formats and preserves action: REC + drive.modifiedTime on unreviewed template', async () => {
      const ffeDateCases = [
        { rawDate: '5/8/26', expectedYymmdd: '260508' },
        { rawDate: '11/21/2026', expectedYymmdd: '261121' },
        { rawDate: 'Sept 8, 2026', expectedYymmdd: '260908' },
        { rawDate: '2026-11-21', expectedYymmdd: '261121' },
      ];

      for (const [idx, tc] of ffeDateCases.entries()) {
        const docId = `gdoc-323-stamped-ffe-${idx}`;
        mockDriveAndDocsForCoverSheet({
          docId,
          fileName: 'Berman_Falk',
          folderName: '3 FFE',
          modifiedTime: '2026-11-18T15:00:00Z',
          docPayload: buildFullCoverSheetDoc({
            documentId: docId,
            submittalNo: 'CG104-A',
            checkedIndex: 2,
            remarks: 'Submit walnut finish sample.',
            reviewerName: 'Sam Designer',
            dateCellElements: [{ textRun: { content: `${tc.rawDate}\n` } }],
          }),
        });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: docId, title: 'Berman_Falk' }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        expect(readText(card, 'specTag', 'submittal-ffe'), tc.rawDate).toBe('CG104');
        expect(readText(card, 'specTitle', 'submittal-ffe'), tc.rawDate).toBe('BED - KING');
        expect(readText(card, 'revision', 'submittal-ffe'), tc.rawDate).toBe('A');
        expect(readSelected(card, 'action', 'submittal-ffe'), tc.rawDate).toBe('RR');
        expect(readText(card, 'date', 'submittal-ffe'), tc.rawDate).toBe(tc.expectedYymmdd);
        expect(readText(card, 'vendor', 'submittal-ffe'), tc.rawDate).toBe('BM');
      }

      // Unreviewed template (0 checked ☐ + \uE907 Date Placeholder) keeps action: "REC" and falls through date to drive.modifiedTime
      const unreviewedId = 'gdoc-323-unreviewed-ffe';
      mockDriveAndDocsForCoverSheet({
        docId: unreviewedId,
        fileName: 'Berman_Falk',
        folderName: '3 FFE',
        modifiedTime: '2026-11-18T15:00:00Z',
        docPayload: buildFullCoverSheetDoc({
          documentId: unreviewedId,
          submittalNo: 'CG104-A',
        }),
      });

      const unreviewedRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: { selectedItems: [{ id: unreviewedId, title: 'Berman_Falk' }] },
        },
      });

      expect(unreviewedRes.statusCode).toBe(200);
      const unreviewedCard = JSON.parse(unreviewedRes.payload).action.navigations[0].pushCard;
      expect(readSelected(unreviewedCard, 'action', 'submittal-ffe')).toBe('REC');
      expect(readText(unreviewedCard, 'date', 'submittal-ffe')).toBe('261118');
      expect(readText(unreviewedCard, 'specTag', 'submittal-ffe')).toBe('CG104');
      expect(readText(unreviewedCard, 'specTitle', 'submittal-ffe')).toBe('BED - KING');
      expect(readText(unreviewedCard, 'vendor', 'submittal-ffe')).toBe('BM');
      expect(nock.isDone()).toBe(true);
    });

    it('skips 0-widget candidates in [Plain_Narrative_Doc, Stamped_Cover_Doc] and [Flat_Drawing.pdf, Stamped_Cover_Doc] with per-mimeType:id memoization', async () => {
      // 1. [Plain_Narrative_Doc, Stamped_Cover_Doc]
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/plain-narrative-323')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'plain-narrative-323',
          name: 'Plain_Narrative_Doc',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/plain-narrative-323')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, {
          documentId: 'plain-narrative-323',
          body: null,
          tabs: [
            {
              documentTab: {
                body: {
                  content: [{ paragraph: { elements: [{ textRun: { content: 'Narrative only.\n' } }] } }],
                },
              },
            },
          ],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-cover-doc-323a')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'stamped-cover-doc-323a',
          name: 'Stamped_Cover_Doc',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['folder-const-323a'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-const-323a')
        .query(true)
        .reply(200, {
          id: 'folder-const-323a',
          name: '6 Construction',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          mimeType: 'application/vnd.google-apps.folder',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/stamped-cover-doc-323a')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(
          200,
          buildFullCoverSheetDoc({
            documentId: 'stamped-cover-doc-323a',
            submittalNo: '071200-004-2',
            checkedIndex: 1,
            dateCellElements: [{ textRun: { content: '2026-11-21\n' } }],
          })
        );

      const docPairRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'plain-narrative-323', title: 'Plain_Narrative_Doc' },
              { id: 'stamped-cover-doc-323a', title: 'Stamped_Cover_Doc' },
            ],
          },
        },
      });
      expect(docPairRes.statusCode).toBe(200);
      const docPairCard = JSON.parse(docPairRes.payload).action.navigations[0].pushCard;
      expect(readText(docPairCard, 'section', 'submittal-arch')).toBe('071200');
      expect(readText(docPairCard, 'number', 'submittal-arch')).toBe('004');
      expect(readText(docPairCard, 'revision', 'submittal-arch')).toBe('2');
      expect(readSelected(docPairCard, 'action', 'submittal-arch')).toBe('NOC');
      expect(readText(docPairCard, 'date', 'submittal-arch')).toBe('261121');

      // 2. [Flat_Drawing.pdf, Stamped_Cover_Doc]
      const flatPdfBytes = Buffer.from(await (await PDFDocument.create()).save());
      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/flat-drawing-323')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'flat-drawing-323',
          name: '071200-001_Flat_Drawing.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/flat-drawing-323')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBytes, { 'content-type': 'application/pdf' });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/stamped-cover-doc-323b')
        .query((q) => q.alt !== 'media')
        .reply(200, {
          id: 'stamped-cover-doc-323b',
          name: 'Stamped_Cover_Doc',
          mimeType: 'application/vnd.google-apps.document',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
      nock('https://docs.googleapis.com')
        .get('/v1/documents/stamped-cover-doc-323b')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(
          200,
          buildFullCoverSheetDoc({
            documentId: 'stamped-cover-doc-323b',
            submittalNo: '081100-012-A',
            checkedIndex: 0,
            dateCellElements: [
              {
                dateElement: {
                  dateElementProperties: {
                    timestamp: '2026-11-22T02:00:00Z',
                    timeZoneId: 'America/New_York',
                  },
                },
              },
            ],
          })
        );

      const mixedPairRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'flat-drawing-323', title: '071200-001_Flat_Drawing.pdf' },
              { id: 'stamped-cover-doc-323b', title: 'Stamped_Cover_Doc' },
            ],
          },
        },
      });
      expect(mixedPairRes.statusCode).toBe(200);
      const mixedPairCard = JSON.parse(mixedPairRes.payload).action.navigations[0].pushCard;
      expect(readText(mixedPairCard, 'section', 'submittal-arch')).toBe('081100');
      expect(readText(mixedPairCard, 'number', 'submittal-arch')).toBe('012');
      expect(readText(mixedPairCard, 'revision', 'submittal-arch')).toBe('A');
      expect(readSelected(mixedPairCard, 'action', 'submittal-arch')).toBe('NET');
      expect(readText(mixedPairCard, 'date', 'submittal-arch')).toBe('261121');
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Initial-load SelectFiles preservation across Pass 1 routing mutations', () => {
    it('keeps SelectFiles checked on initial Shared Drive load when Pass 1 infers projects + space, and extracts Submittal Arch fields on follow-up onDocumentTypeChange', async () => {
      const flatPdfBuffer = Buffer.from(await (await PDFDocument.create()).save());

      function mockDriveHierarchy() {
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-initial-submittal-1')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'file-initial-submittal-1',
            name: '07 12 00 - 1_v1_Waterproofing.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-comm-initial-1'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-comm-initial-1')
          .query(true)
          .reply(200, {
            id: 'folder-comm-initial-1',
            name: 'Communication',
            parents: ['folder-admin-initial-1'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-admin-initial-1')
          .query(true)
          .reply(200, {
            id: 'folder-admin-initial-1',
            name: '1 Admin',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
      }

      // Step 1 mocks: Pass 1 infers projects + Projects Shared Drive 001 + communication-project from 1 Admin/Communication hierarchy
      mockDriveHierarchy();

      const step1Res = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-initial-submittal-1', title: '07 12 00 - 1_v1_Waterproofing.pdf' },
            ],
          },
        },
      });

      expect(step1Res.statusCode).toBe(200);
      const pushCard = JSON.parse(step1Res.payload).action.navigations[0].pushCard;
      const docTypeSec1 = pushCard.sections.find((s: { header?: string }) => s.header === 'Document Type');
      expect(
        docTypeSec1.widgets
          .find((w: { selectionInput?: { name?: string } }) => w.selectionInput?.name === 'SelectDocumentSpaceType')
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
      ).toBe('projects');
      expect(
        docTypeSec1.widgets.find(
          (w: { textInput?: { name?: string } }) => w.textInput?.name === getDocumentSpaceWidgetName('projects')
        )?.textInput?.value
      ).toBe('Projects Shared Drive 001');
      expect(
        docTypeSec1.widgets
          .find(
            (w: { selectionInput?: { name?: string } }) =>
              w.selectionInput?.name === getDocumentTypeWidgetName('projects')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
      ).toBe('communication-project');

      const fileSelSec1 = pushCard.sections.find((s: { header?: string }) => s.header === 'File Selection');
      const selectFiles1 = fileSelSec1.widgets.find(
        (w: { selectionInput?: { name?: string } }) => w.selectionInput?.name === 'SelectFiles'
      )?.selectionInput;
      expect(selectFiles1?.items).toEqual([
        { text: '07 12 00 - 1_v1_Waterproofing.pdf', value: 'file-initial-submittal-1', selected: true },
      ]);

      // Step 2 mocks: Follow-up onDocumentTypeChange to submittal-arch runs Pass 2 (form ?alt=media + drive hierarchy/metadata)
      mockDriveHierarchy();

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-initial-submittal-1')
        .query((q) => q.alt === 'media')
        .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

      const checkedIds = selectFiles1.items
        .filter((i: { selected?: boolean }) => i.selected)
        .map((i: { value: string }) => i.value);

      const step2Res = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-initial-submittal-1', title: '07 12 00 - 1_v1_Waterproofing.pdf' },
            ],
          },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Projects Shared Drive 001'] },
              },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['submittal-arch'] },
              },
              SelectFiles: { stringInputs: { value: checkedIds } },
            },
          },
        },
      });

      expect(step2Res.statusCode).toBe(200);
      const updateCard = JSON.parse(step2Res.payload).action.navigations[0].updateCard;
      const fileSelSec2 = updateCard.sections.find((s: { header?: string }) => s.header === 'File Selection');
      const selectFiles2 = fileSelSec2.widgets.find(
        (w: { selectionInput?: { name?: string } }) => w.selectionInput?.name === 'SelectFiles'
      )?.selectionInput;
      expect(selectFiles2?.items).toEqual([
        { text: '07 12 00 - 1_v1_Waterproofing.pdf', value: 'file-initial-submittal-1', selected: true },
      ]);

      const docDataSec2 = updateCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const getTextVal = (field: string) =>
        docDataSec2.widgets.find(
          (w: { textInput?: { name?: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
        )?.textInput?.value;

      expect(getTextVal('section')).toBe('071200');
      expect(getTextVal('number')).toBe('001');
      expect(getTextVal('revision')).toBe('0');
      expect(getTextVal('title')).toBe('Waterproofing');
      expect(getTextVal('date')).toBe('261118');
      expect(nock.isDone()).toBe(true);
    });
  });
});

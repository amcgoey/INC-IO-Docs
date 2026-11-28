import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import type { AppInstance } from '../src/app/server';
import { GoogleDriveClient, GoogleDriveApiError } from '../src/infrastructure/drive/drive-client';
import {
  createDriveIntegrationContext,
  getCachedFlatPdfBuffer,
  mockDocumentLogSearch,
} from './utils/workspace-drive-test-helper';

describe('Workspace-to-Drive E2E: Selection & Pass 1 Routing', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  describe('Driving Adapter: POST /workspace/drive-items-selected (read-only manifest)', () => {
    let app: AppInstance;

    beforeAll(async () => {
      ({ app } = await createDriveIntegrationContext());
    });

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
  });

  describe('Driving Adapter: POST /workspace/drive-items-selected (Drive prototype spies)', () => {
    let app: AppInstance;

    beforeEach(async () => {
      ({ app } = await createDriveIntegrationContext());
    });

    it('infers submittal-arch from CSI filename in unmatched folder on drive-items-selected (Ticket #291)', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
      const flatPdfBytes = await getCachedFlatPdfBuffer();
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
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
      const flatPdfBytes = await getCachedFlatPdfBuffer();
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
        mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
        const flatPdfBytes = await getCachedFlatPdfBuffer();
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
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
      const flatPdfBytes = await getCachedFlatPdfBuffer();
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
});

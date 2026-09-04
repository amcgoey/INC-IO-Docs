import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { AuthVerifierPort, AuthVerificationResult } from '../src/features/workspace/ports';
import { GoogleDriveClient } from '../src/infrastructure/drive/drive-client';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';

describe('Workspace-to-Drive E2E Integration (Happy Path)', () => {
  let app: AppInstance;
  let mockAuthVerifier: AuthVerifierPort;

  beforeEach(async () => {
    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string): Promise<AuthVerificationResult> => {
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

    const manifestPath = path.resolve(__dirname, 'fixtures/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
    });

    await app.initialize();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('Driving Adapter: POST /workspace/homepage', () => {
    it('returns a Google Workspace Card with a "Move Selected File" button', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/homepage',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const cardResponse = JSON.parse(response.payload);

      expect(cardResponse.action).toBeDefined();
      const pushCard = cardResponse.action.navigations[0].pushCard;
      expect(pushCard.header.title).toBe('INC-IO Docs');

      const buttons = pushCard.sections[0].widgets[0].buttonList.buttons;
      expect(buttons).toHaveLength(1);
      expect(buttons[0].text).toBe('Move Selected File');
      expect(buttons[0].onClick.action.actionMethodName).toBe('moveSelectedFile');
    });

    it('returns 401 Unauthorized when JWT token is invalid or missing', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/homepage',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
    });
  });

  describe('Driving Adapter: POST /workspace/action with nock Google Drive API Interception', () => {
    it('extracts context, executes DriveActivityHandler, moves file to !TestMove, and returns Toast Notification', async () => {
      const fileId = 'google-doc-file-456';
      const fileName = 'Contract_Agreement.pdf';
      const currentParentId = 'client-root-folder-001';
      const testMoveFolderId = 'test-move-subfolder-888';

      // 1. Mock GET file metadata (called by DriveActivityHandler and GoogleDriveClient.move)
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}?fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`)
        .times(2)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [currentParentId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      // 2. Mock list files to find existing !TestMove folder (simulate none found)
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((query) => {
          return (
            typeof query.q === 'string' &&
            query.q.includes(`'${currentParentId}' in parents`) &&
            query.q.includes("name = '!TestMove'")
          );
        })
        .reply(200, {
          files: [],
        });

      // 3. Mock create !TestMove folder
      nock('https://www.googleapis.com')
        .post('/drive/v3/files?fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true', {
          name: '!TestMove',
          mimeType: 'application/vnd.google-apps.folder',
          parents: [currentParentId],
        })
        .reply(200, {
          id: testMoveFolderId,
          name: '!TestMove',
          parents: [currentParentId],
          mimeType: 'application/vnd.google-apps.folder',
          webViewLink: `https://drive.google.com/drive/folders/${testMoveFolderId}`,
        });

      // 4. Mock move file (update with addParents & removeParents)
      nock('https://www.googleapis.com')
        .patch(
          `/drive/v3/files/${fileId}?addParents=${testMoveFolderId}&removeParents=${currentParentId}&fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`
        )
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [testMoveFolderId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      // Synthetic Workspace Event Payload
      const syntheticWorkspaceEvent = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.synthetic-user-oauth-token',
        },
        userEmail: 'contractor@example.com',
        commonEventObject: {
          hostApp: 'DRIVE',
          platform: 'WEB',
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
      };

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
          'x-cloud-trace-context': 'trace-test-12345',
        },
        payload: syntheticWorkspaceEvent,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      // Verify Google Workspace Toast Notification structure
      expect(body).toEqual({
        action: {
          notification: {
            text: `Moved '${fileName}' to '!TestMove'`,
          },
        },
      });

      expect(nock.isDone()).toBe(true);
    });

    it('reuses existing !TestMove folder when one already exists', async () => {
      const fileId = 'file-existing-test';
      const fileName = 'ExistingTest.docx';
      const currentParentId = 'folder-p1';
      const existingFolderId = 'folder-testmove-already-present';

      // 1. Mock GET file metadata (called by DriveActivityHandler and GoogleDriveClient.move)
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}?fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`)
        .times(2)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [currentParentId],
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      // 2. Mock list files returning existing !TestMove
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query(true)
        .reply(200, {
          files: [
            {
              id: existingFolderId,
              name: '!TestMove',
              parents: [currentParentId],
              webViewLink: `https://drive.google.com/drive/folders/${existingFolderId}`,
            },
          ],
        });

      // 3. Mock move file
      nock('https://www.googleapis.com')
        .patch(
          `/drive/v3/files/${fileId}?addParents=${existingFolderId}&removeParents=${currentParentId}&fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`
        )
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [existingFolderId],
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      const syntheticPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.token-123',
        },
        drive: {
          selectedItems: [
            {
              id: fileId,
              title: fileName,
            },
          ],
        },
      };

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: syntheticPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          notification: {
            text: `Moved '${fileName}' to '!TestMove'`,
          },
        },
      });

      expect(nock.isDone()).toBe(true);
    });

    it('returns 401 Unauthorized for action endpoint without valid Bearer token', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer bad-token',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
    });

    it('returns 200 with AuthorizationAction when userOAuthToken is missing in action payload', async () => {
      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt-token',
        },
        payload: {
          commonEventObject: { hostApp: 'DRIVE' },
          drive: {
            selectedItems: [{ id: 'doc-123', title: 'File.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          authorizationAction: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          },
        },
      });
    });

    it('retries on 429 rate limit from Google Drive API with backoff and succeeds', async () => {
      const fileId = 'retry-file-429';
      const fileName = 'RateLimitedDoc.pdf';
      const currentParentId = 'parent-p1';
      const targetFolderId = 'folder-target';

      // 1. First GET returns 429 Too Many Requests
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}?fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`)
        .reply(429, {
          error: {
            code: 429,
            message: 'User rate limit exceeded',
          },
        });

      // 2. Second GET (retry for DriveActivityHandler) succeeds with 200
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}?fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [currentParentId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      // 3. Third GET (for GoogleDriveClient.move) succeeds with 200
      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}?fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`)
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [currentParentId],
          mimeType: 'application/pdf',
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      // 3. List folders returns existing !TestMove folder
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query(true)
        .reply(200, {
          files: [
            {
              id: targetFolderId,
              name: '!TestMove',
              parents: [currentParentId],
              webViewLink: `https://drive.google.com/drive/folders/${targetFolderId}`,
            },
          ],
        });

      // 4. Move file succeeds
      nock('https://www.googleapis.com')
        .patch(
          `/drive/v3/files/${fileId}?addParents=${targetFolderId}&removeParents=${currentParentId}&fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`
        )
        .reply(200, {
          id: fileId,
          name: fileName,
          parents: [targetFolderId],
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        });

      const manifestProvider = new AppManifestProvider({
        manifestPath: path.resolve(__dirname, 'fixtures/manifest.json'),
      });
      const fastRetryApp = createApp({
        manifestProvider,
        authVerifier: mockAuthVerifier,
        driveService: new GoogleDriveClient({
          configProvider: manifestProvider,
          retryOptions: {
            maxRetries: 3,
            initialDelayMs: 10,
            backoffFactor: 1.5,
          },
        }),
      });

      await fastRetryApp.initialize();

      const response = await fastRetryApp.server.inject({
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
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          notification: {
            text: `Moved '${fileName}' to '!TestMove'`,
          },
        },
      });
      expect(nock.isDone()).toBe(true);
    });

    it('bubbles unhandled Google Drive API errors (e.g. 403 Forbidden) into a native Workspace UI Error Card', async () => {
      const fileId = 'forbidden-file';

      nock('https://www.googleapis.com')
        .get(`/drive/v3/files/${fileId}?fields=id%2C%20name%2C%20parents%2C%20mimeType%2C%20webViewLink&supportsAllDrives=true`)
        .reply(403, {
          error: {
            code: 403,
            message: 'The user does not have sufficient permissions for this file.',
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
            selectedItems: [
              {
                id: fileId,
                title: 'ForbiddenFile.pdf',
              },
            ],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action).toBeDefined();
      expect(body.action.notification.text).toContain(
        'Google Drive API error in getFile'
      );
      expect(
        body.action.navigations[0].pushCard.sections[0].widgets[0].textParagraph.text
      ).toContain('Google Drive API error in getFile');
      expect(nock.isDone()).toBe(true);
    });
  });
});


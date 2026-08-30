import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDriveClient, GoogleDriveApiError } from './drive-client';
import { google, type drive_v3 } from 'googleapis';

describe('GoogleDriveClient', () => {
  let mockDrive: drive_v3.Drive;
  let client: GoogleDriveClient;

  beforeEach(() => {
    mockDrive = {
      files: {
        get: vi.fn(),
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as drive_v3.Drive;

    client = new GoogleDriveClient({ drive: mockDrive });
  });

  describe('getFile', () => {
    it('returns file metadata when file is found', async () => {
      (mockDrive.files.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'file-123',
          name: 'Project Plan.pdf',
          parents: ['parent-folder-abc'],
          mimeType: 'application/pdf',
        },
      });

      const file = await client.getFile('file-123');

      expect(file).toEqual({
        id: 'file-123',
        name: 'Project Plan.pdf',
        parents: ['parent-folder-abc'],
        mimeType: 'application/pdf',
      });
      expect(mockDrive.files.get).toHaveBeenCalledWith({
        fileId: 'file-123',
        fields: 'id, name, parents, mimeType',
        supportsAllDrives: true,
      });
    });

    it('throws error if file metadata is incomplete or missing', async () => {
      (mockDrive.files.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {},
      });

      await expect(client.getFile('invalid-id')).rejects.toThrow(
        /Failed to retrieve file metadata for fileId 'invalid-id'/
      );
    });

    it('throws error if Drive API fails', async () => {
      (mockDrive.files.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('404 Not Found')
      );

      await expect(client.getFile('missing-file')).rejects.toThrow(
        /Google Drive API error in getFile: 404 Not Found/
      );
    });

    it('accepts options with custom auth token and invokes drive client', async () => {
      const customDriveMock = {
        files: {
          get: vi.fn().mockResolvedValue({
            data: {
              id: 'file-auth-123',
              name: 'Secure.pdf',
              parents: ['p1'],
            },
          }),
        },
      };
      const driveSpy = vi.spyOn(google, 'drive').mockReturnValue(customDriveMock as unknown as drive_v3.Drive);

      const file = await client.getFile('file-auth-123', { auth: 'ya29.custom-token' });
      expect(file).toEqual({
        id: 'file-auth-123',
        name: 'Secure.pdf',
        parents: ['p1'],
        mimeType: undefined,
      });
      expect(driveSpy).toHaveBeenCalled();
      driveSpy.mockRestore();
    });
  });

  describe('findOrCreateFolder', () => {
    it('returns existing folder when found under parentId', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          files: [
            {
              id: 'existing-folder-id',
              name: '!TestMove',
              parents: ['parent-folder-abc'],
              mimeType: 'application/vnd.google-apps.folder',
            },
          ],
        },
      });

      const folder = await client.findOrCreateFolder('parent-folder-abc', '!TestMove');

      expect(folder).toEqual({
        id: 'existing-folder-id',
        name: '!TestMove',
        parents: ['parent-folder-abc'],
        mimeType: 'application/vnd.google-apps.folder',
      });
      expect(mockDrive.files.create).not.toHaveBeenCalled();
    });

    it('creates folder if not found under parentId', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { files: [] },
      });

      (mockDrive.files.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'new-folder-id',
          name: '!TestMove',
          parents: ['parent-folder-abc'],
          mimeType: 'application/vnd.google-apps.folder',
        },
      });

      const folder = await client.findOrCreateFolder('parent-folder-abc', '!TestMove');

      expect(folder).toEqual({
        id: 'new-folder-id',
        name: '!TestMove',
        parents: ['parent-folder-abc'],
        mimeType: 'application/vnd.google-apps.folder',
      });
      expect(mockDrive.files.create).toHaveBeenCalledWith({
        requestBody: {
          name: '!TestMove',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['parent-folder-abc'],
        },
        fields: 'id, name, parents, mimeType',
        supportsAllDrives: true,
      });
    });

    it('escapes quotes in folder query properly', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { files: [] },
      });

      (mockDrive.files.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { id: 'created-folder', name: "Owner's Documents", parents: ['p1'] },
      });

      await client.findOrCreateFolder('p1', "Owner's Documents");

      expect(mockDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "'p1' in parents and name = 'Owner\\'s Documents' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        })
      );
    });
  });

  describe('moveFile', () => {
    it('moves file from current parent to target folder', async () => {
      (mockDrive.files.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: 'file-123',
          name: 'Project Plan.pdf',
          parents: ['new-target-folder-id'],
        },
      });

      const moved = await client.moveFile('file-123', 'old-parent-id', 'new-target-folder-id');

      expect(moved).toEqual({
        id: 'file-123',
        name: 'Project Plan.pdf',
        parents: ['new-target-folder-id'],
        mimeType: undefined,
      });

      expect(mockDrive.files.update).toHaveBeenCalledWith({
        fileId: 'file-123',
        addParents: 'new-target-folder-id',
        removeParents: 'old-parent-id',
        fields: 'id, name, parents, mimeType',
        supportsAllDrives: true,
      });
    });

    it('throws error when update response lacks file ID or name', async () => {
      (mockDrive.files.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {},
      });

      await expect(client.moveFile('file-123', 'p1', 'p2')).rejects.toThrow(
        /Failed to move file 'file-123' to folder 'p2'/
      );
    });
  });

  describe('searchFiles', () => {
    it('executes global search with trashed = false and contains query when parents array is empty', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          files: [
            {
              id: 'file-global-1',
              name: 'Invoice_123.pdf',
              parents: ['folder-abc'],
              mimeType: 'application/pdf',
              webViewLink: 'https://drive.google.com/file/d/file-global-1/view',
            },
          ],
        },
      });

      const results = await client.searchFiles({
        targetName: 'Invoice',
        expectedParentPathNames: [],
      });

      expect(results).toEqual([
        {
          id: 'file-global-1',
          name: 'Invoice_123.pdf',
          parents: ['folder-abc'],
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/file-global-1/view',
        },
      ]);
      expect(mockDrive.files.list).toHaveBeenCalledWith({
        q: "name contains 'Invoice' and trashed = false",
        fields: 'files(id, name, parents, mimeType, webViewLink)',
        corpora: 'user',
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
    });

    it('throws error when non-empty expectedParentPathNames is provided (pending #75/#76)', async () => {
      await expect(
        client.searchFiles({
          targetName: 'Document',
          expectedParentPathNames: ['ParentFolder'],
        })
      ).rejects.toThrow(
        /Parent path traversal is not yet implemented for searchFiles/
      );
    });

    it('executes global search when expectedParentPathNames is undefined', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          files: [
            {
              id: 'f-1',
              name: 'Document.docx',
            },
          ],
        },
      });

      const results = await client.searchFiles({
        targetName: 'Document',
      });

      expect(results).toEqual([
        {
          id: 'f-1',
          name: 'Document.docx',
          parents: undefined,
          mimeType: undefined,
          webViewLink: undefined,
        },
      ]);
      expect(mockDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          corpora: 'user',
          spaces: 'drive',
          q: "name contains 'Document' and trashed = false",
        })
      );
    });

    it('uses exact equality when exactMatch is true', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { files: [] },
      });

      await client.searchFiles({
        targetName: 'ExactName.pdf',
        exactMatch: true,
        expectedParentPathNames: [],
      });

      expect(mockDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "name = 'ExactName.pdf' and trashed = false",
        })
      );
    });

    it('escapes single quotes in targetName query', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { files: [] },
      });

      await client.searchFiles({
        targetName: "O'Connor's Receipt.pdf",
        exactMatch: true,
      });

      expect(mockDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "name = 'O\\'Connor\\'s Receipt.pdf' and trashed = false",
        })
      );
    });

    it('scopes search to sharedDriveId when provided', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { files: [] },
      });

      await client.searchFiles({
        targetName: 'SharedDoc',
        sharedDriveId: 'shared-drive-999',
        expectedParentPathNames: [],
      });

      expect(mockDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          corpora: 'drive',
          driveId: 'shared-drive-999',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        })
      );
    });

    it('appends single mimeType filter clause', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { files: [] },
      });

      await client.searchFiles({
        targetName: 'Sheet',
        mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        expectedParentPathNames: [],
      });

      expect(mockDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "name contains 'Sheet' and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
        })
      );
    });

    it('appends multiple mimeType filter clauses joined with OR', async () => {
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { files: [] },
      });

      await client.searchFiles({
        targetName: 'Doc',
        mimeTypes: ['application/pdf', 'application/vnd.google-apps.document'],
        expectedParentPathNames: [],
      });

      expect(mockDrive.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "name contains 'Doc' and trashed = false and (mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')",
        })
      );
    });

    it('maps 401 Unauthorized API errors to GoogleDriveApiError', async () => {
      const authError = {
        status: 401,
        message: 'Invalid Credentials',
      };
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockRejectedValue(authError);

      const err = await client.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(GoogleDriveApiError);
      expect(err.statusCode).toBe(401);
      expect(err.message).toMatch(/Google Drive API error in searchFiles: Invalid Credentials/);
    });

    it('maps 403 Forbidden API errors to GoogleDriveApiError', async () => {
      const forbiddenError = {
        status: 403,
        message: 'User Rate Limit Exceeded or Insufficient Permissions',
      };
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockRejectedValue(forbiddenError);

      const err = await client.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(GoogleDriveApiError);
      expect(err.statusCode).toBe(403);
      expect(err.message).toMatch(/Google Drive API error in searchFiles: User Rate Limit Exceeded or Insufficient Permissions/);
    });

    it('maps 500 Internal Server Error API errors to GoogleDriveApiError', async () => {
      const serverError = {
        status: 500,
        message: 'Backend Error',
      };
      (mockDrive.files.list as ReturnType<typeof vi.fn>).mockRejectedValue(serverError);

      const err = await client.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(GoogleDriveApiError);
      expect(err.statusCode).toBe(500);
      expect(err.message).toMatch(/Google Drive API error in searchFiles: Backend Error/);
    });

    it('retries searchFiles on 429 status code and succeeds on next attempt', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const retryClient = new GoogleDriveClient({
        drive: mockDrive,
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 50,
          backoffFactor: 2,
          sleep: sleepMock,
        },
      });

      const rateLimitError = { status: 429, message: 'Too many requests' };
      (mockDrive.files.list as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            files: [{ id: 'retry-file-id', name: 'FoundAfterRetry.pdf' }],
          },
        });

      const results = await retryClient.searchFiles({ targetName: 'FoundAfterRetry' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('retry-file-id');
      expect(mockDrive.files.list).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledWith(50);
    });
  });

  describe('429 Rate Limit Exponential Backoff Interceptor', () => {
    it('retries getFile on 429 status code and succeeds on next attempt', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const retryClient = new GoogleDriveClient({
        drive: mockDrive,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffFactor: 2,
          sleep: sleepMock,
        },
      });

      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as unknown as { status: number }).status = 429;

      (mockDrive.files.get as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            id: 'file-retry-success',
            name: 'RetriedFile.pdf',
            parents: ['folder-1'],
          },
        });

      const file = await retryClient.getFile('file-retry-success');

      expect(file).toEqual({
        id: 'file-retry-success',
        name: 'RetriedFile.pdf',
        parents: ['folder-1'],
        mimeType: undefined,
      });
      expect(mockDrive.files.get).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(100);
    });

    it('retries with exponential delay on repeated 429s (100ms then 200ms)', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const retryClient = new GoogleDriveClient({
        drive: mockDrive,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffFactor: 2,
          sleep: sleepMock,
        },
      });

      const rateLimitError = {
        code: 429,
        message: 'Too Many Requests',
      };

      (mockDrive.files.list as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            files: [{ id: 'f-1', name: '!TestMove', parents: ['p1'] }],
          },
        });

      const folder = await retryClient.findOrCreateFolder('p1', '!TestMove');

      expect(folder.id).toBe('f-1');
      expect(mockDrive.files.list).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenNthCalledWith(1, 100);
      expect(sleepMock).toHaveBeenNthCalledWith(2, 200);
    });

    it('throws error when 429 retries are exhausted', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const retryClient = new GoogleDriveClient({
        drive: mockDrive,
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 50,
          backoffFactor: 2,
          sleep: sleepMock,
        },
      });

      const rateLimitError = {
        response: { status: 429 },
        message: 'User rate limit exceeded',
      };

      (mockDrive.files.update as ReturnType<typeof vi.fn>).mockRejectedValue(rateLimitError);

      await expect(retryClient.moveFile('f1', 'p1', 'p2')).rejects.toThrow(
        /Google Drive API error in moveFile/
      );
      expect(mockDrive.files.update).toHaveBeenCalledTimes(3); // Initial + 2 retries
      expect(sleepMock).toHaveBeenCalledTimes(2);
    });

    it('does not retry non-429 errors (e.g. 403 Forbidden or 404 Not Found)', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const retryClient = new GoogleDriveClient({
        drive: mockDrive,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 100,
          sleep: sleepMock,
        },
      });

      const forbiddenError = {
        status: 403,
        message: 'The user does not have sufficient permissions for this file.',
      };

      (mockDrive.files.get as ReturnType<typeof vi.fn>).mockRejectedValue(forbiddenError);

      await expect(retryClient.getFile('secret-file')).rejects.toThrow(
        /The user does not have sufficient permissions/
      );
      expect(mockDrive.files.get).toHaveBeenCalledTimes(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('fetches retry configuration dynamically from DriveConfigProvider', async () => {
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const mockConfigProvider = {
        getDriveConfig: vi.fn().mockResolvedValue({
          maxRetries: 1,
          initialDelayMs: 250,
          backoffFactor: 3,
        }),
      };

      const retryClient = new GoogleDriveClient({
        drive: mockDrive,
        configProvider: mockConfigProvider,
        retryOptions: {
          sleep: sleepMock,
        },
      });

      const rateLimitError = { status: 429 };
      (mockDrive.files.get as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({
          data: {
            id: 'file-dyn',
            name: 'Dynamic.pdf',
          },
        });

      const result = await retryClient.getFile('file-dyn');
      expect(result.id).toBe('file-dyn');
      expect(mockConfigProvider.getDriveConfig).toHaveBeenCalled();
      expect(mockDrive.files.get).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledWith(250);
    });
  });
});



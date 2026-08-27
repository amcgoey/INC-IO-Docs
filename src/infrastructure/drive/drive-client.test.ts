import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDriveClient } from './drive-client';
import type { drive_v3 } from 'googleapis';

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

  describe('constructor auth handling', () => {
    it('instantiates with string access token or OAuth2Client', () => {
      const clientWithToken = new GoogleDriveClient({ auth: 'ya29.sample-token' });
      expect(clientWithToken).toBeDefined();

      const defaultClient = new GoogleDriveClient();
      expect(defaultClient).toBeDefined();
    });
  });
});

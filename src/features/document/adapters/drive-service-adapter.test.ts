import { describe, it, expect, vi } from 'vitest';
import { DriveServiceAdapter, type DriveClientPort } from './drive-service-adapter';
import { DriveServiceError } from '../ports';

describe('DriveServiceAdapter', () => {
  const mockDriveClient: DriveClientPort = {
    getFile: vi.fn(),
    findOrCreateFolder: vi.fn(),
    moveFile: vi.fn(),
    searchFiles: vi.fn(),
  };

  const adapter = new DriveServiceAdapter(mockDriveClient);

  describe('getFile', () => {
    it('returns mapped file result on success', async () => {
      (mockDriveClient.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-1',
        name: 'test.pdf',
        parents: ['p1'],
        mimeType: 'application/pdf',
        webViewLink: 'https://link',
      });

      const res = await adapter.getFile('file-1');
      expect(res).toEqual({
        id: 'file-1',
        name: 'test.pdf',
        parents: ['p1'],
        mimeType: 'application/pdf',
        webViewLink: 'https://link',
      });
    });

    it('translates external errors to DriveServiceError', async () => {
      (mockDriveClient.getFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network failure')
      );

      const err = await adapter.getFile('file-1').catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error in getFile: Network failure/);
    });
  });

  describe('findOrCreateFolder', () => {
    it('returns mapped folder result on success', async () => {
      (mockDriveClient.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'folder-1',
        name: 'Invoices',
        parents: ['root'],
        mimeType: 'application/vnd.google-apps.folder',
      });

      const res = await adapter.findOrCreateFolder('root', 'Invoices');
      expect(res).toEqual({
        id: 'folder-1',
        name: 'Invoices',
        parents: ['root'],
        mimeType: 'application/vnd.google-apps.folder',
        webViewLink: undefined,
      });
    });
  });

  describe('moveFile', () => {
    it('returns mapped moved file result on success', async () => {
      (mockDriveClient.moveFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-1',
        name: 'moved.pdf',
        parents: ['target-folder'],
      });

      const res = await adapter.moveFile('file-1', 'old-parent', 'target-folder');
      expect(res).toEqual({
        id: 'file-1',
        name: 'moved.pdf',
        parents: ['target-folder'],
        mimeType: undefined,
        webViewLink: undefined,
      });
    });
  });

  describe('searchFiles', () => {
    it('returns mapped file results on success', async () => {
      (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'f-1',
          name: 'Target.pdf',
          parents: ['p-1'],
          mimeType: 'application/pdf',
          webViewLink: 'https://drive/view',
        },
      ]);

      const results = await adapter.searchFiles({
        targetName: 'Target',
        exactMatch: true,
      });

      expect(results).toEqual([
        {
          id: 'f-1',
          name: 'Target.pdf',
          parents: ['p-1'],
          mimeType: 'application/pdf',
          webViewLink: 'https://drive/view',
        },
      ]);
    });

    it('translates external errors to DriveServiceError', async () => {
      (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Drive quota exceeded')
      );

      const err = await adapter.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error in searchFiles: Drive quota exceeded/);
    });

    it('translates 401 Unauthorized API error to DriveServiceError with status code', async () => {
      (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue({
        statusCode: 401,
        message: 'Invalid Credentials',
      });

      const err = await adapter.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error \(401\) in searchFiles: Invalid Credentials/);
    });

    it('translates 403 Forbidden API error to DriveServiceError with status code', async () => {
      (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue({
        statusCode: 403,
        message: 'Insufficient Permissions',
      });

      const err = await adapter.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error \(403\) in searchFiles: Insufficient Permissions/);
    });

    it('translates 500 Internal Server Error to DriveServiceError with status code', async () => {
      (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue({
        statusCode: 500,
        message: 'Backend Error',
      });

      const err = await adapter.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error \(500\) in searchFiles: Backend Error/);
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { DriveServiceAdapter, type DriveClientPort } from './drive-service-adapter';
import { DriveServiceError, AmbiguousPathSpecError } from '../ports';

describe('DriveServiceAdapter', () => {
  const mockDriveClient: DriveClientPort = {
    getFile: vi.fn(),
    findOrCreateFolder: vi.fn(),
    move: vi.fn(),
    rename: vi.fn(),
    duplicate: vi.fn(),
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

  describe('move', () => {
    it('returns mapped moved file result on success', async () => {
      (mockDriveClient.move as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-1',
        name: 'moved.pdf',
        parents: ['target-folder'],
      });

      const res = await adapter.move('file-1', 'target-folder');
      expect(res).toEqual({
        id: 'file-1',
        name: 'moved.pdf',
        parents: ['target-folder'],
        mimeType: undefined,
        webViewLink: undefined,
      });
    });

    it('translates external errors to DriveServiceError', async () => {
      (mockDriveClient.move as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Move failed')
      );

      const err = await adapter.move('file-1', 'target-folder').catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error in move: Move failed/);
    });
  });

  describe('rename', () => {
    it('returns mapped renamed file result on success', async () => {
      (mockDriveClient.rename as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-1',
        name: 'renamed.pdf',
        parents: ['folder-1'],
        mimeType: 'application/pdf',
        webViewLink: 'https://link',
      });

      const res = await adapter.rename('file-1', 'renamed.pdf');
      expect(res).toEqual({
        id: 'file-1',
        name: 'renamed.pdf',
        parents: ['folder-1'],
        mimeType: 'application/pdf',
        webViewLink: 'https://link',
      });
      expect(mockDriveClient.rename).toHaveBeenCalledWith('file-1', 'renamed.pdf', undefined);
    });

    it('translates external errors to DriveServiceError', async () => {
      (mockDriveClient.rename as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Rename failed')
      );

      const err = await adapter.rename('file-1', 'new-name.pdf').catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error in rename: Rename failed/);
    });
  });

  describe('duplicate', () => {
    it('returns mapped duplicated file result on success', async () => {
      (mockDriveClient.duplicate as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-copy-1',
        name: 'copied.pdf',
        parents: ['folder-1'],
        mimeType: 'application/pdf',
        webViewLink: 'https://link',
      });

      const res = await adapter.duplicate('file-1', {
        newName: 'copied.pdf',
        targetFolderId: 'folder-1',
      });
      expect(res).toEqual({
        id: 'file-copy-1',
        name: 'copied.pdf',
        parents: ['folder-1'],
        mimeType: 'application/pdf',
        webViewLink: 'https://link',
      });
      expect(mockDriveClient.duplicate).toHaveBeenCalledWith(
        'file-1',
        { newName: 'copied.pdf', targetFolderId: 'folder-1' },
        undefined
      );
    });

    it('translates external errors to DriveServiceError', async () => {
      (mockDriveClient.duplicate as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Duplicate failed')
      );

      const err = await adapter.duplicate('file-1').catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error in duplicate: Duplicate failed/);
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

    it('translates GoogleDriveAmbiguousPathError to AmbiguousPathSpecError', async () => {
      const ambiguousError = new Error('Query for parent folder returned 21 results, exceeding threshold cap of 20 matches.');
      ambiguousError.name = 'GoogleDriveAmbiguousPathError';

      (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue(ambiguousError);

      const err = await adapter.searchFiles({
        targetName: 'Target.pdf',
        expectedParentPathNames: ['Invoices'],
      }).catch((e) => e);

      expect(err).toBeInstanceOf(AmbiguousPathSpecError);
      expect(err.name).toBe('AmbiguousPathSpecError');
      expect(err.message).toMatch(/exceeding threshold cap of 20 matches/);
    });

    it('translates external errors to DriveServiceError', async () => {
      (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Drive quota exceeded')
      );

      const err = await adapter.searchFiles({ targetName: 'Test' }).catch((e) => e);
      expect(err).toBeInstanceOf(DriveServiceError);
      expect(err.message).toMatch(/Drive service error in searchFiles: Drive quota exceeded/);
    });

    it.each([
      { statusCode: 401, message: 'Invalid Credentials', expectedStatus: 401 },
      { statusCode: 403, message: 'Insufficient Permissions', expectedStatus: 403 },
      { statusCode: 500, message: 'Backend Error', expectedStatus: 500 },
    ])(
      'translates $statusCode API error to DriveServiceError with status code',
      async ({ statusCode, message, expectedStatus }) => {
        (mockDriveClient.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue({
          statusCode,
          message,
        });

        const err = await adapter.searchFiles({ targetName: 'Test' }).catch((e) => e);
        expect(err).toBeInstanceOf(DriveServiceError);
        expect(err.message).toMatch(
          new RegExp(`Drive service error \\(${expectedStatus}\\) in searchFiles: ${message}`)
        );
      }
    );
  });
});

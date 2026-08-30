import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriveActivityHandler } from './drive-activity-handler';
import type { DriveServicePort } from '../ports';
import type { Activity } from '../domain';

describe('DriveActivityHandler', () => {
  let mockDriveService: DriveServicePort;
  let handler: DriveActivityHandler;

  beforeEach(() => {
    mockDriveService = {
      getFile: vi.fn().mockResolvedValue({
        id: 'file-123',
        name: 'Report.docx',
        parents: ['folder-parent-xyz'],
        webViewLink: 'https://drive.google.com/file/d/file-123/view',
      }),
      findOrCreateFolder: vi.fn().mockResolvedValue({
        id: 'testmove-folder-id',
        name: 'Unfiled',
        parents: ['folder-parent-xyz'],
        webViewLink: 'https://drive.google.com/drive/folders/testmove-folder-id',
      }),
      moveFile: vi.fn().mockResolvedValue({
        id: 'file-123',
        name: 'Report.docx',
        parents: ['testmove-folder-id'],
        webViewLink: 'https://drive.google.com/file/d/file-123/view',
      }),
      searchFiles: vi.fn().mockResolvedValue([]),
    };

    handler = new DriveActivityHandler(mockDriveService);
  });

  describe('canHandle', () => {
    it('returns true for supported activity types', () => {
      expect(handler.canHandle({ type: 'MOVE_DRIVE_FILE', payload: {} })).toBe(true);
      expect(handler.canHandle({ type: 'MOVE_SELECTED_FILE', payload: {} })).toBe(true);
      expect(handler.canHandle({ type: 'DRIVE_MOVE_SELECTED_FILE', payload: {} })).toBe(true);
    });

    it('returns false for unrelated activity types', () => {
      expect(handler.canHandle({ type: 'LOG_DOCUMENT', payload: {} })).toBe(false);
      expect(handler.canHandle({ type: 'SEND_EMAIL', payload: {} })).toBe(false);
    });
  });

  describe('handle', () => {
    it('moves file when fileId is in activity payload', async () => {
      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: {
          fileId: 'file-123',
          folderName: 'Unfiled',
        },
      };

      const context = { credentials: { oauthToken: 'ya29.mock-token' } };

      const output = await handler.handle(activity, context);

      expect(mockDriveService.getFile).toHaveBeenCalledWith('file-123', { auth: 'ya29.mock-token' });
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'Unfiled',
        { auth: 'ya29.mock-token' }
      );
      expect(mockDriveService.moveFile).toHaveBeenCalledWith(
        'file-123',
        'folder-parent-xyz',
        'testmove-folder-id',
        { auth: 'ya29.mock-token' }
      );

      expect(output).toEqual({
        success: true,
        files: [
          {
            id: 'file-123',
            name: 'Report.docx',
            parentName: 'Unfiled',
            uri: 'https://drive.google.com/file/d/file-123/view',
          },
        ],
      });
    });

    it('extracts fileId from context resources primaryTargetId when not in payload', async () => {
      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: {},
      };

      const context = {
        credentials: { oauthToken: 'ya29.token-abc' },
        resources: { primaryTargetId: 'selected-file-789' },
      };

      await handler.handle(activity, context);

      expect(mockDriveService.getFile).toHaveBeenCalledWith('selected-file-789', { auth: 'ya29.token-abc' });
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'Unfiled',
        { auth: 'ya29.token-abc' }
      );
      expect(mockDriveService.moveFile).toHaveBeenCalledWith(
        'selected-file-789',
        'folder-parent-xyz',
        'testmove-folder-id',
        { auth: 'ya29.token-abc' }
      );
    });

    it('throws error when fileId cannot be found in payload or context', async () => {
      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: {},
      };

      await expect(handler.handle(activity, {})).rejects.toThrow(
        /No fileId found in activity payload or execution context/
      );
    });

    it('falls back to root parent if file has no parents', async () => {
      (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'root-file-123',
        name: 'RootDoc.pdf',
        parents: [],
        webViewLink: 'https://drive.google.com/file/d/root-file-123/view',
      });

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'root-file-123' },
      };

      await handler.handle(activity);

      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith('root', 'Unfiled', undefined);
      expect(mockDriveService.moveFile).toHaveBeenCalledWith(
        'root-file-123',
        'root',
        'testmove-folder-id',
        undefined
      );
    });

    it('uses defaultFolderName from configProvider when activity payload omits folderName', async () => {
      const mockConfigProvider = {
        getDriveConfig: vi.fn().mockResolvedValue({
          defaultFolderName: 'ManifestFolder',
        }),
      };

      (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'manifest-folder-id',
        name: 'ManifestFolder',
        parents: ['folder-parent-xyz'],
      });

      const configHandler = new DriveActivityHandler(mockDriveService, {
        configProvider: mockConfigProvider,
      });

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'file-123' },
      };

      const output = await configHandler.handle(activity);

      expect(mockConfigProvider.getDriveConfig).toHaveBeenCalled();
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'ManifestFolder',
        undefined
      );
      expect(output.files?.[0]?.parentName).toBe('ManifestFolder');
    });

    it('prioritizes activity.payload.folderName over configProvider', async () => {
      const mockConfigProvider = {
        getDriveConfig: vi.fn().mockResolvedValue({
          defaultFolderName: 'ManifestFolder',
        }),
      };

      const configHandler = new DriveActivityHandler(mockDriveService, {
        configProvider: mockConfigProvider,
      });

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'file-123', folderName: 'PayloadFolder' },
      };

      await configHandler.handle(activity);

      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'PayloadFolder',
        undefined
      );
    });

    it('falls back to getFile webViewLink if moveFile does not provide webViewLink', async () => {
      (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-fallback',
        name: 'Fallback.pdf',
        parents: ['folder-xyz'],
        webViewLink: 'https://drive.google.com/file/d/file-fallback/view',
      });
      (mockDriveService.moveFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-fallback',
        name: 'Fallback.pdf',
        parents: ['testmove-folder-id'],
      });

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'file-fallback' },
      };

      const output = await handler.handle(activity);
      expect(output.files?.[0]?.uri).toBe('https://drive.google.com/file/d/file-fallback/view');
    });

    it('omits uri on fileLocator if webViewLink is absent on both movedFile and file', async () => {
      (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-no-link',
        name: 'NoLink.pdf',
        parents: ['folder-xyz'],
      });
      (mockDriveService.moveFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-no-link',
        name: 'NoLink.pdf',
        parents: ['testmove-folder-id'],
      });

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'file-no-link' },
      };

      const output = await handler.handle(activity);
      expect(output.files?.[0]?.uri).toBeUndefined();
    });

    it('throws configuration error when configProvider.getDriveConfig fails', async () => {
      const mockConfigProvider = {
        getDriveConfig: vi.fn().mockRejectedValue(new Error('Config service unavailable')),
      };

      const configHandler = new DriveActivityHandler(mockDriveService, {
        configProvider: mockConfigProvider,
      });

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'file-123' },
      };

      await expect(configHandler.handle(activity)).rejects.toThrow(
        /DriveActivityHandler failed to get drive config: Config service unavailable/
      );
    });

    it('throws move file error when driveService operation fails', async () => {
      (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Google Drive API 404 Not Found')
      );

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'file-123' },
      };

      await expect(handler.handle(activity)).rejects.toThrow(
        /DriveActivityHandler failed to move file: Google Drive API 404 Not Found/
      );
    });
  });
});


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
      }),
      findOrCreateFolder: vi.fn().mockResolvedValue({
        id: 'testmove-folder-id',
        name: '!TestMove',
        parents: ['folder-parent-xyz'],
      }),
      moveFile: vi.fn().mockResolvedValue({
        id: 'file-123',
        name: 'Report.docx',
        parents: ['testmove-folder-id'],
      }),
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
      expect(handler.canHandle({ type: 'LOG_RECORD', payload: {} })).toBe(false);
      expect(handler.canHandle({ type: 'SEND_EMAIL', payload: {} })).toBe(false);
    });
  });

  describe('handle', () => {
    it('moves file when fileId is in activity payload', async () => {
      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: {
          fileId: 'file-123',
          folderName: '!TestMove',
        },
      };

      const context = { userOAuthToken: 'ya29.mock-token' };

      await handler.handle(activity, context);

      expect(mockDriveService.getFile).toHaveBeenCalledWith('file-123', 'ya29.mock-token');
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        '!TestMove',
        'ya29.mock-token'
      );
      expect(mockDriveService.moveFile).toHaveBeenCalledWith(
        'file-123',
        'folder-parent-xyz',
        'testmove-folder-id',
        'ya29.mock-token'
      );

      expect(handler.getLastExecutionResult()).toEqual({
        fileId: 'file-123',
        fileName: 'Report.docx',
        destinationFolder: '!TestMove',
      });

      expect((context as Record<string, unknown>).lastExecutionResult).toEqual({
        fileId: 'file-123',
        fileName: 'Report.docx',
        destinationFolder: '!TestMove',
      });
    });

    it('extracts fileId from context selectedItems when not in payload', async () => {
      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: {},
      };

      const context = {
        userOAuthToken: 'ya29.token-abc',
        selectedItems: [{ id: 'selected-file-789' }],
      };

      await handler.handle(activity, context);

      expect(mockDriveService.getFile).toHaveBeenCalledWith('selected-file-789', 'ya29.token-abc');
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        '!TestMove',
        'ya29.token-abc'
      );
      expect(mockDriveService.moveFile).toHaveBeenCalledWith(
        'selected-file-789',
        'folder-parent-xyz',
        'testmove-folder-id',
        'ya29.token-abc'
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
      });

      const activity: Activity = {
        type: 'MOVE_DRIVE_FILE',
        payload: { fileId: 'root-file-123' },
      };

      await handler.handle(activity);

      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith('root', '!TestMove', undefined);
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

      await configHandler.handle(activity);

      expect(mockConfigProvider.getDriveConfig).toHaveBeenCalled();
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'ManifestFolder',
        undefined
      );
      expect(configHandler.getLastExecutionResult()?.destinationFolder).toBe('ManifestFolder');
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
  });
});


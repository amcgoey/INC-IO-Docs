import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriveActivityHandler } from './drive-activity-handler';
import {
  AmbiguousPathSpecError,
  DriveServiceError,
  type DriveServicePort,
} from '../ports';
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
      resolveFolderPath: vi.fn().mockResolvedValue({
        id: 'resolved-parent-folder-id',
        name: 'Communication',
        parents: ['folder-parent-xyz'],
        webViewLink: 'https://drive.google.com/drive/folders/resolved-parent-folder-id',
      }),
      move: vi.fn().mockResolvedValue({
        id: 'file-123',
        name: 'Report.docx',
        parents: ['testmove-folder-id'],
        webViewLink: 'https://drive.google.com/file/d/file-123/view',
      }),
      rename: vi.fn().mockResolvedValue({
        id: 'file-123',
        name: 'Renamed.docx',
        parents: ['folder-parent-xyz'],
        webViewLink: 'https://drive.google.com/file/d/file-123/view',
      }),
      duplicate: vi.fn().mockResolvedValue({
        id: 'file-copy-123',
        name: 'Report.docx',
        parents: ['folder-parent-xyz'],
        webViewLink: 'https://drive.google.com/file/d/file-copy-123/view',
      }),
      searchFiles: vi.fn().mockResolvedValue([]),
      downloadAsBuffer: vi.fn(),
      saveBuffer: vi.fn(),
      uploadStream: vi.fn(),
    };

    handler = new DriveActivityHandler(mockDriveService);
  });

  describe('canHandle', () => {
    it('returns true for supported activity types', () => {
      expect(handler.canHandle({ type: 'MOVE_FILE', payload: {} })).toBe(true);
      expect(handler.canHandle({ type: 'SEARCH_DRIVE_FILE', payload: {} })).toBe(true);
      expect(handler.canHandle({ type: 'FIND_DRIVE_FILE', payload: {} })).toBe(true);
      expect(handler.canHandle({ type: 'RESOLVE_DRIVE_FILE', payload: {} })).toBe(true);
    });

    it('returns false for retired aliases and unrelated activity types', () => {
      expect(handler.canHandle({ type: 'MOVE_DRIVE_FILE', payload: {} })).toBe(false);
      expect(handler.canHandle({ type: 'MOVE_SELECTED_FILE', payload: {} })).toBe(false);
      expect(handler.canHandle({ type: 'DRIVE_MOVE_SELECTED_FILE', payload: {} })).toBe(false);
      expect(handler.canHandle({ type: 'LOG_DOCUMENT', payload: {} })).toBe(false);
      expect(handler.canHandle({ type: 'SEND_EMAIL', payload: {} })).toBe(false);
    });
  });

  describe('handle', () => {
    it('moves file when fileId is in activity payload', async () => {
      const activity: Activity = {
        type: 'MOVE_FILE',
        payload: {
          fileId: 'file-123',
          folderName: 'Unfiled',
        },
      };

      const output = await handler.handle(activity);

      expect(mockDriveService.getFile).toHaveBeenCalledWith('file-123');
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'Unfiled'
      );
      expect(mockDriveService.move).toHaveBeenCalledWith(
        'file-123',
        'testmove-folder-id'
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

    it('extracts fileId from options primaryTargetId when not in payload', async () => {
      const handlerWithTarget = new DriveActivityHandler(mockDriveService, {
        primaryTargetId: 'selected-file-789',
      });
      const activity: Activity = {
        type: 'MOVE_FILE',
        payload: {},
      };

      await handlerWithTarget.handle(activity);

      expect(mockDriveService.getFile).toHaveBeenCalledWith('selected-file-789');
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'Unfiled'
      );
      expect(mockDriveService.move).toHaveBeenCalledWith(
        'selected-file-789',
        'testmove-folder-id'
      );
    });

    it('throws error when fileId cannot be found in payload or context', async () => {
      const activity: Activity = {
        type: 'MOVE_FILE',
        payload: {},
      };

      await expect(handler.handle(activity)).rejects.toThrow(
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
        type: 'MOVE_FILE',
        payload: { fileId: 'root-file-123' },
      };

      await handler.handle(activity);

      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith('root', 'Unfiled');
      expect(mockDriveService.move).toHaveBeenCalledWith(
        'root-file-123',
        'testmove-folder-id'
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
        type: 'MOVE_FILE',
        payload: { fileId: 'file-123' },
      };

      const output = await configHandler.handle(activity);

      expect(mockConfigProvider.getDriveConfig).toHaveBeenCalled();
      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'ManifestFolder'
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
        type: 'MOVE_FILE',
        payload: { fileId: 'file-123', folderName: 'PayloadFolder' },
      };

      await configHandler.handle(activity);

      expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
        'folder-parent-xyz',
        'PayloadFolder'
      );
    });

    it('falls back to getFile webViewLink if move does not provide webViewLink', async () => {
      (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-fallback',
        name: 'Fallback.pdf',
        parents: ['folder-xyz'],
        webViewLink: 'https://drive.google.com/file/d/file-fallback/view',
      });
      (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-fallback',
        name: 'Fallback.pdf',
        parents: ['testmove-folder-id'],
      });

      const activity: Activity = {
        type: 'MOVE_FILE',
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
      (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'file-no-link',
        name: 'NoLink.pdf',
        parents: ['testmove-folder-id'],
      });

      const activity: Activity = {
        type: 'MOVE_FILE',
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
        type: 'MOVE_FILE',
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
        type: 'MOVE_FILE',
        payload: { fileId: 'file-123' },
      };

      await expect(handler.handle(activity)).rejects.toThrow(
        /DriveActivityHandler failed to move file: Google Drive API 404 Not Found/
      );
    });

    describe('searchFiles and path resolution', () => {
      it('executes searchFiles with expectedParentPathNames array and returns single match', async () => {
        (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
          {
            id: 'found-file-456',
            name: 'TargetDoc.pdf',
            parents: ['folder-123'],
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/found-file-456/view',
          },
        ]);

        const activity: Activity = {
          type: 'SEARCH_DRIVE_FILE',
          payload: {
            targetName: 'TargetDoc.pdf',
            expectedParentPathNames: ['Clients', 'Acme Corp'],
            exactMatch: true,
            sharedDriveId: 'shared-drive-001',
            mimeTypes: ['application/pdf'],
          },
        };

        const output = await handler.handle(activity);

        expect(mockDriveService.searchFiles).toHaveBeenCalledWith(
          {
            targetName: 'TargetDoc.pdf',
            expectedParentPathNames: ['Clients', 'Acme Corp'],
            exactMatch: true,
            sharedDriveId: 'shared-drive-001',
            mimeTypes: ['application/pdf'],
          }
        );

        expect(output).toEqual({
          success: true,
          files: [
            {
              id: 'found-file-456',
              name: 'TargetDoc.pdf',
              parentName: 'folder-123',
              mimeType: 'application/pdf',
              uri: 'https://drive.google.com/file/d/found-file-456/view',
            },
          ],
          documentDataPatch: {
            fileId: 'found-file-456',
            webViewLink: 'https://drive.google.com/file/d/found-file-456/view',
          },
          contextVariables: {
            fileId: 'found-file-456',
            webViewLink: 'https://drive.google.com/file/d/found-file-456/view',
          },
        });
      });

      it('parses targetPath string into expectedParentPathNames and targetName', async () => {
        (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
          {
            id: 'found-file-789',
            name: 'Summary.xlsx',
            parents: ['folder-456'],
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            webViewLink: 'https://drive.google.com/file/d/found-file-789/view',
          },
        ]);

        const activity: Activity = {
          type: 'RESOLVE_DRIVE_FILE',
          payload: {
            targetPath: '1Admin/Communication/ClientA/Summary.xlsx',
          },
        };

        const output = await handler.handle(activity);

        expect(mockDriveService.searchFiles).toHaveBeenCalledWith({
          targetName: 'Summary.xlsx',
          expectedParentPathNames: ['1Admin', 'Communication', 'ClientA'],
        });

        expect(output.success).toBe(true);
        expect(output.files?.[0]?.id).toBe('found-file-789');
      });

      it('catches AmbiguousPathSpecError from searchFiles and returns success: false to UI layer', async () => {
        (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue(
          new AmbiguousPathSpecError(
            "AmbiguousPathSpecError: Query for parent folder 'Clients' returned 25 results, exceeding the threshold cap of 20 matches."
          )
        );

        const activity: Activity = {
          type: 'SEARCH_DRIVE_FILE',
          payload: {
            targetName: 'Budget.xlsx',
            expectedParentPathNames: ['Clients'],
          },
        };

        const output = await handler.handle(activity);

        expect(output).toEqual({
          success: false,
          error:
            "AmbiguousPathSpecError: Query for parent folder 'Clients' returned 25 results, exceeding the threshold cap of 20 matches.",
        });
      });

      it('catches AmbiguousFileError when searchFiles returns multiple matches and returns success: false to UI layer', async () => {
        (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
          { id: 'file-1', name: 'Duplicate.pdf' },
          { id: 'file-2', name: 'Duplicate.pdf' },
        ]);

        const activity: Activity = {
          type: 'FIND_DRIVE_FILE',
          payload: {
            targetName: 'Duplicate.pdf',
          },
        };

        const output = await handler.handle(activity);

        expect(output).toEqual({
          success: false,
          error:
            "AmbiguousFileError: Query for target 'Duplicate.pdf' returned 2 matches and could not be uniquely resolved.",
        });
      });

      it('catches FileNotFoundError when searchFiles returns 0 matches and returns success: false to UI layer', async () => {
        (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

        const activity: Activity = {
          type: 'FIND_DRIVE_FILE',
          payload: {
            targetName: 'NonExistent.docx',
            expectedParentPathNames: ['Archive'],
          },
        };

        const output = await handler.handle(activity);

        expect(output).toEqual({
          success: false,
          error: "FileNotFoundError: File not found for target 'NonExistent.docx'",
        });
      });

      it('bubbles up infrastructure DriveServiceError (e.g. 403 Forbidden) across the seam', async () => {
        const driveError = new DriveServiceError(
          'Drive service error (403) in searchFiles: Google Drive API error in searchFiles: Forbidden'
        );
        (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockRejectedValue(driveError);

        const activity: Activity = {
          type: 'SEARCH_DRIVE_FILE',
          payload: {
            targetName: 'ProtectedDoc.pdf',
          },
        };

        await expect(handler.handle(activity)).rejects.toThrow(driveError);
        await expect(handler.handle(activity)).rejects.toBeInstanceOf(DriveServiceError);
      });
    });

    describe('primaryTargetId constructor injection', () => {
      it('uses primaryTargetId injected via options when not in payload or context', async () => {
        const injectedHandler = new DriveActivityHandler(mockDriveService, {
          primaryTargetId: 'injected-file-opt-999',
        });
        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: { folderName: 'CustomFolder' },
        };

        const result = await injectedHandler.handle(activity);

        expect(result.success).toBe(true);
        expect(mockDriveService.getFile).toHaveBeenCalledWith('injected-file-opt-999');
        expect(mockDriveService.move).toHaveBeenCalledWith('injected-file-opt-999', 'testmove-folder-id');
      });

      it.each([
        ['empty string', ''],
        ['whitespace-only string', '   \t\n  '],
        ['number (not a string)', 12345 as unknown as string],
      ])('throws fail-fast error if primaryTargetId is %s', (_desc, invalidTargetId) => {
        expect(
          () => new DriveActivityHandler(mockDriveService, { primaryTargetId: invalidTargetId })
        ).toThrow(/DriveActivityHandler: primaryTargetId must be a non-empty string/);
      });

      it('prefers payload fileId over injected primaryTargetId', async () => {
        const injectedHandler = new DriveActivityHandler(mockDriveService, {
          primaryTargetId: 'fallback-file-id',
        });
        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: { fileId: 'payload-priority-id', folderName: 'CustomFolder' },
        };

        await injectedHandler.handle(activity);

        expect(mockDriveService.getFile).toHaveBeenCalledWith('payload-priority-id');
        expect(mockDriveService.move).toHaveBeenCalledWith('payload-priority-id', 'testmove-folder-id');
      });
    });

    describe('sourceFiles constructor injection and deep path MOVE_FILE', () => {
      it('moves sourceFiles to resolved deep path and sequential subfolders preserving original filename', async () => {
        (mockDriveService.resolveFolderPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'admin-comm-folder-id',
          name: 'Communication',
          parents: ['admin-id'],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: 'contact-folder-id',
            name: 'Acme Corp',
            parents: ['admin-comm-folder-id'],
          })
          .mockResolvedValueOnce({
            id: 'comm-folder-id',
            name: '260920 IN - Meeting Notes',
            parents: ['contact-folder-id'],
          });

        (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'sf-1',
          name: 'Original_Report.pdf',
          parents: ['comm-folder-id'],
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/sf-1/view',
        });

        const sfHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'sf-1', name: 'Original_Report.pdf', mimeType: 'application/pdf' }],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-shared-drive-id',
            parentPath: '1 Admin/Communication',
            folderName: 'Acme Corp/260920 IN - Meeting Notes',
          },
        };

        const result = await sfHandler.handle(activity);

        expect(result.success).toBe(true);
        expect(mockDriveService.resolveFolderPath).toHaveBeenCalledWith('root-shared-drive-id', [
          '1 Admin',
          'Communication',
        ]);
        expect(mockDriveService.findOrCreateFolder).toHaveBeenNthCalledWith(
          1,
          'admin-comm-folder-id',
          'Acme Corp'
        );
        expect(mockDriveService.findOrCreateFolder).toHaveBeenNthCalledWith(
          2,
          'contact-folder-id',
          '260920 IN - Meeting Notes'
        );
        expect(mockDriveService.move).toHaveBeenCalledWith('sf-1', 'comm-folder-id');
        expect(result.files).toEqual([
          {
            id: 'sf-1',
            name: 'Original_Report.pdf',
            parentName: '260920 IN - Meeting Notes',
            mimeType: 'application/pdf',
            uri: 'https://drive.google.com/file/d/sf-1/view',
          },
        ]);
      });

      it('moves multiple sourceFiles sequentially into the leaf folder', async () => {
        (mockDriveService.resolveFolderPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'base-comm-id',
          name: 'Communication',
        });
        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'leaf-id',
          name: 'LeafFolder',
        });

        (mockDriveService.move as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: 'sf-1',
            name: 'Doc1.pdf',
            parents: ['leaf-id'],
          })
          .mockResolvedValueOnce({
            id: 'sf-2',
            name: 'Doc2.pdf',
            parents: ['leaf-id'],
          });

        const multiHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [
            { id: 'sf-1', name: 'Doc1.pdf' },
            { id: 'sf-2', name: 'Doc2.pdf' },
          ],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-id',
            parentPath: 'Communication',
            folderName: 'LeafFolder',
          },
        };

        const result = await multiHandler.handle(activity);

        expect(result.success).toBe(true);
        expect(result.files).toHaveLength(2);
        expect(mockDriveService.move).toHaveBeenNthCalledWith(1, 'sf-1', 'leaf-id');
        expect(mockDriveService.move).toHaveBeenNthCalledWith(2, 'sf-2', 'leaf-id');
      });

      it('catches DriveServiceError during move and returns success: false instead of crashing', async () => {
        (mockDriveService.resolveFolderPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          new DriveServiceError('Drive service error (403): Insufficient permissions')
        );

        const sfHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'sf-1' }],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-id',
            parentPath: '1 Admin/Communication',
            folderName: 'Acme/Sub',
          },
        };

        const result = await sfHandler.handle(activity);

        expect(result).toEqual({
          success: false,
          error: 'Drive service error (403): Insufficient permissions',
        });
      });

      it('catches AmbiguousPathSpecError during findOrCreateFolder and returns success: false', async () => {
        (mockDriveService.resolveFolderPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'base-id',
          name: 'Communication',
        });
        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
          new AmbiguousPathSpecError('AmbiguousPathSpecError: Multiple folders named Acme found')
        );

        const sfHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'sf-1' }],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-id',
            parentPath: 'Communication',
            folderName: 'Acme/Sub',
          },
        };

        const result = await sfHandler.handle(activity);

        expect(result).toEqual({
          success: false,
          error: 'AmbiguousPathSpecError: Multiple folders named Acme found',
        });
      });
    });
  });
});


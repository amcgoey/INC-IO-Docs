import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriveActivityHandler, parsePathSegments } from './drive-activity-handler';
import {
  AmbiguousPathSpecError,
  DriveServiceError,
  FileNotFoundError,
  type DriveServicePort,
  type SourceFileHydratorPort,
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
            parentId: 'testmove-folder-id',
            parentName: 'Unfiled',
            parentUri: 'https://drive.google.com/drive/folders/testmove-folder-id',
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
              parentId: 'folder-123',
              parentUri: 'https://drive.google.com/drive/folders/folder-123',
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

      it('prefers normalized sourceFiles (from primaryTargetId) over payload fileId', async () => {
        const injectedHandler = new DriveActivityHandler(mockDriveService, {
          primaryTargetId: 'fallback-file-id',
        });
        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: { fileId: 'payload-priority-id', folderName: 'CustomFolder' },
        };

        await injectedHandler.handle(activity);

        expect(mockDriveService.getFile).toHaveBeenCalledWith('fallback-file-id');
        expect(mockDriveService.move).toHaveBeenCalledWith('fallback-file-id', 'testmove-folder-id');
      });

      it('falls back to payload fileId when sourceFiles and primaryTargetId are absent', async () => {
        const fallbackHandler = new DriveActivityHandler(mockDriveService);
        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: { fileId: 'payload-file-id', folderName: 'CustomFolder' },
        };

        await fallbackHandler.handle(activity);

        expect(mockDriveService.getFile).toHaveBeenCalledWith('payload-file-id');
        expect(mockDriveService.move).toHaveBeenCalledWith('payload-file-id', 'testmove-folder-id');
      });
    });

    describe('parsePathSegments helper', () => {
      it('parses valid single and multi-segment paths', () => {
        expect(parsePathSegments('Admin/Communication')).toEqual(['Admin', 'Communication']);
        expect(parsePathSegments('  /Admin\\Communication/  ')).toEqual(['Admin', 'Communication']);
        expect(parsePathSegments('SingleFolder')).toEqual(['SingleFolder']);
      });

      it('throws DriveServiceError on invalid paths', () => {
        expect(() => parsePathSegments('')).toThrow(DriveServiceError);
        expect(() => parsePathSegments('   /  ')).toThrow(DriveServiceError);
        expect(() => parsePathSegments(123 as unknown as string)).toThrow(DriveServiceError);
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
      });

      it('prefers context.document.sourceFiles over constructor sourceFiles when provided (#373)', async () => {
        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'submittals-folder-id',
          name: 'Submittals',
          parents: ['root-shared-drive-id'],
        });
        (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'resolved-target-1',
          name: 'Resolved.pdf',
          parents: ['submittals-folder-id'],
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/resolved-target-1/view',
        });

        const sfHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'shortcut-1', name: 'Shortcut.pdf' }],
        });

        const result = await sfHandler.handle(
          {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-shared-drive-id',
              folderName: 'Submittals',
            },
          },
          {
            document: {
              type: 'submittal-arch',
              data: {},
              sourceFiles: [{ id: 'resolved-target-1', name: 'Resolved.pdf', mimeType: 'application/pdf' }],
            },
            files: [],
            stepOutputs: {},
            contextVariables: {},
          }
        );

        expect(result.success).toBe(true);
        expect(mockDriveService.move).toHaveBeenCalledWith('resolved-target-1', 'submittals-folder-id');
        expect(result.files).toEqual([
          {
            id: 'resolved-target-1',
            name: 'Resolved.pdf',
            parentId: 'submittals-folder-id',
            parentName: 'Submittals',
            parentUri: 'https://drive.google.com/drive/folders/submittals-folder-id',
            mimeType: 'application/pdf',
            uri: 'https://drive.google.com/file/d/resolved-target-1/view',
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
            webViewLink: 'https://drive.google.com/file/d/sf-1/view',
          })
          .mockResolvedValueOnce({
            id: 'sf-2',
            name: 'Doc2.pdf',
            parents: ['leaf-id'],
            webViewLink: 'https://drive.google.com/file/d/sf-2/view',
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
        expect(result.files).toEqual([
          {
            id: 'sf-1',
            name: 'Doc1.pdf',
            parentId: 'leaf-id',
            parentName: 'LeafFolder',
            parentUri: 'https://drive.google.com/drive/folders/leaf-id',
            uri: 'https://drive.google.com/file/d/sf-1/view',
          },
          {
            id: 'sf-2',
            name: 'Doc2.pdf',
            parentId: 'leaf-id',
            parentName: 'LeafFolder',
            parentUri: 'https://drive.google.com/drive/folders/leaf-id',
            uri: 'https://drive.google.com/file/d/sf-2/view',
          },
        ]);
        expect(mockDriveService.move).toHaveBeenNthCalledWith(1, 'sf-1', 'leaf-id');
        expect(mockDriveService.move).toHaveBeenNthCalledWith(2, 'sf-2', 'leaf-id');
      });

      it('halts immediately on partial failure during batch move, returning already moved files and error', async () => {
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
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/sf-1/view',
          })
          .mockRejectedValueOnce(
            new DriveServiceError('Drive service error (403) in move: User does not have permission')
          );

        const multiHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [
            { id: 'sf-1', name: 'Doc1.pdf' },
            { id: 'sf-2', name: 'Doc2.pdf' },
            { id: 'sf-3', name: 'Doc3.pdf' },
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

        expect(result.success).toBe(false);
        expect(result.error).toBe('Access denied. You do not have permission to access this Google Drive file or folder.');
        expect(result.files).toEqual([
          {
            id: 'sf-1',
            name: 'Doc1.pdf',
            parentId: 'leaf-id',
            parentName: 'LeafFolder',
            parentUri: 'https://drive.google.com/drive/folders/leaf-id',
            mimeType: 'application/pdf',
            uri: 'https://drive.google.com/file/d/sf-1/view',
          },
        ]);
        expect(mockDriveService.move).toHaveBeenCalledTimes(2);
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

      it('validates that resolved folder path segments are non-empty before initiating folder creation', async () => {
        const sfHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'sf-1' }],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-id',
            folderName: '   ',
          },
        };

        const result = await sfHandler.handle(activity);
        expect(result).toEqual({
          success: false,
          error: expect.stringMatching(/non-empty/i),
        });
        expect(mockDriveService.findOrCreateFolder).not.toHaveBeenCalled();
      });

      it('creates destination folder hierarchy when targetSourceFiles is empty and rootStorageId is provided', async () => {
        (mockDriveService.resolveFolderPath as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          id: 'resolved-comm-folder-id',
          name: 'Communication',
        });
        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            id: 'contact-folder-id',
            name: 'Acme Corp',
          })
          .mockResolvedValueOnce({
            id: 'subfolder-id',
            name: '260920 IN - Meeting Notes',
          });

        const zeroFilesHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'shared-drive-root-id',
            parentPath: '1 Admin/Communication',
            folderName: 'Acme Corp/260920 IN - Meeting Notes',
          },
        };

        const result = await zeroFilesHandler.handle(activity);

        expect(result).toEqual({
          success: true,
          files: [
            {
              id: 'subfolder-id',
              name: '260920 IN - Meeting Notes',
              parentId: 'subfolder-id',
              parentName: '260920 IN - Meeting Notes',
              parentUri: 'https://drive.google.com/drive/folders/subfolder-id',
              mimeType: 'application/vnd.google-apps.folder',
              uri: 'https://drive.google.com/drive/folders/subfolder-id',
            },
          ],
        });
        expect(mockDriveService.resolveFolderPath).toHaveBeenCalledWith(
          'shared-drive-root-id',
          ['1 Admin', 'Communication']
        );
        expect(mockDriveService.findOrCreateFolder).toHaveBeenNthCalledWith(
          1,
          'resolved-comm-folder-id',
          'Acme Corp'
        );
        expect(mockDriveService.findOrCreateFolder).toHaveBeenNthCalledWith(
          2,
          'contact-folder-id',
          '260920 IN - Meeting Notes'
        );
        expect(mockDriveService.move).not.toHaveBeenCalled();
      });

      it('throws when targetSourceFiles is empty and rootStorageId is missing', async () => {
        const zeroFilesHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            parentPath: '1 Admin/Communication',
            folderName: 'Acme Corp/260920 IN - Meeting Notes',
          },
        };

        await expect(zeroFilesHandler.handle(activity)).rejects.toThrow(
          'DriveActivityHandler: Cannot create destination folder for zero-file filing because rootStorageId is missing or unresolved in activity payload'
        );
      });
    });

    describe('Google Drive file/folder move & resilient 404/403 error mapping', () => {
      it('moves file ID via move and returns FileLocator on success', async () => {
        const fileHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'file-doc-123', name: 'Document.docx' }],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'file-doc-123',
          name: 'Document.docx',
          parents: ['target-folder-id'],
          mimeType: 'application/vnd.google-apps.document',
          webViewLink: 'https://docs.google.com/document/d/file-doc-123/edit',
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await fileHandler.handle(activity);

        expect(mockDriveService.move).toHaveBeenCalledWith('file-doc-123', 'target-folder-id');
        expect(result).toEqual({
          success: true,
          files: [
            {
              id: 'file-doc-123',
              name: 'Document.docx',
              parentId: 'target-folder-id',
              parentName: 'Target Folder',
              parentUri: 'https://drive.google.com/drive/folders/target-folder-id',
              mimeType: 'application/vnd.google-apps.document',
              uri: 'https://docs.google.com/document/d/file-doc-123/edit',
            },
          ],
        });
      });

      it('moves folder ID via move and returns FileLocator on success', async () => {
        const folderHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'folder-sub-456', name: 'SubFolder' }],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'folder-sub-456',
          name: 'SubFolder',
          parents: ['target-folder-id'],
          mimeType: 'application/vnd.google-apps.folder',
          webViewLink: 'https://drive.google.com/drive/folders/folder-sub-456',
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await folderHandler.handle(activity);

        expect(mockDriveService.move).toHaveBeenCalledWith('folder-sub-456', 'target-folder-id');
        expect(result).toEqual({
          success: true,
          files: [
            {
              id: 'folder-sub-456',
              name: 'SubFolder',
              parentId: 'target-folder-id',
              parentName: 'Target Folder',
              parentUri: 'https://drive.google.com/drive/folders/target-folder-id',
              mimeType: 'application/vnd.google-apps.folder',
              uri: 'https://drive.google.com/drive/folders/folder-sub-456',
            },
          ],
        });
      });

      it('catches FileNotFoundError during move and returns mapped error "The specified Google Drive file or folder was not found."', async () => {
        const notFoundHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'non-existent-id', name: 'Missing' }],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.move as ReturnType<typeof vi.fn>).mockRejectedValue(
          new FileNotFoundError('File not found: non-existent-id')
        );

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await notFoundHandler.handle(activity);

        expect(result).toEqual({
          success: false,
          error: 'The specified Google Drive file or folder was not found.',
          files: [],
        });
      });

      it('catches 403 error during move and returns mapped error "Access denied. You do not have permission to access this Google Drive file or folder."', async () => {
        const forbiddenHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'forbidden-id', name: 'Restricted' }],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.move as ReturnType<typeof vi.fn>).mockRejectedValue(
          new DriveServiceError('Drive service error (403) in move: Insufficient permissions for file')
        );

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await forbiddenHandler.handle(activity);

        expect(result).toEqual({
          success: false,
          error: 'Access denied. You do not have permission to access this Google Drive file or folder.',
          files: [],
        });
      });

      it('catches error containing "Access denied" or "insufficient permissions" and maps to friendly error', async () => {
        const deniedHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [{ id: 'denied-id', name: 'NoAccess' }],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.move as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('Access denied: user cannot write to resource')
        );

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await deniedHandler.handle(activity);

        expect(result).toEqual({
          success: false,
          error: 'Access denied. You do not have permission to access this Google Drive file or folder.',
          files: [],
        });
      });
    });

    describe('Binary SourceFile filing via saveBuffer (Ticket #200)', () => {
      it('saves binary sourceFile content using driveService.saveBuffer into leafFolder preserving name and mimeType', async () => {
        const binaryContent = new Uint8Array([1, 2, 3, 4]);
        const binaryHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [
            {
              id: 'att-1',
              name: 'Invoice.pdf',
              mimeType: 'application/pdf',
              content: binaryContent,
            },
          ],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'drive-file-new-1',
          name: 'Invoice.pdf',
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/drive-file-new-1/view',
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await binaryHandler.handle(activity);

        expect(mockDriveService.saveBuffer).toHaveBeenCalledWith(binaryContent, {
          action: 'create',
          targetFolderId: 'target-folder-id',
          name: 'Invoice.pdf',
          mimeType: 'application/pdf',
        });
        expect(mockDriveService.move).not.toHaveBeenCalled();
        expect(result).toEqual({
          success: true,
          files: [
            {
              id: 'drive-file-new-1',
              name: 'Invoice.pdf',
              parentId: 'target-folder-id',
              parentName: 'Target Folder',
              parentUri: 'https://drive.google.com/drive/folders/target-folder-id',
              mimeType: 'application/pdf',
              uri: 'https://drive.google.com/file/d/drive-file-new-1/view',
            },
          ],
        });
      });

      it('falls back to sourceFile.id if sourceFile.name is undefined when calling saveBuffer', async () => {
        const binaryContent = new Uint8Array([5, 6, 7]);
        const binaryHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [
            {
              id: 'att-unnamed',
              mimeType: 'image/png',
              content: binaryContent,
            },
          ],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'drive-file-new-2',
          name: 'att-unnamed',
          mimeType: 'image/png',
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await binaryHandler.handle(activity);

        expect(mockDriveService.saveBuffer).toHaveBeenCalledWith(binaryContent, {
          action: 'create',
          targetFolderId: 'target-folder-id',
          name: 'att-unnamed',
          mimeType: 'image/png',
        });
        expect(result.files).toHaveLength(1);
        expect(result.files?.[0].uri).toBe('');
      });

      it('does NOT call getFile().parents when resolving startingId if targetSourceFiles[0] has binary content', async () => {
        const binaryHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [
            {
              id: 'att-binary-no-parent',
              name: 'Invoice.pdf',
              content: new Uint8Array([1, 2]),
            },
          ],
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            folderName: 'Target Folder',
          },
        };

        await expect(binaryHandler.handle(activity)).rejects.toThrow(
          'DriveActivityHandler: Cannot create destination folder for binary file filing because rootStorageId is missing or unresolved in activity payload'
        );
        expect(mockDriveService.getFile).not.toHaveBeenCalled();
      });

      it('handles mixed source files saving binary files via saveBuffer and moving Drive items via move', async () => {
        const binaryContent = new Uint8Array([9, 9]);
        const mixedHandler = new DriveActivityHandler(mockDriveService, {
          sourceFiles: [
            {
              id: 'att-binary',
              name: 'Attachment.pdf',
              mimeType: 'application/pdf',
              content: binaryContent,
            },
            {
              id: 'drive-item-123',
              name: 'ExistingDoc.docx',
            },
          ],
        });

        (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'target-folder-id',
          name: 'Target Folder',
        });
        (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'drive-saved-1',
          name: 'Attachment.pdf',
          mimeType: 'application/pdf',
          webViewLink: 'https://drive.google.com/file/d/drive-saved-1/view',
        });
        (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
          id: 'drive-item-123',
          name: 'ExistingDoc.docx',
          mimeType: 'application/vnd.google-apps.document',
          webViewLink: 'https://drive.google.com/file/d/drive-item-123/view',
        });

        const activity: Activity = {
          type: 'MOVE_FILE',
          payload: {
            rootStorageId: 'root-storage-id',
            folderName: 'Target Folder',
          },
        };

        const result = await mixedHandler.handle(activity);

        expect(mockDriveService.saveBuffer).toHaveBeenCalledWith(binaryContent, {
          action: 'create',
          targetFolderId: 'target-folder-id',
          name: 'Attachment.pdf',
          mimeType: 'application/pdf',
        });
        expect(mockDriveService.move).toHaveBeenCalledWith('drive-item-123', 'target-folder-id');
        expect(result.success).toBe(true);
        expect(result.files).toHaveLength(2);
        expect(result.files?.[0].id).toBe('drive-saved-1');
        expect(result.files?.[1].id).toBe('drive-item-123');
      });

      describe('sourceFileHydrator integration', () => {
        it('invokes sourceFileHydrator.hydrate in handleMove after findOrCreateFolder and before saving/moving files', async () => {
          const callOrder: string[] = [];
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            callOrder.push('findOrCreateFolder');
            return { id: 'target-folder-id', name: 'Target Folder' };
          });

          const hydratedBytes = new Uint8Array([5, 6, 7]);
          const mockHydrator: SourceFileHydratorPort = {
            hydrate: vi.fn().mockImplementation(async (files) => {
              callOrder.push('hydrate');
              return files.map((f: { id: string }) => ({
                id: f.id,
                name: 'Hydrated.pdf',
                mimeType: 'application/pdf',
                content: hydratedBytes,
              }));
            }),
          };

          (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockImplementation(async () => {
            callOrder.push('saveBuffer');
            return {
              id: 'saved-file-1',
              name: 'Hydrated.pdf',
              mimeType: 'application/pdf',
              webViewLink: 'https://drive.google.com/file/d/saved-file-1/view',
            };
          });

          const hydratorHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'att-raw-1' }],
            sourceFileHydrator: mockHydrator,
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await hydratorHandler.handle(activity);

          expect(callOrder).toEqual(['findOrCreateFolder', 'hydrate', 'saveBuffer']);
          expect(mockHydrator.hydrate).toHaveBeenCalledWith([{ id: 'att-raw-1' }]);
          expect(mockDriveService.saveBuffer).toHaveBeenCalledWith(hydratedBytes, {
            action: 'create',
            targetFolderId: 'target-folder-id',
            name: 'Hydrated.pdf',
            mimeType: 'application/pdf',
          });
          expect(result.success).toBe(true);
        });

        it('does not invoke hydrate if findOrCreateFolder fails', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockRejectedValue(
            new FileNotFoundError('Folder not found')
          );

          const mockHydrator: SourceFileHydratorPort = {
            hydrate: vi.fn(),
          };

          const hydratorHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'att-raw-1' }],
            sourceFileHydrator: mockHydrator,
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'NonExistent',
            },
          };

          const result = await hydratorHandler.handle(activity);

          expect(result.success).toBe(false);
          expect(mockHydrator.hydrate).not.toHaveBeenCalled();
        });

        it('skips hydrate call if all sourceFiles already have binary content', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });
          (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'saved-file-1',
            name: 'AlreadyBinary.pdf',
          });

          const mockHydrator: SourceFileHydratorPort = {
            hydrate: vi.fn(),
          };

          const binaryContent = new Uint8Array([1, 2]);
          const hydratorHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'already-binary', content: binaryContent, name: 'AlreadyBinary.pdf' }],
            sourceFileHydrator: mockHydrator,
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await hydratorHandler.handle(activity);

          expect(mockHydrator.hydrate).not.toHaveBeenCalled();
          expect(mockDriveService.saveBuffer).toHaveBeenCalled();
          expect(result.success).toBe(true);
        });
      });

      describe('unhydrated SourceFile guards (Ticket #207)', () => {
        it('returns error without calling driveService.move when an unhydrated email-pdf reaches the move loop', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });

          const handler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'email-pdf-msg-123' }],
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await handler.handle(activity);

          expect(result.success).toBe(false);
          expect(result.error).toBe('Could not generate the Email PDF. Please try again.');
          expect(result.files).toEqual([]);
          expect(mockDriveService.findOrCreateFolder).toHaveBeenCalled();
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('returns error without calling driveService.move when an unhydrated email attachment reaches the move loop with isFileSourceEmailAttachments: true', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });

          const handler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'some-att-id', name: 'Invoice.pdf' }],
            isFileSourceEmailAttachments: true,
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await handler.handle(activity);

          expect(result.success).toBe(false);
          expect(result.error).toBe(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          );
          expect(result.files).toEqual([]);
          expect(mockDriveService.findOrCreateFolder).toHaveBeenCalled();
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('returns error without calling driveService.move when an unhydrated email attachment has part- prefix', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });

          const handler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'part-0.1', name: 'Receipt.pdf' }],
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await handler.handle(activity);

          expect(result.success).toBe(false);
          expect(result.error).toBe(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          );
          expect(result.files).toEqual([]);
          expect(mockDriveService.findOrCreateFolder).toHaveBeenCalled();
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('returns error without calling driveService.move when an unhydrated email attachment has inline- prefix', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });

          const handler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'inline-part-0.2', name: 'small-photo.png' }],
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await handler.handle(activity);

          expect(result.success).toBe(false);
          expect(result.error).toBe(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          );
          expect(result.files).toEqual([]);
          expect(mockDriveService.findOrCreateFolder).toHaveBeenCalled();
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('preserves created folder and already-saved files when an unhydrated email-pdf follows a successfully saved binary file', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });
          (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'saved-att-1',
            name: 'Invoice.pdf',
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/saved-att-1/view',
          });

          const binaryBytes = new Uint8Array([1, 2, 3]);
          const handler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [
              { id: 'att-1', name: 'Invoice.pdf', content: binaryBytes, mimeType: 'application/pdf' },
              { id: 'email-pdf-msg-123' },
            ],
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await handler.handle(activity);

          expect(result.success).toBe(false);
          expect(result.error).toBe('Could not generate the Email PDF. Please try again.');
          expect(result.files).toHaveLength(1);
          expect(result.files?.[0]).toEqual({
            id: 'saved-att-1',
            name: 'Invoice.pdf',
            parentId: 'target-folder-id',
            parentName: 'Target Folder',
            parentUri: 'https://drive.google.com/drive/folders/target-folder-id',
            mimeType: 'application/pdf',
            uri: 'https://drive.google.com/file/d/saved-att-1/view',
          });
          expect(mockDriveService.saveBuffer).toHaveBeenCalledTimes(1);
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('preserves created folder and already-saved files when an unhydrated email attachment follows a successfully saved binary file', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });
          (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'saved-att-1',
            name: 'Invoice.pdf',
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/saved-att-1/view',
          });

          const binaryBytes = new Uint8Array([1, 2, 3]);
          const handler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [
              { id: 'att-1', name: 'Invoice.pdf', content: binaryBytes, mimeType: 'application/pdf' },
              { id: 'part-2', name: 'SecondAttachment.pdf' },
            ],
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await handler.handle(activity);

          expect(result.success).toBe(false);
          expect(result.error).toBe(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          );
          expect(result.files).toHaveLength(1);
          expect(result.files?.[0].id).toBe('saved-att-1');
          expect(mockDriveService.saveBuffer).toHaveBeenCalledTimes(1);
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('propagates DriveServiceError from sourceFileHydrator.hydrate preserving created folder', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'target-folder-id',
            name: 'Target Folder',
          });

          const mockHydrator: SourceFileHydratorPort = {
            hydrate: vi.fn().mockRejectedValue(
              new DriveServiceError(
                'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
              )
            ),
          };

          const handler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'att-1' }],
            sourceFileHydrator: mockHydrator,
          });

          const activity: Activity = {
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Target Folder',
            },
          };

          const result = await handler.handle(activity);

          expect(result.success).toBe(false);
          expect(result.error).toBe(
            'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.'
          );
          expect(result.files).toEqual([]);
          expect(mockDriveService.findOrCreateFolder).toHaveBeenCalled();
          expect(mockDriveService.move).not.toHaveBeenCalled();
          expect(mockDriveService.saveBuffer).not.toHaveBeenCalled();
        });
      });

      describe('MOVE_FILE atomic rename and extension preservation (#375)', () => {
        it('preserves real source extension and calls driveService.move with newName', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'closed-folder-id',
            name: '08 Openings',
          });
          (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'file-arch-1',
            name: '081100-001-0 Doors - 261102 PMG.pdf',
            parents: ['closed-folder-id'],
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/file-arch-1/view',
          });

          const renameHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [
              { id: 'file-arch-1', name: 'Original Upload.pdf', mimeType: 'application/pdf' },
            ],
          });

          const result = await renameHandler.handle({
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'drive-root-1',
              folderName: 'Submittals/Closed/08 Openings',
              fileName: '081100-001-0 Doors - 261102 PMG',
            },
          });

          expect(mockDriveService.move).toHaveBeenCalledWith('file-arch-1', 'closed-folder-id', {
            newName: '081100-001-0 Doors - 261102 PMG.pdf',
          });
          expect(result).toEqual({
            success: true,
            files: [
              {
                id: 'file-arch-1',
                name: '081100-001-0 Doors - 261102 PMG.pdf',
                parentId: 'closed-folder-id',
                parentName: '08 Openings',
                parentUri: 'https://drive.google.com/drive/folders/closed-folder-id',
                mimeType: 'application/pdf',
                uri: 'https://drive.google.com/file/d/file-arch-1/view',
              },
            ],
          });
        });

        it('fetches getFile metadata when sourceFile lacks name or mimeType during MOVE_FILE rename', async () => {
          (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'file-meta-1',
            name: '08.11.00 - Doors',
            mimeType: 'application/pdf',
            parents: ['inbox'],
          });
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'closed-folder-id',
            name: '08 Openings',
          });
          (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'file-meta-1',
            name: '081100-001-0 Doors - 261102 PMG.pdf',
            parents: ['closed-folder-id'],
            mimeType: 'application/pdf',
          });

          const renameHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'file-meta-1' }],
          });

          const result = await renameHandler.handle({
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'drive-root-1',
              folderName: '08 Openings',
              fileName: '081100-001-0 Doors - 261102 PMG',
            },
          });

          expect(result.success).toBe(true);
          expect(mockDriveService.getFile).toHaveBeenCalledWith('file-meta-1');
          expect(mockDriveService.move).toHaveBeenCalledWith('file-meta-1', 'closed-folder-id', {
            newName: '081100-001-0 Doors - 261102 PMG.pdf',
          });
        });

        it.each([
          {
            label: 'dotted non-extension text with whitespace falls back to MIME extension',
            sourceName: '08.11.00 - Doors',
            mimeType: 'application/pdf',
            requestedName: '081100-001-0 Doors - 261102 PMG',
            expectedName: '081100-001-0 Doors - 261102 PMG.pdf',
          },
          {
            label: 'dotted numeric section name falls back to MIME extension',
            sourceName: '08.11.00',
            mimeType: 'application/pdf',
            requestedName: '081100-001-0 Doors - 261102 PMG',
            expectedName: '081100-001-0 Doors - 261102 PMG.pdf',
          },
          {
            label: 'dotfile / dot-only basename falls back to MIME extension',
            sourceName: '..pdf',
            mimeType: 'application/pdf',
            requestedName: '081100-001-0 Doors - 261102 PMG',
            expectedName: '081100-001-0 Doors - 261102 PMG.pdf',
          },
          {
            label: 'dot-only name with unknown MIME preserves base without fabricated extension',
            sourceName: '...',
            mimeType: undefined,
            requestedName: '081100-001-0 Doors - 261102 PMG',
            expectedName: '081100-001-0 Doors - 261102 PMG',
          },
          {
            label: 'Google Workspace native doc skips MIME suffix',
            sourceName: '08.11.00 - Doors',
            mimeType: 'application/vnd.google-apps.document',
            requestedName: '081100-001-0 Doors - 261102 PMG',
            expectedName: '081100-001-0 Doors - 261102 PMG',
          },
          {
            label: 'Google Workspace native sheet skips MIME suffix',
            sourceName: 'Schedule',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            requestedName: '081100-001-0 Schedule - 261102 PMG',
            expectedName: '081100-001-0 Schedule - 261102 PMG',
          },
          {
            label: 'extensionless binary file falls back to MIME extension',
            sourceName: 'Scan_001',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            requestedName: '081100-001-0 Spec - 261102 PMG',
            expectedName: '081100-001-0 Spec - 261102 PMG.docx',
          },
          {
            label: 'prevents double extension when requested fileName already ends with same extension',
            sourceName: 'Original.pdf',
            mimeType: 'application/pdf',
            requestedName: '081100-001-0 Doors - 261102 PMG.PDF',
            expectedName: '081100-001-0 Doors - 261102 PMG.PDF',
          },
          {
            label: 'preserves source extension even when requested fileName has dotted CSI prefix',
            sourceName: 'Doors.dwg',
            mimeType: 'image/vnd.dwg',
            requestedName: '08.11.00 - Doors',
            expectedName: '08.11.00 - Doors.dwg',
          },
        ])('$label', async ({ sourceName, mimeType, requestedName, expectedName }) => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'dest-folder-id',
            name: 'Dest',
          });
          (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'file-case-1',
            name: expectedName,
            parents: ['dest-folder-id'],
            mimeType,
          });

          const caseHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'file-case-1', name: sourceName, ...(mimeType ? { mimeType } : {}) }],
          });

          const result = await caseHandler.handle({
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Dest',
              fileName: requestedName,
            },
          });

          expect(result.success).toBe(true);
          expect(mockDriveService.move).toHaveBeenCalledWith('file-case-1', 'dest-folder-id', {
            newName: expectedName,
          });
        });

        it('applies extension-preserving fileName when saving binary SourceFile via saveBuffer', async () => {
          const bytes = new Uint8Array([1, 2, 3]);
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'dest-folder-id',
            name: '07 Thermal and Moisture Protection',
          });
          (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'saved-renamed-1',
            name: '071200-001-0 Waterproofing - 261102 PMG.pdf',
            parents: ['dest-folder-id'],
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/saved-renamed-1/view',
          });

          const binaryRenameHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [
              {
                id: 'att-1',
                name: '07.12.00 - Waterproofing',
                mimeType: 'application/pdf',
                content: bytes,
              },
            ],
          });

          const result = await binaryRenameHandler.handle({
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Submittals/Closed/07 Thermal and Moisture Protection',
              fileName: '071200-001-0 Waterproofing - 261102 PMG',
            },
          });

          expect(result.success).toBe(true);
          expect(mockDriveService.saveBuffer).toHaveBeenCalledWith(bytes, {
            action: 'create',
            targetFolderId: 'dest-folder-id',
            name: '071200-001-0 Waterproofing - 261102 PMG.pdf',
            mimeType: 'application/pdf',
          });
          expect(result.files?.[0]).toMatchObject({
            id: 'saved-renamed-1',
            name: '071200-001-0 Waterproofing - 261102 PMG.pdf',
            parentId: 'dest-folder-id',
          });
        });

        it('returns failure when payload.fileName is blank or whitespace-only', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'dest-folder-id',
            name: 'Dest',
          });
          const renameHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'file-1', name: 'Doc.pdf', mimeType: 'application/pdf' }],
          });

          const result = await renameHandler.handle({
            type: 'MOVE_FILE',
            payload: {
              rootStorageId: 'root-id',
              folderName: 'Dest',
              fileName: '   ',
            },
          });

          expect(result.success).toBe(false);
          expect(result.error).toMatch(/fileName/i);
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('does not treat payload.fileName as a search query in MOVE_FILE when fileId and sourceFiles are missing', async () => {
          await expect(
            handler.handle({
              type: 'MOVE_FILE',
              payload: {
                rootStorageId: 'root-id',
                folderName: 'Dest',
                fileName: '071200-001-0 Waterproofing - 261102 PMG',
              },
            })
          ).rejects.toThrow(/No fileId found in activity payload or execution context/);
          expect(mockDriveService.searchFiles).not.toHaveBeenCalled();
        });
      });

      describe('DUPLICATE_FILE active review copy (#377)', () => {
        it('canHandle returns true for DUPLICATE_FILE', () => {
          expect(handler.canHandle({ type: 'DUPLICATE_FILE', payload: {} })).toBe(true);
        });

        it('duplicates file resolved via context.stepOutputs[fileSourceStepId] into destination folder with non-doubling "_" prefix and FileLocator.parentId', async () => {
          (mockDriveService.resolveFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'folder-6-const',
            name: '6 Construction',
          });
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'folder-submittals',
            name: 'Submittals',
            parents: ['folder-6-const'],
          });
          (mockDriveService.duplicate as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'review-copy-1',
            name: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
            parents: ['folder-submittals'],
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/review-copy-1/view',
          });

          const result = await handler.handle(
            {
              id: 'duplicateForReview',
              type: 'DUPLICATE_FILE',
              payload: {
                fileSourceStepId: 'moveOriginal',
                rootStorageId: 'drive-root-1',
                parentPath: '6 Construction',
                folderName: 'Submittals',
                fileName: '071200-001-0 Waterproofing - 261102 PMG',
                fileNamePrefix: '_',
              },
            },
            {
              document: {
                type: 'submittal-arch',
                data: {},
              },
              files: [],
              stepOutputs: {
                moveOriginal: {
                  success: true,
                  files: [
                    {
                      id: 'archived-original-1',
                      name: '071200-001-0 Waterproofing - 261102 PMG.pdf',
                      parentId: 'folder-closed-07',
                      parentName: '07 Thermal and Moisture Protection',
                      mimeType: 'application/pdf',
                      uri: 'https://drive.google.com/file/d/archived-original-1/view',
                    },
                  ],
                },
              },
              contextVariables: {},
            }
          );

          expect(mockDriveService.resolveFolderPath).toHaveBeenCalledWith('drive-root-1', [
            '6 Construction',
          ]);
          expect(mockDriveService.findOrCreateFolder).toHaveBeenCalledWith(
            'folder-6-const',
            'Submittals'
          );
          expect(mockDriveService.duplicate).toHaveBeenCalledWith('archived-original-1', {
            targetFolderId: 'folder-submittals',
            newName: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
          });
          expect(result).toEqual({
            success: true,
            files: [
              {
                id: 'review-copy-1',
                name: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
                parentId: 'folder-submittals',
                parentName: 'Submittals',
                parentUri: 'https://drive.google.com/drive/folders/folder-submittals',
                mimeType: 'application/pdf',
                uri: 'https://drive.google.com/file/d/review-copy-1/view',
              },
            ],
          });
        });

        it('does not double leading "_" prefix when fileName or source name already begins with "_"', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'folder-submittals',
            name: 'Submittals',
            parents: ['drive-root-1'],
          });
          (mockDriveService.duplicate as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'review-copy-2',
            name: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
            parents: ['folder-submittals'],
            mimeType: 'application/pdf',
          });

          const result = await handler.handle(
            {
              type: 'DUPLICATE_FILE',
              payload: {
                fileSourceStepId: 'moveOriginal',
                rootStorageId: 'drive-root-1',
                folderName: 'Submittals',
                fileName: '_071200-001-0 Waterproofing - 261102 PMG',
                fileNamePrefix: '_',
              },
            },
            {
              document: { type: 'submittal-arch', data: {} },
              files: [],
              stepOutputs: {
                moveOriginal: {
                  success: true,
                  files: [
                    {
                      id: 'orig-1',
                      name: '_AlreadyPrefixed.pdf',
                      mimeType: 'application/pdf',
                    },
                  ],
                },
              },
              contextVariables: {},
            }
          );

          expect(result.success).toBe(true);
          expect(mockDriveService.duplicate).toHaveBeenCalledWith('orig-1', {
            targetFolderId: 'folder-submittals',
            newName: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
          });
        });

        it('uses source file name with "_" prefix when fileName is omitted, and skips MIME suffix on Google Workspace native files', async () => {
          (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'gdoc-1',
            name: 'Original Spec',
            parents: ['folder-3-ffe'],
            mimeType: 'application/vnd.google-apps.document',
          });
          (mockDriveService.resolveFolderPath as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'folder-3-ffe',
            name: '3 FFE',
          });
          (mockDriveService.duplicate as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({
              id: 'copy-native-1',
              name: '_Original Spec',
              parents: ['folder-3-ffe'],
              mimeType: 'application/vnd.google-apps.document',
            })
            .mockResolvedValueOnce({
              id: 'copy-renamed-native-2',
              name: '_AC102-A Berman Falk - 261102 INC',
              parents: ['folder-3-ffe'],
              mimeType: 'application/vnd.google-apps.document',
            });

          const r1 = await handler.handle(
            {
              type: 'DUPLICATE_FILE',
              payload: {
                fileSourceStepId: 'moveOriginal',
                rootStorageId: 'drive-root-1',
                parentPath: '3 FFE',
                fileNamePrefix: '_',
              },
            },
            {
              document: { type: 'submittal-ffe', data: {} },
              files: [],
              stepOutputs: {
                moveOriginal: {
                  success: true,
                  files: [
                    {
                      id: 'gdoc-1',
                      name: 'Original Spec',
                      mimeType: 'application/vnd.google-apps.document',
                    },
                  ],
                },
              },
              contextVariables: {},
            }
          );
          expect(r1.success).toBe(true);
          expect(mockDriveService.duplicate).toHaveBeenNthCalledWith(1, 'gdoc-1', {
            targetFolderId: 'folder-3-ffe',
            newName: '_Original Spec',
          });

          const r2 = await handler.handle(
            {
              type: 'DUPLICATE_FILE',
              payload: {
                fileId: 'gdoc-1',
                rootStorageId: 'drive-root-1',
                parentPath: '3 FFE',
                fileName: 'AC102-A Berman Falk - 261102 INC',
                fileNamePrefix: '_',
              },
            }
          );
          expect(r2.success).toBe(true);
          expect(mockDriveService.duplicate).toHaveBeenNthCalledWith(2, 'gdoc-1', {
            targetFolderId: 'folder-3-ffe',
            newName: '_AC102-A Berman Falk - 261102 INC',
          });
        });

        it('allows native Drive duplicate filenames and falls back to context.files when fileSourceStepId is omitted', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'folder-submittals',
            name: 'Submittals',
          });
          (mockDriveService.duplicate as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce({
              id: 'dup-1',
              name: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
              parents: ['folder-submittals'],
              mimeType: 'application/pdf',
            })
            .mockResolvedValueOnce({
              id: 'dup-2',
              name: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
              parents: ['folder-submittals'],
              mimeType: 'application/pdf',
            });

          const ctx = {
            document: { type: 'submittal-arch', data: {} },
            files: [
              {
                id: 'moved-1',
                name: '071200-001-0 Waterproofing - 261102 PMG.pdf',
                mimeType: 'application/pdf',
              },
            ],
            stepOutputs: {},
            contextVariables: {},
          };
          const act: Activity = {
            type: 'DUPLICATE_FILE',
            payload: {
              rootStorageId: 'drive-root-1',
              folderName: 'Submittals',
              fileNamePrefix: '_',
            },
          };

          const first = await handler.handle(act, ctx);
          const second = await handler.handle(act, ctx);
          expect(first.success).toBe(true);
          expect(second.success).toBe(true);
          expect(first.files?.[0]?.name).toBe('_071200-001-0 Waterproofing - 261102 PMG.pdf');
          expect(second.files?.[0]?.name).toBe('_071200-001-0 Waterproofing - 261102 PMG.pdf');
        });

        it('fails fast when fileSourceStepId is unexecuted, missing context, or resolves zero FileLocators', async () => {
          const unexecuted = await handler.handle(
            {
              type: 'DUPLICATE_FILE',
              payload: {
                fileSourceStepId: 'missingStep',
                rootStorageId: 'drive-root-1',
                folderName: 'Submittals',
              },
            },
            {
              document: { type: 'submittal-arch', data: {} },
              files: [],
              stepOutputs: {},
              contextVariables: {},
            }
          );
          expect(unexecuted.success).toBe(false);
          expect(unexecuted.error).toContain('missingStep');
          expect(mockDriveService.findOrCreateFolder).not.toHaveBeenCalled();
          expect(mockDriveService.duplicate).not.toHaveBeenCalled();

          const zeroFiles = await handler.handle(
            {
              type: 'DUPLICATE_FILE',
              payload: {
                fileSourceStepId: 'moveOriginal',
                rootStorageId: 'drive-root-1',
                folderName: 'Submittals',
              },
            },
            {
              document: { type: 'submittal-arch', data: {} },
              files: [{ id: 'unrelated', name: 'Other.pdf' }],
              stepOutputs: {
                moveOriginal: { success: true, files: [] },
              },
              contextVariables: {},
            }
          );
          expect(zeroFiles.success).toBe(false);
          expect(zeroFiles.error).toMatch(/zero files/i);
          expect(mockDriveService.duplicate).not.toHaveBeenCalled();

          const moveZeroFiles = await handler.handle(
            {
              type: 'MOVE_FILE',
              payload: {
                fileSourceStepId: 'prevStep',
                rootStorageId: 'drive-root-1',
                folderName: 'Submittals',
              },
            },
            {
              document: { type: 'submittal-arch', data: {} },
              files: [],
              stepOutputs: {
                prevStep: { success: true, files: [] },
              },
              contextVariables: {},
            }
          );
          expect(moveZeroFiles.success).toBe(false);
          expect(moveZeroFiles.error).toMatch(/zero files/i);
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });

        it('rejects blank fileName or fileNamePrefix on DUPLICATE_FILE before Drive calls', async () => {
          const badFileName = await handler.handle({
            type: 'DUPLICATE_FILE',
            payload: {
              fileId: 'file-1',
              rootStorageId: 'drive-root-1',
              folderName: 'Submittals',
              fileName: '   ',
            },
          });
          expect(badFileName.success).toBe(false);
          expect(badFileName.error).toMatch(/fileName/i);

          const badPrefix = await handler.handle({
            type: 'DUPLICATE_FILE',
            payload: {
              fileId: 'file-1',
              rootStorageId: 'drive-root-1',
              folderName: 'Submittals',
              fileNamePrefix: '  ',
            },
          });
          expect(badPrefix.success).toBe(false);
          expect(badPrefix.error).toMatch(/fileNamePrefix/i);
          expect(mockDriveService.duplicate).not.toHaveBeenCalled();
        });

        it('does not re-hydrate or reject fileSourceStepId FileLocators as unhydrated email attachments in Gmail mode', async () => {
          const mockHydrator: SourceFileHydratorPort = {
            hydrate: vi.fn().mockRejectedValue(new Error('Should not hydrate Drive FileLocators')),
          };
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'folder-submittals',
            name: 'Submittals',
          });
          (mockDriveService.duplicate as ReturnType<typeof vi.fn>).mockResolvedValue({
            id: 'gmail-dup-1',
            name: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
            parents: ['folder-submittals'],
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/gmail-dup-1/view',
          });

          const gmailHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [{ id: 'part-arch-1', name: 'Upload.pdf' }],
            sourceFileHydrator: mockHydrator,
            isFileSourceEmailAttachments: true,
          });

          const result = await gmailHandler.handle(
            {
              id: 'duplicateForReview',
              type: 'DUPLICATE_FILE',
              payload: {
                fileSourceStepId: 'moveOriginal',
                rootStorageId: 'drive-root-1',
                folderName: 'Submittals',
                fileName: '071200-001-0 Waterproofing - 261102 PMG',
                fileNamePrefix: '_',
              },
            },
            {
              document: { type: 'submittal-arch', data: {} },
              files: [],
              stepOutputs: {
                moveOriginal: {
                  success: true,
                  files: [
                    {
                      id: 'drive-saved-gmail-1',
                      name: '071200-001-0 Waterproofing - 261102 PMG.pdf',
                      parentId: 'folder-closed-07',
                      parentName: '07 Thermal and Moisture Protection',
                      mimeType: 'application/pdf',
                    },
                  ],
                },
              },
              contextVariables: {},
            }
          );

          expect(result.success).toBe(true);
          expect(mockHydrator.hydrate).not.toHaveBeenCalled();
          expect(mockDriveService.duplicate).toHaveBeenCalledWith('drive-saved-gmail-1', {
            targetFolderId: 'folder-submittals',
            newName: '_071200-001-0 Waterproofing - 261102 PMG.pdf',
          });
        });
      });

      describe('parentUri, handleSearch parentName fix, and empty MOVE_FILE placeholder (#384)', () => {
        it('populates parentUri from leafFolder.webViewLink (or folder URL fallback) across MOVE_FILE (remote and binary) and DUPLICATE_FILE', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            id: 'folder-custom-link',
            name: 'Closed',
            parents: ['root'],
            webViewLink: 'https://drive.google.com/drive/u/0/folders/folder-custom-link',
          });
          (mockDriveService.move as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            id: 'file-123',
            name: 'Report.docx',
            parents: ['folder-custom-link'],
            webViewLink: 'https://drive.google.com/file/d/file-123/view',
          });
          const moveOutput = await handler.handle({
            type: 'MOVE_FILE',
            payload: { fileId: 'file-123', folderName: 'Closed' },
          });
          expect(moveOutput.files?.[0]?.parentUri).toBe(
            'https://drive.google.com/drive/u/0/folders/folder-custom-link'
          );

          // Fallback URL when webViewLink is absent on destination folder
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            id: 'folder-no-link',
            name: 'Submittals',
            parents: ['root'],
          });
          (mockDriveService.saveBuffer as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            id: 'bin-saved-1',
            name: 'Attachment.pdf',
            parents: ['folder-no-link'],
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/bin-saved-1/view',
          });
          const binaryHandler = new DriveActivityHandler(mockDriveService, {
            sourceFiles: [
              {
                id: 'att-1',
                name: 'Attachment.pdf',
                mimeType: 'application/pdf',
                content: new Uint8Array([1, 2, 3]),
              },
            ],
          });
          const binaryOutput = await binaryHandler.handle({
            type: 'MOVE_FILE',
            payload: { rootStorageId: 'root', folderName: 'Submittals' },
          });
          expect(binaryOutput.files?.[0]?.parentUri).toBe(
            'https://drive.google.com/drive/folders/folder-no-link'
          );

          // In-place DUPLICATE_FILE without leafFolder resolves real parentName and parentUri instead of writing parents[0] ID
          (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockImplementation(
            async (id: string) => {
              if (id === 'folder-real-parent') {
                return {
                  id: 'folder-real-parent',
                  name: '07 Thermal & Moisture',
                  mimeType: 'application/vnd.google-apps.folder',
                  webViewLink: 'https://drive.google.com/drive/folders/folder-real-parent',
                };
              }
              return {
                id,
                name: 'Original.pdf',
                mimeType: 'application/pdf',
                parents: ['folder-real-parent'],
              };
            }
          );
          (mockDriveService.duplicate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            id: 'dup-inplace-1',
            name: '_Original.pdf',
            parents: ['folder-real-parent'],
            mimeType: 'application/pdf',
            webViewLink: 'https://drive.google.com/file/d/dup-inplace-1/view',
          });
          const dupOutput = await handler.handle({
            type: 'DUPLICATE_FILE',
            payload: { fileId: 'file-orig-1', fileNamePrefix: '_' },
          });
          expect(dupOutput.files?.[0]).toEqual({
            id: 'dup-inplace-1',
            name: '_Original.pdf',
            parentId: 'folder-real-parent',
            parentName: '07 Thermal & Moisture',
            parentUri: 'https://drive.google.com/drive/folders/folder-real-parent',
            mimeType: 'application/pdf',
            uri: 'https://drive.google.com/file/d/dup-inplace-1/view',
          });
        });

        it('resolves real parentName and parentUri on SEARCH_DRIVE_FILE and never writes parents[0] ID into parentName', async () => {
          (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            {
              id: 'found-1',
              name: 'Budget.xlsx',
              parents: ['folder-acme-id'],
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              webViewLink: 'https://drive.google.com/file/d/found-1/view',
            },
          ]);
          (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            id: 'folder-acme-id',
            name: 'Acme Corp',
            mimeType: 'application/vnd.google-apps.folder',
            webViewLink: 'https://drive.google.com/drive/u/0/folders/folder-acme-id',
          });

          const resolvedSearch = await handler.handle({
            type: 'SEARCH_DRIVE_FILE',
            payload: { targetName: 'Budget.xlsx' },
          });
          expect(resolvedSearch.files?.[0]).toEqual({
            id: 'found-1',
            name: 'Budget.xlsx',
            parentId: 'folder-acme-id',
            parentName: 'Acme Corp',
            parentUri: 'https://drive.google.com/drive/u/0/folders/folder-acme-id',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            uri: 'https://drive.google.com/file/d/found-1/view',
          });

          // When parent folder lookup fails, parentName is omitted (never folder ID) and parentUri falls back
          (mockDriveService.searchFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            {
              id: 'found-2',
              name: 'Spec.pdf',
              parents: ['folder-unknown-id'],
              mimeType: 'application/pdf',
            },
          ]);
          (mockDriveService.getFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
            new Error('Not found')
          );

          const fallbackSearch = await handler.handle({
            type: 'FIND_DRIVE_FILE',
            payload: { targetName: 'Spec.pdf' },
          });
          expect(fallbackSearch.files?.[0]).toEqual({
            id: 'found-2',
            name: 'Spec.pdf',
            parentId: 'folder-unknown-id',
            parentUri: 'https://drive.google.com/drive/folders/folder-unknown-id',
            mimeType: 'application/pdf',
          });
          expect(fallbackSearch.files?.[0]?.parentName).toBeUndefined();
        });

        it('emits a single folder-only placeholder FileLocator (id === parentId, uri === parentUri) when MOVE_FILE runs with 0 SourceFiles', async () => {
          (mockDriveService.findOrCreateFolder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            id: 'empty-dest-folder-1',
            name: '261126 OT - Empty Comm',
            parents: ['comm-contact-folder'],
            mimeType: 'application/vnd.google-apps.folder',
            webViewLink: 'https://drive.google.com/drive/u/0/folders/empty-dest-folder-1',
          });

          const zeroFilesHandler = new DriveActivityHandler(mockDriveService);
          const result = await zeroFilesHandler.handle(
            {
              id: 'moveFiles',
              type: 'MOVE_FILE',
              payload: {
                rootStorageId: 'shared-drive-1',
                folderName: '261126 OT - Empty Comm',
              },
            },
            {
              document: {
                type: 'communication-project',
                data: {},
                sourceFiles: [],
              },
              files: [],
              stepOutputs: {},
              contextVariables: {},
            }
          );

          expect(result).toEqual({
            success: true,
            files: [
              {
                id: 'empty-dest-folder-1',
                name: '261126 OT - Empty Comm',
                parentId: 'empty-dest-folder-1',
                parentName: '261126 OT - Empty Comm',
                parentUri: 'https://drive.google.com/drive/u/0/folders/empty-dest-folder-1',
                mimeType: 'application/vnd.google-apps.folder',
                uri: 'https://drive.google.com/drive/u/0/folders/empty-dest-folder-1',
              },
            ],
          });
          expect(mockDriveService.move).not.toHaveBeenCalled();
        });
      });

    });
  });
});



import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleDriveClient, GoogleDriveApiError, GoogleDriveAmbiguousPathError } from './drive-client';
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
          webViewLink: 'https://drive.google.com/file/d/file-123/view',
        },
      });

      const file = await client.getFile('file-123');

      expect(file).toEqual({
        id: 'file-123',
        name: 'Project Plan.pdf',
        parents: ['parent-folder-abc'],
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/file-123/view',
      });
      expect(mockDrive.files.get).toHaveBeenCalledWith({
        fileId: 'file-123',
        fields: 'id, name, parents, mimeType, webViewLink',
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
        webViewLink: undefined,
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
              webViewLink: 'https://drive.google.com/drive/folders/existing-folder-id',
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
        webViewLink: 'https://drive.google.com/drive/folders/existing-folder-id',
      });
      expect(mockDrive.files.list).toHaveBeenCalledWith({
        q: "'parent-folder-abc' in parents and name = '!TestMove' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: 'files(id, name, parents, mimeType, webViewLink)',
        spaces: 'drive',
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
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
          webViewLink: 'https://drive.google.com/drive/folders/new-folder-id',
        },
      });

      const folder = await client.findOrCreateFolder('parent-folder-abc', '!TestMove');

      expect(folder).toEqual({
        id: 'new-folder-id',
        name: '!TestMove',
        parents: ['parent-folder-abc'],
        mimeType: 'application/vnd.google-apps.folder',
        webViewLink: 'https://drive.google.com/drive/folders/new-folder-id',
      });
      expect(mockDrive.files.create).toHaveBeenCalledWith({
        requestBody: {
          name: '!TestMove',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['parent-folder-abc'],
        },
        fields: 'id, name, parents, mimeType, webViewLink',
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
          webViewLink: 'https://drive.google.com/file/d/file-123/view',
        },
      });

      const moved = await client.moveFile('file-123', 'old-parent-id', 'new-target-folder-id');

      expect(moved).toEqual({
        id: 'file-123',
        name: 'Project Plan.pdf',
        parents: ['new-target-folder-id'],
        mimeType: undefined,
        webViewLink: 'https://drive.google.com/file/d/file-123/view',
      });

      expect(mockDrive.files.update).toHaveBeenCalledWith({
        fileId: 'file-123',
        addParents: 'new-target-folder-id',
        removeParents: 'old-parent-id',
        fields: 'id, name, parents, mimeType, webViewLink',
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

    describe('single-level expectedParentPathNames', () => {
      it('executes exact match parent query with pageSize 21 and trashed = false, then finds target in parent', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          // 1. Parent folder query
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'folder-p1', name: 'Invoices' },
              ],
            },
          })
          // 2. Target file query
          .mockResolvedValueOnce({
            data: {
              files: [
                {
                  id: 'file-in-p1',
                  name: 'Invoice_2026.xlsx',
                  parents: ['folder-p1'],
                  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  webViewLink: 'https://drive.google.com/file/d/file-in-p1/view',
                },
              ],
            },
          });

        const results = await client.searchFiles({
          targetName: 'Invoice',
          expectedParentPathNames: ['Invoices'],
        });

        expect(results).toEqual([
          {
            id: 'file-in-p1',
            name: 'Invoice_2026.xlsx',
            parents: ['folder-p1'],
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            webViewLink: 'https://drive.google.com/file/d/file-in-p1/view',
          },
        ]);

        expect(mockDrive.files.list).toHaveBeenCalledTimes(2);

        // Parent query
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(1, {
          q: "name = 'Invoices' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 21,
          fields: 'files(id, name)',
          corpora: 'user',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });

        // Target query
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, {
          q: "name contains 'Invoice' and 'folder-p1' in parents and trashed = false",
          fields: 'files(id, name, parents, mimeType, webViewLink)',
          corpora: 'user',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
      });

      it('enforces 20 match threshold: strictly throwing GoogleDriveAmbiguousPathError on 21 parent results', async () => {
        const twentyOneFolders = Array.from({ length: 21 }, (_, i) => ({
          id: `folder-${i + 1}`,
          name: 'Duplicates',
        }));

        (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          data: {
            files: twentyOneFolders,
          },
        });

        const error = await client
          .searchFiles({
            targetName: 'Doc.pdf',
            expectedParentPathNames: ['Duplicates'],
          })
          .catch((e) => e);

        expect(error).toBeInstanceOf(GoogleDriveAmbiguousPathError);
        expect(error.name).toBe('GoogleDriveAmbiguousPathError');
        expect(error.message).toMatch(/AmbiguousPathSpecError: Query for parent folder 'Duplicates' returned 21 results, exceeding the threshold cap of 20 matches/);
        expect(mockDrive.files.list).toHaveBeenCalledTimes(1);
      });

      it('succeeds and consolidates with OR when parent query returns exactly 20 matches', async () => {
        const twentyFolders = Array.from({ length: 20 }, (_, i) => ({
          id: `f-${i + 1}`,
          name: 'Project',
        }));

        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            data: { files: twentyFolders },
          })
          .mockResolvedValueOnce({
            data: {
              files: [
                {
                  id: 'target-file-id',
                  name: 'Target.pdf',
                  parents: ['f-5'],
                },
              ],
            },
          });

        const results = await client.searchFiles({
          targetName: 'Target.pdf',
          exactMatch: true,
          expectedParentPathNames: ['Project'],
        });

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('target-file-id');

        const expectedParentOrClause = twentyFolders.map((f) => `'${f.id}' in parents`).join(' or ');
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, {
          q: `name = 'Target.pdf' and (${expectedParentOrClause}) and trashed = false`,
          fields: 'files(id, name, parents, mimeType, webViewLink)',
          corpora: 'user',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
      });

      it('returns empty array when 0 parent folders match without searching for target file', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
          data: { files: [] },
        });

        const results = await client.searchFiles({
          targetName: 'File.pdf',
          expectedParentPathNames: ['NonExistentFolder'],
        });

        expect(results).toEqual([]);
        expect(mockDrive.files.list).toHaveBeenCalledTimes(1);
      });

      it('escapes single quotes in parent folder name and target file name', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'p-quotes', name: "O'Connor's Folder" }],
            },
          })
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'f-quotes', name: "O'Reilly's Summary.pdf", parents: ['p-quotes'] },
              ],
            },
          });

        const results = await client.searchFiles({
          targetName: "O'Reilly's Summary.pdf",
          exactMatch: true,
          expectedParentPathNames: ["O'Connor's Folder"],
        });

        expect(results).toHaveLength(1);
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(1, expect.objectContaining({
          q: "name = 'O\\'Connor\\'s Folder' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        }));
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
          q: "name = 'O\\'Reilly\\'s Summary.pdf' and 'p-quotes' in parents and trashed = false",
        }));
      });

      it('scopes single-level parent and target queries to sharedDriveId when provided', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'sd-parent-1', name: 'SharedFolder' }],
            },
          })
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'sd-target-1', name: 'SharedTarget.docx', parents: ['sd-parent-1'] }],
            },
          });

        await client.searchFiles({
          targetName: 'SharedTarget.docx',
          exactMatch: true,
          expectedParentPathNames: ['SharedFolder'],
          sharedDriveId: 'team-drive-123',
        });

        expect(mockDrive.files.list).toHaveBeenNthCalledWith(1, expect.objectContaining({
          corpora: 'drive',
          driveId: 'team-drive-123',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        }));
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
          corpora: 'drive',
          driveId: 'team-drive-123',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        }));
      });

      it('applies mimeTypes filter to target search within single parent', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'parent-id', name: 'Spreadsheets' }],
            },
          })
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'sheet-id', name: 'Ledger', mimeType: 'application/vnd.google-apps.spreadsheet' }],
            },
          });

        await client.searchFiles({
          targetName: 'Ledger',
          expectedParentPathNames: ['Spreadsheets'],
          mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        });

        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
          q: "name contains 'Ledger' and 'parent-id' in parents and trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'",
        }));
      });
    });

    describe('multi-level expectedParentPathNames', () => {
      it('executes top-down traversal for 2-level path and finds target in deepest parent', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          // 1. Level 0 query: "Acme Corp"
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'acme-id', name: 'Acme Corp' }],
            },
          })
          // 2. Level 1 query: "Invoices" under "Acme Corp"
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'inv-id', name: 'Invoices' }],
            },
          })
          // 3. Target query: "Log_Sheet.xlsx" under "Invoices"
          .mockResolvedValueOnce({
            data: {
              files: [
                {
                  id: 'file-target-1',
                  name: 'Log_Sheet.xlsx',
                  parents: ['inv-id'],
                  mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  webViewLink: 'https://drive.google.com/file/d/file-target-1/view',
                },
              ],
            },
          });

        const results = await client.searchFiles({
          targetName: 'Log_Sheet.xlsx',
          exactMatch: true,
          expectedParentPathNames: ['Acme Corp', 'Invoices'],
        });

        expect(results).toEqual([
          {
            id: 'file-target-1',
            name: 'Log_Sheet.xlsx',
            parents: ['inv-id'],
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            webViewLink: 'https://drive.google.com/file/d/file-target-1/view',
          },
        ]);

        expect(mockDrive.files.list).toHaveBeenCalledTimes(3);

        // Level 0: Global search for first parent folder
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(1, {
          q: "name = 'Acme Corp' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 21,
          fields: 'files(id, name)',
          corpora: 'user',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });

        // Level 1: Scoped to acme-id
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, {
          q: "name = 'Invoices' and 'acme-id' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 21,
          fields: 'files(id, name)',
          corpora: 'user',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });

        // Target: Scoped to inv-id
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(3, {
          q: "name = 'Log_Sheet.xlsx' and 'inv-id' in parents and trashed = false",
          fields: 'files(id, name, parents, mimeType, webViewLink)',
          corpora: 'user',
          spaces: 'drive',
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });
      });

      it('consolidates multiple surviving parent IDs with OR at each level across 3-level path', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          // Level 0: "Region" returns 2 folders
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'region-1', name: 'Region' },
                { id: 'region-2', name: 'Region' },
              ],
            },
          })
          // Level 1: "Offices" under (region-1 or region-2) returns 3 folders
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'office-a', name: 'Offices' },
                { id: 'office-b', name: 'Offices' },
                { id: 'office-c', name: 'Offices' },
              ],
            },
          })
          // Level 2: "2026" under (office-a or office-b or office-c) returns 2 folders
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'year-2026-1', name: '2026' },
                { id: 'year-2026-2', name: '2026' },
              ],
            },
          })
          // Target: "Summary.pdf" under (year-2026-1 or year-2026-2)
          .mockResolvedValueOnce({
            data: {
              files: [
                {
                  id: 'summary-doc-id',
                  name: 'Summary.pdf',
                  parents: ['year-2026-1'],
                  mimeType: 'application/pdf',
                  webViewLink: 'https://drive.google.com/file/d/summary-doc-id/view',
                },
              ],
            },
          });

        const results = await client.searchFiles({
          targetName: 'Summary.pdf',
          exactMatch: true,
          expectedParentPathNames: ['Region', 'Offices', '2026'],
        });

        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('summary-doc-id');
        expect(mockDrive.files.list).toHaveBeenCalledTimes(4);

        // Level 0
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(1, expect.objectContaining({
          q: "name = 'Region' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 21,
        }));

        // Level 1: Consolidated OR for 2 parents
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
          q: "name = 'Offices' and ('region-1' in parents or 'region-2' in parents) and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 21,
        }));

        // Level 2: Consolidated OR for 3 parents
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(3, expect.objectContaining({
          q: "name = '2026' and ('office-a' in parents or 'office-b' in parents or 'office-c' in parents) and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 21,
        }));

        // Target: Consolidated OR for 2 parents
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(4, expect.objectContaining({
          q: "name = 'Summary.pdf' and ('year-2026-1' in parents or 'year-2026-2' in parents) and trashed = false",
        }));
      });

      it('enforces 20-match threshold failure at intermediate depth level (level 2)', async () => {
        const twentyOneOffices = Array.from({ length: 21 }, (_, i) => ({
          id: `office-${i + 1}`,
          name: 'Offices',
        }));

        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          // Level 0: 2 regions
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'region-1', name: 'Region' },
                { id: 'region-2', name: 'Region' },
              ],
            },
          })
          // Level 1: 21 offices -> exceeds cap
          .mockResolvedValueOnce({
            data: {
              files: twentyOneOffices,
            },
          });

        const error = await client
          .searchFiles({
            targetName: 'Doc.pdf',
            expectedParentPathNames: ['Region', 'Offices', '2026'],
          })
          .catch((e) => e);

        expect(error).toBeInstanceOf(GoogleDriveAmbiguousPathError);
        expect(error.message).toMatch(
          /AmbiguousPathSpecError: Query for parent folder 'Offices' returned 21 results, exceeding the threshold cap of 20 matches/
        );
        // Should halt immediately and not query Level 2 or Target
        expect(mockDrive.files.list).toHaveBeenCalledTimes(2);
      });

      it('returns empty array early if any intermediate level yields 0 folders', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          // Level 0: 1 match
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'dept-1', name: 'Finance' }],
            },
          })
          // Level 1: 0 matches
          .mockResolvedValueOnce({
            data: {
              files: [],
            },
          });

        const results = await client.searchFiles({
          targetName: 'Ledger.xlsx',
          expectedParentPathNames: ['Finance', 'MissingSubFolder', '2026'],
        });

        expect(results).toEqual([]);
        // Should not query Level 2 or target file
        expect(mockDrive.files.list).toHaveBeenCalledTimes(2);
      });

      it('escapes single quotes at each level of multi-level path traversal', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'p1', name: "O'Connor's Org" }],
            },
          })
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'p2', name: "Vendors' Files" }],
            },
          })
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'f1', name: "Supplier's Bill.pdf", parents: ['p2'] },
              ],
            },
          });

        const results = await client.searchFiles({
          targetName: "Supplier's Bill.pdf",
          exactMatch: true,
          expectedParentPathNames: ["O'Connor's Org", "Vendors' Files"],
        });

        expect(results).toHaveLength(1);
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(1, expect.objectContaining({
          q: "name = 'O\\'Connor\\'s Org' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        }));
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
          q: "name = 'Vendors\\' Files' and 'p1' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        }));
        expect(mockDrive.files.list).toHaveBeenNthCalledWith(3, expect.objectContaining({
          q: "name = 'Supplier\\'s Bill.pdf' and 'p2' in parents and trashed = false",
        }));
      });

      it('propagates sharedDriveId across all levels in multi-level search', async () => {
        (mockDrive.files.list as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'shared-p1', name: 'SharedRoot' }],
            },
          })
          .mockResolvedValueOnce({
            data: {
              files: [{ id: 'shared-p2', name: 'SharedChild' }],
            },
          })
          .mockResolvedValueOnce({
            data: {
              files: [
                { id: 'shared-file', name: 'File.pdf', parents: ['shared-p2'] },
              ],
            },
          });

        await client.searchFiles({
          targetName: 'File.pdf',
          expectedParentPathNames: ['SharedRoot', 'SharedChild'],
          sharedDriveId: 'shared-drive-xyz',
        });

        expect(mockDrive.files.list).toHaveBeenCalledTimes(3);
        for (let i = 1; i <= 3; i++) {
          expect(mockDrive.files.list).toHaveBeenNthCalledWith(i, expect.objectContaining({
            corpora: 'drive',
            driveId: 'shared-drive-xyz',
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
          }));
        }
      });
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



import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DriveSourceContextAdapter,
  type DriveSourceContextClientPort,
} from './drive-source-context.adapter';
import { GoogleDriveApiError, type DriveFileMetadata } from '../../../infrastructure/drive/drive-client';

describe('DriveSourceContextAdapter', () => {
  let mockClient: DriveSourceContextClientPort;
  let fileStore: Map<string, DriveFileMetadata>;

  beforeEach(() => {
    fileStore = new Map();
    mockClient = {
      getFile: vi.fn().mockImplementation(async (fileId: string) => {
        const file = fileStore.get(fileId);
        if (!file) {
          throw new Error(`File not found: ${fileId}`);
        }
        return file;
      }),
      listSharedDrives: vi.fn().mockResolvedValue({
        drives: [
          { id: 'drive-proj-1', name: 'Project 1001 Alpha' },
          { id: 'drive-marketing', name: 'INC Marketing' },
        ],
      }),
    };
  });

  it('walks parents[0] upward and orders ancestors from top-level down to immediate parent', async () => {
    fileStore.set('file-1', {
      id: 'file-1',
      name: 'Submittal.pdf',
      parents: ['sub-folder'],
      driveId: 'drive-proj-1',
    });
    fileStore.set('sub-folder', {
      id: 'sub-folder',
      name: '05 Submittals',
      parents: ['ffe-folder'],
      driveId: 'drive-proj-1',
    });
    fileStore.set('ffe-folder', {
      id: 'ffe-folder',
      name: '3 FFE',
      parents: ['drive-proj-1'],
      driveId: 'drive-proj-1',
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    const hierarchy = await adapter.getItemHierarchy('file-1');

    expect(hierarchy.item).toEqual({ id: 'file-1', name: 'Submittal.pdf' });
    expect(hierarchy.driveId).toBe('drive-proj-1');
    expect(hierarchy.driveName).toBe('Project 1001 Alpha');
    // Ancestors: top-level (3 FFE) down to immediate parent (05 Submittals)
    expect(hierarchy.ancestors).toEqual([
      { id: 'ffe-folder', name: '3 FFE' },
      { id: 'sub-folder', name: '05 Submittals' },
    ]);
  });

  it('caches getFile per-request so shared ancestors are fetched at most once', async () => {
    fileStore.set('file-1', {
      id: 'file-1',
      name: 'Plan1.pdf',
      parents: ['common-parent'],
    });
    fileStore.set('file-2', {
      id: 'file-2',
      name: 'Plan2.pdf',
      parents: ['common-parent'],
    });
    fileStore.set('common-parent', {
      id: 'common-parent',
      name: '1 Admin/Communication',
      parents: [],
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    await adapter.getItemHierarchy('file-1');
    await adapter.getItemHierarchy('file-2');

    // common-parent should only be fetched once despite two file hierarchies
    const commonCalls = (mockClient.getFile as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === 'common-parent'
    );
    expect(commonCalls).toHaveLength(1);
  });

  it('terminates early upon reaching terminal routing folders', async () => {
    fileStore.set('file-1', {
      id: 'file-1',
      name: 'Note.docx',
      parents: ['comm-folder'],
      driveId: 'drive-marketing',
    });
    fileStore.set('comm-folder', {
      id: 'comm-folder',
      name: 'Communications',
      parents: ['proposal-folder'],
      driveId: 'drive-marketing',
    });
    fileStore.set('proposal-folder', {
      id: 'proposal-folder',
      name: 'Grand Hotel',
      parents: ['opp-folder'],
      driveId: 'drive-marketing',
    });
    fileStore.set('opp-folder', {
      id: 'opp-folder',
      name: 'Opportunities',
      parents: ['marketing-root'],
      driveId: 'drive-marketing',
    });
    fileStore.set('marketing-root', {
      id: 'marketing-root',
      name: 'INC Marketing Root',
      parents: [],
      driveId: 'drive-marketing',
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    const hierarchy = await adapter.getItemHierarchy('file-1');

    // Because Opportunities is terminal, marketing-root should NOT be fetched
    expect(fileStore.has('marketing-root')).toBe(true);
    expect(mockClient.getFile).not.toHaveBeenCalledWith('marketing-root');
    expect(hierarchy.ancestors.map((a) => a.name)).toEqual([
      'Opportunities',
      'Grand Hotel',
      'Communications',
    ]);
  });

  it('terminates traversal on Shared Drive root (parentId === driveId)', async () => {
    fileStore.set('file-root', {
      id: 'file-root',
      name: 'RootDoc.pdf',
      parents: ['drive-proj-1'],
      driveId: 'drive-proj-1',
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    const hierarchy = await adapter.getItemHierarchy('file-root');

    expect(hierarchy.ancestors).toEqual([]);
    expect(mockClient.getFile).toHaveBeenCalledWith('file-root');
    // drive-proj-1 should not be fetched via getFile
    expect(mockClient.getFile).not.toHaveBeenCalledWith('drive-proj-1');
  });

  it('terminates traversal on My Drive root (parentId === "root")', async () => {
    fileStore.set('file-my-drive-root', {
      id: 'file-my-drive-root',
      name: 'RootDoc.pdf',
      parents: ['root'],
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    const hierarchy = await adapter.getItemHierarchy('file-my-drive-root');

    expect(hierarchy.ancestors).toEqual([]);
    expect(mockClient.getFile).toHaveBeenCalledWith('file-my-drive-root');
    expect(mockClient.getFile).not.toHaveBeenCalledWith('root');
  });

  it('enforces 15-level depth cap during upward walk', async () => {
    // Build a chain of 20 folders
    for (let i = 1; i <= 20; i++) {
      fileStore.set(`folder-${i}`, {
        id: `folder-${i}`,
        name: `Folder ${i}`,
        parents: [`folder-${i + 1}`],
      });
    }
    fileStore.set('folder-21', {
      id: 'folder-21',
      name: 'Folder 21',
      parents: [],
    });
    fileStore.set('file-deep', {
      id: 'file-deep',
      name: 'Deep.pdf',
      parents: ['folder-1'],
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    const hierarchy = await adapter.getItemHierarchy('file-deep');

    expect(hierarchy.ancestors).toHaveLength(15);
    expect(mockClient.getFile).not.toHaveBeenCalledWith('folder-16');
  });

  it('guards against cycles in parent hierarchy', async () => {
    fileStore.set('file-cycle', {
      id: 'file-cycle',
      name: 'Cycle.pdf',
      parents: ['folder-a'],
    });
    fileStore.set('folder-a', {
      id: 'folder-a',
      name: 'Folder A',
      parents: ['folder-b'],
    });
    fileStore.set('folder-b', {
      id: 'folder-b',
      name: 'Folder B',
      parents: ['folder-a'], // cycle!
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    const hierarchy = await adapter.getItemHierarchy('file-cycle');

    expect(hierarchy.ancestors.map((a) => a.id)).toEqual(['folder-b', 'folder-a']);
  });

  it('resolves driveName via cached listSharedDrives and never calls files.get on driveId', async () => {
    fileStore.set('file-shared', {
      id: 'file-shared',
      name: 'Doc.pdf',
      parents: [],
      driveId: 'drive-proj-1',
    });

    const adapter = new DriveSourceContextAdapter(mockClient);
    const hierarchy1 = await adapter.getItemHierarchy('file-shared');
    const hierarchy2 = await adapter.getItemHierarchy('file-shared');

    expect(hierarchy1.driveName).toBe('Project 1001 Alpha');
    expect(hierarchy2.driveName).toBe('Project 1001 Alpha');
    expect(mockClient.listSharedDrives).toHaveBeenCalledTimes(1);
    expect(mockClient.getFile).not.toHaveBeenCalledWith('drive-proj-1');
  });

  describe('Google Drive Shortcuts (Ticket #291)', () => {
    it('resolves shortcut target first and evaluates the target item hierarchy and drive', async () => {
      // Shortcut item located in My Drive
      fileStore.set('shortcut-1', {
        id: 'shortcut-1',
        name: 'Shortcut to Submittal.pdf',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: {
          targetId: 'target-file-123',
          targetMimeType: 'application/pdf',
        },
        parents: ['root'],
      });

      // Target item located in a Project Shared Drive under 3 FFE
      fileStore.set('target-file-123', {
        id: 'target-file-123',
        name: '071200-001_Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['ffe-folder'],
        driveId: 'drive-proj-1',
      });
      fileStore.set('ffe-folder', {
        id: 'ffe-folder',
        name: '3 FFE',
        parents: ['drive-proj-1'],
        driveId: 'drive-proj-1',
      });

      const adapter = new DriveSourceContextAdapter(mockClient);
      const hierarchy = await adapter.getItemHierarchy('shortcut-1');

      // Evaluates target item's identity, drive, and hierarchy
      expect(hierarchy.item).toEqual({
        id: 'target-file-123',
        name: '071200-001_Waterproofing.pdf',
        mimeType: 'application/pdf',
      });
      expect(hierarchy.driveId).toBe('drive-proj-1');
      expect(hierarchy.driveName).toBe('Project 1001 Alpha');
      expect(hierarchy.ancestors).toEqual([
        { id: 'ffe-folder', name: '3 FFE' },
      ]);
      expect(mockClient.getFile).toHaveBeenCalledWith('shortcut-1');
      expect(mockClient.getFile).toHaveBeenCalledWith('target-file-123');
    });

    it('resolves shortcut pointing to a folder target', async () => {
      fileStore.set('shortcut-folder', {
        id: 'shortcut-folder',
        name: 'Shortcut to Proposals',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: {
          targetId: 'target-proposal-folder',
          targetMimeType: 'application/vnd.google-apps.folder',
        },
        parents: ['root'],
      });

      fileStore.set('target-proposal-folder', {
        id: 'target-proposal-folder',
        name: 'Acme Proposal',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['opp-folder'],
        driveId: 'drive-marketing',
      });
      fileStore.set('opp-folder', {
        id: 'opp-folder',
        name: 'Opportunities',
        parents: [],
        driveId: 'drive-marketing',
      });

      const adapter = new DriveSourceContextAdapter(mockClient);
      const hierarchy = await adapter.getItemHierarchy('shortcut-folder');

      expect(hierarchy.item).toEqual({
        id: 'target-proposal-folder',
        name: 'Acme Proposal',
        mimeType: 'application/vnd.google-apps.folder',
      });
      expect(hierarchy.driveId).toBe('drive-marketing');
      expect(hierarchy.driveName).toBe('INC Marketing');
      expect(hierarchy.ancestors).toEqual([
        { id: 'opp-folder', name: 'Opportunities' },
      ]);
    });
  });

  describe('Parent Permission Boundary vs Systemic Errors (Ticket #291)', () => {
    it('silently stops upward traversal and retains partial hierarchy when parent folder returns 403 Forbidden', async () => {
      fileStore.set('file-restricted-parent', {
        id: 'file-restricted-parent',
        name: 'Shared_File.pdf',
        mimeType: 'application/pdf',
        parents: ['parent-forbidden'],
        driveId: 'drive-proj-1',
      });

      // parent-forbidden is NOT in fileStore, so getFile will throw
      mockClient.getFile = vi.fn().mockImplementation(async (fileId: string) => {
        if (fileId === 'file-restricted-parent') {
          return fileStore.get(fileId)!;
        }
        if (fileId === 'parent-forbidden') {
          throw new GoogleDriveApiError('Forbidden', { statusCode: 403 });
        }
        throw new Error('Not found');
      });

      const adapter = new DriveSourceContextAdapter(mockClient);
      const hierarchy = await adapter.getItemHierarchy('file-restricted-parent');

      expect(hierarchy.item).toEqual({
        id: 'file-restricted-parent',
        name: 'Shared_File.pdf',
        mimeType: 'application/pdf',
      });
      expect(hierarchy.driveId).toBe('drive-proj-1');
      expect(hierarchy.driveName).toBe('Project 1001 Alpha');
      expect(hierarchy.ancestors).toEqual([]);
    });

    it('silently stops upward traversal and retains partial hierarchy when higher parent folder returns 404 Not Found', async () => {
      fileStore.set('file-leaf', {
        id: 'file-leaf',
        name: 'Leaf.pdf',
        parents: ['parent-visible'],
      });
      fileStore.set('parent-visible', {
        id: 'parent-visible',
        name: 'Accessible Subfolder',
        parents: ['parent-missing'],
      });

      mockClient.getFile = vi.fn().mockImplementation(async (fileId: string) => {
        if (fileStore.has(fileId)) {
          return fileStore.get(fileId)!;
        }
        if (fileId === 'parent-missing') {
          throw new GoogleDriveApiError('File not found: parent-missing', { statusCode: 404 });
        }
        throw new Error(`File not found: ${fileId}`);
      });

      const adapter = new DriveSourceContextAdapter(mockClient);
      const hierarchy = await adapter.getItemHierarchy('file-leaf');

      expect(hierarchy.item).toEqual({ id: 'file-leaf', name: 'Leaf.pdf' });
      // Retains partial hierarchy collected so far
      expect(hierarchy.ancestors).toEqual([
        { id: 'parent-visible', name: 'Accessible Subfolder' },
      ]);
    });

    it('re-throws systemic Drive API errors (429 rate limits, 5xx server errors) encountered on parent folders', async () => {
      fileStore.set('file-leaf', {
        id: 'file-leaf',
        name: 'Leaf.pdf',
        parents: ['parent-rate-limited'],
      });

      mockClient.getFile = vi.fn().mockImplementation(async (fileId: string) => {
        if (fileId === 'file-leaf') {
          return fileStore.get(fileId)!;
        }
        if (fileId === 'parent-rate-limited') {
          throw new GoogleDriveApiError('User rate limit exceeded', { statusCode: 429 });
        }
        throw new Error(`File not found: ${fileId}`);
      });

      const adapter = new DriveSourceContextAdapter(mockClient);
      await expect(adapter.getItemHierarchy('file-leaf')).rejects.toThrow(GoogleDriveApiError);
    });

    it('re-throws error when selected item itself fails to load', async () => {
      mockClient.getFile = vi.fn().mockRejectedValue(
        new GoogleDriveApiError('Not Found', { statusCode: 404 })
      );

      const adapter = new DriveSourceContextAdapter(mockClient);
      await expect(adapter.getItemHierarchy('missing-item')).rejects.toThrow(GoogleDriveApiError);
    });

    it('re-throws error when shortcut target fails to load (broken shortcut)', async () => {
      fileStore.set('shortcut-broken', {
        id: 'shortcut-broken',
        name: 'Broken Shortcut',
        mimeType: 'application/vnd.google-apps.shortcut',
        shortcutDetails: {
          targetId: 'target-deleted',
        },
      });

      mockClient.getFile = vi.fn().mockImplementation(async (fileId: string) => {
        if (fileId === 'shortcut-broken') {
          return fileStore.get(fileId)!;
        }
        if (fileId === 'target-deleted') {
          throw new GoogleDriveApiError('Target not found', { statusCode: 404 });
        }
        throw new Error('Not found');
      });

      const adapter = new DriveSourceContextAdapter(mockClient);
      await expect(adapter.getItemHierarchy('shortcut-broken')).rejects.toThrow(GoogleDriveApiError);
    });
  });
});

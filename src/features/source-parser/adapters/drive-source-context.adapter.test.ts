import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DriveSourceContextAdapter,
  type DriveSourceContextClientPort,
} from './drive-source-context.adapter';
import type { DriveFileMetadata } from '../../../infrastructure/drive/drive-client';

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
});

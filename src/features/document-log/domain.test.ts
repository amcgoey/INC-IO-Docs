import { describe, it, expect, vi } from 'vitest';
import { DocumentLogService } from './domain';
import {
  DocumentLogAmbiguousError,
  DocumentLogConfigurationError,
  DocumentLogMissingError,
  type DocumentLogDiscoveryConfig,
  type DocumentLogDocument,
  type DocumentLogSchema,
  type DocumentLogSpace,
  type LogDiscoveryFileMetadata,
  type LogDiscoveryPort,
  type LogSchemaRegistryPort,
  type LogStoragePort,
  type LogTargetDocumentSchema,
} from './ports';
import { HandlebarsAdapter } from '../../infrastructure/template-engine/handlebars-adapter';

describe('DocumentLogService', () => {
  const discoveryConfig: DocumentLogDiscoveryConfig = {
    preferredFolderPath: '1 Admin',
    fileNameContains: 'Document Log',
    excludePrefixes: ['Copy of '],
    excludeSubstrings: ['Template'],
    templateSpreadsheetId: 'template-123',
    copyNameTemplate: '{{DocumentSpace.name}} Document Log',
  };

  const logSchema: DocumentLogSchema = {
    provider: 'google_sheets',
    target: {
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      extentMarker: '<--->',
      groupDividerMarker: '---',
    },
    grouping: {
      groupBy: 'idGroup',
      sortBy: 'id',
      groupSortOrder: 'asc',
      rowSortOrder: 'asc',
      duplicatePolicy: 'insert',
    },
    columns: {
      Status: { template: '{{status.key}}' },
      Section: { template: '{{section}}' },
      Number: { template: '{{number}}' },
      Revision: { template: '{{revision}}' },
      Title: { template: '{{title}}' },
      Date: { template: '{{date}}' },
      Contact: { template: '{{contact.key}}' },
      Action: { template: '{{action.name}}' },
      Notes: { template: '{{notes}}' },
      'Calc Link': { source: 'fileLink', label: 'Link' },
    },
  };

  const targetSchema: LogTargetDocumentSchema = {
    fields: [
      { key: 'status', name: 'Status', type: 'string', required: true, options: { source: 'statuses', key: 'key' } },
      { key: 'section', name: 'Section', type: 'string', required: true },
      { key: 'number', name: 'Number', type: 'string', required: true },
      { key: 'revision', name: 'Revision', type: 'string', required: true },
      { key: 'title', name: 'Title', type: 'string', required: true },
      { key: 'date', name: 'Date', type: 'string', required: true },
      { key: 'contact', name: 'Contact', type: 'string', required: true, options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
      { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
      { key: 'notes', name: 'Notes', type: 'string', required: false },
    ],
    identity: {
      idGroup: '{{section}}-{{number}}',
      idDocument: '{{section}}-{{number}}-{{revision}}',
      id: '{{section}}-{{number}}-{{revision}}-{{date}}-{{action.order}}',
    },
    options: {
      statuses: [{ key: 'Open' }, { key: 'Closed' }],
      actions: [{ key: 'REC', name: 'Received', order: '1' }],
      contacts: [{ key: 'MB', name: 'Meridian Builders' }],
    },
  };

  const sampleSpace: DocumentLogSpace = {
    id: 'space-harborview',
    typeId: 'projects',
    name: 'Harborview Hotel',
    abstractStorageId: 'shared-drive-harborview',
  };

  const sampleDoc: DocumentLogDocument = {
    type: 'submittal-arch',
    space: sampleSpace,
    data: {
      status: 'Open',
      section: '071200',
      number: '001',
      revision: '0',
      title: 'Fluid-Applied Waterproofing',
      date: '260204',
      contact: 'MB',
      action: 'REC',
      notes: '',
    },
  };

  function createService(overrides?: {
    discovery?: Partial<LogDiscoveryPort>;
    storage?: Partial<LogStoragePort>;
    registry?: Partial<LogSchemaRegistryPort>;
  }) {
    const registry: LogSchemaRegistryPort = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getDiscoveryConfig: vi.fn().mockReturnValue(discoveryConfig),
      getDocumentLogSchema: vi.fn().mockImplementation((k) => (k === 'submittal-arch' ? logSchema : undefined)),
      getTargetSchema: vi.fn().mockImplementation((k) => (k === 'submittal-arch' ? targetSchema : undefined)),
      ...overrides?.registry,
    };
    const discovery: LogDiscoveryPort = {
      searchSpreadsheets: vi.fn().mockResolvedValue([]),
      ...overrides?.discovery,
    };
    const storage: LogStoragePort = {
      insertRow: vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' }),
      ...overrides?.storage,
    };
    const service = new DocumentLogService(
      registry,
      discovery,
      storage,
      new HandlebarsAdapter()
    );
    return { service, registry, discovery, storage };
  }

  describe('resolveLog', () => {
    it('performs live zero-cache Drive-only search and filters excludePrefixes & excludeSubstrings case-insensitively', async () => {
      const searchSpreadsheets = vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'copy-1', name: 'copy of Harborview Hotel Document Log' },
          { id: 'tmpl-1', name: 'INC Document Log template' },
          { id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['admin-folder'] },
        ])
        .mockResolvedValueOnce([]);

      const { service, storage } = createService({
        discovery: { searchSpreadsheets },
      });

      const first = await service.resolveLog(sampleSpace);
      expect(first).toEqual({
        status: 'resolved',
        candidate: { id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['admin-folder'] },
        candidates: [{ id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['admin-folder'] }],
      });
      expect(searchSpreadsheets).toHaveBeenCalledWith({
        targetName: 'Document Log',
        sharedDriveId: 'shared-drive-harborview',
        mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        exactMatch: false,
      });

      // Live zero-cache: second call hits discovery again instead of returning cached match
      const second = await service.resolveLog(sampleSpace);
      expect(second).toEqual({
        status: 'missing',
        candidates: [],
        expectedFolderPath: '1 Admin',
      });
      expect(searchSpreadsheets).toHaveBeenCalledTimes(2);
      expect(storage.insertRow).not.toHaveBeenCalled();
    });

    it('returns ambiguous when 2+ non-excluded matching spreadsheets exist', async () => {
      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-a', name: 'Harborview Hotel Document Log' },
            { id: 'log-b', name: 'Harborview Document Log Archive' },
          ]),
        },
      });

      const res = await service.resolveLog(sampleSpace);
      expect(res).toEqual({
        status: 'ambiguous',
        candidates: [
          { id: 'log-a', name: 'Harborview Hotel Document Log' },
          { id: 'log-b', name: 'Harborview Document Log Archive' },
        ],
      });
    });

    it('supports folder-backed discovery inside a Shared Drive folder and excludes sibling folders and excluded files before walking', async () => {
      const oppSpace: DocumentLogSpace = {
        id: 'space-opp-a',
        typeId: 'proposals',
        name: 'Opportunity A',
        abstractStorageId: 'folder-opp-a',
      };

      const fileMap: Record<string, LogDiscoveryFileMetadata> = {
        'folder-opp-a': {
          id: 'folder-opp-a',
          name: 'Opportunity A',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'shared-drive-marketing',
          parents: ['opps-root'],
        },
        'opp-a-admin': {
          id: 'opp-a-admin',
          name: '1 Admin',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'shared-drive-marketing',
          parents: ['folder-opp-a'],
        },
        'sibling-folder': {
          id: 'sibling-folder',
          name: 'Opportunity B',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'shared-drive-marketing',
          parents: ['opps-root'],
        },
        'excluded-folder': {
          id: 'excluded-folder',
          name: 'Excluded Folder',
          mimeType: 'application/vnd.google-apps.folder',
          driveId: 'shared-drive-marketing',
          parents: ['folder-opp-a'],
        },
      };

      const getFile = vi.fn(async (id: string) => {
        const entry = fileMap[id];
        if (!entry) {
          throw new Error(`Not found: ${id}`);
        }
        return entry;
      });

      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'copy-in-opp', name: 'Copy of Opportunity A Document Log', parents: ['excluded-folder'] },
        { id: 'tmpl-in-opp', name: 'Opportunity A Document Log Template', parents: ['excluded-folder'] },
        { id: 'sibling-log', name: 'Opportunity B Document Log', parents: ['sibling-folder'] },
        { id: 'opp-a-log', name: 'Opportunity A Document Log', parents: ['opp-a-admin'] },
      ]);

      const { service } = createService({
        registry: {
          getSpaceFetchMethod: vi.fn().mockReturnValue('folders'),
        },
        discovery: {
          searchSpreadsheets,
          getFile,
        },
      });

      const res = await service.resolveLog(oppSpace);

      expect(searchSpreadsheets).toHaveBeenCalledWith({
        targetName: 'Document Log',
        sharedDriveId: 'shared-drive-marketing',
        mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        exactMatch: false,
      });
      expect(res).toEqual({
        status: 'resolved',
        candidate: { id: 'opp-a-log', name: 'Opportunity A Document Log', parents: ['opp-a-admin'] },
        candidates: [{ id: 'opp-a-log', name: 'Opportunity A Document Log', parents: ['opp-a-admin'] }],
      });
      // Excluded files are filtered before descendant walk so 'excluded-folder' is never looked up
      expect(getFile).not.toHaveBeenCalledWith('excluded-folder');
    });

    it('supports folder-backed discovery inside My Drive with sharedDriveId undefined and strict descendant filtering', async () => {
      const oppSpace: DocumentLogSpace = {
        id: 'space-opp-b',
        typeId: 'proposals',
        name: 'Opportunity B',
        abstractStorageId: 'folder-opp-b',
      };

      const fileMap: Record<string, LogDiscoveryFileMetadata> = {
        'folder-opp-b': {
          id: 'folder-opp-b',
          name: 'Opportunity B',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['my-drive-opps'],
          driveId: undefined,
        },
        'my-drive-other': {
          id: 'my-drive-other',
          name: 'Other Folder',
          mimeType: 'application/vnd.google-apps.folder',
          parents: ['root'],
        },
      };

      const getFile = vi.fn(async (id: string) => fileMap[id]);
      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'other-log', name: 'Other Document Log', parents: ['my-drive-other'] },
        { id: 'opp-b-log', name: 'Opportunity B Document Log', parents: ['folder-opp-b'] },
      ]);

      const { service } = createService({
        registry: {
          getSpaceFetchMethod: vi.fn().mockReturnValue('folders'),
        },
        discovery: {
          searchSpreadsheets,
          getFile,
        },
      });

      const res = await service.resolveLog(oppSpace);

      expect(searchSpreadsheets).toHaveBeenCalledTimes(1);
      const queryArg = searchSpreadsheets.mock.calls[0][0];
      expect(queryArg.sharedDriveId).toBeUndefined();
      expect(queryArg).toMatchObject({
        targetName: 'Document Log',
        mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        exactMatch: false,
      });
      expect(res).toEqual({
        status: 'resolved',
        candidate: { id: 'opp-b-log', name: 'Opportunity B Document Log', parents: ['folder-opp-b'] },
        candidates: [{ id: 'opp-b-log', name: 'Opportunity B Document Log', parents: ['folder-opp-b'] }],
      });
      // 'root' is terminal non-matching when rootFolderId !== 'root', so getFile('root') is not called
      expect(getFile).not.toHaveBeenCalledWith('root');
    });

    it('falls back to folder-backed discovery when getSpaceFetchMethod returns undefined and container is a folder', async () => {
      const folderSpace: DocumentLogSpace = {
        id: 'space-folder-fallback',
        typeId: 'proposals',
        name: 'Fallback Folder Space',
        abstractStorageId: 'folder-fallback-1',
      };

      const getFile = vi.fn(async (id: string) => {
        if (id === 'folder-fallback-1') {
          return {
            id: 'folder-fallback-1',
            name: 'Fallback Folder Space',
            mimeType: 'application/vnd.google-apps.folder',
            driveId: 'shared-drive-marketing',
            parents: ['opps-root'],
          };
        }
        if (id === 'other-folder') {
          return {
            id: 'other-folder',
            name: 'Other Folder',
            mimeType: 'application/vnd.google-apps.folder',
            driveId: 'shared-drive-marketing',
            parents: ['opps-root'],
          };
        }
        throw new Error(`Unexpected getFile(${id})`);
      });

      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'sibling-sheet', name: 'Other Document Log', parents: ['other-folder'] },
        { id: 'valid-sheet', name: 'Fallback Folder Space Document Log', parents: ['folder-fallback-1'] },
      ]);

      const { service } = createService({
        registry: {
          getSpaceFetchMethod: vi.fn().mockReturnValue(undefined),
        },
        discovery: {
          searchSpreadsheets,
          getFile,
        },
      });

      const res = await service.resolveLog(folderSpace);

      expect(searchSpreadsheets).toHaveBeenCalledWith({
        targetName: 'Document Log',
        sharedDriveId: 'shared-drive-marketing',
        mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        exactMatch: false,
      });
      expect(res).toEqual({
        status: 'resolved',
        candidate: {
          id: 'valid-sheet',
          name: 'Fallback Folder Space Document Log',
          parents: ['folder-fallback-1'],
        },
        candidates: [
          {
            id: 'valid-sheet',
            name: 'Fallback Folder Space Document Log',
            parents: ['folder-fallback-1'],
          },
        ],
      });
    });

    it('falls back to Shared Drive discovery without descendant walk when getSpaceFetchMethod is omitted and container is a Shared Drive root', async () => {
      const getFile = vi.fn(async (id: string) => ({
        id,
        name: 'Harborview Hotel',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'shared-drive-harborview',
      }));

      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['some-nested-folder'] },
      ]);

      const { service } = createService({
        discovery: {
          searchSpreadsheets,
          getFile,
        },
      });

      const res = await service.resolveLog(sampleSpace);

      expect(searchSpreadsheets).toHaveBeenCalledWith({
        targetName: 'Document Log',
        sharedDriveId: 'shared-drive-harborview',
        mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        exactMatch: false,
      });
      expect(res).toEqual({
        status: 'resolved',
        candidate: { id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['some-nested-folder'] },
        candidates: [{ id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['some-nested-folder'] }],
      });
      // Only container check called getFile; no descendant walk lookup for 'some-nested-folder'
      expect(getFile).toHaveBeenCalledTimes(1);
      expect(getFile).toHaveBeenCalledWith('shared-drive-harborview');
      expect(getFile).not.toHaveBeenCalledWith('some-nested-folder');
    });

    it('enforces bounded parent-chain depth cap of 10 intermediate folder hops', async () => {
      const oppSpace: DocumentLogSpace = {
        id: 'space-depth',
        typeId: 'proposals',
        name: 'Depth Space',
        abstractStorageId: 'spaceRoot',
      };

      const buildChainGetFile = (depth: number) =>
        vi.fn(async (id: string) => {
          if (id === 'spaceRoot') {
            return {
              id: 'spaceRoot',
              name: 'Depth Space',
              mimeType: 'application/vnd.google-apps.folder',
              parents: ['root'],
            };
          }
          const match = /^f(\d+)$/.exec(id);
          if (match) {
            const index = Number(match[1]);
            const nextParent = index === depth ? 'spaceRoot' : `f${index + 1}`;
            return {
              id,
              name: id,
              mimeType: 'application/vnd.google-apps.folder',
              parents: [nextParent],
            };
          }
          throw new Error(`Not found: ${id}`);
        });

      // 10 intermediate hops: sheet -> f1 -> ... -> f10 -> spaceRoot (accepted)
      const getFile10 = buildChainGetFile(10);
      const { service: service10 } = createService({
        registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('folders') },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'sheet-10', name: 'Depth Space Document Log', parents: ['f1'] },
          ]),
          getFile: getFile10,
        },
      });

      const res10 = await service10.resolveLog(oppSpace);
      expect(res10).toEqual({
        status: 'resolved',
        candidate: { id: 'sheet-10', name: 'Depth Space Document Log', parents: ['f1'] },
        candidates: [{ id: 'sheet-10', name: 'Depth Space Document Log', parents: ['f1'] }],
      });
      expect(getFile10).toHaveBeenCalledWith('f10');

      // 11 intermediate hops: sheet -> f1 -> ... -> f11 -> spaceRoot (rejected, f11 never fetched)
      const getFile11 = buildChainGetFile(11);
      const { service: service11 } = createService({
        registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('folders') },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'sheet-11', name: 'Depth Space Document Log', parents: ['f1'] },
          ]),
          getFile: getFile11,
        },
      });

      const res11 = await service11.resolveLog(oppSpace);
      expect(res11).toEqual({
        status: 'missing',
        candidates: [],
        expectedFolderPath: '1 Admin',
      });
      expect(getFile11).toHaveBeenCalledWith('f10');
      expect(getFile11).not.toHaveBeenCalledWith('f11');
    });

    it('handles parent-chain cycles safely without infinite looping', async () => {
      const oppSpace: DocumentLogSpace = {
        id: 'space-cycle',
        typeId: 'proposals',
        name: 'Cycle Space',
        abstractStorageId: 'spaceRoot',
      };

      const getFile = vi.fn(async (id: string) => {
        if (id === 'spaceRoot') {
          return {
            id: 'spaceRoot',
            name: 'Cycle Space',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root'],
          };
        }
        if (id === 'f1') {
          return { id: 'f1', name: 'f1', mimeType: 'application/vnd.google-apps.folder', parents: ['f2'] };
        }
        if (id === 'f2') {
          return { id: 'f2', name: 'f2', mimeType: 'application/vnd.google-apps.folder', parents: ['f1'] };
        }
        throw new Error(`Not found: ${id}`);
      });

      const { service } = createService({
        registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('folders') },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'sheet-cycle', name: 'Cycle Space Document Log', parents: ['f1'] },
          ]),
          getFile,
        },
      });

      const res = await service.resolveLog(oppSpace);
      expect(res).toEqual({
        status: 'missing',
        candidates: [],
        expectedFolderPath: '1 Admin',
      });
    });

    it('memoizes getFile per resolveLog call for shared ancestors and performs zero cross-call caching', async () => {
      const oppSpace: DocumentLogSpace = {
        id: 'space-memo',
        typeId: 'proposals',
        name: 'Memo Space',
        abstractStorageId: 'spaceRoot',
      };

      const getFile = vi.fn(async (id: string) => {
        if (id === 'spaceRoot') {
          return {
            id: 'spaceRoot',
            name: 'Memo Space',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root'],
          };
        }
        if (id === 'sub-a' || id === 'sub-b') {
          return {
            id,
            name: id,
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['shared-ancestor'],
          };
        }
        if (id === 'shared-ancestor') {
          return {
            id: 'shared-ancestor',
            name: 'Shared Ancestor',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['spaceRoot'],
          };
        }
        throw new Error(`Not found: ${id}`);
      });

      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'sheet-a', name: 'Memo Space Document Log A', parents: ['sub-a'] },
        { id: 'sheet-b', name: 'Memo Space Document Log B', parents: ['sub-b'] },
      ]);

      const { service } = createService({
        registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('folders') },
        discovery: {
          searchSpreadsheets,
          getFile,
        },
      });

      const first = await service.resolveLog(oppSpace);
      expect(first.status).toBe('ambiguous');
      expect(first.candidates).toHaveLength(2);
      const sharedAncestorCallsFirst = getFile.mock.calls.filter(([id]) => id === 'shared-ancestor').length;
      expect(sharedAncestorCallsFirst).toBe(1);

      // Second resolveLog call hits searchSpreadsheets and getFile fresh again (zero cross-call caching)
      const second = await service.resolveLog(oppSpace);
      expect(second.status).toBe('ambiguous');
      expect(searchSpreadsheets).toHaveBeenCalledTimes(2);
      const sharedAncestorCallsTotal = getFile.mock.calls.filter(([id]) => id === 'shared-ancestor').length;
      expect(sharedAncestorCallsTotal).toBe(2);
    });

    it('treats missing or unreadable ancestor folder gracefully as non-descendant without throwing', async () => {
      const oppSpace: DocumentLogSpace = {
        id: 'space-unreadable',
        typeId: 'proposals',
        name: 'Unreadable Space',
        abstractStorageId: 'spaceRoot',
      };

      const getFile = vi.fn(async (id: string) => {
        if (id === 'spaceRoot') {
          return {
            id: 'spaceRoot',
            name: 'Unreadable Space',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['root'],
          };
        }
        if (id === 'f-mid') {
          return {
            id: 'f-mid',
            name: 'Mid',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['f-forbidden'],
          };
        }
        throw new Error('403 Forbidden / 404 Not Found');
      });

      const { service } = createService({
        registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('folders') },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'sheet-1', name: 'Unreadable Space Document Log', parents: ['f-mid'] },
          ]),
          getFile,
        },
      });

      const res = await service.resolveLog(oppSpace);
      expect(res).toEqual({
        status: 'missing',
        candidates: [],
        expectedFolderPath: '1 Admin',
      });
    });

    it('fails fast with DocumentLogConfigurationError when fetchMethod is folders and getFile is missing', async () => {
      const oppSpace: DocumentLogSpace = {
        id: 'space-missing-getfile',
        typeId: 'proposals',
        name: 'Missing GetFile Space',
        abstractStorageId: 'folder-1',
      };

      const { service } = createService({
        registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('folders') },
        discovery: {
          searchSpreadsheets: vi.fn(),
        },
      });

      await expect(service.resolveLog(oppSpace)).rejects.toThrow(DocumentLogConfigurationError);
    });

    it('falls back to folder-backed discovery when fetchMethod is undefined and getFile omits mimeType but driveId differs from abstractStorageId', async () => {
      const folderSpace: DocumentLogSpace = {
        id: 'space-folder-no-mime',
        typeId: 'proposals',
        name: 'No Mime Folder Space',
        abstractStorageId: 'folder-no-mime',
      };

      const getFile = vi.fn(async (id: string) => {
        if (id === 'folder-no-mime') {
          return {
            id: 'folder-no-mime',
            name: 'Folder',
            driveId: 'other-drive',
          };
        }
        if (id === 'other-folder') {
          return {
            id: 'other-folder',
            name: 'Other Folder',
            mimeType: 'application/vnd.google-apps.folder',
            driveId: 'other-drive',
            parents: ['drive-root'],
          };
        }
        throw new Error(`Unexpected getFile(${id})`);
      });

      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'sibling-sheet', name: 'Other Document Log', parents: ['other-folder'] },
        { id: 'valid-sheet', name: 'No Mime Folder Space Document Log', parents: ['folder-no-mime'] },
      ]);

      const { service } = createService({
        registry: {
          getSpaceFetchMethod: vi.fn().mockReturnValue(undefined),
        },
        discovery: {
          searchSpreadsheets,
          getFile,
        },
      });

      const res = await service.resolveLog(folderSpace);

      expect(searchSpreadsheets).toHaveBeenCalledWith({
        targetName: 'Document Log',
        sharedDriveId: 'other-drive',
        mimeTypes: ['application/vnd.google-apps.spreadsheet'],
        exactMatch: false,
      });
      expect(res).toEqual({
        status: 'resolved',
        candidate: {
          id: 'valid-sheet',
          name: 'No Mime Folder Space Document Log',
          parents: ['folder-no-mime'],
        },
        candidates: [
          {
            id: 'valid-sheet',
            name: 'No Mime Folder Space Document Log',
            parents: ['folder-no-mime'],
          },
        ],
      });
    });

    describe('lazy preferredFolderPath resolution & 3-tier ranking', () => {
      it('skips resolveFolderPath completely when 0 or 1 candidates match', async () => {
        const resolveFolderPath = vi.fn();
        const searchSpreadsheets = vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['some-folder'] },
          ]);

        const { service } = createService({
          registry: {
            getDiscoveryConfig: vi.fn().mockReturnValue({
              ...discoveryConfig,
              preferredFolderPath: '01 Admin/Logs',
            }),
          },
          discovery: {
            searchSpreadsheets,
            resolveFolderPath,
          },
        });

        const zeroRes = await service.resolveLog(sampleSpace);
        expect(zeroRes.status).toBe('missing');
        expect(resolveFolderPath).not.toHaveBeenCalled();

        const oneRes = await service.resolveLog(sampleSpace);
        expect(oneRes.status).toBe('resolved');
        expect(resolveFolderPath).not.toHaveBeenCalled();
      });

      it('lazily calls resolveFolderPath with split forward-slash and backslash segments when 2+ candidates match in Shared Drive and folder-backed spaces', async () => {
        const resolveFolderPath = vi.fn().mockResolvedValue({ id: 'preferred-folder-id', name: 'Logs' });
        const { service: sharedDriveService } = createService({
          registry: {
            getSpaceFetchMethod: vi.fn().mockReturnValue('shared_drives'),
            getDiscoveryConfig: vi.fn().mockReturnValue({
              ...discoveryConfig,
              preferredFolderPath: '01 Admin/Logs',
            }),
          },
          discovery: {
            searchSpreadsheets: vi.fn().mockResolvedValue([
              { id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['other-folder'] },
              { id: 'log-2', name: 'Harborview Hotel Document Log', parents: ['preferred-folder-id'] },
            ]),
            resolveFolderPath,
          },
        });

        await sharedDriveService.resolveLog(sampleSpace);
        expect(resolveFolderPath).toHaveBeenCalledTimes(1);
        expect(resolveFolderPath).toHaveBeenCalledWith('shared-drive-harborview', ['01 Admin', 'Logs']);

        const oppSpace: DocumentLogSpace = {
          id: 'space-opp',
          typeId: 'proposals',
          name: 'Opportunity A',
          abstractStorageId: 'folder-opp-root',
        };
        const folderResolvePath = vi.fn().mockResolvedValue({ id: 'opp-logs-folder', name: 'Logs' });
        const { service: folderService } = createService({
          registry: {
            getSpaceFetchMethod: vi.fn().mockReturnValue('folders'),
            getDiscoveryConfig: vi.fn().mockReturnValue({
              ...discoveryConfig,
              preferredFolderPath: '01 Admin\\Logs',
            }),
          },
          discovery: {
            getFile: vi.fn().mockResolvedValue({
              id: 'folder-opp-root',
              name: 'Opportunity A',
              mimeType: 'application/vnd.google-apps.folder',
              driveId: 'shared-drive-marketing',
            }),
            searchSpreadsheets: vi.fn().mockResolvedValue([
              { id: 'opp-log-1', name: 'Opportunity A Document Log', parents: ['folder-opp-root'] },
              { id: 'opp-log-2', name: 'Opportunity A Document Log', parents: ['folder-opp-root'] },
            ]),
            resolveFolderPath: folderResolvePath,
          },
        });

        await folderService.resolveLog(oppSpace);
        expect(folderResolvePath).toHaveBeenCalledTimes(1);
        expect(folderResolvePath).toHaveBeenCalledWith('folder-opp-root', ['01 Admin', 'Logs']);
      });

      it('ignores errors from resolveFolderPath and ranks candidates using Tiers 2, 3, and 4', async () => {
        const resolveFolderPath = vi.fn().mockRejectedValue(new Error('Preferred folder missing or ambiguous'));
        const { service } = createService({
          registry: {
            getDiscoveryConfig: vi.fn().mockReturnValue({
              ...discoveryConfig,
              preferredFolderPath: '01 Admin/Logs',
            }),
          },
          discovery: {
            searchSpreadsheets: vi.fn().mockResolvedValue([
              {
                id: 'log-non-exact-newer',
                name: 'Harborview Document Log Backup',
                parents: ['f1'],
                modifiedTime: '2026-06-01T00:00:00Z',
              },
              {
                id: 'log-exact-older',
                name: 'harborview hotel document log',
                parents: ['f2'],
                modifiedTime: '2026-01-01T00:00:00Z',
              },
            ]),
            resolveFolderPath,
          },
        });

        const res = await service.resolveLog(sampleSpace);
        expect(resolveFolderPath).toHaveBeenCalledWith('shared-drive-harborview', ['01 Admin', 'Logs']);
        expect(res.status).toBe('ambiguous');
        expect(res.candidates.map((c) => c.id)).toEqual(['log-exact-older', 'log-non-exact-newer']);
      });

      it('Tier 1 (preferredFolderId parent) outranks Tier 2 (exact copyNameTemplate) and Tier 3 (newer modifiedTime)', async () => {
        const resolveFolderPath = vi.fn().mockResolvedValue({ id: 'pref-folder', name: '1 Admin' });
        const { service } = createService({
          discovery: {
            searchSpreadsheets: vi.fn().mockResolvedValue([
              {
                id: 'outside-exact-newest',
                name: 'Harborview Hotel Document Log',
                parents: ['other-folder'],
                modifiedTime: '2026-12-01T00:00:00Z',
              },
              {
                id: 'inside-non-exact-older',
                name: 'Harborview Document Log Archive',
                parents: ['pref-folder'],
                modifiedTime: '2025-01-01T00:00:00Z',
              },
            ]),
            resolveFolderPath,
          },
        });

        const res = await service.resolveLog(sampleSpace);
        expect(res.status).toBe('ambiguous');
        expect(res.candidates.map((c) => c.id)).toEqual([
          'inside-non-exact-older',
          'outside-exact-newest',
        ]);
      });

      it('Tier 2 (case-insensitive exact copyNameTemplate including per-spaceTypeId overrides) outranks Tier 3 (newer modifiedTime)', async () => {
        const getDiscoveryConfig = vi.fn((spaceTypeId?: string) => {
          if (spaceTypeId === 'proposals') {
            return {
              ...discoveryConfig,
              copyNameTemplate: '{{DocumentSpace.name}} Proposal Document Log',
            };
          }
          return discoveryConfig;
        });

        const { service } = createService({
          registry: { getDiscoveryConfig },
          discovery: {
            resolveFolderPath: vi.fn().mockResolvedValue({ id: 'pref-folder', name: '1 Admin' }),
            searchSpreadsheets: vi
              .fn()
              .mockResolvedValueOnce([
                {
                  id: 'non-exact-newest',
                  name: 'Harborview Document Log v2',
                  parents: ['pref-folder'],
                  modifiedTime: '2026-10-01T00:00:00Z',
                },
                {
                  id: 'exact-lowercase-older',
                  name: 'harborview hotel document log',
                  parents: ['pref-folder'],
                  modifiedTime: '2025-05-01T00:00:00Z',
                },
              ])
              .mockResolvedValueOnce([
                {
                  id: 'proposal-default-name-newer',
                  name: 'Opportunity Alpha Document Log',
                  parents: ['pref-folder'],
                  modifiedTime: '2026-10-01T00:00:00Z',
                },
                {
                  id: 'proposal-override-exact-older',
                  name: 'opportunity alpha proposal document log',
                  parents: ['pref-folder'],
                  modifiedTime: '2025-01-01T00:00:00Z',
                },
              ]),
          },
        });

        const projectRes = await service.resolveLog(sampleSpace);
        expect(getDiscoveryConfig).toHaveBeenCalledWith('projects');
        expect(projectRes.candidates.map((c) => c.id)).toEqual([
          'exact-lowercase-older',
          'non-exact-newest',
        ]);

        const proposalRes = await service.resolveLog({
          id: 'space-opp-alpha',
          typeId: 'proposals',
          name: 'Opportunity Alpha',
          abstractStorageId: 'shared-drive-proposals',
        });
        expect(getDiscoveryConfig).toHaveBeenCalledWith('proposals');
        expect(proposalRes.candidates.map((c) => c.id)).toEqual([
          'proposal-override-exact-older',
          'proposal-default-name-newer',
        ]);
      });

      it('Tier 3 sorts valid modifiedTime descending and places missing or unparseable timestamps last', async () => {
        const { service } = createService({
          discovery: {
            resolveFolderPath: vi.fn().mockResolvedValue({ id: 'pref-folder', name: '1 Admin' }),
            searchSpreadsheets: vi.fn().mockResolvedValue([
              { id: 'c-missing', name: 'Harborview Document Log A', parents: ['other'] },
              {
                id: 'c-older',
                name: 'Harborview Document Log B',
                parents: ['other'],
                modifiedTime: '2026-01-15T10:00:00Z',
              },
              {
                id: 'c-invalid',
                name: 'Harborview Document Log C',
                parents: ['other'],
                modifiedTime: 'not-a-date',
              },
              {
                id: 'c-newer',
                name: 'Harborview Document Log D',
                parents: ['other'],
                modifiedTime: '2026-05-20T12:00:00Z',
              },
            ]),
          },
        });

        const res = await service.resolveLog(sampleSpace);
        expect(res.status).toBe('ambiguous');
        expect(res.candidates.map((c) => c.id)).toEqual([
          'c-newer',
          'c-older',
          'c-invalid',
          'c-missing',
        ]);
      });

      it('Tier 4 breaks ties deterministically using id.localeCompare including two missing/unparseable timestamps', async () => {
        const { service } = createService({
          discovery: {
            resolveFolderPath: vi.fn().mockResolvedValue({ id: 'pref-folder', name: '1 Admin' }),
            searchSpreadsheets: vi.fn().mockResolvedValue([
              { id: 'log-z', name: 'Harborview Document Log Z', modifiedTime: 'not-a-date' },
              { id: 'log-b', name: 'Harborview Document Log B', modifiedTime: '2026-03-01T00:00:00Z' },
              { id: 'log-m', name: 'Harborview Document Log M', modifiedTime: undefined },
              { id: 'log-a', name: 'Harborview Document Log A', modifiedTime: '2026-03-01T00:00:00Z' },
            ]),
          },
        });

        const res = await service.resolveLog(sampleSpace);
        expect(res.status).toBe('ambiguous');
        expect(res.candidates.map((c) => c.id)).toEqual(['log-a', 'log-b', 'log-m', 'log-z']);
      });
    });
  });

  describe('writeLog', () => {
    it('resolves log via resolveLog, dehydrates row + hyperlink, and delegates to LogStoragePort', async () => {
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 7, action: 'inserted' });
      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { insertRow },
      });

      const res = await service.writeLog({
        document: sampleDoc,
        fileUri: 'https://drive.google.com/file/d/moved-1/view',
      });

      expect(res).toEqual({
        spreadsheetId: 'log-1',
        sheetName: 'Submittal Arch',
        rowNumber: 7,
        action: 'inserted',
      });
      expect(insertRow).toHaveBeenCalledWith({
        target: {
          spreadsheetId: 'log-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        rowData: {
          Status: 'Open',
          Section: '071200',
          Number: '001',
          Revision: '0',
          Title: 'Fluid-Applied Waterproofing',
          Date: '260204',
          Contact: 'MB',
          Action: 'Received',
          Notes: null,
          'Calc Link': {
            formula: '=HYPERLINK("https://drive.google.com/file/d/moved-1/view", "Link")',
          },
        },
        groupSortOrder: 'asc',
        rowSortOrder: 'asc',
        duplicatePolicy: 'insert',
      });
    });

    it('writes directly to selectedLogId without calling resolveLog', async () => {
      const searchSpreadsheets = vi.fn();
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' });
      const { service } = createService({
        discovery: { searchSpreadsheets },
        storage: { insertRow },
      });

      const res = await service.writeLog({
        document: { ...sampleDoc, space: undefined },
        selectedLogId: 'selected-log-999',
      });

      expect(searchSpreadsheets).not.toHaveBeenCalled();
      expect(res).toEqual({
        spreadsheetId: 'selected-log-999',
        sheetName: 'Submittal Arch',
        rowNumber: 6,
        action: 'inserted',
      });
      expect(insertRow).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ spreadsheetId: 'selected-log-999' }),
          rowData: expect.objectContaining({ 'Calc Link': null }),
        })
      );
    });

    it('fails fast with DocumentLogMissingError naming space.name and preferredFolderPath when 0 matches', async () => {
      const { service, storage } = createService({
        discovery: { searchSpreadsheets: vi.fn().mockResolvedValue([]) },
      });

      await expect(service.writeLog({ document: sampleDoc })).rejects.toThrow(DocumentLogMissingError);
      await expect(service.writeLog({ document: sampleDoc })).rejects.toThrow(/Harborview Hotel/);
      await expect(service.writeLog({ document: sampleDoc })).rejects.toThrow(/1 Admin/);
      expect(storage.insertRow).not.toHaveBeenCalled();
    });

    it('fails fast with DocumentLogAmbiguousError listing conflicting candidate spreadsheets when 2+ matches', async () => {
      const { service, storage } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
            { id: 'log-2', name: 'Harborview Document Log Old' },
          ]),
        },
      });

      await expect(service.writeLog({ document: sampleDoc })).rejects.toThrow(DocumentLogAmbiguousError);
      await expect(service.writeLog({ document: sampleDoc })).rejects.toThrow(
        /Harborview Hotel Document Log.*Harborview Document Log Old/
      );
      expect(storage.insertRow).not.toHaveBeenCalled();
    });

    it('fails fast with DocumentLogAmbiguousError with candidates in Tier 1->2->3->ID ranked order and repeats live discovery across calls', async () => {
      const searchSpreadsheets = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'outside-exact-newest',
            name: 'Harborview Hotel Document Log',
            parents: ['other'],
            modifiedTime: '2026-12-01T00:00:00Z',
          },
          {
            id: 'pref-nonexact-older',
            name: 'Harborview Document Log Backup',
            parents: ['pref-folder'],
            modifiedTime: '2025-01-01T00:00:00Z',
          },
          {
            id: 'outside-nonexact-tie-b',
            name: 'Harborview Document Log B',
            parents: ['other'],
            modifiedTime: '2026-01-01T00:00:00Z',
          },
          {
            id: 'outside-nonexact-tie-a',
            name: 'Harborview Document Log A',
            parents: ['other'],
            modifiedTime: '2026-01-01T00:00:00Z',
          },
          {
            id: 'pref-exact-oldest',
            name: 'Harborview Hotel Document Log',
            parents: ['pref-folder'],
            modifiedTime: '2024-01-01T00:00:00Z',
          },
        ])
        .mockResolvedValueOnce([
          { id: 'resolved-after-cleanup', name: 'Harborview Hotel Document Log', parents: ['pref-folder'] },
        ]);

      const resolveFolderPath = vi.fn().mockResolvedValue({ id: 'pref-folder', name: '1 Admin' });
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' });

      const { service } = createService({
        discovery: {
          searchSpreadsheets,
          resolveFolderPath,
        },
        storage: { insertRow },
      });

      let caught: unknown;
      try {
        await service.writeLog({ document: sampleDoc });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(DocumentLogAmbiguousError);
      const ambiguousErr = caught as DocumentLogAmbiguousError;
      expect(ambiguousErr.candidates.map((c) => c.id)).toEqual([
        'pref-exact-oldest',
        'pref-nonexact-older',
        'outside-exact-newest',
        'outside-nonexact-tie-a',
        'outside-nonexact-tie-b',
      ]);
      expect(insertRow).not.toHaveBeenCalled();

      // Second writeLog call repeats live discovery with zero caching (and skips resolveFolderPath when 1 candidate matches)
      const writeRes = await service.writeLog({ document: sampleDoc });
      expect(writeRes.spreadsheetId).toBe('resolved-after-cleanup');
      expect(searchSpreadsheets).toHaveBeenCalledTimes(2);
      expect(resolveFolderPath).toHaveBeenCalledTimes(1);
    });

    it('fails fast with DocumentLogConfigurationError for missing documentLogSchema or missing space without selectedLogId', async () => {
      const { service } = createService();

      await expect(
        service.writeLog({
          document: { ...sampleDoc, type: 'communication-project' },
        })
      ).rejects.toThrow(DocumentLogConfigurationError);

      await expect(
        service.writeLog({
          document: { ...sampleDoc, space: undefined },
        })
      ).rejects.toThrow(DocumentLogConfigurationError);
    });
  });
});

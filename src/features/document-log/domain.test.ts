import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { Value } from '@sinclair/typebox/value';
import { DocumentLogService } from './domain';
import {
  DocumentLogAmbiguousError,
  DocumentLogConfigurationError,
  DocumentLogError,
  DocumentLogMissingError,
  DocumentLogUiContextResultSchema,
  LogResolutionCandidateSchema,
  LogStorageInaccessibleError,
  WriteDocumentLogResultSchema,
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
      readRows: vi.fn().mockResolvedValue({ headers: [], formulaColumns: [], rows: [] }),
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

      describe('lazy parentFolderName resolution on 2+ ambiguous candidates', () => {
        it('supports optional parentFolderName on LogResolutionCandidateSchema', () => {
          expect(
            Value.Check(LogResolutionCandidateSchema, {
              id: 'log-1',
              name: 'Harborview Hotel Document Log',
              parentFolderName: '1 Admin',
            })
          ).toBe(true);
          expect(
            Value.Check(LogResolutionCandidateSchema, {
              id: 'log-1',
              name: 'Harborview Hotel Document Log',
              parentFolderName: undefined,
            })
          ).toBe(true);
          expect(
            Value.Check(LogResolutionCandidateSchema, {
              id: 'log-1',
              name: 'Harborview Hotel Document Log',
              parentFolderName: 123,
            })
          ).toBe(false);
        });

        it('leaves single-match resolved untouched with 0 getFile calls and 1 Drive search call', async () => {
          const searchSpreadsheets = vi.fn().mockResolvedValue([
            {
              id: 'log-single',
              name: 'Harborview Hotel Document Log',
              parents: ['folder-admin'],
              modifiedTime: '2026-10-01T00:00:00Z',
            },
          ]);
          const getFile = vi.fn();

          const { service } = createService({
            registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('shared_drives') },
            discovery: { searchSpreadsheets, getFile },
          });

          const res = await service.resolveLog(sampleSpace);
          expect(res.status).toBe('resolved');
          if (res.status === 'resolved') {
            expect(res.candidate.parentFolderName).toBeUndefined();
            expect('parentFolderName' in res.candidate).toBe(false);
          }
          expect(searchSpreadsheets).toHaveBeenCalledTimes(1);
          expect(getFile).not.toHaveBeenCalled();
        });

        it('lazily resolves parents[0] names on 2+ matches reusing per-call getFileMemo, skipping space root, and omitting on lookup failure', async () => {
          const searchSpreadsheets = vi.fn().mockResolvedValue([
            {
              id: 'log-admin-1',
              name: 'Harborview Hotel Document Log',
              parents: ['folder-admin'],
              modifiedTime: '2026-10-15T12:00:00Z',
            },
            {
              id: 'log-admin-2',
              name: 'Harborview Hotel Document Log Backup',
              parents: ['folder-admin'],
              modifiedTime: '2026-10-10T12:00:00Z',
            },
            {
              id: 'log-root',
              name: 'Harborview Hotel Document Log Root',
              parents: [sampleSpace.abstractStorageId],
              modifiedTime: '2026-10-05T12:00:00Z',
            },
            {
              id: 'log-unreadable-parent',
              name: 'Harborview Hotel Document Log Hidden',
              parents: ['folder-forbidden'],
              modifiedTime: '2026-10-01T12:00:00Z',
            },
          ]);
          const getFile = vi.fn().mockImplementation(async (fileId: string) => {
            if (fileId === 'folder-admin') {
              return { id: 'folder-admin', name: '1 Admin', parents: [sampleSpace.abstractStorageId] };
            }
            throw new Error('403 Forbidden');
          });

          const { service } = createService({
            registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('shared_drives') },
            discovery: {
              searchSpreadsheets,
              getFile,
              resolveFolderPath: vi.fn().mockResolvedValue({ id: 'folder-admin', name: '1 Admin' }),
            },
          });

          const res = await service.resolveLog(sampleSpace);
          expect(res.status).toBe('ambiguous');
          if (res.status === 'ambiguous') {
            const byId = new Map(res.candidates.map((c) => [c.id, c]));
            expect(byId.get('log-admin-1')?.parentFolderName).toBe('1 Admin');
            expect(byId.get('log-admin-2')?.parentFolderName).toBe('1 Admin');
            expect(byId.get('log-root')?.parentFolderName).toBeUndefined();
            expect('parentFolderName' in (byId.get('log-root') ?? {})).toBe(false);
            expect(byId.get('log-unreadable-parent')?.parentFolderName).toBeUndefined();
            expect('parentFolderName' in (byId.get('log-unreadable-parent') ?? {})).toBe(false);
          }

          // folder-admin queried only ONCE across 2 candidates; space root NEVER queried; folder-forbidden queried once
          expect(getFile).toHaveBeenCalledTimes(2);
          expect(getFile).toHaveBeenCalledWith('folder-admin');
          expect(getFile).toHaveBeenCalledWith('folder-forbidden');
          expect(getFile).not.toHaveBeenCalledWith(sampleSpace.abstractStorageId);
        });

        it('reuses per-call getFileMemo populated during folder-backed descendant walks without duplicate getFile calls', async () => {
          const folderSpace: DocumentLogSpace = {
            id: 'opp-space-1',
            typeId: 'proposals',
            name: 'Opportunity Alpha',
            abstractStorageId: 'folder-opp-root',
          };
          const getFile = vi.fn().mockImplementation(async (fileId: string): Promise<LogDiscoveryFileMetadata> => {
            if (fileId === 'folder-opp-root') {
              return { id: 'folder-opp-root', name: 'Opportunity Alpha', driveId: 'mkt-drive' };
            }
            if (fileId === 'folder-sub-1') {
              return { id: 'folder-sub-1', name: '1 Admin', parents: ['folder-opp-root'] };
            }
            if (fileId === 'folder-sub-2') {
              return { id: 'folder-sub-2', name: '6 Construction', parents: ['folder-opp-root'] };
            }
            throw new Error(`Unexpected fileId: ${fileId}`);
          });
          const searchSpreadsheets = vi.fn().mockResolvedValue([
            {
              id: 'log-1',
              name: 'Opportunity Alpha Document Log',
              parents: ['folder-sub-1'],
              modifiedTime: '2026-10-15T12:00:00Z',
            },
            {
              id: 'log-2',
              name: 'Opportunity Alpha Document Log Old',
              parents: ['folder-sub-2'],
              modifiedTime: '2026-10-10T12:00:00Z',
            },
          ]);

          const { service } = createService({
            registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('folders') },
            discovery: { searchSpreadsheets, getFile },
          });

          const res = await service.resolveLog(folderSpace);
          expect(res.status).toBe('ambiguous');
          if (res.status === 'ambiguous') {
            const byId = new Map(res.candidates.map((c) => [c.id, c]));
            expect(byId.get('log-1')?.parentFolderName).toBe('1 Admin');
            expect(byId.get('log-2')?.parentFolderName).toBe('6 Construction');
          }

          // folder-opp-root (scope check) + folder-sub-1 (once) + folder-sub-2 (once) = 3 total calls
          expect(getFile).toHaveBeenCalledTimes(3);
          expect(getFile.mock.calls.filter(([id]) => id === 'folder-sub-1')).toHaveLength(1);
          expect(getFile.mock.calls.filter(([id]) => id === 'folder-sub-2')).toHaveLength(1);
        });
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
        uri: 'https://docs.google.com/spreadsheets/d/log-1/edit',
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
        rowKeyExtractor: expect.any(Function),
        targetKeys: {
          groupKey: '071200-001',
          sortKey: '071200-001-0-260204-1',
        },
        groupSortOrder: 'asc',
        rowSortOrder: 'asc',
        duplicatePolicy: 'insert',
      });

      const passedRequest = insertRow.mock.calls[0][0];
      expect(
        passedRequest.rowKeyExtractor({
          Status: 'Closed',
          Section: '033000',
          Number: '001',
          Revision: '0',
          Title: 'Concrete',
          Date: '260115',
          Contact: 'MB',
          Action: 'received',
        })
      ).toEqual({
        groupKey: '033000-001',
        sortKey: '033000-001-0-260115-1',
      });
      expect(
        passedRequest.rowKeyExtractor({
          Status: 'Open',
          Section: '',
          Number: '',
          Title: 'Malformed blank key row',
        })
      ).toBeNull();
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
        uri: 'https://docs.google.com/spreadsheets/d/selected-log-999/edit',
      });
      expect(insertRow).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ spreadsheetId: 'selected-log-999' }),
          rowData: expect.objectContaining({ 'Calc Link': null }),
        })
      );
    });

    it('builds row deep-link uri with #gid=<sheetId>&range=<rowNumber>:<rowNumber> (including sheetId === 0) and falls back to /edit when sheetId is undefined', async () => {
      const insertRowZero = vi.fn().mockResolvedValue({ rowNumber: 12, action: 'inserted', sheetId: 0 });
      const { service: svcZero } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-zero', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { insertRow: insertRowZero },
      });

      const zeroRes = await svcZero.writeLog({ document: sampleDoc });
      expect(zeroRes).toEqual({
        spreadsheetId: 'log-zero',
        sheetName: 'Submittal Arch',
        sheetId: 0,
        rowNumber: 12,
        action: 'inserted',
        uri: 'https://docs.google.com/spreadsheets/d/log-zero/edit#gid=0&range=12:12',
      });

      const insertRowNonZero = vi.fn().mockResolvedValue({ rowNumber: 15, action: 'updated', sheetId: 202 });
      const { service: svcNonZero } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-202', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { insertRow: insertRowNonZero },
      });

      const nonZeroRes = await svcNonZero.writeLog({ document: sampleDoc });
      expect(nonZeroRes).toEqual({
        spreadsheetId: 'log-202',
        sheetName: 'Submittal Arch',
        sheetId: 202,
        rowNumber: 15,
        action: 'updated',
        uri: 'https://docs.google.com/spreadsheets/d/log-202/edit#gid=202&range=15:15',
      });

      const insertRowUndefined = vi.fn().mockResolvedValue({ rowNumber: 8, action: 'inserted' });
      const { service: svcUndefined } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-fallback', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { insertRow: insertRowUndefined },
      });

      const fallbackRes = await svcUndefined.writeLog({ document: sampleDoc });
      expect(fallbackRes).toEqual({
        spreadsheetId: 'log-fallback',
        sheetName: 'Submittal Arch',
        rowNumber: 8,
        action: 'inserted',
        uri: 'https://docs.google.com/spreadsheets/d/log-fallback/edit',
      });
      expect('sheetId' in fallbackRes).toBe(false);

      const prevPolicy = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(Value.Check(WriteDocumentLogResultSchema, zeroRes)).toBe(true);
        expect(Value.Check(WriteDocumentLogResultSchema, nonZeroRes)).toBe(true);
        expect(Value.Check(WriteDocumentLogResultSchema, fallbackRes)).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prevPolicy;
      }
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

    it('forwards non-default grouping sort orders, duplicatePolicy, and readOnlyColumns with computed targetKeys', async () => {
      const customLogSchema: DocumentLogSchema = {
        ...logSchema,
        grouping: {
          groupBy: 'idGroup',
          sortBy: 'idDocument',
          groupSortOrder: 'desc',
          rowSortOrder: 'desc',
          duplicatePolicy: 'upsert',
        },
        columns: {
          ...logSchema.columns,
          Title: { template: '{{title}}', readOnly: true },
        },
      };
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 10, action: 'updated' });
      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(customLogSchema),
        },
        storage: { insertRow },
      });

      const res = await service.writeLog({
        document: sampleDoc,
        selectedLogId: 'log-upsert-1',
      });

      expect(res).toEqual({
        spreadsheetId: 'log-upsert-1',
        sheetName: 'Submittal Arch',
        rowNumber: 10,
        action: 'updated',
        uri: 'https://docs.google.com/spreadsheets/d/log-upsert-1/edit',
      });
      expect(insertRow).toHaveBeenCalledWith(
        expect.objectContaining({
          targetKeys: {
            groupKey: '071200-001',
            sortKey: '071200-001-0',
          },
          groupSortOrder: 'desc',
          rowSortOrder: 'desc',
          duplicatePolicy: 'upsert',
          readOnlyColumns: ['Title'],
          rowKeyExtractor: expect.any(Function),
        })
      );
    });

    it('writes Submittal FF&E rows skipping readOnly Spec Title, forwarding readOnlyColumns, mapping blank relatedTag to null, and computing identity keys', async () => {
      const ffeLogSchema: DocumentLogSchema = {
        provider: 'google_sheets',
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
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
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Vendor: { template: '{{vendor.name}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
          Notes: { template: '{{notes}}' },
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
      };

      const ffeTargetSchema: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true, options: { source: 'statuses', key: 'key' } },
          { key: 'specTag', name: 'Spec Tag', type: 'string', required: true, options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'relatedTag', name: 'Related Tag', type: 'string', required: false, options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'revision', name: 'Revision', type: 'string', required: true },
          { key: 'specTitle', name: 'Spec Title', type: 'string', required: true, linkedField: { sourceField: 'specTag', sourceProperty: 'name' } },
          { key: 'vendor', name: 'Vendor', type: 'string', required: true, options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true, options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
          { key: 'notes', name: 'Notes', type: 'string', required: false },
        ],
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
        },
        options: {
          statuses: [{ key: 'Open' }, { key: 'Closed' }],
          specs: [{ key: 'CG104', name: 'BED - KING' }],
          vendors: [{ key: 'FDT', name: 'Fil Doux Textiles' }],
          contacts: [{ key: 'BW', name: 'Benjamin West' }],
          actions: [{ key: 'REC', name: 'Received', order: '1' }],
        },
      };

      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 8, action: 'inserted' });
      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockImplementation((k) => (k === 'submittal-ffe' ? ffeLogSchema : undefined)),
          getTargetSchema: vi.fn().mockImplementation((k) => (k === 'submittal-ffe' ? ffeTargetSchema : undefined)),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-ffe-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { insertRow },
      });

      const res = await service.writeLog({
        document: {
          type: 'submittal-ffe',
          space: sampleSpace,
          data: {
            status: 'Open',
            specTag: 'CG104',
            relatedTag: '',
            revision: '0',
            specTitle: 'BED - KING',
            vendor: 'FDT',
            date: '260120',
            contact: 'BW',
            action: 'REC',
            notes: '',
          },
        },
        fileUri: 'https://drive.google.com/file/d/ffe-doc-1/view',
      });

      expect(res).toEqual({
        spreadsheetId: 'log-ffe-1',
        sheetName: 'Submittal FF&E',
        rowNumber: 8,
        action: 'inserted',
        uri: 'https://docs.google.com/spreadsheets/d/log-ffe-1/edit',
      });

      expect(insertRow).toHaveBeenCalledWith({
        target: {
          spreadsheetId: 'log-ffe-1',
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        rowData: {
          Status: 'Open',
          'Spec Tag': 'CG104',
          'Related Tag': null,
          Revision: '0',
          Vendor: 'Fil Doux Textiles',
          Date: '260120',
          Contact: 'BW',
          Action: 'Received',
          Notes: null,
          'Calc Link': {
            formula: '=HYPERLINK("https://drive.google.com/file/d/ffe-doc-1/view", "Link")',
          },
        },
        readOnlyColumns: ['Spec Title'],
        rowKeyExtractor: expect.any(Function),
        targetKeys: {
          groupKey: 'CG104',
          sortKey: 'CG104-0-260120-1',
        },
        groupSortOrder: 'asc',
        rowSortOrder: 'asc',
        duplicatePolicy: 'insert',
      });

      const passedRequest = insertRow.mock.calls[0][0];
      expect('Spec Title' in passedRequest.rowData).toBe(false);
      expect(
        passedRequest.rowKeyExtractor({
          'Spec Tag': 'CG104',
          Revision: '0',
          Date: '260120',
          Action: 'received',
        })
      ).toEqual({
        groupKey: 'CG104',
        sortKey: 'CG104-0-260120-1',
      });
      expect(
        passedRequest.rowKeyExtractor({
          'Spec Tag': '',
          Revision: '0',
          Date: '260120',
          Action: 'Received',
        })
      ).toBeNull();
    });

    it('passes a rowKeyExtractor that extracts best-effort keys for submittalArch.partialHydrationRows-style hand-edited rows without throwing and returns null for unkeyable rows', async () => {
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' });
      const archTargetSchemaWithRef: LogTargetDocumentSchema = {
        ...targetSchema,
        options: {
          ...targetSchema.options,
          actions: [
            ...(targetSchema.options?.actions ?? []),
            { key: 'REF', name: 'Referred', order: '2' },
          ],
        },
      };
      const { service } = createService({
        registry: {
          getTargetSchema: vi.fn().mockImplementation((k) =>
            k === 'submittal-arch' ? archTargetSchemaWithRef : undefined
          ),
        },
        storage: { insertRow },
      });

      await service.writeLog({
        document: sampleDoc,
        selectedLogId: 'log-partial-rows',
      });

      const { rowKeyExtractor } = insertRow.mock.calls[0][0];

      // Short 4-digit section
      expect(
        rowKeyExtractor({
          Status: 'Open',
          Section: '7120',
          Number: '001',
          Revision: '0',
          Title: 'Manual Entry Short Section',
          Date: '260225',
          Contact: 'MB',
          Action: 'Received',
        })
      ).toEqual({
        groupKey: '7120-001',
        sortKey: '7120-001-0-260225-1',
      });

      // Unknown Action ('Approved')
      expect(
        rowKeyExtractor({
          Status: 'Open',
          Section: '071200',
          Number: '001',
          Revision: '1',
          Title: 'Fluid-Applied Waterproofing Membrane',
          Date: '260226',
          Contact: 'ARC',
          Action: 'Approved',
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-1-260226-',
      });

      // Missing required Date
      expect(
        rowKeyExtractor({
          Status: 'Waiting',
          Section: '071200',
          Number: '001',
          Revision: '1',
          Title: 'Fluid-Applied Waterproofing Membrane',
          Date: '',
          Contact: 'PST',
          Action: 'Referred',
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-1--2',
      });

      // Key-in-name-column ('REC')
      expect(
        rowKeyExtractor({
          Status: 'Open',
          Section: '071200',
          Number: '001',
          Revision: '0',
          Title: 'Fluid-Applied Waterproofing',
          Date: '260204',
          Contact: 'MB',
          Action: 'REC',
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-0-260204-1',
      });

      // Completely unkeyable row
      expect(
        rowKeyExtractor({
          Section: '',
          Number: '',
          Title: 'Random note',
        })
      ).toBeNull();
    });

    it('enriches document.data once per writeLog and reuses enrichedData for row mapping and target key computation', async () => {
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' });
      const { service } = createService({ storage: { insertRow } });

      let titleReads = 0;
      const dataWithReadCounter: Record<string, unknown> = {
        status: 'Open',
        section: '071200',
        number: '001',
        revision: '0',
        date: '260204',
        contact: 'MB',
        action: 'REC',
      };
      Object.defineProperty(dataWithReadCounter, 'title', {
        enumerable: true,
        get: () => {
          titleReads++;
          return 'Waterproofing';
        },
      });

      const result = await service.writeLog({
        document: {
          type: 'submittal-arch',
          data: dataWithReadCounter,
        },
        selectedLogId: 'log-single-enrich',
      });

      expect(result.action).toBe('inserted');
      expect(titleReads).toBe(1);
      expect(insertRow).toHaveBeenCalledWith(
        expect.objectContaining({
          rowData: expect.objectContaining({ Title: 'Waterproofing', Action: 'Received' }),
          targetKeys: {
            groupKey: '071200-001',
            sortKey: '071200-001-0-260204-1',
          },
        })
      );
    });
  });

  describe('requiresDocumentLog and queryUiContext', () => {
    it('requiresDocumentLog returns true for configured logging types and false for non-logging or blank types', () => {
      const { service } = createService();

      expect(service.requiresDocumentLog('submittal-arch')).toBe(true);
      expect(service.requiresDocumentLog('communication-project')).toBe(false);
      expect(service.requiresDocumentLog('communication-proposal')).toBe(false);
      expect(service.requiresDocumentLog('')).toBe(false);
      expect(service.requiresDocumentLog('   ')).toBe(false);
    });

    it('queryUiContext returns undefined with zero Drive/Sheets calls for non-logging or missing documentTypeKey', async () => {
      const searchSpreadsheets = vi.fn();
      const insertRow = vi.fn();
      const { service } = createService({
        discovery: { searchSpreadsheets },
        storage: { insertRow },
      });

      await expect(
        service.queryUiContext({ documentTypeKey: 'communication-project', space: sampleSpace })
      ).resolves.toBeUndefined();
      await expect(
        service.queryUiContext({ documentTypeKey: 'communication-proposal', space: sampleSpace })
      ).resolves.toBeUndefined();
      await expect(service.queryUiContext({ space: sampleSpace })).resolves.toBeUndefined();

      expect(searchSpreadsheets).not.toHaveBeenCalled();
      expect(insertRow).not.toHaveBeenCalled();
    });

    it('queryUiContext returns missing_space when space is absent without calling Drive', async () => {
      const searchSpreadsheets = vi.fn();
      const { service } = createService({
        discovery: { searchSpreadsheets },
      });

      const res = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
      });

      expect(res).toEqual({ status: 'missing_space' });
      expect(searchSpreadsheets).not.toHaveBeenCalled();
    });

    it('queryUiContext wraps live resolveLog in try/catch and returns discovery_error on Drive failures', async () => {
      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockRejectedValue(new Error('Drive API 503 Service Unavailable')),
        },
      });

      const res = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });

      expect(res).toEqual({
        status: 'discovery_error',
        spaceName: 'Harborview Hotel',
        discoveryErrorMessage: 'Drive API 503 Service Unavailable',
      });
    });

    it('queryUiContext renders copyNameTemplate and expected folder on missing status', async () => {
      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
        },
      });

      const res = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });

      expect(res).toEqual({
        status: 'missing',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        targetFileName: 'Harborview Hotel Document Log',
      });
    });

    it('queryUiContext returns activeCandidate on resolved with webViewLink and fallback URL when omitted', async () => {
      const searchSpreadsheets = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'log-with-link',
            name: 'Harborview Hotel Document Log',
            webViewLink: 'https://docs.google.com/spreadsheets/d/custom-link/edit',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'log-without-link',
            name: 'Harborview Hotel Document Log',
          },
        ]);

      const { service } = createService({
        discovery: { searchSpreadsheets },
      });

      const withLink = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });
      expect(withLink).toEqual({
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        activeCandidate: {
          name: 'Harborview Hotel Document Log',
          url: 'https://docs.google.com/spreadsheets/d/custom-link/edit',
        },
        readStatus: 'idle_incomplete_id',
        missingIdFields: ['Section', 'Number'],
      });
      expect('targetFolderPath' in withLink!).toBe(false);

      const withoutLink = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });
      expect(withoutLink).toEqual({
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        activeCandidate: {
          name: 'Harborview Hotel Document Log',
          url: 'https://docs.google.com/spreadsheets/d/log-without-link/edit',
        },
        readStatus: 'idle_incomplete_id',
        missingIdFields: ['Section', 'Number'],
      });
      expect('targetFolderPath' in withoutLink!).toBe(false);
    });

    it('queryUiContext returns ambiguous with presentation-ready candidateOptions, matching selectedLogId, or ranked fallback when absent/stale, without leaking raw Drive metadata', async () => {
      const { service } = createService({
        registry: { getSpaceFetchMethod: vi.fn().mockReturnValue('shared_drives') },
        discovery: {
          resolveFolderPath: vi.fn().mockResolvedValue({ id: 'folder-admin', name: '1 Admin' }),
          getFile: vi.fn().mockImplementation(async (fileId: string) => {
            if (fileId === 'folder-admin') {
              return { id: 'folder-admin', name: '1 Admin' };
            }
            if (fileId === 'folder-const') {
              return { id: 'folder-const', name: '6 Construction' };
            }
            throw new Error('403 Forbidden');
          }),
          searchSpreadsheets: vi.fn().mockResolvedValue([
            {
              id: 'log-1',
              name: 'Harborview Hotel Document Log',
              parents: ['folder-admin'],
              modifiedTime: '2026-10-19T14:30:00.000Z',
              webViewLink: 'https://docs.google.com/spreadsheets/d/custom-log-1/edit',
            },
            {
              id: 'log-2',
              name: 'Harborview Hotel Document Log',
              parents: ['folder-const'],
              modifiedTime: '2026-10-12T08:00:00Z',
            },
            {
              id: 'log-3',
              name: 'Harborview Hotel Document Log Root',
              parents: [sampleSpace.abstractStorageId],
              modifiedTime: '2026-10-01T00:00:00Z',
            },
            {
              id: 'log-4',
              name: 'Harborview Hotel Document Log Undated',
              parents: ['folder-const'],
            },
            {
              id: 'log-5',
              name: 'Harborview Hotel Document Log Plain',
              parents: ['folder-forbidden'],
            },
          ]),
        },
      });

      const fallbackRes = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });
      expect(Value.Check(DocumentLogUiContextResultSchema, fallbackRes)).toBe(true);
      expect(fallbackRes).toEqual({
        status: 'ambiguous',
        spaceName: 'Harborview Hotel',
        candidateOptions: [
          { text: 'Harborview Hotel Document Log (1 Admin · 2026-10-19)', value: 'log-1', selected: true },
          { text: 'Harborview Hotel Document Log (6 Construction · 2026-10-12)', value: 'log-2', selected: false },
          { text: 'Harborview Hotel Document Log Root (2026-10-01)', value: 'log-3', selected: false },
          { text: 'Harborview Hotel Document Log Undated (6 Construction)', value: 'log-4', selected: false },
          { text: 'Harborview Hotel Document Log Plain', value: 'log-5', selected: false },
        ],
        activeCandidate: {
          name: 'Harborview Hotel Document Log',
          url: 'https://docs.google.com/spreadsheets/d/custom-log-1/edit',
        },
        readStatus: 'idle_incomplete_id',
        missingIdFields: ['Section', 'Number'],
      });
      expect('targetFolderPath' in fallbackRes!).toBe(false);

      // Raw Drive metadata never leaks onto the presentation-ready UI context DTO
      const serialized = JSON.stringify(fallbackRes);
      expect(serialized).not.toContain('parentFolderName');
      expect(serialized).not.toContain('modifiedTime');
      expect(serialized).not.toContain('"parents"');

      // Matching selectedLogId switches activeCandidate and selected option
      const chosenRes = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'log-2',
      });
      expect(chosenRes?.activeCandidate).toEqual({
        name: 'Harborview Hotel Document Log',
        url: 'https://docs.google.com/spreadsheets/d/log-2/edit',
      });
      expect(chosenRes?.candidateOptions).toEqual([
        { text: 'Harborview Hotel Document Log (1 Admin · 2026-10-19)', value: 'log-1', selected: false },
        { text: 'Harborview Hotel Document Log (6 Construction · 2026-10-12)', value: 'log-2', selected: true },
        { text: 'Harborview Hotel Document Log Root (2026-10-01)', value: 'log-3', selected: false },
        { text: 'Harborview Hotel Document Log Undated (6 Construction)', value: 'log-4', selected: false },
        { text: 'Harborview Hotel Document Log Plain', value: 'log-5', selected: false },
      ]);

      // Stale selectedLogId (not in live candidates) falls back to ranked candidates[0]
      const staleRes = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'log-deleted-stale',
      });
      expect(staleRes?.activeCandidate).toEqual({
        name: 'Harborview Hotel Document Log',
        url: 'https://docs.google.com/spreadsheets/d/custom-log-1/edit',
      });
      expect(staleRes?.candidateOptions?.[0]?.selected).toBe(true);
      expect(staleRes?.candidateOptions?.slice(1).every((o) => o.selected === false)).toBe(true);
    });

    it('queryUiContext resolves widget-suffixed keys before unsuffixed keys, trims before enrichment, and skips Sheets on idle_incomplete_id', async () => {
      const readRows = vi.fn();
      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { readRows },
      });

      // Suffixed key cleared ('') must win over unsuffixed fallback ('071200') and skip Sheets
      const clearedSuffixed = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: {
          'section_submittal-arch': '   ',
          section: '071200',
          'number_submittal-arch': ' 001 ',
        },
      });
      expect(clearedSuffixed?.readStatus).toBe('idle_incomplete_id');
      expect(clearedSuffixed?.missingIdFields).toEqual(['Section']);
      expect(clearedSuffixed?.idGroup).toBeUndefined();
      expect(readRows).not.toHaveBeenCalled();

      // Missing number only
      const missingNumber = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: {
          'section_submittal-arch': ' 071200 ',
        },
      });
      expect(missingNumber?.readStatus).toBe('idle_incomplete_id');
      expect(missingNumber?.missingIdFields).toEqual(['Number']);
      expect(readRows).not.toHaveBeenCalled();
    });

    it('queryUiContext formats newest-first historyDisplay with 5-char HTML escaping in text (preserving = and falling back to "—") and unescaped plain labels', async () => {
      const archLogWithHistory: DocumentLogSchema = {
        ...logSchema,
        historyDisplay: {
          topLabel: 'Rev {{revision}} • {{section}}-{{number}} • {{status.key}} • {{title}}',
          text: '<b>{{action.name}}</b> {{date}} ({{contact.key}}) — {{notes}}',
          bottomLabel: '{{title}}',
        },
      };
      const archTargetWithSpecials: LogTargetDocumentSchema = {
        ...targetSchema,
        options: {
          statuses: [{ key: 'Open' }, { key: 'Closed' }],
          actions: [
            { key: 'REC', name: 'Received', order: '1' },
            { key: 'RR', name: 'Revise & Resubmit', order: '5' },
          ],
          contacts: [
            { key: 'MB', name: 'Meridian Builders' },
            { key: 'A&B', name: 'A & B Tower' },
          ],
        },
      };

      const readRows = vi.fn().mockResolvedValue({
        headers: ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
        formulaColumns: [],
        rows: [
          {
            rowNumber: 6,
            values: {
              Status: 'Open',
              Section: '071200',
              Number: '001',
              Revision: '0',
              Title: 'Pipe <2" at A & B Tower',
              Date: '260204',
              Contact: 'MB',
              Action: 'Received',
              Notes: 'ratio=1:2 & \'ok\'',
              'Calc Link': 'Link',
            },
            links: { 'Calc Link': 'https://drive.google.com/file/d/row-6/view' },
          },
          {
            rowNumber: 7,
            values: {
              Status: 'Open',
              Section: '071200',
              Number: '001',
              Revision: '1',
              Title: 'Pipe <2" at A & B Tower',
              Date: '260212',
              Contact: 'A&B',
              Action: 'Revise & Resubmit',
              Notes: 'Check <detail> "A=B"',
              'Calc Link': '',
            },
            links: { 'Calc Link': null },
          },
        ],
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(archLogWithHistory),
          getTargetSchema: vi.fn().mockReturnValue(archTargetWithSpecials),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-hist-1', name: 'A & B Tower Document Log' },
          ]),
        },
        storage: { readRows },
      });

      const res = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: {
          'section_submittal-arch': ' 071200 ',
          'number_submittal-arch': ' 001 ',
        },
      });

      expect(Value.Check(DocumentLogUiContextResultSchema, res)).toBe(true);
      expect(readRows).toHaveBeenCalledTimes(1);
      expect(readRows).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ spreadsheetId: 'log-hist-1' }),
          linkColumns: ['Calc Link'],
        })
      );

      expect(res?.readStatus).toBe('ready');
      expect(res?.idGroup).toBe('071200-001');
      expect(res?.warningMessages).toBeUndefined();
      // Newest-first (row 7 before row 6)
      expect(res?.entries).toEqual([
        {
          topLabel: 'Rev 1 • 071200-001 • Open • Pipe <2" at A & B Tower',
          text: '<b>Revise &amp; Resubmit</b> 260212 (A&amp;B) — Check &lt;detail&gt; &quot;A=B&quot;',
          bottomLabel: 'Pipe <2" at A & B Tower',
          valid: true,
        },
        {
          topLabel: 'Rev 0 • 071200-001 • Open • Pipe <2" at A & B Tower',
          text: '<b>Received</b> 260204 (MB) — ratio=1:2 &amp; &#39;ok&#39;',
          bottomLabel: 'Pipe <2" at A & B Tower',
          fileUri: 'https://drive.google.com/file/d/row-6/view',
          valid: true,
        },
      ]);
      // Preserves '=' without &#x3D;
      expect(res?.entries?.[0].text).not.toContain('&#x3D;');
      expect(res?.entries?.[1].text).not.toContain('&#x3D;');
      // Plain text labels stay unescaped
      expect(res?.entries?.[0].bottomLabel).not.toContain('&lt;');
      expect(res?.entries?.[0].bottomLabel).not.toContain('&amp;');
      expect('fileUri' in (res?.entries?.[0] ?? {})).toBe(false);

      // Blank rendered text falls back to "—" and omitted historyDisplay uses a sensible HTML-escaped default format
      const blankTextLogSchema: DocumentLogSchema = {
        ...logSchema,
        historyDisplay: { text: '<b>{{notes}}</b>' },
      };
      const { service: blankSvc } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(blankTextLogSchema),
          getTargetSchema: vi.fn().mockReturnValue(archTargetWithSpecials),
        },
        discovery: {
          searchSpreadsheets: vi
            .fn()
            .mockResolvedValue([{ id: 'log-blank', name: 'Harborview Hotel Document Log' }]),
        },
        storage: {
          readRows: vi.fn().mockResolvedValue({
            headers: ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes'],
            formulaColumns: [],
            rows: [
              {
                rowNumber: 6,
                values: {
                  Status: 'Open',
                  Section: '071200',
                  Number: '001',
                  Revision: '0',
                  Title: 'Pipe <2"',
                  Date: '260204',
                  Contact: 'MB',
                  Action: 'Received',
                  Notes: '',
                },
              },
            ],
          }),
        },
      });
      const blankRes = await blankSvc.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: { section: '071200', number: '001' },
      });
      expect(blankRes?.entries?.[0].text).toBe('—');

      const { service: defaultFormatSvc } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchema), // historyDisplay omitted
          getTargetSchema: vi.fn().mockReturnValue(archTargetWithSpecials),
        },
        discovery: {
          searchSpreadsheets: vi
            .fn()
            .mockResolvedValue([{ id: 'log-default', name: 'Harborview Hotel Document Log' }]),
        },
        storage: {
          readRows: vi.fn().mockResolvedValue({
            headers: ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action'],
            formulaColumns: [],
            rows: [
              {
                rowNumber: 6,
                values: {
                  Status: 'Open',
                  Section: '071200',
                  Number: '001',
                  Revision: '0',
                  Title: 'Pipe <2" & A=B',
                  Date: '260204',
                  Contact: 'MB',
                  Action: 'Revise & Resubmit',
                },
              },
            ],
          }),
        },
      });
      const defaultRes = await defaultFormatSvc.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: { section: '071200', number: '001' },
      });
      expect(defaultRes?.readStatus).toBe('ready');
      expect(defaultRes?.entries).toHaveLength(1);
      expect(defaultRes?.entries?.[0].topLabel).toBe('071200-001-0');
      expect(defaultRes?.entries?.[0].text).toContain('Revise &amp; Resubmit');
      expect(defaultRes?.entries?.[0].text).not.toContain('&#x3D;');
    });

    it('queryUiContext enriches trimmed/lowercase Submittal FF&E specTag, queries selected ambiguous log, maps partialHydrationRows warnings, and degrades gracefully on Sheets read_error', async () => {
      interface FixturePartialRow {
        scenario: string;
        rowCells: Record<string, string>;
        linkFormula: string;
      }
      const fixture = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../../test/fixtures/document-log-sample-data.json'),
          'utf-8'
        )
      ) as {
        anonymizedEntities: {
          contacts: Array<{ key: string; name: string; type: string }>;
          vendors: Array<{ key: string; name: string; type: string }>;
        };
        submittalFfe: { partialHydrationRows: FixturePartialRow[] };
      };

      const ffeLogSchema: DocumentLogSchema = {
        provider: 'google_sheets',
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
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
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Vendor: { template: '{{vendor.name}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
          Notes: { template: '{{notes}}' },
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
        historyDisplay: {
          topLabel: 'Rev {{revision}} • {{specTag.key}} • {{status.key}}',
          text: '<b>{{action.name}}</b> {{date}} ({{contact.key}})',
          bottomLabel: '{{specTitle}} — {{vendor.name}}',
        },
      };

      const ffeTargetSchema: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true, options: { source: 'statuses', key: 'key' } },
          { key: 'specTag', name: 'Spec Tag', type: 'string', required: true, options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'relatedTag', name: 'Related Tag', type: 'string', required: false, options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'revision', name: 'Revision', type: 'string', required: true },
          { key: 'specTitle', name: 'Spec Title', type: 'string', required: true, linkedField: { sourceField: 'specTag', sourceProperty: 'name' } },
          { key: 'vendor', name: 'Vendor', type: 'string', required: true, options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true, options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
          { key: 'notes', name: 'Notes', type: 'string', required: false },
        ],
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
        },
        options: {
          statuses: [{ key: 'Open' }, { key: 'Closed' }, { key: 'Waiting' }],
          specs: [
            { key: 'CG104', name: 'BED - KING' },
            { key: 'LT108', name: 'SCONCE' },
          ],
          vendors: fixture.anonymizedEntities.vendors,
          contacts: fixture.anonymizedEntities.contacts,
          actions: [
            { key: 'REC', name: 'Received', order: '1' },
            { key: 'REF', name: 'Referred', order: '2' },
          ],
        },
      };

      const partialFfeRow0 = fixture.submittalFfe.partialHydrationRows[0]; // LT108, Status "In Review", blank Vendor
      const partialFfeRow1 = fixture.submittalFfe.partialHydrationRows[1]; // CG104, blank Revision, raw URL

      const readRows = vi.fn().mockImplementation(async (req: { target: { spreadsheetId: string } }) => {
        if (req.target.spreadsheetId === 'log-ffe-2') {
          return {
            headers: Object.keys(partialFfeRow0.rowCells),
            formulaColumns: ['Spec Title'],
            rows: [
              {
                rowNumber: 8,
                values: partialFfeRow0.rowCells,
                links: { 'Calc Link': 'https://drive.google.com/file/d/fixture-ffe-partial-vendor/view' },
              },
              {
                rowNumber: 9,
                values: partialFfeRow1.rowCells,
                links: { 'Calc Link': 'https://drive.google.com/file/d/fixture-ffe-raw-url/view' },
              },
            ],
          };
        }
        const sheetsErr = new Error('Named range "Log_Submittal_FFE" not found on sheet "Submittal FF&E".');
        sheetsErr.name = 'GoogleSheetsNamedRangeNotFoundError';
        throw sheetsErr;
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockImplementation((k) => (k === 'submittal-ffe' ? ffeLogSchema : undefined)),
          getTargetSchema: vi.fn().mockImplementation((k) => (k === 'submittal-ffe' ? ffeTargetSchema : undefined)),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-ffe-1', name: 'Harborview Hotel Document Log A', modifiedTime: '2026-10-19T12:00:00Z' },
            { id: 'log-ffe-2', name: 'Harborview Hotel Document Log B', modifiedTime: '2026-10-10T12:00:00Z' },
          ]),
        },
        storage: { readRows },
      });

      // Ambiguous log-ffe-2 selected + lowercase/untrimmed specTag ' lt108 ' -> partial_hydration with human-entered "In Review" visible!
      const partialRes = await service.queryUiContext({
        documentTypeKey: 'submittal-ffe',
        space: sampleSpace,
        selectedLogId: 'log-ffe-2',
        formData: {
          'specTag_submittal-ffe': ' lt108 ',
        },
      });
      expect(Value.Check(DocumentLogUiContextResultSchema, partialRes)).toBe(true);
      expect(partialRes?.status).toBe('ambiguous');
      expect(partialRes?.readStatus).toBe('partial_hydration');
      expect(partialRes?.idGroup).toBe('LT108');
      expect(partialRes?.entries).toEqual([
        {
          topLabel: 'Rev 0 • LT108 • In Review',
          text: '<b>Received</b> 260216 (HPG)',
          bottomLabel: 'SCONCE —',
          fileUri: 'https://drive.google.com/file/d/fixture-ffe-partial-vendor/view',
          valid: false,
        },
      ]);
      expect(partialRes?.warningMessages).toHaveLength(2);
      expect(partialRes?.warningMessages?.every((m) => typeof m === 'string')).toBe(true);
      expect(partialRes?.warningMessages?.[0]).toContain('Row 8');
      expect(JSON.stringify(partialRes)).not.toContain('"rowNumber"');

      // Ambiguous default log-ffe-1 -> read_error without leaking GoogleSheetsNamedRangeNotFoundError name
      const errorRes = await service.queryUiContext({
        documentTypeKey: 'submittal-ffe',
        space: sampleSpace,
        formData: {
          'specTag_submittal-ffe': ' cg104 ',
        },
      });
      expect(Value.Check(DocumentLogUiContextResultSchema, errorRes)).toBe(true);
      expect(errorRes?.status).toBe('ambiguous');
      expect(errorRes?.readStatus).toBe('read_error');
      expect(errorRes?.idGroup).toBe('CG104');
      expect(errorRes?.readErrorMessage).toContain('Named range "Log_Submittal_FFE" not found');
      expect(JSON.stringify(errorRes)).not.toContain('GoogleSheetsNamedRangeNotFoundError');
      expect(errorRes?.entries).toBeUndefined();
    });

    it('forwards non-empty readRows error messages verbatim without storage-specific stripping and falls back on blank errors', async () => {
      const readRows = vi
        .fn()
        .mockRejectedValueOnce(new Error('GoogleSheetsApiError: Upstream failure'))
        .mockRejectedValueOnce(new Error('   '));

      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-err-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { readRows },
      });

      const verbatimRes = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: {
          section: '071200',
          number: '001',
        },
      });
      expect(verbatimRes?.readStatus).toBe('read_error');
      expect(verbatimRes?.readErrorMessage).toBe('GoogleSheetsApiError: Upstream failure');

      const blankRes = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: {
          section: '071200',
          number: '001',
        },
      });
      expect(blankRes?.readStatus).toBe('read_error');
      expect(blankRes?.readErrorMessage).toBe('Unable to read Document Log history right now.');
    });
  });

  describe('readLog', () => {
    it('resolves log via resolveLog, collects fileLink columns, delegates to readRows, and hydrates valid and partial rows with readOnly columns, LookupFields, Identity keys, and warnings', async () => {
      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'log-read-1', name: 'Harborview Hotel Document Log' },
      ]);
      const readRows = vi.fn().mockResolvedValue({
        headers: [
          'Status',
          'Section',
          'Number',
          'Revision',
          'Title',
          'Date',
          'Contact',
          'Action',
          'Notes',
          'Calc Link',
        ],
        formulaColumns: [],
        rows: [
          {
            rowNumber: 6,
            values: {
              Status: 'open',
              Section: '071200',
              Number: '001',
              Revision: '0',
              Title: 'Fluid-Applied Waterproofing',
              Date: '260204',
              Contact: 'Acme Corp',
              Action: 'received',
              Notes: '',
              'Calc Link': 'Link',
            },
            links: {
              'Calc Link': 'https://drive.google.com/file/d/arch-valid-1/view',
            },
          },
          {
            rowNumber: 7,
            values: {
              Status: 'Open',
              Section: '071200',
              Number: '002',
              Revision: '1',
              Title: 'Roofing Membrane',
              Date: '',
              Contact: 'MB',
              Action: 'Approved',
              Notes: 'Manual entry',
              'Calc Link': '',
            },
            links: {
              'Calc Link': null,
            },
          },
        ],
      });

      const archReadOnlyLogSchema: DocumentLogSchema = {
        ...logSchema,
        columns: {
          ...logSchema.columns,
          Title: { template: '{{title}}', readOnly: true },
        },
      };

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockImplementation((k) =>
            k === 'submittal-arch' ? archReadOnlyLogSchema : undefined
          ),
        },
        discovery: { searchSpreadsheets },
        storage: { readRows },
      });

      const result = await service.readLog({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });

      expect(searchSpreadsheets).toHaveBeenCalledTimes(1);
      expect(readRows).toHaveBeenCalledWith({
        target: {
          spreadsheetId: 'log-read-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        linkColumns: ['Calc Link'],
      });

      expect(result.spreadsheetId).toBe('log-read-1');
      expect(result.sheetName).toBe('Submittal Arch');
      expect(result.entries).toHaveLength(2);

      const validEntry = result.entries[0];
      expect(validEntry).toEqual({
        rowNumber: 6,
        valid: true,
        fileUri: 'https://drive.google.com/file/d/arch-valid-1/view',
        document: {
          id: '071200-001-0-260204-1',
          idDocument: '071200-001-0',
          idGroup: '071200-001',
          type: 'submittal-arch',
          data: {
            status: { key: 'Open' },
            section: '071200',
            number: '001',
            revision: '0',
            title: 'Fluid-Applied Waterproofing',
            date: '260204',
            contact: { key: 'Acme Corp', name: 'Acme Corp' },
            action: { key: 'REC', name: 'Received', order: '1' },
          },
        },
      });
      expect('notes' in validEntry.document.data).toBe(false);
      expect('calculated' in validEntry.document).toBe(false);

      const partialEntry = result.entries[1];
      expect(partialEntry.rowNumber).toBe(7);
      expect(partialEntry.valid).toBe(false);
      expect('fileUri' in partialEntry).toBe(false);
      expect('date' in partialEntry.document.data).toBe(false);
      expect('calculated' in partialEntry.document).toBe(false);
      expect(partialEntry.document.idGroup).toBe('071200-002');
      expect(partialEntry.document.idDocument).toBe('071200-002-1');
      expect(partialEntry.document.id).toBe('071200-002-1--');
      expect(partialEntry.document.data.action).toEqual({ key: 'Approved', name: 'Approved' });
      expect(partialEntry.document.data.contact).toEqual({ key: 'MB', name: 'Meridian Builders' });
      expect(partialEntry.document.data.notes).toBe('Manual entry');
      expect(partialEntry.validationErrors).toHaveLength(2);

      expect(result.warnings).toHaveLength(2);
      expect(result.warnings.map((w) => ({ rowNumber: w.rowNumber, field: w.field }))).toEqual([
        { rowNumber: 7, field: 'date' },
        { rowNumber: 7, field: 'action' },
      ]);
    });

    it('bypasses resolveLog and Drive search when selectedLogId is provided even if space is omitted', async () => {
      const searchSpreadsheets = vi.fn();
      const readRows = vi.fn().mockResolvedValue({
        headers: ['Status', 'Section'],
        formulaColumns: [],
        rows: [],
      });

      const { service } = createService({
        discovery: { searchSpreadsheets },
        storage: { readRows },
      });

      const result = await service.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'selected-log-77',
      });

      expect(searchSpreadsheets).not.toHaveBeenCalled();
      expect(readRows).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ spreadsheetId: 'selected-log-77' }),
        })
      );
      expect(result).toEqual({
        spreadsheetId: 'selected-log-77',
        sheetName: 'Submittal Arch',
        entries: [],
        warnings: [],
      });
    });

    it('validates documentTypeKey before filterBy/values checks and enforces paired filterBy and values', async () => {
      const { service, discovery, storage } = createService();

      // Unknown documentTypeKey throws even with unpaired filterBy or values
      await expect(
        service.readLog({
          documentTypeKey: 'unknown-type',
          filterBy: 'idGroup',
        })
      ).rejects.toThrow(DocumentLogConfigurationError);

      await expect(
        service.readLog({
          documentTypeKey: 'unknown-type',
          values: ['071200-001'],
        })
      ).rejects.toThrow(DocumentLogConfigurationError);

      // filterBy without values throws
      await expect(
        service.readLog({
          documentTypeKey: 'submittal-arch',
          selectedLogId: 'log-1',
          filterBy: 'idGroup',
        })
      ).rejects.toThrow(DocumentLogConfigurationError);

      // values without filterBy throws
      await expect(
        service.readLog({
          documentTypeKey: 'submittal-arch',
          selectedLogId: 'log-1',
          values: ['071200-001'],
        })
      ).rejects.toThrow(DocumentLogConfigurationError);

      await expect(
        service.readLog({
          documentTypeKey: 'submittal-arch',
          selectedLogId: 'log-1',
          values: '',
        })
      ).rejects.toThrow(DocumentLogConfigurationError);

      expect(discovery.searchSpreadsheets).not.toHaveBeenCalled();
      expect(storage.readRows).not.toHaveBeenCalled();
    });

    it('short-circuits with zero Drive or Sheets calls when filterBy is set and normalized values are empty', async () => {
      const searchSpreadsheets = vi.fn();
      const readRows = vi.fn();
      const { service } = createService({
        discovery: { searchSpreadsheets },
        storage: { readRows },
      });

      for (const emptyValues of [[], '', ['  ', '\t']] as Array<string | string[]>) {
        const result = await service.readLog({
          documentTypeKey: 'submittal-arch',
          filterBy: 'idGroup',
          values: emptyValues,
        });
        expect(result).toEqual({
          spreadsheetId: '',
          sheetName: 'Submittal Arch',
          entries: [],
          warnings: [],
        });
      }

      expect(searchSpreadsheets).not.toHaveBeenCalled();
      expect(readRows).not.toHaveBeenCalled();
    });

    it('filters by idGroup, idDocument, and id case-insensitively on trimmed values, ignores unkeyable rows for "-", and scopes warnings to matched rows', async () => {
      const ffeLogSchema: DocumentLogSchema = {
        provider: 'google_sheets',
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
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
          'Spec Tag': { template: '{{specTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Vendor: { template: '{{vendor.name}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
        },
      };

      const ffeTargetSchema: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true, options: { source: 'statuses', key: 'key' } },
          { key: 'specTag', name: 'Spec Tag', type: 'string', required: true, options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'revision', name: 'Revision', type: 'string', required: true },
          { key: 'specTitle', name: 'Spec Title', type: 'string', required: false },
          { key: 'vendor', name: 'Vendor', type: 'string', required: true, options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true, options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
        ],
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
        },
        options: {
          statuses: [{ key: 'Open' }],
          specs: [{ key: 'CG104', name: 'BED - KING' }],
          vendors: [{ key: 'FDT', name: 'Fil Doux Textiles' }],
          contacts: [{ key: 'BW', name: 'Benjamin West' }],
          actions: [
            { key: 'REC', name: 'Received', order: '1' },
            { key: 'REF', name: 'Referred', order: '2' },
          ],
        },
      };

      const archRows = [
        // Row 6: 071200-001 (partial, missing date -> warning on row 6)
        {
          rowNumber: 6,
          values: {
            Status: 'Open',
            Section: '071200',
            Number: '001',
            Revision: '0',
            Title: 'Waterproofing',
            Date: '',
            Contact: 'MB',
            Action: 'REC',
          },
        },
        // Row 7: 071200-002 (partial, invalid action -> warning on row 7)
        {
          rowNumber: 7,
          values: {
            Status: 'Open',
            Section: '071200',
            Number: '002',
            Revision: '1',
            Title: 'Flashing',
            Date: '260205',
            Contact: 'MB',
            Action: 'BadAction',
          },
        },
        // Row 8: Unkeyable note row (all identity fields blank -> idGroup/idDocument/id undefined, never '-')
        {
          rowNumber: 8,
          values: {
            Status: '',
            Section: '',
            Number: '',
            Revision: '',
            Title: 'General section note',
            Date: '',
            Contact: '',
            Action: '',
          },
        },
      ];

      const ffeRows = [
        {
          rowNumber: 10,
          values: {
            Status: 'Open',
            'Spec Tag': 'CG104',
            Revision: '0',
            'Spec Title': 'BED - KING',
            Vendor: 'Fil Doux Textiles',
            Date: '260120',
            Contact: 'BW',
            Action: 'Received',
          },
        },
        {
          rowNumber: 11,
          values: {
            Status: 'Open',
            'Spec Tag': 'LT108',
            Revision: '1',
            'Spec Title': 'SCONCE',
            Vendor: 'Fil Doux Textiles',
            Date: '260121',
            Contact: 'BW',
            Action: 'Referred',
          },
        },
      ];

      const readRows = vi.fn().mockImplementation(({ target }: { target: { sheetName: string } }) =>
        Promise.resolve({
          headers: [],
          formulaColumns: [],
          rows: target.sheetName === 'Submittal FF&E' ? ffeRows : archRows,
        })
      );

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockImplementation((k) => {
            if (k === 'submittal-arch') return logSchema;
            if (k === 'submittal-ffe') return ffeLogSchema;
            return undefined;
          }),
          getTargetSchema: vi.fn().mockImplementation((k) => {
            if (k === 'submittal-arch') return targetSchema;
            if (k === 'submittal-ffe') return ffeTargetSchema;
            return undefined;
          }),
        },
        storage: { readRows },
      });

      // idGroup match with whitespace + warning scoping to row 6 only (excluding row 7 and row 8 warnings)
      const byGroup = await service.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'log-filter-1',
        filterBy: 'idGroup',
        values: [' 071200-001 ', '  '],
      });
      expect(byGroup.entries.map((e) => e.rowNumber)).toEqual([6]);
      expect(byGroup.warnings.map((w) => w.rowNumber)).toEqual([6]);

      // Case-insensitive single-string filter on FF&E idGroup ('cg104')
      const ffeByGroup = await service.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: 'log-filter-1',
        filterBy: 'idGroup',
        values: 'cg104',
      });
      expect(ffeByGroup.entries.map((e) => e.rowNumber)).toEqual([10]);
      expect(ffeByGroup.entries[0].document.idGroup).toBe('CG104');

      // idDocument filter
      const byDoc = await service.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'log-filter-1',
        filterBy: 'idDocument',
        values: ['071200-002-1'],
      });
      expect(byDoc.entries.map((e) => e.rowNumber)).toEqual([7]);
      expect(byDoc.warnings.map((w) => w.rowNumber)).toEqual([7]);

      // id filter
      const byId = await service.readLog({
        documentTypeKey: 'submittal-ffe',
        selectedLogId: 'log-filter-1',
        filterBy: 'id',
        values: ['lt108-1-260121-2'],
      });
      expect(byId.entries.map((e) => e.rowNumber)).toEqual([11]);

      // Unkeyable note row has undefined identities and never matches idGroup = '-'
      const fullArch = await service.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'log-filter-1',
      });
      const noteEntry = fullArch.entries.find((e) => e.rowNumber === 8);
      expect(noteEntry?.document.idGroup).toBeUndefined();
      expect(noteEntry?.document.idDocument).toBeUndefined();
      expect(noteEntry?.document.id).toBeUndefined();
      expect(fullArch.warnings.some((w) => w.rowNumber === 8)).toBe(true);

      const dashFilter = await service.readLog({
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'log-filter-1',
        filterBy: 'idGroup',
        values: ['-'],
      });
      expect(dashFilter.entries).toEqual([]);
      expect(dashFilter.warnings).toEqual([]);
    });

    it('fails fast with DocumentLogMissingError, DocumentLogAmbiguousError, and DocumentLogConfigurationError when space and selectedLogId are omitted', async () => {
      const missingService = createService({
        discovery: { searchSpreadsheets: vi.fn().mockResolvedValue([]) },
      }).service;

      await expect(
        missingService.readLog({
          documentTypeKey: 'submittal-arch',
          space: sampleSpace,
        })
      ).rejects.toThrow(DocumentLogMissingError);

      const ambiguousService = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
            { id: 'log-2', name: 'Harborview Hotel Document Log Copy' },
          ]),
        },
      }).service;

      await expect(
        ambiguousService.readLog({
          documentTypeKey: 'submittal-arch',
          space: sampleSpace,
        })
      ).rejects.toThrow(DocumentLogAmbiguousError);

      await expect(
        missingService.readLog({
          documentTypeKey: 'submittal-arch',
        })
      ).rejects.toThrow(DocumentLogConfigurationError);

      await expect(
        missingService.readLog({
          documentTypeKey: 'submittal-arch',
          selectedLogId: '   ',
        })
      ).rejects.toThrow(DocumentLogConfigurationError);
    });
  });

  describe('copyLog', () => {
    it('ensures preferredFolderPath, evaluates copyNameTemplate, copies templateSpreadsheetId, and returns created: true when log is missing', async () => {
      const ensureFolderPath = vi.fn().mockResolvedValue({
        id: 'admin-folder-1',
        name: '1 Admin',
      });
      const copiedCandidate = {
        id: 'copied-log-1',
        name: 'Harborview Hotel Document Log',
        parents: ['admin-folder-1'],
        webViewLink: 'https://docs.google.com/spreadsheets/d/copied-log-1/edit',
      };
      const copyFile = vi.fn().mockResolvedValue(copiedCandidate);

      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
          ensureFolderPath,
          copyFile,
        },
      });

      const result = await service.copyLog(sampleSpace);

      expect(ensureFolderPath).toHaveBeenCalledWith(sampleSpace.abstractStorageId, ['1 Admin']);
      expect(copyFile).toHaveBeenCalledWith('template-123', {
        targetFolderId: 'admin-folder-1',
        newName: 'Harborview Hotel Document Log',
      });
      expect(result).toEqual({
        created: true,
        candidate: copiedCandidate,
        folderPath: '1 Admin',
      });
    });

    it('is idempotent when resolveLog returns resolved and does not call ensureFolderPath or copyFile', async () => {
      const existingCandidate = {
        id: 'existing-log-1',
        name: 'Harborview Hotel Document Log',
        parents: ['admin-folder-1'],
        webViewLink: 'https://docs.google.com/spreadsheets/d/existing-log-1/edit',
      };
      const ensureFolderPath = vi.fn();
      const copyFile = vi.fn();

      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([existingCandidate]),
          ensureFolderPath,
          copyFile,
        },
      });

      const result = await service.copyLog(sampleSpace);

      expect(ensureFolderPath).not.toHaveBeenCalled();
      expect(copyFile).not.toHaveBeenCalled();
      expect(result).toEqual({
        created: false,
        candidate: existingCandidate,
        folderPath: '1 Admin',
      });
    });

    it('is idempotent when resolveLog returns ambiguous and returns the ranked best candidate without copying', async () => {
      const preferredFolderId = 'admin-folder-1';
      const bestCandidate = {
        id: 'log-best',
        name: 'Harborview Hotel Document Log',
        parents: [preferredFolderId],
        modifiedTime: '2026-03-01T10:00:00.000Z',
      };
      const otherCandidate = {
        id: 'log-other',
        name: 'Harborview Hotel Document Log (Old)',
        parents: ['other-folder'],
        modifiedTime: '2026-04-01T10:00:00.000Z',
      };
      const ensureFolderPath = vi.fn();
      const copyFile = vi.fn();

      const { service } = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([otherCandidate, bestCandidate]),
          resolveFolderPath: vi.fn().mockResolvedValue({
            id: preferredFolderId,
            name: '1 Admin',
          }),
          ensureFolderPath,
          copyFile,
        },
      });

      const result = await service.copyLog(sampleSpace);

      expect(ensureFolderPath).not.toHaveBeenCalled();
      expect(copyFile).not.toHaveBeenCalled();
      expect(result).toEqual({
        created: false,
        candidate: bestCandidate,
        folderPath: '1 Admin',
      });
    });

    it('honors space-type preferredFolderPath override with multi-segment path', async () => {
      const overrideConfig: DocumentLogDiscoveryConfig = {
        ...discoveryConfig,
        preferredFolderPath: 'Admin/Logs',
        copyNameTemplate: '{{DocumentSpace.name}} Proposal Log',
      };
      const ensureFolderPath = vi.fn().mockResolvedValue({
        id: 'nested-logs-folder',
        name: 'Logs',
      });
      const copiedCandidate = {
        id: 'copied-proposal-log',
        name: 'Harborview Hotel Proposal Log',
        parents: ['nested-logs-folder'],
      };
      const copyFile = vi.fn().mockResolvedValue(copiedCandidate);

      const { service } = createService({
        registry: {
          getDiscoveryConfig: vi.fn().mockReturnValue(overrideConfig),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
          ensureFolderPath,
          copyFile,
        },
      });

      const result = await service.copyLog(sampleSpace);

      expect(ensureFolderPath).toHaveBeenCalledWith(sampleSpace.abstractStorageId, ['Admin', 'Logs']);
      expect(copyFile).toHaveBeenCalledWith('template-123', {
        targetFolderId: 'nested-logs-folder',
        newName: 'Harborview Hotel Proposal Log',
      });
      expect(result).toEqual({
        created: true,
        candidate: copiedCandidate,
        folderPath: 'Admin/Logs',
      });
    });

    it('throws DocumentLogConfigurationError when discovery config, ensureFolderPath, or copyFile is missing', async () => {
      const missingConfigService = createService({
        registry: {
          getDiscoveryConfig: vi.fn().mockReturnValue(undefined),
        },
        discovery: {
          ensureFolderPath: vi.fn(),
          copyFile: vi.fn(),
        },
      }).service;

      await expect(missingConfigService.copyLog(sampleSpace)).rejects.toThrow(
        DocumentLogConfigurationError
      );

      const missingEnsureService = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
          copyFile: vi.fn(),
        },
      }).service;

      await expect(missingEnsureService.copyLog(sampleSpace)).rejects.toThrow(
        DocumentLogConfigurationError
      );

      const missingCopyService = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
          ensureFolderPath: vi.fn(),
        },
      }).service;

      await expect(missingCopyService.copyLog(sampleSpace)).rejects.toThrow(
        DocumentLogConfigurationError
      );
    });

    it('propagates Drive 403 errors from ensureFolderPath or copyFile untouched', async () => {
      const folderForbiddenError = Object.assign(new Error('Insufficient permission for folder'), {
        statusCode: 403,
      });
      const ensureFailureService = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
          ensureFolderPath: vi.fn().mockRejectedValue(folderForbiddenError),
          copyFile: vi.fn(),
        },
      }).service;

      await expect(ensureFailureService.copyLog(sampleSpace)).rejects.toBe(folderForbiddenError);

      const copyForbiddenError = Object.assign(new Error('Insufficient permission to copy'), {
        statusCode: 403,
      });
      const copyFailureService = createService({
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
          ensureFolderPath: vi.fn().mockResolvedValue({ id: 'admin-folder-1', name: '1 Admin' }),
          copyFile: vi.fn().mockRejectedValue(copyForbiddenError),
        },
      }).service;

      await expect(copyFailureService.copyLog(sampleSpace)).rejects.toBe(copyForbiddenError);
    });
  });

  describe('readOptionTables (Ticket #358)', () => {
    const logSchemaWithBindings: DocumentLogSchema = {
      ...logSchema,
      optionBindings: {
        statuses: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Statuses',
          validationRangeName: 'Validation_Submittal_Arch_Statuses',
          endMarker: '---',
          columns: {
            Status: 'key',
          },
        },
        actions: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Actions',
          endMarker: '---',
          columns: {
            Action: 'key',
            Name: 'name',
            Suffix: 'suffix',
            Order: 'order',
          },
        },
      },
    };

    const targetSchemaWithSources: LogTargetDocumentSchema = {
      ...targetSchema,
      optionSources: {
        statuses: { provider: 'document_log', properties: ['key'] },
        actions: { provider: 'document_log', properties: ['key', 'name', 'suffix', 'order'] },
      },
    };

    it('reads all bound _Config option tables in one batched readNamedRanges call, parses order-independent Row 0 headers ignoring extra columns, skips blank rows, and deduplicates by trimmed case-insensitive key keeping first row', async () => {
      const readNamedRanges = vi.fn().mockResolvedValue({
        statuses: {
          status: 'found',
          values: [
            ['Notes', 'Status', 'Extra'],
            ['', '', ''],
            ['default', 'Open', '1'],
            ['dup', '  open  ', '2'],
            ['done', 'Closed', '3'],
            ['', '---', ''],
            ['ignored', 'AfterMarker', '4'],
          ],
        },
        actions: {
          status: 'found',
          values: [
            ['Order', 'Suffix', 'ExtraCol', 'Name', 'Action'],
            ['', '', '', '', ''],
            ['1', '', 'unused', 'Received', 'REC'],
            ['2', '_REF', 'unused', 'Referred', 'REF'],
            ['9', '_DUP', 'unused', 'Duplicate Rec', ' rec '],
            ['6', '_NOC', 'unused', 'No Objections As Corrected', 'NOC'],
            ['---', '', '', '', ''],
          ],
        },
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchemaWithBindings),
          getTargetSchema: vi.fn().mockReturnValue(targetSchemaWithSources),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: {
          readNamedRanges,
        },
      });

      const result = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });

      expect(readNamedRanges).toHaveBeenCalledTimes(1);
      expect(readNamedRanges).toHaveBeenCalledWith({
        spreadsheetId: 'log-1',
        targets: [
          {
            key: 'statuses',
            sheetName: '_Config Submittal Arch',
            rangeName: 'Options_Submittal_Arch_Statuses',
          },
          {
            key: 'actions',
            sheetName: '_Config Submittal Arch',
            rangeName: 'Options_Submittal_Arch_Actions',
          },
        ],
      });

      expect(result).toEqual({
        status: 'ready',
        spreadsheetId: 'log-1',
        tables: {
          statuses: {
            status: 'ready',
            tuples: [{ key: 'Open' }, { key: 'Closed' }],
          },
          actions: {
            status: 'ready',
            tuples: [
              { key: 'REC', name: 'Received', suffix: '', order: '1' },
              { key: 'REF', name: 'Referred', suffix: '_REF', order: '2' },
              { key: 'NOC', name: 'No Objections As Corrected', suffix: '_NOC', order: '6' },
            ],
          },
        },
      });
    });

    it('resolves omitted or stale selectedLogId to top-ranked candidates[0] when ambiguous, while writeLog still rejects ambiguous_log', async () => {
      const readNamedRanges = vi.fn().mockImplementation(async (req: { spreadsheetId: string }) => {
        if (req.spreadsheetId === 'deleted-log-id') {
          throw new LogStorageInaccessibleError('Spreadsheet not found', {
            spreadsheetId: req.spreadsheetId,
            statusCode: 404,
          });
        }
        return {
          statuses: {
            status: 'found',
            values: [['Status'], ['Open'], ['---']],
          },
        };
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchemaWithBindings),
          getTargetSchema: vi.fn().mockReturnValue(targetSchemaWithSources),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-older', name: 'Old Document Log', modifiedTime: '2026-01-01T00:00:00Z' },
            { id: 'log-best', name: 'Harborview Hotel Document Log', modifiedTime: '2026-02-01T00:00:00Z' },
          ]),
        },
        storage: {
          readNamedRanges,
        },
      });

      // Omitted selectedLogId -> candidates[0] ('log-best')
      const omittedRes = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        sourceKeys: ['statuses'],
      });
      expect(omittedRes.status).toBe('ready');
      if (omittedRes.status === 'ready') {
        expect(omittedRes.spreadsheetId).toBe('log-best');
      }

      // Stale selectedLogId -> falls back to candidates[0] ('log-best')
      const staleRes = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'deleted-log-id',
        sourceKeys: ['statuses'],
      });
      expect(staleRes.status).toBe('ready');
      if (staleRes.status === 'ready') {
        expect(staleRes.spreadsheetId).toBe('log-best');
      }

      // Valid selectedLogId -> uses that candidate
      const chosenRes = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'log-older',
        sourceKeys: ['statuses'],
      });
      expect(chosenRes.status).toBe('ready');
      if (chosenRes.status === 'ready') {
        expect(chosenRes.spreadsheetId).toBe('log-older');
      }

      // writeLog without selectedLogId still rejects with DocumentLogAmbiguousError
      await expect(service.writeLog({ document: sampleDoc })).rejects.toThrow(
        DocumentLogAmbiguousError
      );
    });

    it('surfaces per-source config_error on missing Named Range, missing "---" terminator, or missing mapped header while valid siblings remain ready', async () => {
      const readNamedRanges = vi.fn().mockResolvedValue({
        statuses: {
          status: 'missing_range',
          errorMessage: 'Named range "Options_Submittal_Arch_Statuses" not found.',
        },
        actions: {
          status: 'found',
          values: [
            ['Action', 'Name', 'Suffix', 'Order'],
            ['REC', 'Received', '', '1'],
            // Missing '---' terminator!
          ],
        },
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchemaWithBindings),
          getTargetSchema: vi.fn().mockReturnValue(targetSchemaWithSources),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([{ id: 'log-1', name: 'Harborview Hotel Document Log' }]),
        },
        storage: { readNamedRanges },
      });

      const res = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });
      expect(res.status).toBe('ready');
      if (res.status === 'ready') {
        expect(res.tables.statuses.status).toBe('config_error');
        expect(res.tables.actions.status).toBe('config_error');
        if (res.tables.actions.status === 'config_error') {
          expect(res.tables.actions.errorMessage).toMatch(/---/);
        }
      }

      // Sibling valid while another has missing mapped header
      readNamedRanges.mockResolvedValueOnce({
        statuses: {
          status: 'found',
          values: [['Status'], ['Open'], ['---']],
        },
        actions: {
          status: 'found',
          values: [['Action', 'Name', 'Order'], ['REC', 'Received', '1'], ['---']],
        },
      });

      const partialRes = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });
      expect(partialRes.status).toBe('ready');
      if (partialRes.status === 'ready') {
        expect(partialRes.tables.statuses).toEqual({
          status: 'ready',
          tuples: [{ key: 'Open' }],
        });
        expect(partialRes.tables.actions.status).toBe('config_error');
      }
    });

    it('returns missing_space and missing_log cleanly', async () => {
      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchemaWithBindings),
          getTargetSchema: vi.fn().mockReturnValue(targetSchemaWithSources),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([]),
        },
      });

      expect(
        await service.readOptionTables({ documentTypeKey: 'submittal-arch' })
      ).toEqual({
        status: 'missing_space',
        tables: {},
      });

      expect(
        await service.readOptionTables({ documentTypeKey: 'submittal-arch', space: sampleSpace })
      ).toEqual({
        status: 'missing_log',
        expectedFolderPath: '1 Admin',
        tables: {},
      });
    });

    it('parses optional aliasesColumn cells as RFC 4180 CSV with "" escaped quotes into tuple.aliases[] and ignores silently when header is absent (Ticket #360)', async () => {
      const logSchemaWithAliases: DocumentLogSchema = {
        ...logSchema,
        optionBindings: {
          contacts: {
            sheetName: '_Config',
            rangeName: 'Options_Contacts',
            endMarker: '---',
            columns: {
              Contact: 'key',
              Name: 'name',
            },
            aliasesColumn: 'Aliases',
          },
          vendors: {
            sheetName: '_Config',
            rangeName: 'Options_Vendors',
            endMarker: '---',
            columns: {
              Vendor: 'key',
              Name: 'name',
            },
            aliasesColumn: 'Aliases',
          },
        },
      };

      const targetSchemaWithContactsAndVendors: LogTargetDocumentSchema = {
        ...targetSchema,
        optionSources: {
          contacts: { provider: 'document_log', properties: ['key', 'name'] },
          vendors: { provider: 'document_log', properties: ['key', 'name'] },
        },
      };

      const readNamedRanges = vi.fn().mockResolvedValue({
        contacts: {
          status: 'found',
          values: [
            ['Contact', 'Name', 'Aliases'],
            ['PMG', 'Pavarini McGovern', '"Pavarini, McGovern", "ACME ""Corp"", Inc.", PCNE, @pavarini.com'],
            ['OBR', "O'Brien Design", '  "O\'Brien, James" , , "" , """OB"" Studio"  '],
            ['NOAL', 'No Aliases Co', '   '],
            ['---', '', ''],
          ],
        },
        vendors: {
          status: 'found',
          values: [
            ['Vendor', 'Name'],
            ['BM', 'Berman Falk'],
            ['---', ''],
          ],
        },
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchemaWithAliases),
          getTargetSchema: vi.fn().mockReturnValue(targetSchemaWithContactsAndVendors),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: {
          readNamedRanges,
        },
      });

      const result = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });

      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.tables.contacts).toEqual({
          status: 'ready',
          tuples: [
            {
              key: 'PMG',
              name: 'Pavarini McGovern',
              aliases: ['Pavarini, McGovern', 'ACME "Corp", Inc.', 'PCNE', '@pavarini.com'],
            },
            {
              key: 'OBR',
              name: "O'Brien Design",
              aliases: ["O'Brien, James", '"OB" Studio'],
            },
            {
              key: 'NOAL',
              name: 'No Aliases Co',
            },
          ],
        });
        expect(result.tables.vendors).toEqual({
          status: 'ready',
          tuples: [{ key: 'BM', name: 'Berman Falk' }],
        });
      }
    });

    it('preserves first-row-wins properties while concatenating and deduplicating aliases across duplicate canonical key rows (Ticket #388)', async () => {
      const logSchemaWithSpecsAndContacts: DocumentLogSchema = {
        ...logSchema,
        optionBindings: {
          specs: {
            sheetName: '_Config Submittal FFE',
            rangeName: 'Options_Submittal_FFE_Specs',
            endMarker: '---',
            columns: {
              Tag: 'key',
              Title: 'name',
            },
            aliasesColumn: 'Aliases',
          },
          contacts: {
            sheetName: '_Config Submittal FFE',
            rangeName: 'Options_Submittal_FFE_Contacts',
            endMarker: '---',
            columns: {
              Key: 'key',
              Name: 'name',
            },
            aliasesColumn: 'Aliases',
          },
        },
      };

      const targetSchemaWithSpecsAndContacts: LogTargetDocumentSchema = {
        ...targetSchema,
        optionSources: {
          specs: { provider: 'document_log', properties: ['key', 'name'] },
          contacts: { provider: 'document_log', properties: ['key', 'name'] },
        },
      };

      const readNamedRanges = vi.fn().mockResolvedValue({
        specs: {
          status: 'found',
          values: [
            ['Tag', 'Title', 'Aliases'],
            ['CG104', 'BED - KING', 'King Bed, king bed, "Royal, Bed"'],
            ['  cg104 ', 'BED - KING ALT TITLE', '  KING BED , Canopy Bed, "Royal, Bed", @king.com'],
            ['CG105', 'NIGHTSTAND', ''],
            ['CG105', 'NIGHTSTAND SECOND', 'Bedside Table, bedside table'],
            ['---', '', ''],
          ],
        },
        contacts: {
          status: 'found',
          values: [
            ['Key', 'Name'],
            ['PMG', 'Pavarini McGovern'],
            [' pmg ', 'Pavarini Duplicate'],
            ['---', ''],
          ],
        },
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchemaWithSpecsAndContacts),
          getTargetSchema: vi.fn().mockReturnValue(targetSchemaWithSpecsAndContacts),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: {
          readNamedRanges,
        },
      });

      const result = await service.readOptionTables({
        documentTypeKey: 'submittal-ffe',
        space: sampleSpace,
      });

      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.tables.specs).toEqual({
          status: 'ready',
          tuples: [
            {
              key: 'CG104',
              name: 'BED - KING',
              aliases: ['King Bed', 'Royal, Bed', 'Canopy Bed', '@king.com'],
            },
            {
              key: 'CG105',
              name: 'NIGHTSTAND',
              aliases: ['Bedside Table'],
            },
          ],
        });
        expect(result.tables.contacts).toEqual({
          status: 'ready',
          tuples: [{ key: 'PMG', name: 'Pavarini McGovern' }],
        });
      }
    });

    it('handles unbalanced RFC 4180 quotes in Aliases cells safely without throwing across single and duplicate rows (Ticket #388)', async () => {
      const logSchemaWithSpecs: DocumentLogSchema = {
        ...logSchema,
        optionBindings: {
          specs: {
            sheetName: '_Config Submittal FFE',
            rangeName: 'Options_Submittal_FFE_Specs',
            endMarker: '---',
            columns: {
              Tag: 'key',
              Title: 'name',
            },
            aliasesColumn: 'Aliases',
          },
        },
      };

      const targetSchemaWithSpecs: LogTargetDocumentSchema = {
        ...targetSchema,
        optionSources: {
          specs: { provider: 'document_log', properties: ['key', 'name'] },
        },
      };

      const readNamedRanges = vi.fn().mockResolvedValue({
        specs: {
          status: 'found',
          values: [
            ['Tag', 'Title', 'Aliases'],
            ['UNBAL1', 'First', '"Unclosed, Phrase'],
            ['UNBAL2', 'Second', 'Valid One, "Unclosed Second'],
            ['UNBAL3', 'Third', '"'],
            ['UNBAL4', 'Fourth', 'Acme "Corp, Trailing"'],
            [' unbal4 ', 'Fourth Dup', 'acme "corp, """'],
            ['---', '', ''],
          ],
        },
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(logSchemaWithSpecs),
          getTargetSchema: vi.fn().mockReturnValue(targetSchemaWithSpecs),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-1', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: {
          readNamedRanges,
        },
      });

      const result = await service.readOptionTables({
        documentTypeKey: 'submittal-ffe',
        space: sampleSpace,
      });

      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.tables.specs).toEqual({
          status: 'ready',
          tuples: [
            { key: 'UNBAL1', name: 'First', aliases: ['Unclosed, Phrase'] },
            { key: 'UNBAL2', name: 'Second', aliases: ['Valid One', 'Unclosed Second'] },
            { key: 'UNBAL3', name: 'Third' },
            { key: 'UNBAL4', name: 'Fourth', aliases: ['Acme "Corp', 'Trailing"', '"'] },
          ],
        });
      }
    });
  });

  describe('READ_LOG live _Config hydration & partial_hydration (Ticket #359)', () => {
    const dynamicLogSchema: DocumentLogSchema = {
      ...logSchema,
      optionBindings: {
        statuses: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Statuses',
          endMarker: '---',
          columns: { Status: 'key' },
        },
        actions: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Actions',
          endMarker: '---',
          columns: { Action: 'key', Name: 'name', Suffix: 'suffix', Order: 'order' },
        },
      },
    };

    const dynamicTargetSchema: LogTargetDocumentSchema = {
      ...targetSchema,
      options: {
        contacts: [{ key: 'MB', name: 'Meridian Builders' }],
      },
      optionSources: {
        statuses: { provider: 'document_log', properties: ['key'] },
        actions: { provider: 'document_log', properties: ['key', 'name', 'suffix', 'order'] },
      },
    };

    it('hydrates restricted dynamic LookupFields from live _Config tables, computes Identity from live tuple properties, and flags partial_hydration on invalid historical values', async () => {
      const readNamedRanges = vi.fn().mockResolvedValue({
        statuses: {
          status: 'found',
          values: [['Status'], ['Open'], ['Closed'], ['---']],
        },
        actions: {
          status: 'found',
          values: [
            ['Action', 'Name', 'Suffix', 'Order'],
            ['CUST', 'Custom Action', '_CUST', '9'],
            ['---', '', '', ''],
          ],
        },
      });

      const readRows = vi.fn().mockResolvedValue({
        headers: ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
        formulaColumns: [],
        rows: [
          {
            rowNumber: 6,
            values: {
              Status: 'Open',
              Section: '071200',
              Number: '001',
              Revision: '0',
              Title: 'Waterproofing',
              Date: '260204',
              Contact: 'MB',
              Action: 'Custom Action',
              Notes: '',
            },
          },
          {
            rowNumber: 7,
            values: {
              Status: 'LegacyStatus',
              Section: '071200',
              Number: '001',
              Revision: '1',
              Title: 'Waterproofing',
              Date: '260205',
              Contact: 'MB',
              Action: 'Approved',
              Notes: '',
            },
          },
        ],
      });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(dynamicLogSchema),
          getTargetSchema: vi.fn().mockReturnValue(dynamicTargetSchema),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-live-359', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: {
          readRows,
          readNamedRanges,
        },
      });

      const readRes = await service.readLog({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
      });

      expect(readNamedRanges).toHaveBeenCalledTimes(1);
      expect(readRes.entries).toHaveLength(2);

      // Row 6 matched live _Config tuple (including custom order '9' and suffix '_CUST')
      expect(readRes.entries[0].valid).toBe(true);
      expect(readRes.entries[0].document.data.action).toEqual({
        key: 'CUST',
        name: 'Custom Action',
        suffix: '_CUST',
        order: '9',
      });
      expect(readRes.entries[0].document.id).toBe('071200-001-0-260204-9');

      // Row 7 failed both restricted dynamic LookupFields ('status' and 'action')
      expect(readRes.entries[1].valid).toBe(false);
      expect(readRes.entries[1].document.data.status).toEqual({ key: 'LegacyStatus' });
      expect(readRes.entries[1].document.data.action).toEqual({ key: 'Approved', name: 'Approved' });
      expect(readRes.warnings).toHaveLength(2);
      expect(readRes.warnings.map((w) => ({ row: w.rowNumber, field: w.field }))).toEqual([
        { row: 7, field: 'status' },
        { row: 7, field: 'action' },
      ]);

      // queryUiContext surfaces partial_hydration
      const uiCtx = await service.queryUiContext({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        formData: { section: '071200', number: '001' },
      });
      expect(uiCtx?.readStatus).toBe('partial_hydration');
      expect(uiCtx?.warningMessages).toHaveLength(2);
    });

    it('shares one batched readNamedRanges call across concurrent readOptionTables and readLog when memoizeResolvePerInstance is enabled', async () => {
      const readNamedRanges = vi.fn().mockResolvedValue({
        statuses: { status: 'found', values: [['Status'], ['Open'], ['---']] },
        actions: { status: 'found', values: [['Action', 'Name', 'Suffix', 'Order'], ['REC', 'Received', '', '1'], ['---', '', '', '']] },
      });
      const readRows = vi.fn().mockResolvedValue({
        headers: ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
        formulaColumns: [],
        rows: [
          {
            rowNumber: 6,
            values: {
              Status: 'Open',
              Section: '071200',
              Number: '001',
              Revision: '0',
              Title: 'Waterproofing',
              Date: '260204',
              Contact: 'MB',
              Action: 'REC',
              Notes: '',
            },
          },
        ],
      });

      const registry: LogSchemaRegistryPort = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getDiscoveryConfig: vi.fn().mockReturnValue(discoveryConfig),
        getDocumentLogSchema: vi.fn().mockReturnValue(dynamicLogSchema),
        getTargetSchema: vi.fn().mockReturnValue(dynamicTargetSchema),
      };
      const discovery: LogDiscoveryPort = {
        searchSpreadsheets: vi.fn().mockResolvedValue([
          { id: 'log-memo-359', name: 'Harborview Hotel Document Log' },
        ]),
      };
      const storage: LogStoragePort = {
        insertRow: vi.fn(),
        readRows,
        readNamedRanges,
      };
      const service = new DocumentLogService(
        registry,
        discovery,
        storage,
        new HandlebarsAdapter(),
        undefined,
        { memoizeResolvePerInstance: true }
      );

      const [tablesRes, readRes] = await Promise.all([
        service.readOptionTables({ documentTypeKey: 'submittal-arch', space: sampleSpace }),
        service.readLog({ documentTypeKey: 'submittal-arch', space: sampleSpace }),
      ]);

      expect(tablesRes.status).toBe('ready');
      expect(readRes.entries[0].valid).toBe(true);
      expect(readNamedRanges).toHaveBeenCalledTimes(1);
    });
  });

  describe('readOptionTables selectedLogId fast-path & inaccessible-storage seam (Ticket #411)', () => {
    const bindingsSchema: DocumentLogSchema = {
      ...logSchema,
      optionBindings: {
        statuses: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Statuses',
          endMarker: '---',
          columns: { Status: 'key' },
        },
      },
    };

    const sourcesSchema: LogTargetDocumentSchema = {
      ...targetSchema,
      optionSources: {
        statuses: { provider: 'document_log', properties: ['key'] },
      },
    };

    it('reads directly via selectedLogId with zero Drive discovery calls, including cross-space selectedLogId trust', async () => {
      const readNamedRanges = vi.fn().mockResolvedValue({
        statuses: { status: 'found', values: [['Status'], ['Open'], ['---']] },
      });
      const searchSpreadsheets = vi.fn();
      const getFile = vi.fn();

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(bindingsSchema),
          getTargetSchema: vi.fn().mockReturnValue(sourcesSchema),
        },
        discovery: { searchSpreadsheets, getFile },
        storage: { readNamedRanges },
      });

      const otherSpace: DocumentLogSpace = {
        id: 'space-b',
        typeId: 'projects',
        name: 'Other Project',
        abstractStorageId: 'drive-b',
      };

      const res = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: otherSpace,
        selectedLogId: '  log-from-space-a  ',
      });

      expect(res).toEqual({
        status: 'ready',
        spreadsheetId: 'log-from-space-a',
        tables: {
          statuses: { status: 'ready', tuples: [{ key: 'Open' }] },
        },
      });
      expect(readNamedRanges).toHaveBeenCalledTimes(1);
      expect(readNamedRanges).toHaveBeenCalledWith({
        spreadsheetId: 'log-from-space-a',
        targets: [
          {
            key: 'statuses',
            sheetName: '_Config Submittal Arch',
            rangeName: 'Options_Submittal_Arch_Statuses',
          },
        ],
      });
      expect(searchSpreadsheets).not.toHaveBeenCalled();
      expect(getFile).not.toHaveBeenCalled();
    });

    it('falls back once to resolveLog(space) on LogStorageInaccessibleError, picking candidates[0] on ambiguous and returning missing_log when missing', async () => {
      const readNamedRanges = vi.fn().mockImplementation(async (req: { spreadsheetId: string }) => {
        if (req.spreadsheetId === 'stale-1' || req.spreadsheetId === 'stale-missing') {
          throw new LogStorageInaccessibleError('Not found', {
            spreadsheetId: req.spreadsheetId,
            statusCode: 404,
          });
        }
        if (req.spreadsheetId === 'fallback-also-inaccessible') {
          throw new LogStorageInaccessibleError('Forbidden', {
            spreadsheetId: req.spreadsheetId,
            statusCode: 403,
          });
        }
        return {
          statuses: { status: 'found', values: [['Status'], ['Recovered'], ['---']] },
        };
      });

      const searchSpreadsheets = vi
        .fn()
        // 1. Ambiguous fallback: stale-1 also appears in candidates[1], must still pick candidates[0]
        .mockResolvedValueOnce([
          { id: 'stale-1', name: 'Old Copy Document Log', modifiedTime: '2026-01-01T00:00:00Z' },
          { id: 'cand-0-best', name: 'Harborview Hotel Document Log', modifiedTime: '2026-02-01T00:00:00Z' },
        ])
        // 2. Missing fallback
        .mockResolvedValueOnce([])
        // 3. Fallback spreadsheet itself inaccessible -> fail without second fallback
        .mockResolvedValueOnce([
          { id: 'fallback-also-inaccessible', name: 'Harborview Hotel Document Log' },
        ]);

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(bindingsSchema),
          getTargetSchema: vi.fn().mockReturnValue(sourcesSchema),
        },
        discovery: { searchSpreadsheets },
        storage: { readNamedRanges },
      });

      const recovered = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'stale-1',
      });
      expect(recovered).toEqual({
        status: 'ready',
        spreadsheetId: 'cand-0-best',
        tables: { statuses: { status: 'ready', tuples: [{ key: 'Recovered' }] } },
      });

      const missingRes = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: { ...sampleSpace, abstractStorageId: 'drive-missing' },
        selectedLogId: 'stale-missing',
      });
      expect(missingRes).toEqual({
        status: 'missing_log',
        expectedFolderPath: '1 Admin',
        tables: {},
      });

      await expect(
        service.readOptionTables({
          documentTypeKey: 'submittal-arch',
          space: { ...sampleSpace, abstractStorageId: 'drive-broken-fallback' },
          selectedLogId: 'stale-1',
        })
      ).rejects.toBeInstanceOf(LogStorageInaccessibleError);
      expect(searchSpreadsheets).toHaveBeenCalledTimes(3);
    });

    it('propagates non-inaccessible errors without calling resolveLog(space)', async () => {
      const searchSpreadsheets = vi.fn();
      const readNamedRanges = vi
        .fn()
        .mockRejectedValueOnce(new DocumentLogError('Rate limit exceeded'))
        .mockRejectedValueOnce(new DocumentLogConfigurationError('Bad config'))
        .mockRejectedValueOnce(new Error('ECONNRESET'));

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(bindingsSchema),
          getTargetSchema: vi.fn().mockReturnValue(sourcesSchema),
        },
        discovery: { searchSpreadsheets },
        storage: { readNamedRanges },
      });

      await expect(
        service.readOptionTables({
          documentTypeKey: 'submittal-arch',
          space: sampleSpace,
          selectedLogId: 'log-1',
        })
      ).rejects.toThrow('Rate limit exceeded');

      await expect(
        service.readOptionTables({
          documentTypeKey: 'submittal-arch',
          space: sampleSpace,
          selectedLogId: 'log-1',
        })
      ).rejects.toBeInstanceOf(DocumentLogConfigurationError);

      await expect(
        service.readOptionTables({
          documentTypeKey: 'submittal-arch',
          space: sampleSpace,
          selectedLogId: 'log-1',
        })
      ).rejects.toThrow('ECONNRESET');

      expect(searchSpreadsheets).not.toHaveBeenCalled();
    });

    it('guards against repeating the storage read when resolveLog(space) returns the same spreadsheet ID', async () => {
      const readNamedRanges = vi.fn().mockRejectedValue(
        new LogStorageInaccessibleError('Forbidden', { spreadsheetId: 'same-id', statusCode: 403 })
      );
      const searchSpreadsheets = vi.fn().mockResolvedValue([
        { id: 'same-id', name: 'Harborview Hotel Document Log' },
      ]);

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(bindingsSchema),
          getTargetSchema: vi.fn().mockReturnValue(sourcesSchema),
        },
        discovery: { searchSpreadsheets },
        storage: { readNamedRanges },
      });

      await expect(
        service.readOptionTables({
          documentTypeKey: 'submittal-arch',
          space: sampleSpace,
          selectedLogId: 'same-id',
        })
      ).rejects.toBeInstanceOf(LogStorageInaccessibleError);

      expect(readNamedRanges).toHaveBeenCalledTimes(1);
      expect(searchSpreadsheets).toHaveBeenCalledTimes(1);
    });

    it('memoizes stale selectedLogId fallback per DocumentLogService instance, shares concurrent calls, and invalidates on copyLog', async () => {
      const readNamedRanges = vi.fn().mockImplementation(async (req: { spreadsheetId: string }) => {
        if (req.spreadsheetId === 'stale-memo-1') {
          throw new LogStorageInaccessibleError('Not found', {
            spreadsheetId: 'stale-memo-1',
            statusCode: 404,
          });
        }
        return {
          statuses: {
            status: 'found',
            values: [['Status'], [`From:${req.spreadsheetId}`], ['---']],
          },
        };
      });

      let resolveSearch!: (val: Array<{ id: string; name: string }>) => void;
      const firstSearchPromise = new Promise<Array<{ id: string; name: string }>>((resolve) => {
        resolveSearch = resolve;
      });
      const searchSpreadsheets = vi
        .fn()
        .mockReturnValueOnce(firstSearchPromise)
        .mockResolvedValue([{ id: 'copied-log-2', name: 'Harborview Hotel Document Log' }]);

      const ensureFolderPath = vi.fn().mockResolvedValue({ id: 'folder-admin', name: '1 Admin' });
      const copyFile = vi.fn().mockResolvedValue({
        id: 'copied-log-2',
        name: 'Harborview Hotel Document Log',
      });

      const registry: LogSchemaRegistryPort = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getDiscoveryConfig: vi.fn().mockReturnValue(discoveryConfig),
        getDocumentLogSchema: vi.fn().mockReturnValue(bindingsSchema),
        getTargetSchema: vi.fn().mockReturnValue(sourcesSchema),
      };
      const discovery: LogDiscoveryPort = { searchSpreadsheets, ensureFolderPath, copyFile };
      const storage: LogStoragePort = { insertRow: vi.fn(), readRows: vi.fn(), readNamedRanges };

      // Default memoizeResolvePerInstance = false -> fallback resolution is STILL memoized per instance
      const service = new DocumentLogService(
        registry,
        discovery,
        storage,
        new HandlebarsAdapter()
      );

      const p1 = service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'stale-memo-1',
      });
      const p2 = service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'stale-memo-1',
      });

      // Allow both fast-path reads to reject before resolving discovery
      await Promise.resolve();
      await Promise.resolve();
      resolveSearch([{ id: 'fallback-log-1', name: 'Harborview Hotel Document Log' }]);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toMatchObject({ status: 'ready', spreadsheetId: 'fallback-log-1' });
      expect(r2).toMatchObject({ status: 'ready', spreadsheetId: 'fallback-log-1' });
      expect(searchSpreadsheets).toHaveBeenCalledTimes(1);

      const callsBeforeSeq = readNamedRanges.mock.calls.length;
      const r3 = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: sampleSpace,
        selectedLogId: 'stale-memo-1',
      });
      expect(r3).toMatchObject({ status: 'ready', spreadsheetId: 'fallback-log-1' });
      // Sequential call skips both stale-memo-1 read AND resolveLog!
      expect(searchSpreadsheets).toHaveBeenCalledTimes(1);
      expect(readNamedRanges).toHaveBeenCalledTimes(callsBeforeSeq + 1);
      expect(readNamedRanges).toHaveBeenLastCalledWith(
        expect.objectContaining({ spreadsheetId: 'fallback-log-1' })
      );

      // Copy Log on a missing space invalidates fallback memo for that space
      const missingSpace: DocumentLogSpace = {
        id: 'sp-copy',
        typeId: 'projects',
        name: 'Copy Test',
        abstractStorageId: 'drive-copy',
      };
      searchSpreadsheets.mockResolvedValueOnce([]); // fallback for stale-missing-copy -> missing
      const beforeCopy = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: missingSpace,
        selectedLogId: 'stale-memo-1',
      });
      expect(beforeCopy.status).toBe('missing_log');

      searchSpreadsheets.mockResolvedValueOnce([]); // copyLog -> resolveLog -> missing -> copies file
      await service.copyLog(missingSpace);

      const afterCopy = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        space: missingSpace,
        selectedLogId: 'stale-memo-1',
      });
      expect(afterCopy).toMatchObject({ status: 'ready', spreadsheetId: 'copied-log-2' });
    });

    it('returns missing_log with zero Drive calls when selectedLogId is inaccessible and space is omitted', async () => {
      const readNamedRanges = vi.fn().mockRejectedValue(
        new LogStorageInaccessibleError('Not found', { spreadsheetId: 'stale-no-space', statusCode: 404 })
      );
      const searchSpreadsheets = vi.fn();

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(bindingsSchema),
          getTargetSchema: vi.fn().mockReturnValue(sourcesSchema),
        },
        discovery: { searchSpreadsheets },
        storage: { readNamedRanges },
      });

      const res = await service.readOptionTables({
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'stale-no-space',
      });

      expect(res).toEqual({
        status: 'missing_log',
        expectedFolderPath: '1 Admin',
        tables: {},
      });
      expect(searchSpreadsheets).not.toHaveBeenCalled();
    });
  });

  describe('writeLog atomic _Config option write-back (Ticket #361)', () => {
    const contactLogSchema: DocumentLogSchema = {
      ...logSchema,
      optionBindings: {
        statuses: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Statuses',
          validationRangeName: 'Validation_Submittal_Arch_Statuses',
          endMarker: '---',
          columns: { Status: 'key' },
        },
        actions: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Actions',
          endMarker: '---',
          columns: { Action: 'key', Name: 'name', Suffix: 'suffix', Order: 'order' },
        },
        contacts: {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Contacts',
          validationRangeName: 'Validation_Submittal_Arch_Contacts',
          endMarker: '---',
          columns: { Contact: 'key', Name: 'name' },
        },
      },
    };

    const contactTargetSchema: LogTargetDocumentSchema = {
      ...targetSchema,
      optionSources: {
        statuses: { provider: 'document_log', properties: ['key'] },
        actions: { provider: 'document_log', properties: ['key', 'name', 'suffix', 'order'] },
        contacts: { provider: 'document_log', properties: ['key', 'name'] },
      },
    };

    it('passes optionWrites and templateSpreadsheetId to logStorage.insertRow for custom allowUserInput options and blank-cell backfills, while coalescing duplicate OptionSource fields', async () => {
      const readNamedRanges = vi.fn().mockResolvedValue({
        statuses: { status: 'found', values: [['Status'], ['Open'], ['---']] },
        actions: { status: 'found', values: [['Action', 'Name', 'Suffix', 'Order'], ['REC', 'Received', '', '1'], ['---']] },
        contacts: {
          status: 'found',
          values: [
            ['Contact', 'Name', 'Contact Type'],
            ['INC', 'INC Architecture and Design', 'INC'],
            ['PARTIAL', '', ''],
            ['---', '', ''],
          ],
        },
      });
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(contactLogSchema),
          getTargetSchema: vi.fn().mockReturnValue(contactTargetSchema),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([
            { id: 'log-361', name: 'Harborview Hotel Document Log' },
          ]),
        },
        storage: { readNamedRanges, insertRow },
      });

      // 1. Custom contact -> optionWrites includes { key: 'Acme Builders', values: { key: 'Acme Builders', name: 'Acme Builders' } }
      await service.writeLog({
        document: {
          ...sampleDoc,
          data: { ...sampleDoc.data, contact: 'Acme Builders' },
        },
      });

      expect(insertRow).toHaveBeenCalledTimes(1);
      expect(insertRow.mock.calls[0][0]).toMatchObject({
        templateSpreadsheetId: 'template-123',
        optionWrites: [
          {
            sheetName: '_Config Submittal Arch',
            rangeName: 'Options_Submittal_Arch_Contacts',
            validationRangeName: 'Validation_Submittal_Arch_Contacts',
            endMarker: '---',
            columns: { Contact: 'key', Name: 'name' },
            items: [
              {
                key: 'Acme Builders',
                values: { key: 'Acme Builders', name: 'Acme Builders' },
              },
            ],
          },
        ],
      });

      // 2. Existing key with blank Name cell: selecting string key must NOT backfill Name with key;
      //    explicitly supplying an object { key, name } DOES backfill Name; fully populated INC -> no optionWrites
      insertRow.mockClear();
      await service.writeLog({
        document: {
          ...sampleDoc,
          data: { ...sampleDoc.data, contact: 'PARTIAL' },
        },
      });
      expect(insertRow.mock.calls[0][0].optionWrites).toBeUndefined();

      insertRow.mockClear();
      await service.writeLog({
        document: {
          ...sampleDoc,
          data: { ...sampleDoc.data, contact: { key: 'PARTIAL', name: 'Partial Builders' } },
        },
      });
      expect(insertRow.mock.calls[0][0].optionWrites).toEqual([
        {
          sheetName: '_Config Submittal Arch',
          rangeName: 'Options_Submittal_Arch_Contacts',
          validationRangeName: 'Validation_Submittal_Arch_Contacts',
          endMarker: '---',
          columns: { Contact: 'key', Name: 'name' },
          items: [
            {
              key: 'PARTIAL',
              values: { key: 'PARTIAL', name: 'Partial Builders' },
            },
          ],
        },
      ]);

      insertRow.mockClear();
      await service.writeLog({
        document: {
          ...sampleDoc,
          data: { ...sampleDoc.data, contact: 'INC' },
        },
      });
      expect(insertRow.mock.calls[0][0].optionWrites).toBeUndefined();
    });

    it('coalesces multiple allowUserInput fields targeting the same OptionSource (e.g. specTag + relatedTag) preferring richer non-blank sibling values', async () => {
      const ffeLogSchema: DocumentLogSchema = {
        ...logSchema,
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        columns: {
          Status: { template: '{{status.key}}' },
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
        },
        optionBindings: {
          specs: {
            sheetName: '_Config Submittal FF&E',
            rangeName: 'Options_Submittal_FFE_Specs',
            validationRangeName: 'Validation_Submittal_FFE_Specs',
            endMarker: '---',
            columns: { 'Spec Tag': 'key', 'Spec Title': 'name' },
          },
        },
      };

      const ffeTargetSchema: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true },
          {
            key: 'specTag',
            name: 'Spec Tag',
            type: 'string',
            required: true,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          {
            key: 'relatedTag',
            name: 'Related Tag',
            type: 'string',
            required: false,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          { key: 'revision', name: 'Revision', type: 'string', required: true },
          {
            key: 'specTitle',
            name: 'Spec Title',
            type: 'string',
            required: true,
            linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
          },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true },
          { key: 'action', name: 'Action', type: 'string', required: true },
        ],
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}',
        },
        optionSources: {
          specs: { provider: 'document_log', properties: ['key', 'name'] },
        },
      };

      const readNamedRanges = vi.fn().mockResolvedValue({
        specs: { status: 'found', values: [['Spec Tag', 'Spec Title'], ['---', '']] },
      });
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(ffeLogSchema),
          getTargetSchema: vi.fn().mockReturnValue(ffeTargetSchema),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([{ id: 'log-ffe', name: 'Harborview Hotel Document Log' }]),
        },
        storage: { readNamedRanges, insertRow },
      });

      await service.writeLog({
        document: {
          type: 'submittal-ffe',
          space: sampleSpace,
          data: {
            status: 'Open',
            specTag: 'XX100',
            relatedTag: 'xx100',
            revision: '0',
            specTitle: 'Custom Lounge Chair',
            date: '260204',
            contact: 'INC',
            action: 'REC',
          },
        },
      });

      expect(insertRow.mock.calls[0][0].optionWrites).toEqual([
        {
          sheetName: '_Config Submittal FF&E',
          rangeName: 'Options_Submittal_FFE_Specs',
          validationRangeName: 'Validation_Submittal_FFE_Specs',
          endMarker: '---',
          columns: { 'Spec Tag': 'key', 'Spec Title': 'name' },
          items: [
            {
              key: 'XX100',
              values: { key: 'XX100', name: 'Custom Lounge Chair' },
            },
          ],
        },
      ]);
    });

    it('writes blank Spec Title for new relatedTag, backfills blank Spec Title on existing key, and allows distinct Spec Tags sharing the same Spec Title', async () => {
      const ffeLogSchema: DocumentLogSchema = {
        ...logSchema,
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        columns: {
          Status: { template: '{{status.key}}' },
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
        },
        optionBindings: {
          specs: {
            sheetName: '_Config Submittal FF&E',
            rangeName: 'Options_Submittal_FFE_Specs',
            validationRangeName: 'Validation_Submittal_FFE_Specs',
            endMarker: '---',
            columns: { 'Spec Tag': 'key', 'Spec Title': 'name' },
          },
        },
      };

      const ffeTargetSchema: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true },
          {
            key: 'specTag',
            name: 'Spec Tag',
            type: 'string',
            required: true,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          {
            key: 'relatedTag',
            name: 'Related Tag',
            type: 'string',
            required: false,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          { key: 'revision', name: 'Revision', type: 'string', required: true },
          {
            key: 'specTitle',
            name: 'Spec Title',
            type: 'string',
            required: true,
            linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
          },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true },
          { key: 'action', name: 'Action', type: 'string', required: true },
        ],
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}',
        },
        optionSources: {
          specs: { provider: 'document_log', properties: ['key', 'name'] },
        },
      };

      const readNamedRanges = vi
        .fn()
        // 1. Existing AC102 & FB127, new relatedTag REL-NEW
        .mockResolvedValueOnce({
          specs: {
            status: 'found',
            values: [
              ['Spec Tag', 'Spec Title'],
              ['AC102', 'HOOK'],
              ['FB127', 'FABRIC - LEATHER'],
              ['---', ''],
            ],
          },
        })
        // 2. Existing REL-NEW with blank Spec Title -> backfill
        .mockResolvedValueOnce({
          specs: {
            status: 'found',
            values: [
              ['Spec Tag', 'Spec Title'],
              ['AC102', 'HOOK'],
              ['FB127', 'FABRIC - LEATHER'],
              ['REL-NEW', ''],
              ['---', ''],
            ],
          },
        })
        // 3. New key FB999 sharing 'FABRIC - LEATHER' title with FB127
        .mockResolvedValueOnce({
          specs: {
            status: 'found',
            values: [
              ['Spec Tag', 'Spec Title'],
              ['FB127', 'FABRIC - LEATHER'],
              ['---', ''],
            ],
          },
        });
      const insertRow = vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' });

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(ffeLogSchema),
          getTargetSchema: vi.fn().mockReturnValue(ffeTargetSchema),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([{ id: 'log-ffe', name: 'Harborview Hotel Document Log' }]),
        },
        storage: { readNamedRanges, insertRow },
      });

      // 1. Known specTag + new relatedTag -> only relatedTag written, with blank Spec Title
      await service.writeLog({
        document: {
          type: 'submittal-ffe',
          space: sampleSpace,
          data: {
            status: 'Open',
            specTag: 'AC102',
            relatedTag: 'REL-NEW',
            revision: '0',
            specTitle: 'HOOK',
            date: '260204',
            contact: 'INC',
            action: 'REC',
          },
        },
      });
      expect(insertRow.mock.calls[0][0].optionWrites).toEqual([
        expect.objectContaining({
          rangeName: 'Options_Submittal_FFE_Specs',
          items: [{ key: 'REL-NEW', values: { key: 'REL-NEW' } }],
        }),
      ]);

      // 2. Later submittal with specTag='rel-new' + non-blank specTitle -> backfills Spec Title
      await service.writeLog({
        document: {
          type: 'submittal-ffe',
          space: sampleSpace,
          data: {
            status: 'Open',
            specTag: 'rel-new',
            revision: '0',
            specTitle: 'Backfilled Related Spec',
            date: '260205',
            contact: 'INC',
            action: 'REC',
          },
        },
      });
      expect(insertRow.mock.calls[1][0].optionWrites).toEqual([
        expect.objectContaining({
          rangeName: 'Options_Submittal_FFE_Specs',
          items: [{ key: 'REL-NEW', values: { key: 'REL-NEW', name: 'Backfilled Related Spec' } }],
        }),
      ]);

      // 3. Distinct Spec Tag FB999 sharing 'FABRIC - LEATHER' title with FB127 -> allowed as new row
      await service.writeLog({
        document: {
          type: 'submittal-ffe',
          space: sampleSpace,
          data: {
            status: 'Open',
            specTag: 'FB999',
            revision: '0',
            specTitle: 'FABRIC - LEATHER',
            date: '260206',
            contact: 'INC',
            action: 'REC',
          },
        },
      });
      expect(insertRow.mock.calls[2][0].optionWrites).toEqual([
        expect.objectContaining({
          rangeName: 'Options_Submittal_FFE_Specs',
          items: [{ key: 'FB999', values: { key: 'FB999', name: 'FABRIC - LEATHER' } }],
        }),
      ]);
    });

    it('fails fast with config_error before logStorage.insertRow if a target option table lacks "---"', async () => {
      const readNamedRanges = vi.fn().mockResolvedValue({
        statuses: { status: 'found', values: [['Status'], ['Open'], ['---']] },
        actions: { status: 'found', values: [['Action', 'Name', 'Suffix', 'Order'], ['REC', 'Received', '', '1'], ['---']] },
        contacts: {
          status: 'found',
          values: [
            ['Contact', 'Name', 'Contact Type'],
            ['INC', 'INC Architecture and Design', 'INC'],
            // Missing '---' terminator!
          ],
        },
      });
      const insertRow = vi.fn();

      const { service } = createService({
        registry: {
          getDocumentLogSchema: vi.fn().mockReturnValue(contactLogSchema),
          getTargetSchema: vi.fn().mockReturnValue(contactTargetSchema),
        },
        discovery: {
          searchSpreadsheets: vi.fn().mockResolvedValue([{ id: 'log-361', name: 'Harborview Hotel Document Log' }]),
        },
        storage: { readNamedRanges, insertRow },
      });

      await expect(
        service.writeLog({
          document: {
            ...sampleDoc,
            data: { ...sampleDoc.data, contact: 'NewContact' },
          },
        })
      ).rejects.toThrow(/config_error.*---/i);

      expect(insertRow).not.toHaveBeenCalled();
    });
  });
});

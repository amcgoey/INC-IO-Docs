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

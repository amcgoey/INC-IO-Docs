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
  });
});

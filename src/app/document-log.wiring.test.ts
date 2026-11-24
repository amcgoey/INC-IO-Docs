import { describe, it, expect, vi, afterEach } from 'vitest';
import nock from 'nock';
import { createDocumentLogWiring } from './document-log.wiring';
import type { RawManifestProviderPort } from '../features/document-log';
import type { SheetsClient } from '../infrastructure/sheets';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';

describe('document-log.wiring', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  const createManifestProvider = (): RawManifestProviderPort => ({
    getRawManifest: vi.fn().mockResolvedValue({
      documentTypes: ['./document-types/submittal-arch.json'],
      configuration: {
        documentLog: {
          preferredFolderPath: '1 Admin',
          fileNameContains: 'Document Log',
          excludePrefixes: ['Copy of '],
          excludeSubstrings: ['Template'],
          templateSpreadsheetId: 'tmpl-1',
          copyNameTemplate: '{{DocumentSpace.name}} Document Log',
        },
      },
    }),
    readParsedSchema: vi.fn().mockResolvedValue({
      key: 'submittal-arch',
      name: 'Submittal Arch',
      documentSchema: {
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
          statuses: [{ key: 'Open' }],
          actions: [{ key: 'REC', name: 'Received', order: '1' }],
          contacts: [{ key: 'PMG', name: 'Pavarini McGovern' }],
        },
      },
      documentLogSchema: {
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
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
      },
    }),
  });

  it('wires LogSchemaRegistryAdapter, default DocumentLogService, and per-request createDocumentLogService with overrides', async () => {
    const mockSheetsClient: SheetsClient = {
      readTable: vi.fn(),
      insertIntoGroupedList: vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' }),
      readNamedRange: vi.fn(),
      writeNamedRange: vi.fn(),
    };
    const mockDriveClient = {
      searchFiles: vi.fn().mockResolvedValue([
        {
          id: 'log-sheet-1',
          name: 'Harborview Hotel Document Log',
          parents: ['admin-folder-1'],
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]),
    } as unknown as GoogleDriveClient;

    const wiring = createDocumentLogWiring({
      manifestProvider: createManifestProvider(),
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
    });

    await wiring.logSchemaRegistry.initialize();

    const doc = {
      type: 'submittal-arch',
      space: {
        id: 'space-1',
        typeId: 'projects',
        name: 'Harborview Hotel',
        abstractStorageId: 'drive-1',
      },
      data: {
        status: 'Open',
        section: '071200',
        number: '001',
        revision: '0',
        title: 'Waterproofing',
        date: '260204',
        contact: 'PMG',
        action: 'REC',
      },
    };

    const result = await wiring.documentLogService.writeLog({
      document: doc,
      fileUri: 'https://drive.google.com/file/d/file-99/view',
    });

    expect(result).toEqual({
      spreadsheetId: 'log-sheet-1',
      sheetName: 'Submittal Arch',
      rowNumber: 6,
      action: 'inserted',
    });
    expect(mockSheetsClient.insertIntoGroupedList).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          spreadsheetId: 'log-sheet-1',
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        rowData: {
          Status: 'Open',
          Section: '071200',
          'Calc Link': {
            formula: '=HYPERLINK("https://drive.google.com/file/d/file-99/view", "Link")',
          },
        },
      })
    );

    // Per-request factory uses context.userOAuthToken and allows per-call overrides
    const overrideSheets: SheetsClient = {
      readTable: vi.fn(),
      insertIntoGroupedList: vi.fn().mockResolvedValue({ rowNumber: 9, action: 'inserted' }),
      readNamedRange: vi.fn(),
      writeNamedRange: vi.fn(),
    };
    const reqService = wiring.createDocumentLogService(
      { userOAuthToken: 'ya29.test-cred' },
      { driveClient: mockDriveClient, sheetsClient: overrideSheets }
    );
    const reqResult = await reqService.writeLog({ document: doc });
    expect(reqResult.rowNumber).toBe(9);
  });

  it('honors options.documentLogService override across default and per-request factory', () => {
    const overrideService = {
      resolveLog: vi.fn(),
      writeLog: vi.fn(),
    };
    const wiring = createDocumentLogWiring({
      manifestProvider: createManifestProvider(),
      documentLogService: overrideService,
    });

    expect(wiring.documentLogService).toBe(overrideService);
    expect(wiring.createDocumentLogService({ userOAuthToken: 'ya29.cred' })).toBe(overrideService);
  });

  it('authenticates per-request Drive and Sheets clients with context.userOAuthToken when no overrides are passed', async () => {
    const wiring = createDocumentLogWiring({
      manifestProvider: createManifestProvider(),
    });
    await wiring.logSchemaRegistry.initialize();

    const perReqCredential = 'ya29.per-request-user-cred';
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    })
      .get('/drive/v3/files')
      .query(true)
      .reply(200, {
        files: [
          {
            id: 'auth-log-1',
            name: 'Harborview Hotel Document Log',
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
        ],
      });

    nock('https://sheets.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    })
      .get('/v4/spreadsheets/auth-log-1')
      .query(true)
      .reply(200, {
        spreadsheetId: 'auth-log-1',
        sheets: [{ properties: { sheetId: 1, title: 'Submittal Arch' } }],
        namedRanges: [
          {
            namedRangeId: 'nr-1',
            name: 'Log_Submittal_Arch',
            range: {
              sheetId: 1,
              startRowIndex: 2,
              endRowIndex: 10,
              startColumnIndex: 0,
              endColumnIndex: 3,
            },
          },
        ],
      });

    nock('https://sheets.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    })
      .get(/\/v4\/spreadsheets\/auth-log-1\/values\/.*/)
      .query(true)
      .reply(200, {
        values: [['Status', 'Section', 'Calc Link'], [], ['<--->'], [], ['<--->']],
      });

    nock('https://sheets.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    })
      .post('/v4/spreadsheets/auth-log-1:batchUpdate')
      .reply(200, {});

    const perRequestService = wiring.createDocumentLogService({
      userOAuthToken: perReqCredential,
    });

    const result = await perRequestService.writeLog({
      document: {
        type: 'submittal-arch',
        space: {
          id: 'space-1',
          typeId: 'projects',
          name: 'Harborview Hotel',
          abstractStorageId: 'drive-1',
        },
        data: {
          status: 'Open',
          section: '071200',
        },
      },
    });

    expect(result).toEqual({
      spreadsheetId: 'auth-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 6,
      action: 'inserted',
    });
    expect(nock.isDone()).toBe(true);
  });
});

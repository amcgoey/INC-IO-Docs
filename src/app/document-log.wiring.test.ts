import { describe, it, expect, vi, afterEach } from 'vitest';
import nock from 'nock';
import { createDocumentLogWiring } from './document-log.wiring';
import {
  DocumentLogAmbiguousError,
  type RawManifestProviderPort,
} from '../features/document-log';
import type { SheetsClient } from '../infrastructure/sheets';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';

describe('document-log.wiring', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  const createManifestProvider = (): RawManifestProviderPort => ({
    getRawManifest: vi.fn().mockResolvedValue({
      documentTypes: ['./document-types/submittal-arch.json'],
      DocumentSpaceTypes: [
        {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: { allowedDocumentTypes: ['submittal-arch'] },
          storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
        },
        {
          id: 'proposals',
          displayName: 'Proposals',
          spaceSchema: { allowedDocumentTypes: ['submittal-arch'] },
          storageConfig: { provider: 'google_drive', fetchMethod: 'folders' },
          documentLog: {
            preferredFolderPath: '00 Admin',
            copyNameTemplate: '{{DocumentSpace.name}} Proposal Document Log',
          },
        },
      ],
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
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
      .reply(200, {
        values: [['Status', 'Section', 'Calc Link'], [], ['<--->'], [], ['<--->']],
      });

    nock('https://sheets.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    })
      .get(/\/v4\/spreadsheets\/auth-log-1\/values\/.*/)
      .query((q) => q.valueRenderOption === 'FORMULA')
      .reply(200, {
        values: [[]],
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

  it('discovers folder-backed space logs with DocumentSpaceTypes overrides over nock without calling resolveFolderPath', async () => {
    const wiring = createDocumentLogWiring({
      manifestProvider: createManifestProvider(),
    });
    await wiring.logSchemaRegistry.initialize();

    const perReqCredential = 'ya29.folder-proposal-cred';
    const driveScope = nock('https://www.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    });

    driveScope
      .get('/drive/v3/files/opp-folder-1')
      .query(true)
      .reply(200, {
        id: 'opp-folder-1',
        name: 'Tower Proposal',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'marketing-sd',
      });

    driveScope
      .get('/drive/v3/files')
      .query(
        (queryObj) =>
          queryObj.driveId === 'marketing-sd' &&
          queryObj.corpora === 'drive' &&
          typeof queryObj.q === 'string' &&
          queryObj.q.includes('application/vnd.google-apps.spreadsheet')
      )
      .reply(200, {
        files: [
          {
            id: 'opp-log-1',
            name: 'Tower Proposal Document Log',
            parents: ['admin-00'],
            mimeType: 'application/vnd.google-apps.spreadsheet',
            webViewLink: 'https://docs.google.com/spreadsheets/d/opp-log-1/edit',
            modifiedTime: '2026-03-01T10:00:00.000Z',
          },
          {
            id: 'sibling-log-1',
            name: 'Other Proposal Document Log',
            parents: ['other-opp-folder'],
            mimeType: 'application/vnd.google-apps.spreadsheet',
            modifiedTime: '2026-03-02T10:00:00.000Z',
          },
        ],
      });

    driveScope
      .get('/drive/v3/files/admin-00')
      .query(true)
      .reply(200, {
        id: 'admin-00',
        name: '00 Admin',
        parents: ['opp-folder-1'],
        mimeType: 'application/vnd.google-apps.folder',
      });

    driveScope
      .get('/drive/v3/files/other-opp-folder')
      .query(true)
      .reply(200, {
        id: 'other-opp-folder',
        name: 'Other Proposal',
        parents: [],
        mimeType: 'application/vnd.google-apps.folder',
      });

    const perRequestService = wiring.createDocumentLogService({
      userOAuthToken: perReqCredential,
    });

    const resolution = await perRequestService.resolveLog({
      id: 'space-prop-1',
      typeId: 'proposals',
      name: 'Tower',
      abstractStorageId: 'opp-folder-1',
    });

    expect(resolution).toEqual({
      status: 'resolved',
      candidate: {
        id: 'opp-log-1',
        name: 'Tower Proposal Document Log',
        parents: ['admin-00'],
        webViewLink: 'https://docs.google.com/spreadsheets/d/opp-log-1/edit',
        modifiedTime: '2026-03-01T10:00:00.000Z',
      },
      candidates: [
        {
          id: 'opp-log-1',
          name: 'Tower Proposal Document Log',
          parents: ['admin-00'],
          webViewLink: 'https://docs.google.com/spreadsheets/d/opp-log-1/edit',
          modifiedTime: '2026-03-01T10:00:00.000Z',
        },
      ],
    });
    expect(nock.isDone()).toBe(true);
  });

  it('ranks ambiguous Shared Drive candidates across 3 tiers with lazy resolveFolderPath and fails fast on writeLog', async () => {
    const wiring = createDocumentLogWiring({
      manifestProvider: createManifestProvider(),
    });
    await wiring.logSchemaRegistry.initialize();

    const perReqCredential = 'ya29.ranking-cred';
    const driveScope = nock('https://www.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    });

    const matchingFiles = [
      {
        id: 'log-newer-other',
        name: 'Harborview Hotel Document Log (Draft)',
        parents: ['other-folder'],
        mimeType: 'application/vnd.google-apps.spreadsheet',
        modifiedTime: '2026-03-01T10:00:00.000Z',
      },
      {
        id: 'log-in-admin',
        name: 'Harborview Hotel Document Log (Admin)',
        parents: ['admin-folder-1'],
        mimeType: 'application/vnd.google-apps.spreadsheet',
        modifiedTime: '2026-01-01T10:00:00.000Z',
      },
      {
        id: 'log-exact-name',
        name: 'Harborview Hotel Document Log',
        parents: ['other-folder'],
        mimeType: 'application/vnd.google-apps.spreadsheet',
        modifiedTime: '2026-02-01T10:00:00.000Z',
      },
    ];

    const isSpreadsheetSearchQuery = (queryObj: Record<string, unknown>): boolean =>
      queryObj.driveId === 'drive-1' &&
      queryObj.corpora === 'drive' &&
      typeof queryObj.q === 'string' &&
      queryObj.q.includes('application/vnd.google-apps.spreadsheet');

    const isAdminFolderQuery = (queryObj: Record<string, unknown>): boolean =>
      typeof queryObj.q === 'string' &&
      queryObj.q.includes("'drive-1' in parents") &&
      queryObj.q.includes("name = '1 Admin'") &&
      queryObj.q.includes('application/vnd.google-apps.folder');

    // Call 1: resolveLog when '1 Admin' does not exist (none in "1 Admin" -> Tier 2 > Tier 3 modifiedTime)
    driveScope
      .get('/drive/v3/files')
      .query(isSpreadsheetSearchQuery)
      .reply(200, { files: matchingFiles });
    driveScope
      .get('/drive/v3/files')
      .query(isAdminFolderQuery)
      .reply(200, { files: [] });

    // Call 2 & 3: resolveLog and writeLog when '1 Admin' resolves to 'admin-folder-1'
    driveScope
      .get('/drive/v3/files')
      .query(isSpreadsheetSearchQuery)
      .times(2)
      .reply(200, { files: matchingFiles });
    driveScope
      .get('/drive/v3/files')
      .query(isAdminFolderQuery)
      .times(2)
      .reply(200, {
        files: [
          {
            id: 'admin-folder-1',
            name: '1 Admin',
            parents: ['drive-1'],
            mimeType: 'application/vnd.google-apps.folder',
          },
        ],
      });

    const perRequestService = wiring.createDocumentLogService({
      userOAuthToken: perReqCredential,
    });

    const space = {
      id: 'space-proj-1',
      typeId: 'projects',
      name: 'Harborview Hotel',
      abstractStorageId: 'drive-1',
    };

    const unpreferredResolution = await perRequestService.resolveLog(space);
    expect(unpreferredResolution.status).toBe('ambiguous');
    expect(unpreferredResolution.candidates.map((c) => c.id)).toEqual([
      'log-exact-name',
      'log-newer-other',
      'log-in-admin',
    ]);

    const rankedResolution = await perRequestService.resolveLog(space);
    expect(rankedResolution.status).toBe('ambiguous');
    expect(rankedResolution.candidates.map((c) => c.id)).toEqual([
      'log-in-admin',
      'log-exact-name',
      'log-newer-other',
    ]);

    await expect(
      perRequestService.writeLog({
        document: {
          type: 'submittal-arch',
          space,
          data: { status: 'Open', section: '071200' },
        },
      })
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(DocumentLogAmbiguousError);
      const ambiguousErr = err as DocumentLogAmbiguousError;
      expect(ambiguousErr.candidates.map((c) => c.id)).toEqual([
        'log-in-admin',
        'log-exact-name',
        'log-newer-other',
      ]);
      return true;
    });

    expect(nock.isDone()).toBe(true);
  });

  it('falls back to My Drive folder-backed discovery when space.typeId is unregistered', async () => {
    const wiring = createDocumentLogWiring({
      manifestProvider: createManifestProvider(),
    });
    await wiring.logSchemaRegistry.initialize();

    const perReqCredential = 'ya29.mydrive-fallback-cred';
    const driveScope = nock('https://www.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    });

    driveScope
      .get('/drive/v3/files/mydrive-folder-1')
      .query(true)
      .reply(200, {
        id: 'mydrive-folder-1',
        name: 'Riverfront',
        mimeType: 'application/vnd.google-apps.folder',
      });

    driveScope
      .get('/drive/v3/files')
      .query(
        (queryObj) =>
          queryObj.corpora === 'user' &&
          queryObj.driveId === undefined &&
          typeof queryObj.q === 'string' &&
          queryObj.q.includes('application/vnd.google-apps.spreadsheet')
      )
      .reply(200, {
        files: [
          {
            id: 'mydrive-log-1',
            name: 'Riverfront Document Log',
            parents: ['sub-admin-1'],
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
          {
            id: 'other-mydrive-log',
            name: 'Other Document Log',
            parents: ['unrelated-folder-1'],
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
        ],
      });

    driveScope
      .get('/drive/v3/files/sub-admin-1')
      .query(true)
      .reply(200, {
        id: 'sub-admin-1',
        name: '1 Admin',
        parents: ['mydrive-folder-1'],
        mimeType: 'application/vnd.google-apps.folder',
      });

    driveScope
      .get('/drive/v3/files/unrelated-folder-1')
      .query(true)
      .reply(200, {
        id: 'unrelated-folder-1',
        name: 'Other Project',
        parents: ['root'],
        mimeType: 'application/vnd.google-apps.folder',
      });

    const perRequestService = wiring.createDocumentLogService({
      userOAuthToken: perReqCredential,
    });

    const resolution = await perRequestService.resolveLog({
      id: 'space-custom-1',
      typeId: 'custom-unregistered',
      name: 'Riverfront',
      abstractStorageId: 'mydrive-folder-1',
    });

    expect(resolution).toEqual({
      status: 'resolved',
      candidate: {
        id: 'mydrive-log-1',
        name: 'Riverfront Document Log',
        parents: ['sub-admin-1'],
      },
      candidates: [
        {
          id: 'mydrive-log-1',
          name: 'Riverfront Document Log',
          parents: ['sub-admin-1'],
        },
      ],
    });
    expect(nock.isDone()).toBe(true);
  });

  it('ignores ambiguous preferredFolderPath (GoogleDriveAmbiguousPathError) in folder-backed space and ranks by overridden copyNameTemplate & modifiedTime over nock', async () => {
    const wiring = createDocumentLogWiring({
      manifestProvider: createManifestProvider(),
    });
    await wiring.logSchemaRegistry.initialize();

    const perReqCredential = 'ya29.folder-ambiguous-cred';
    const driveScope = nock('https://www.googleapis.com', {
      reqheaders: { authorization: `Bearer ${perReqCredential}` },
    });

    driveScope
      .get('/drive/v3/files/opp-folder-2')
      .query(true)
      .reply(200, {
        id: 'opp-folder-2',
        name: 'Summit',
        mimeType: 'application/vnd.google-apps.folder',
        driveId: 'marketing-sd',
      });

    driveScope
      .get('/drive/v3/files')
      .query(
        (queryObj) =>
          queryObj.driveId === 'marketing-sd' &&
          queryObj.corpora === 'drive' &&
          typeof queryObj.q === 'string' &&
          queryObj.q.includes('application/vnd.google-apps.spreadsheet')
      )
      .reply(200, {
        files: [
          {
            id: 'prop-newer-nonexact',
            name: 'Summit Document Log Draft',
            parents: ['opp-folder-2'],
            mimeType: 'application/vnd.google-apps.spreadsheet',
            modifiedTime: '2026-04-01T10:00:00.000Z',
          },
          {
            id: 'prop-exact-older',
            name: 'summit proposal document log',
            parents: ['opp-folder-2'],
            mimeType: 'application/vnd.google-apps.spreadsheet',
            modifiedTime: '2026-01-01T10:00:00.000Z',
          },
        ],
      });

    // resolveFolderPath for overridden preferredFolderPath '00 Admin' finds 2 folders -> GoogleDriveAmbiguousPathError
    driveScope
      .get('/drive/v3/files')
      .query(
        (queryObj) =>
          typeof queryObj.q === 'string' &&
          queryObj.q.includes("'opp-folder-2' in parents") &&
          queryObj.q.includes("name = '00 Admin'") &&
          queryObj.q.includes('application/vnd.google-apps.folder')
      )
      .reply(200, {
        files: [
          { id: 'admin-dup-1', name: '00 Admin', parents: ['opp-folder-2'] },
          { id: 'admin-dup-2', name: '00 Admin', parents: ['opp-folder-2'] },
        ],
      });

    const perRequestService = wiring.createDocumentLogService({
      userOAuthToken: perReqCredential,
    });

    const resolution = await perRequestService.resolveLog({
      id: 'space-prop-2',
      typeId: 'proposals',
      name: 'Summit',
      abstractStorageId: 'opp-folder-2',
    });

    expect(resolution.status).toBe('ambiguous');
    expect(resolution.candidates.map((c) => c.id)).toEqual([
      'prop-exact-older',
      'prop-newer-nonexact',
    ]);
    expect(nock.isDone()).toBe(true);
  });
});

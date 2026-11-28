import { describe, it, expect, vi, afterEach } from 'vitest';
import nock from 'nock';
import {
  createLookupOptionsService,
  createLookupOptionsWiring,
  createOptionsFetcherAdapter,
  createDocumentDynamicValidationAdapter,
  createCanonicalOptionsProviderAdapter,
} from './lookup-options.wiring';
import { createDocumentLogWiring } from './document-log.wiring';
import type { RawManifestProviderPort } from '../features/document-log';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleSheetsClient } from '../infrastructure/sheets';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';

describe('lookup-options.wiring', () => {
  const manifestProvider = {
    getRawManifest: vi.fn().mockResolvedValue({
      documentTypes: ['./document-types/communication-project.json'],
    }),
    readParsedSchema: vi.fn().mockResolvedValue({
      key: 'communication-project',
      name: 'Communication Project',
      documentSchema: {
        fields: [
          {
            key: 'contact',
            name: 'Contact',
            type: 'string',
            required: true,
            options: {
              source: 'contactFolders',
              key: 'key',
              name: 'name',
              allowUserInput: true,
            },
          },
        ],
        optionSources: {
          contactFolders: {
            provider: 'google_drive',
            method: 'list_folders',
            relativePath: '1 Admin/Communication',
            properties: ['key', 'name'],
          },
        },
      },
    }),
  };

  it('shares one LookupOptionsPort instance per WorkspaceExecutionContext across SchemaDrivenUi, DocumentService, and SourceParser', async () => {
    const listFolders = vi.fn().mockImplementation(async (opts?: { parentFolderId?: string }) => {
      if (opts?.parentFolderId === 'space-1') {
        return { folders: [{ id: 'admin-1', name: '1 Admin' }] };
      }
      if (opts?.parentFolderId === 'admin-1') {
        return { folders: [{ id: 'comm-1', name: 'Communication' }] };
      }
      if (opts?.parentFolderId === 'comm-1') {
        return { folders: [{ id: 'c-1', name: 'Pavarini' }] };
      }
      return { folders: [] };
    });

    const wiring = createLookupOptionsWiring({
      manifestProvider,
      driveClient: { listFolders },
    });

    const context: WorkspaceExecutionContext = { hostApp: 'DRIVE' };

    const canonicalProvider = wiring.createCanonicalOptionsProvider(context);
    const optionsFetcher = wiring.createOptionsFetcher(context);
    const dynamicValidator = wiring.createDynamicValidator(context);

    const canonical = await canonicalProvider.getCanonicalOptions(
      'space-1',
      { key: 'contact', options: { source: 'contactFolders', key: 'key', name: 'name', allowUserInput: true } },
      'communication-project'
    );
    expect(canonical).toEqual([{ key: 'Pavarini', name: 'Pavarini' }]);

    const fetched = await optionsFetcher.fetchOptions(
      [{ sourceKey: 'contactFolders' }],
      { spaceId: 'space-1', documentTypeKey: 'communication-project' }
    );
    expect(fetched.contactFolders).toEqual({
      status: 'ready',
      targetPath: '1 Admin/Communication',
      items: [{ text: 'Pavarini', value: 'Pavarini' }],
    });

    const validated = await dynamicValidator.validateExistence(
      [
        {
          queryId: 'contact',
          fieldKey: 'contact',
          sourceKey: 'contactFolders',
          valueToValidate: 'Pavarini',
          allowUserInput: true,
        },
      ],
      { spaceId: 'space-1', documentTypeKey: 'communication-project' }
    );
    expect(validated.contact.isValid).toBe(true);
    expect(validated.contact.matchedTuple).toEqual({ key: 'Pavarini', name: 'Pavarini' });

    // Only 3 listFolders calls total (space-1 -> 1 Admin -> Communication -> Pavarini), shared across all 3 consumers
    expect(listFolders).toHaveBeenCalledTimes(3);

    // Separate request context gets an isolated LookupOptions instance (zero cross-request caching)
    const context2: WorkspaceExecutionContext = { hostApp: 'DRIVE' };
    const optionsFetcher2 = wiring.createOptionsFetcher(context2);
    await optionsFetcher2.fetchOptions(
      [{ sourceKey: 'contactFolders' }],
      { spaceId: 'space-1', documentTypeKey: 'communication-project' }
    );
    expect(listFolders).toHaveBeenCalledTimes(6);
  });

  it('creates standalone LookupOptionsService via createLookupOptionsService and adapts all 3 consumer ports', async () => {
    const listFolders = vi.fn().mockResolvedValue({
      folders: [{ id: 'f-1', name: 'Acme Corp' }],
    });
    const service = createLookupOptionsService({
      manifestProvider: {
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./doc.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'simple-doc',
          documentSchema: {
            fields: [
              {
                key: 'contact',
                options: { source: 'contactFolders', key: 'key', name: 'name', allowUserInput: true },
              },
            ],
            optionSources: {
              contactFolders: { provider: 'google_drive', method: 'list_folders' },
            },
          },
        }),
      },
      driveClient: { listFolders },
    });

    const fetcher = createOptionsFetcherAdapter(service);
    const validator = createDocumentDynamicValidationAdapter(service);
    const canonical = createCanonicalOptionsProviderAdapter(service);

    expect(
      (await fetcher.fetchOptions([{ sourceKey: 'contactFolders' }], { spaceId: 'sp-1', documentTypeKey: 'simple-doc' }))
        .contactFolders.status
    ).toBe('ready');
    expect(
      (
        await validator.validateExistence(
          [{ queryId: 'contact', sourceKey: 'contactFolders', valueToValidate: 'Acme Corp', allowUserInput: true }],
          { spaceId: 'sp-1', documentTypeKey: 'simple-doc' }
        )
      ).contact.isValid
    ).toBe(true);
    expect(
      await canonical.getCanonicalOptions('sp-1', { key: 'contact' }, 'simple-doc')
    ).toEqual([{ key: 'Acme Corp', name: 'Acme Corp' }]);
    expect(listFolders).toHaveBeenCalledTimes(1);
  });

  it('forwards getDocumentSpaceService in createLookupOptionsService to resolve partial space metadata before readOptionTables (#415)', async () => {
    const readOptionTables = vi.fn().mockResolvedValue({
      status: 'ready',
      spreadsheetId: 'log-1',
      tables: {
        statuses: {
          status: 'ready',
          tuples: [{ key: 'Open' }],
        },
      },
    });
    const mockDocLogService = {
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn(),
      readLog: vi.fn(),
      readOptionTables,
      writeLog: vi.fn(),
    };
    const getCollection = vi.fn().mockResolvedValue({
      spaces: [
        {
          id: 'sp-1',
          typeId: 'projects',
          name: 'Harborview Hotel',
          abstractStorageId: 'drive-root-1',
        },
      ],
    });
    const getDocumentSpaceService = vi.fn().mockReturnValue({
      getAllTypes: () => [{ id: 'projects' }],
      getCollection,
    } as never);

    const service = createLookupOptionsService({
      manifestProvider: {
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./submittal.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'submittal-arch',
          documentSchema: {
            fields: [{ key: 'status', options: { source: 'statuses', key: 'key' } }],
            optionSources: {
              statuses: { provider: 'document_log', properties: ['key'] },
            },
          },
        }),
      },
      documentLogService: mockDocLogService,
      getDocumentSpaceService,
    });

    const res = await service.resolveOptions(
      {
        space: { id: 'sp-1', abstractStorageId: 'drive-root-1' },
        documentTypeKey: 'submittal-arch',
      },
      ['statuses']
    );

    expect(res.statuses.status).toBe('ready');
    expect(getDocumentSpaceService).toHaveBeenCalledTimes(1);
    expect(readOptionTables).toHaveBeenCalledWith(
      {
        documentTypeKey: 'submittal-arch',
        space: {
          id: 'sp-1',
          typeId: 'projects',
          name: 'Harborview Hotel',
          abstractStorageId: 'drive-root-1',
        },
        sourceKeys: ['statuses'],
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('wires document_log option source to DocumentLogPort.readOptionTables and resolves full space metadata via getDocumentSpaceService', async () => {
    const readOptionTables = vi.fn().mockResolvedValue({
      status: 'ready',
      spreadsheetId: 'log-1',
      tables: {
        statuses: {
          status: 'ready',
          tuples: [{ key: 'Open' }, { key: 'Closed' }],
        },
      },
    });
    const mockDocLogService = {
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn(),
      readLog: vi.fn(),
      readOptionTables,
      writeLog: vi.fn(),
    };

    const getCollection = vi.fn().mockResolvedValue({
      spaces: [
        {
          id: 'sp-1',
          typeId: 'projects',
          name: 'Harborview Hotel',
          abstractStorageId: 'drive-root-1',
        },
      ],
    });
    const wiring = createLookupOptionsWiring({
      manifestProvider: {
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./submittal.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'submittal-arch',
          documentSchema: {
            fields: [
              { key: 'status', options: { source: 'statuses', key: 'key' } },
            ],
            optionSources: {
              statuses: { provider: 'document_log', properties: ['key'] },
            },
          },
        }),
      },
      getDocumentLogService: () => mockDocLogService,
      getDocumentSpaceService: () => ({
        getAllTypes: () => [{ id: 'projects' }],
        getCollection,
      }) as never,
    });

    const ctx: WorkspaceExecutionContext = { hostApp: 'DRIVE' };
    const fetcher = wiring.createOptionsFetcher(ctx);
    const res = await fetcher.fetchOptions(
      [{ sourceKey: 'statuses' }],
      { spaceId: 'sp-1', documentTypeKey: 'submittal-arch' }
    );

    expect(res.statuses).toEqual({
      status: 'ready',
      items: [
        { text: 'Open', value: 'Open' },
        { text: 'Closed', value: 'Closed' },
      ],
    });
    expect(readOptionTables).toHaveBeenCalledWith(
      {
        documentTypeKey: 'submittal-arch',
        space: {
          id: 'sp-1',
          typeId: 'projects',
          name: 'Harborview Hotel',
          abstractStorageId: 'drive-root-1',
        },
        sourceKeys: ['statuses'],
      },
      { signal: expect.any(AbortSignal) }
    );
  });

  it('resolves abstractStorageId consistently across optionsFetcher, dynamicValidator, canonicalProvider, and invalidate({ spaceId: abstractStorageId }) when space.id !== space.abstractStorageId', async () => {
    const readOptionTables = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'missing_log',
        expectedFolderPath: '1 Admin',
        tables: {},
      })
      .mockResolvedValueOnce({
        status: 'ready',
        spreadsheetId: 'new-log-1',
        tables: {
          statuses: {
            status: 'ready',
            tuples: [{ key: 'Open' }, { key: 'Closed' }],
          },
        },
      });

    const mockDocLogService = {
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn(),
      readLog: vi.fn(),
      readOptionTables,
      writeLog: vi.fn(),
    };

    const getCollection = vi.fn().mockResolvedValue({
      spaces: [
        {
          id: 'sp-proposal-1',
          typeId: 'proposals',
          name: 'Proposal Alpha',
          abstractStorageId: 'folder-opp-alpha',
        },
      ],
    });

    const wiring = createLookupOptionsWiring({
      manifestProvider: {
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./submittal.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'submittal-arch',
          documentSchema: {
            fields: [{ key: 'status', options: { source: 'statuses', key: 'key' } }],
            optionSources: {
              statuses: { provider: 'document_log', properties: ['key'] },
            },
          },
        }),
      },
      getDocumentLogService: () => mockDocLogService,
      getDocumentSpaceService: () =>
        ({
          getAllTypes: () => [{ id: 'proposals' }],
          getCollection,
        }) as never,
    });

    const ctx: WorkspaceExecutionContext = { hostApp: 'DRIVE' };
    const fetcher = wiring.createOptionsFetcher(ctx);
    const sharedLookup = wiring.getPerRequestLookupOptions(ctx);

    const beforeCopy = await fetcher.fetchOptions([{ sourceKey: 'statuses' }], {
      spaceId: 'sp-proposal-1',
      documentTypeKey: 'submittal-arch',
    });
    expect(beforeCopy.statuses.status).toBe('missing_log');

    // Copy Log invalidates using space.id (and/or abstractStorageId)
    sharedLookup.invalidate({ spaceId: 'sp-proposal-1' });

    const afterCopy = await fetcher.fetchOptions([{ sourceKey: 'statuses' }], {
      spaceId: 'sp-proposal-1',
      documentTypeKey: 'submittal-arch',
    });
    expect(afterCopy.statuses).toEqual({
      status: 'ready',
      items: [
        { text: 'Open', value: 'Open' },
        { text: 'Closed', value: 'Closed' },
      ],
    });
    expect(readOptionTables).toHaveBeenCalledTimes(2);
  });

  it('provides createOptionTableResolver sharing the per-request LookupOptionsService cache with createDynamicValidator (#374)', async () => {
    const readOptionTables = vi.fn().mockResolvedValue({
      status: 'ready',
      spreadsheetId: 'log-1',
      tables: {
        statuses: {
          status: 'ready',
          tuples: [{ key: 'Open' }],
        },
        csiDivisions: {
          status: 'ready',
          tuples: [
            { key: '07', folder: '07 Thermal and Moisture Protection' },
          ],
        },
      },
    });

    const mockDocLogService = {
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn(),
      readLog: vi.fn(),
      readOptionTables,
      writeLog: vi.fn(),
    };

    const wiring = createLookupOptionsWiring({
      manifestProvider: {
        getRawManifest: vi.fn().mockResolvedValue({ documentTypes: ['./submittal-arch.json'] }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'submittal-arch',
          documentSchema: {
            fields: [{ key: 'status', options: { source: 'statuses', key: 'key' } }],
            optionSources: {
              statuses: { provider: 'document_log', properties: ['key'] },
              csiDivisions: { provider: 'document_log', properties: ['key', 'folder'] },
            },
          },
        }),
      },
      getDocumentLogService: () => mockDocLogService,
    });

    const ctx: WorkspaceExecutionContext = { hostApp: 'DRIVE' };
    const validator = wiring.createDynamicValidator(ctx);
    const optionTablePort = wiring.createOptionTableResolver(ctx);

    const space = {
      id: 'sp-1',
      typeId: 'projects',
      name: '123 Main',
      abstractStorageId: 'drive-1',
    };
    const valRes = await validator.validateExistence(
      [{ sourceKey: 'statuses', fieldKey: 'status', queryId: 'status', valueToValidate: 'Open' }],
      { space, documentTypeKey: 'submittal-arch' }
    );
    expect(valRes.status.isValid).toBe(true);

    const tableRes = await optionTablePort.resolveOptionTables(['csiDivisions'], {
      space,
      documentTypeKey: 'submittal-arch',
    });
    expect(tableRes.csiDivisions.status).toBe('ready');
    expect(tableRes.csiDivisions.tuples).toEqual([
      { key: '07', folder: '07 Thermal and Moisture Protection' },
    ]);
    // Both calls share the same batched readOptionTables call in the per-request cache
    expect(readOptionTables).toHaveBeenCalledTimes(1);
  });

  describe('DocumentLog selectedLogId fast-path & inaccessible-storage seam (Ticket #411)', () => {
    const projectSpace = {
      id: 'sp-1',
      typeId: 'projects',
      name: 'Harborview Hotel',
      abstractStorageId: 'drive-1',
    };

    const createDocLogManifestProvider = (): RawManifestProviderPort => ({
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        DocumentSpaceTypes: [
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['submittal-arch'] },
            storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
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
            {
              key: 'status',
              name: 'Status',
              type: 'string',
              required: true,
              options: { source: 'statuses', key: 'key' },
            },
          ],
          identity: {
            idGroup: '{{status.key}}',
            idDocument: '{{status.key}}',
            id: '{{status.key}}',
          },
          optionSources: {
            statuses: { provider: 'document_log', properties: ['key'] },
          },
        },
        documentWorkflowConfig: { workflows: [] },
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
          },
          optionBindings: {
            statuses: {
              sheetName: '_Config Submittal Arch',
              rangeName: 'Options_Statuses',
              endMarker: '---',
              columns: { Status: 'key' },
            },
          },
        },
      }),
    });

    const createWiredLookupFixture = (oauthCredential: string) => {
      const manifestProvider = createDocLogManifestProvider();
      const driveClient = new GoogleDriveClient({
        auth: oauthCredential,
        retryOptions: { maxRetries: 0 },
      });
      const sheetsClient = new GoogleSheetsClient({
        auth: oauthCredential,
        retryOptions: { maxRetries: 0 },
      });
      const docLogWiring = createDocumentLogWiring({
        manifestProvider,
        driveClient,
        sheetsClient,
      });
      const lookupOptionsWiring = createLookupOptionsWiring({
        manifestProvider,
        driveClient,
        getDocumentLogService: (ctx) => docLogWiring.getPerRequestService(ctx),
        ensureDocumentLogInitialized: () => docLogWiring.logSchemaRegistry.initialize(),
      });
      return { lookupOptionsWiring };
    };

    const mockSpreadsheetOptionRead = (
      oauthCredential: string,
      spreadsheetId: string,
      values: string[][]
    ) => {
      const sheetsScope = nock('https://sheets.googleapis.com', {
        reqheaders: { authorization: `Bearer ${oauthCredential}` },
      });
      sheetsScope
        .get(`/v4/spreadsheets/${spreadsheetId}`)
        .query(true)
        .reply(200, {
          spreadsheetId,
          sheets: [{ properties: { sheetId: 10, title: '_Config Submittal Arch' } }],
          namedRanges: [
            {
              namedRangeId: 'nr-opt-1',
              name: 'Options_Statuses',
              range: {
                sheetId: 10,
                startRowIndex: 0,
                endRowIndex: values.length,
                startColumnIndex: 0,
                endColumnIndex: 1,
              },
            },
          ],
        });
      sheetsScope
        .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
        .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
        .reply(200, {
          valueRanges: [{ values }],
        });
    };

    afterEach(() => {
      nock.cleanAll();
      nock.enableNetConnect();
    });

    it('resolves document_log options directly from selectedLogId with zero Drive calls even when space is provided', async () => {
      nock.disableNetConnect();
      const credential = 'ya29.direct-fast-path';
      mockSpreadsheetOptionRead(credential, 'log-direct-1', [
        ['Status'],
        ['Open'],
        ['Closed'],
        ['---'],
      ]);

      const { lookupOptionsWiring } = createWiredLookupFixture(credential);
      const lookupOptions = lookupOptionsWiring.createLookupOptions({ hostApp: 'DRIVE' });
      const res = await lookupOptions.resolveOptions(
        {
          space: projectSpace,
          documentTypeKey: 'submittal-arch',
          selectedLogId: 'log-direct-1',
        },
        ['statuses']
      );

      expect(res.statuses).toEqual({
        status: 'ready',
        tuples: [{ key: 'Open' }, { key: 'Closed' }],
        items: [
          { text: 'Open', value: 'Open' },
          { text: 'Closed', value: 'Closed' },
        ],
      });
      expect(nock.isDone()).toBe(true);
    });

    it.each([
      {
        label: '404',
        statusCode: 404,
        body: { error: { code: 404, message: 'Requested entity was not found.' } },
      },
      {
        label: 'non-quota 403 forbidden',
        statusCode: 403,
        body: {
          error: {
            code: 403,
            message: 'The caller does not have permission',
            errors: [{ reason: 'forbidden', message: 'The caller does not have permission' }],
          },
        },
      },
    ])(
      'falls back once to Drive discovery on stale selectedLogId ($label) with space, picking ranked candidates[0]',
      async ({ statusCode, body }) => {
        nock.disableNetConnect();
        const credential = `ya29.stale-fallback-${statusCode}`;

        nock('https://sheets.googleapis.com', {
          reqheaders: { authorization: `Bearer ${credential}` },
        })
          .get('/v4/spreadsheets/log-stale-1')
          .query(true)
          .reply(statusCode, body);

        const driveScope = nock('https://www.googleapis.com', {
          reqheaders: { authorization: `Bearer ${credential}` },
        });
        driveScope
          .get('/drive/v3/files')
          .query(
            (q) =>
              q.driveId === 'drive-1' &&
              q.corpora === 'drive' &&
              typeof q.q === 'string' &&
              q.q.includes('application/vnd.google-apps.spreadsheet')
          )
          .reply(200, {
            files: [
              {
                id: 'log-fallback-other',
                name: 'Harborview Hotel Document Log (Draft)',
                parents: ['drive-1'],
                mimeType: 'application/vnd.google-apps.spreadsheet',
                modifiedTime: '2026-03-01T10:00:00.000Z',
              },
              {
                id: 'log-fallback-ranked-1',
                name: 'Harborview Hotel Document Log',
                parents: ['admin-folder-1'],
                mimeType: 'application/vnd.google-apps.spreadsheet',
                modifiedTime: '2026-01-01T10:00:00.000Z',
              },
            ],
          });
        driveScope
          .get('/drive/v3/files')
          .query(
            (q) =>
              typeof q.q === 'string' &&
              q.q.includes("'drive-1' in parents") &&
              q.q.includes("name = '1 Admin'") &&
              q.q.includes('application/vnd.google-apps.folder')
          )
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
        driveScope
          .get('/drive/v3/files/admin-folder-1')
          .query(true)
          .reply(200, {
            id: 'admin-folder-1',
            name: '1 Admin',
            parents: ['drive-1'],
            mimeType: 'application/vnd.google-apps.folder',
          });

        mockSpreadsheetOptionRead(credential, 'log-fallback-ranked-1', [
          ['Status'],
          ['FallbackOpen'],
          ['---'],
        ]);

        const { lookupOptionsWiring } = createWiredLookupFixture(credential);
        const lookupOptions = lookupOptionsWiring.createLookupOptions({ hostApp: 'DRIVE' });
        const res = await lookupOptions.resolveOptions(
          {
            space: projectSpace,
            documentTypeKey: 'submittal-arch',
            selectedLogId: 'log-stale-1',
          },
          ['statuses']
        );

        expect(res.statuses).toEqual({
          status: 'ready',
          tuples: [{ key: 'FallbackOpen' }],
          items: [{ text: 'FallbackOpen', value: 'FallbackOpen' }],
        });
        expect(nock.isDone()).toBe(true);
      }
    );

    it('returns missing_log with zero Drive calls on stale selectedLogId (404) when space is omitted', async () => {
      nock.disableNetConnect();
      const credential = 'ya29.stale-omitted-space';

      nock('https://sheets.googleapis.com', {
        reqheaders: { authorization: `Bearer ${credential}` },
      })
        .get('/v4/spreadsheets/log-stale-omitted')
        .query(true)
        .reply(404, { error: { code: 404, message: 'Requested entity was not found.' } });

      const { lookupOptionsWiring } = createWiredLookupFixture(credential);
      const lookupOptions = lookupOptionsWiring.createLookupOptions({ hostApp: 'DRIVE' });
      const res = await lookupOptions.resolveOptions(
        {
          space: undefined,
          documentTypeKey: 'submittal-arch',
          selectedLogId: 'log-stale-omitted',
        },
        ['statuses']
      );

      expect(res.statuses).toEqual({
        status: 'missing_log',
        tuples: [],
        items: [],
        targetPath: '1 Admin',
      });
      expect(nock.isDone()).toBe(true);
    });

    it.each([
      {
        label: 'quota 403 rateLimitExceeded',
        statusCode: 403,
        body: {
          error: {
            code: 403,
            message: 'Forbidden',
            errors: [{ reason: 'rateLimitExceeded', message: 'Forbidden' }],
          },
        },
      },
      {
        label: '400',
        statusCode: 400,
        body: { error: { code: 400, message: 'Invalid argument' } },
      },
      {
        label: '401',
        statusCode: 401,
        body: { error: { code: 401, message: 'Invalid Credentials' } },
      },
      {
        label: '429',
        statusCode: 429,
        body: { error: { code: 429, message: 'Too Many Requests' } },
      },
      {
        label: '503',
        statusCode: 503,
        body: { error: { code: 503, message: 'The service is currently unavailable' } },
      },
    ])(
      'surfaces status error with zero Drive discovery on $label for selectedLogId',
      async ({ label, statusCode, body }) => {
        nock.disableNetConnect();
        const credential = `ya29.non-inaccessible-${statusCode}-${label}`;

        nock('https://sheets.googleapis.com', {
          reqheaders: { authorization: `Bearer ${credential}` },
        })
          .get('/v4/spreadsheets/log-error-1')
          .query(true)
          .reply(statusCode, body);

        const { lookupOptionsWiring } = createWiredLookupFixture(credential);
        const lookupOptions = lookupOptionsWiring.createLookupOptions({ hostApp: 'DRIVE' });
        const res = await lookupOptions.resolveOptions(
          {
            space: projectSpace,
            documentTypeKey: 'submittal-arch',
            selectedLogId: 'log-error-1',
          },
          ['statuses']
        );

        expect(res.statuses).toEqual({
          status: 'error',
          tuples: [],
          items: [],
        });
        expect(nock.isDone()).toBe(true);
      }
    );
  });

  describe('AbortSignal cancellation and non-poisoning across wired GoogleSheetsClient and GoogleDriveClient (Ticket #414)', () => {
    it('cancels GoogleSheetsClient 429 retry backoff on lookupTimeoutMs and prevents timeout cache poisoning across calls in the same request', async () => {
      const sheetsGet = vi
        .fn()
        .mockRejectedValueOnce({ statusCode: 429, message: 'Too Many Requests' })
        .mockResolvedValueOnce({
          data: {
            spreadsheetId: 'log-1',
            sheets: [{ properties: { sheetId: 1, title: '_Config Submittal Arch' } }],
            namedRanges: [
              {
                name: 'Options_Statuses',
                range: {
                  sheetId: 1,
                  startRowIndex: 2,
                  endRowIndex: 5,
                  startColumnIndex: 0,
                  endColumnIndex: 1,
                },
              },
            ],
          },
        });
      const sheetsBatchGet = vi.fn().mockResolvedValueOnce({
        data: {
          valueRanges: [{ values: [['Status'], ['Open'], ['---']] }],
        },
      });

      const sheetsClient = new GoogleSheetsClient({
        sheets: {
          spreadsheets: {
            get: sheetsGet,
            values: { batchGet: sheetsBatchGet, get: vi.fn(), update: vi.fn() },
            batchUpdate: vi.fn(),
          },
        } as never,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 60_000,
        },
      });

      const driveClient = new GoogleDriveClient({
        drive: {
          files: {
            list: vi.fn().mockResolvedValue({
              data: {
                files: [{ id: 'log-1', name: 'Harborview Hotel Document Log', parents: ['admin-1'] }],
              },
            }),
          },
        } as never,
      });

      const manifest: RawManifestProviderPort = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./document-types/submittal-arch.json'],
          DocumentSpaceTypes: [
            {
              id: 'projects',
              displayName: 'Projects',
              spaceSchema: { allowedDocumentTypes: ['submittal-arch'] },
              storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
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
            fields: [{ key: 'status', options: { source: 'statuses', key: 'key' } }],
            identity: {
              idGroup: '{{status.key}}',
              idDocument: '{{status.key}}',
              id: '{{status.key}}',
            },
            optionSources: { statuses: { provider: 'document_log', properties: ['key'] } },
          },
          documentWorkflowConfig: { workflows: [] },
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
            columns: { Status: { template: '{{status.key}}' } },
            optionBindings: {
              statuses: {
                sheetName: '_Config Submittal Arch',
                rangeName: 'Options_Statuses',
                endMarker: '---',
                columns: { Status: 'key' },
              },
            },
          },
        }),
      };

      const docLogWiring = createDocumentLogWiring({
        manifestProvider: manifest,
        driveClient,
        sheetsClient,
      });
      await docLogWiring.logSchemaRegistry.initialize();

      const lookupWiring = createLookupOptionsWiring({
        manifestProvider: manifest,
        driveClient,
        getDocumentLogService: (ctx) => docLogWiring.getPerRequestService(ctx),
        lookupTimeoutMs: 25,
      });

      const reqCtx: WorkspaceExecutionContext = { hostApp: 'DRIVE' };
      const lookup = lookupWiring.getPerRequestLookupOptions(reqCtx);
      const callCtx = {
        space: {
          id: 'sp-1',
          typeId: 'projects',
          name: 'Harborview Hotel',
          abstractStorageId: 'drive-1',
        },
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'log-1',
      };

      const startedAt = Date.now();
      const first = await lookup.resolveOptions(callCtx, ['statuses']);
      const elapsedMs = Date.now() - startedAt;

      expect(first.statuses.status).toBe('timeout');
      expect(elapsedMs).toBeLessThan(1000);
      // Wait briefly to confirm aborted 60s retry loop does NOT fire a background Sheets call
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(sheetsGet).toHaveBeenCalledTimes(1);

      // Second call in the same request is NOT poisoned by timeout and succeeds
      const second = await lookup.validateFields(callCtx, [
        { queryId: 'status', fieldKey: 'status', sourceKey: 'statuses', value: 'Open' },
      ]);
      expect(second.status).toEqual({
        isValid: true,
        status: 'valid',
        canonicalValue: 'Open',
        matchedTuple: { key: 'Open' },
      });
      expect(sheetsGet).toHaveBeenCalledTimes(2);
      expect(sheetsBatchGet).toHaveBeenCalledTimes(1);
    });

    it('cancels GoogleDriveClient 429 retry backoff immediately when lookupTimeoutMs fires for google_drive OptionSource', async () => {
      const filesList = vi
        .fn()
        .mockRejectedValueOnce({ status: 429, message: 'Too Many Requests' })
        .mockResolvedValueOnce({ data: { files: [{ id: 'c-1', name: 'Acme Corp' }] } });

      const driveClient = new GoogleDriveClient({
        drive: {
          files: {
            list: filesList,
          },
        } as never,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 60_000,
        },
      });

      const lookupWiring = createLookupOptionsWiring({
        manifestProvider,
        driveClient,
        lookupTimeoutMs: 25,
      });

      const reqCtx: WorkspaceExecutionContext = { hostApp: 'DRIVE' };
      const fetcher = lookupWiring.createOptionsFetcher(reqCtx);
      const startedAt = Date.now();
      const res = await fetcher.fetchOptions([{ sourceKey: 'contactFolders' }], {
        spaceId: 'sp-1',
        documentTypeKey: 'communication-project',
      });
      const elapsedMs = Date.now() - startedAt;

      expect(res.contactFolders.status).toBe('timeout');
      expect(elapsedMs).toBeLessThan(1000);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(filesList).toHaveBeenCalledTimes(1);
    });
  });
});

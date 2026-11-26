import { describe, it, expect, vi } from 'vitest';
import {
  createLookupOptionsService,
  createLookupOptionsWiring,
  createOptionsFetcherAdapter,
  createDocumentDynamicValidationAdapter,
  createCanonicalOptionsProviderAdapter,
} from './lookup-options.wiring';
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
    expect(readOptionTables).toHaveBeenCalledWith({
      documentTypeKey: 'submittal-arch',
      space: {
        id: 'sp-1',
        typeId: 'projects',
        name: 'Harborview Hotel',
        abstractStorageId: 'drive-root-1',
      },
      sourceKeys: ['statuses'],
    });
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
});

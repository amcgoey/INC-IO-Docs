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
});

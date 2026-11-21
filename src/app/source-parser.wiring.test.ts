import { describe, it, expect, vi } from 'vitest';
import {
  createSourceParserWiring,
} from './source-parser.wiring';
import { SourceParserService } from '../features/source-parser/domain';
import type { DriveSourceContextClientPort } from '../features/source-parser';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';

describe('source-parser.wiring', () => {
  const dummySpaceType = {
    id: 'projects',
    displayName: 'Projects',
    spaceSchema: { allowedDocumentTypes: ['communication-project'], defaultDocumentType: 'communication-project' },
    storageConfig: {
      provider: 'google_drive',
      fetchMethod: 'shared_drives',
    },
  };

  const mockSpaceTypesProvider = {
    getAllTypes: vi.fn().mockReturnValue([dummySpaceType]),
  };

  const mockDriveClient = {
    getFile: vi.fn().mockResolvedValue({ id: 'file-1', name: 'File.pdf', parents: [] }),
    listSharedDrives: vi.fn().mockResolvedValue({ drives: [] }),
  } as unknown as GoogleDriveClient;

  it('creates default singleton and per-request factory for SourceParser', async () => {
    const wiring = createSourceParserWiring({
      spaceTypesProvider: mockSpaceTypesProvider,
      driveClient: mockDriveClient,
    });

    expect(wiring.sourceParser).toBeInstanceOf(SourceParserService);
    expect(typeof wiring.createSourceParser).toBe('function');
    expect(wiring.parseSchemaRegistry).toBeDefined();
    expect(typeof wiring.parseSchemaRegistry.initialize).toBe('function');

    const reqParser = wiring.createSourceParser({});
    expect(reqParser).toBeInstanceOf(SourceParserService);
  });

  it('passes canonicalOptionsProvider to per-request SourceParserService', () => {
    const mockCanonicalProvider = {
      getCanonicalOptions: vi.fn(),
    };
    const wiring = createSourceParserWiring({
      spaceTypesProvider: mockSpaceTypesProvider,
      driveClient: mockDriveClient,
      getCanonicalOptionsProvider: () => mockCanonicalProvider,
    });

    const parser = wiring.createSourceParser({});
    expect(parser).toBeInstanceOf(SourceParserService);
  });

  it('uses driveContextClient when provided without importing Document DriveServicePort', async () => {
    const mockDriveContextClient: DriveSourceContextClientPort = {
      getFile: vi.fn().mockResolvedValue({
        id: 'file-mock',
        name: 'Mock.pdf',
        parents: [],
        driveId: 'drive-mock',
      }),
      listSharedDrives: vi.fn().mockResolvedValue({ drives: [] }),
    };

    const wiring = createSourceParserWiring({
      spaceTypesProvider: mockSpaceTypesProvider,
      driveContextClient: mockDriveContextClient,
    });

    const result = await wiring.sourceParser.inferRouting({ items: [{ id: 'file-mock' }] });
    expect(mockDriveContextClient.getFile).toHaveBeenCalledWith('file-mock');
    expect(result.spaceTypeId).toBe('projects');
    expect(result.spaceIdOrName).toBe('drive-mock');
  });

  it('reads configuration.workspace.timeZone lazily at extractFields call time rather than wiring construction time (#307)', async () => {
    let loadedTimeZone: string | undefined = undefined;
    const mockWorkspaceConfigProvider = {
      getWorkspaceConfig: vi.fn().mockImplementation(async () =>
        loadedTimeZone !== undefined ? { timeZone: loadedTimeZone } : undefined
      ),
    };
    const mockManifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/comm.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'comm',
        documentSchema: { fields: [{ key: 'date', type: 'string' }] },
        documentParseSchema: {
          extractors: [
            {
              source: 'drive',
              fields: { date: { from: 'drive.modifiedTime' } },
            },
          ],
        },
      }),
    };
    const mockDriveContextClient: DriveSourceContextClientPort = {
      getFile: vi.fn().mockResolvedValue({
        id: 'file-tz',
        name: 'Evening_Note.pdf',
        parents: [],
        modifiedTime: '2026-03-16T02:30:00Z',
      }),
      listSharedDrives: vi.fn().mockResolvedValue({ drives: [] }),
    };

    // Wiring constructed synchronously BEFORE initialize() / manifest load sets timeZone
    const wiring = createSourceParserWiring({
      spaceTypesProvider: mockSpaceTypesProvider,
      manifestProvider: mockManifestProvider,
      driveContextClient: mockDriveContextClient,
      workspaceConfigProvider: mockWorkspaceConfigProvider,
    });
    expect(mockWorkspaceConfigProvider.getWorkspaceConfig).not.toHaveBeenCalled();

    await wiring.parseSchemaRegistry.initialize();
    loadedTimeZone = 'America/New_York';

    const parser = wiring.createSourceParser({});
    const extracted = await parser.extractFields({
      documentTypeKey: 'comm',
      context: { items: [{ id: 'file-tz' }] },
    });

    expect(mockWorkspaceConfigProvider.getWorkspaceConfig).toHaveBeenCalled();
    expect(extracted.fields).toEqual({ date: '260315' });
  });
});

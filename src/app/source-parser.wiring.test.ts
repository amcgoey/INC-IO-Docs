import { describe, it, expect, vi } from 'vitest';
import {
  createSourceParserWiring,
} from './source-parser.wiring';
import { SourceParserService } from '../features/source-parser/domain';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { DriveServicePort } from '../features/document/ports';

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

    const reqParser = wiring.createSourceParser({});
    expect(reqParser).toBeInstanceOf(SourceParserService);
  });

  it('adapts driveService.getFile when driveService is provided', async () => {
    const mockDriveService = {
      getFile: vi.fn().mockResolvedValue({
        id: 'file-mock',
        name: 'Mock.pdf',
        parents: [],
        driveId: 'drive-mock',
      }),
    };

    const wiring = createSourceParserWiring({
      spaceTypesProvider: mockSpaceTypesProvider,
      driveService: mockDriveService as unknown as DriveServicePort,
    });

    const result = await wiring.sourceParser.inferRouting({ items: [{ id: 'file-mock' }] });
    expect(mockDriveService.getFile).toHaveBeenCalledWith('file-mock');
    expect(result.spaceTypeId).toBe('projects');
    expect(result.spaceIdOrName).toBe('drive-mock');
  });
});

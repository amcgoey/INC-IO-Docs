import { describe, it, expect, vi } from 'vitest';
import { SourceParserService } from '../src/features/source-parser/domain';
import { DriveSourceContextAdapter } from '../src/features/source-parser/adapters/drive-source-context.adapter';
import type {
  DriveSourceContextClientPort,
  SourceParserSpaceConfigPort,
} from '../src/features/source-parser/ports';

describe('SourceParser + DriveSourceContextAdapter integration', () => {
  it('memoizes broken-shortcut and item-error promises across Pass 1 + Pass 2 via DriveSourceContextAdapter and deduplicates Pass 2 notice', async () => {
    const mockClient: DriveSourceContextClientPort = {
      getFile: vi.fn().mockImplementation(async (fileId: string) => {
        if (fileId === 'shortcut-broken') {
          return {
            id: 'shortcut-broken',
            name: 'Broken Shortcut',
            mimeType: 'application/vnd.google-apps.shortcut',
            shortcutDetails: { targetId: 'target-missing' },
          };
        }
        const err = new Error('Not found') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }),
      listSharedDrives: vi.fn().mockResolvedValue({ drives: [] }),
    };

    const requestDrivePort = new DriveSourceContextAdapter(mockClient);
    const registry = {
      initialize: vi.fn(),
      getParseSchema: vi.fn().mockResolvedValue({
        extractors: [
          {
            source: 'gmail' as const,
            fields: {
              description: { from: 'email.subjectClean' as const },
            },
          },
          {
            source: 'drive' as const,
            fields: {
              date: { from: 'drive.modifiedTime' as const },
            },
          },
          {
            source: 'drive' as const,
            fields: {
              contact: { from: 'drive.fileNameStem' as const },
            },
          },
        ],
      }),
      getTargetSchema: vi.fn().mockResolvedValue({
        fields: [
          { key: 'description', type: 'string' },
          { key: 'date', type: 'string' },
          { key: 'contact', type: 'string' },
        ],
      }),
    };

    const spaceConfigPort: SourceParserSpaceConfigPort = {
      getDocumentSpaceTypes: vi.fn().mockResolvedValue([
        {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: {
            allowedDocumentTypes: ['communication-project'],
            defaultDocumentType: 'communication-project',
          },
          storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
        },
      ]),
    };

    const service = new SourceParserService(requestDrivePort, spaceConfigPort, {
      parseSchemaRegistry: registry,
    });

    // Pass 1 fails on broken shortcut (calls getFile('shortcut-broken') and getFile('target-missing') once each)
    const routing = await service.inferRouting({
      items: [{ id: 'shortcut-broken' }],
    });
    expect(routing.statusMessages).toEqual([
      'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.',
    ]);

    // Pass 2 runs both failing drive extractors in the same request without re-fetching Drive API
    const extracted = await service.extractFields({
      documentTypeKey: 'communication-project',
      context: {
        isDriveUrl: true,
        items: [{ id: 'shortcut-broken' }],
        email: {
          id: 'msg-1',
          subject: 'Weekly Update',
        },
      },
    });

    expect(mockClient.getFile).toHaveBeenCalledTimes(2);
    expect(extracted.fields.description).toBe('Weekly Update');
    expect(extracted.statusMessages).toEqual([
      'Could not read Google Drive file metadata to pre-populate fields; you can enter them manually.',
    ]);
  });
});

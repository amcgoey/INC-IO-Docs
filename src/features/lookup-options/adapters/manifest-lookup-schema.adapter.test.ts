import { describe, it, expect, vi } from 'vitest';
import { ManifestLookupSchemaAdapter } from './manifest-lookup-schema.adapter';

describe('ManifestLookupSchemaAdapter', () => {
  it('cleans and returns LookupDocumentSchema for matching documentTypeKey', async () => {
    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/comm-proj.json'],
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
          options: {
            direction: [{ key: 'IN', name: 'Incoming' }],
          },
        },
      }),
    };

    const adapter = new ManifestLookupSchemaAdapter(manifestProvider);
    const schema = await adapter.getDocumentSchema('communication-project');

    expect(schema).toEqual({
      fields: [
        {
          key: 'contact',
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
      options: {
        direction: [{ key: 'IN', name: 'Incoming' }],
      },
    });
  });

  it('returns undefined when documentTypeKey is not found', async () => {
    const adapter = new ManifestLookupSchemaAdapter({
      getRawManifest: vi.fn().mockResolvedValue({ documentTypes: [] }),
      readParsedSchema: vi.fn(),
    });

    expect(await adapter.getDocumentSchema('missing')).toBeUndefined();
  });
});

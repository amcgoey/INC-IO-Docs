import { describe, it, expect, vi } from 'vitest';
import { createHttpServer } from '../infrastructure/http';
import { wireWorkspaceAddonRoutes } from './workspace-addon.wiring';
import { createSourceParserWiring } from './source-parser.wiring';
import { ParseSchemaRegistryAdapter } from '../features/source-parser/adapters/parse-schema-registry.adapter';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { GoogleWorkspaceActionResponse } from '../infrastructure/workspace-addon/ui-blocks';

describe('workspace-addon.wiring (S3)', () => {
  const createAuthVerifier = () => ({
    verifyToken: vi.fn().mockResolvedValue({
      isValid: true,
      payload: { email: 'user@inc.nyc', sub: 'user-1' },
    }),
  });

  const createSpaceService = (): DocumentSpaceService =>
    ({
      getAllTypes: () => [
        {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: {
            allowedDocumentTypes: ['comm-doc'],
            defaultDocumentType: 'comm-doc',
          },
          storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
        },
      ],
      getCollection: async () => ({ spaces: [] }),
    }) as unknown as DocumentSpaceService;

  const createGmailClient = (): GoogleGmailClient =>
    ({
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-1',
        messageId: 'msg-1',
        subject: 'Re: Standalone Test Subject',
        date: 'Mon, 19 Oct 2026 10:00:00 +0000',
        attachments: [],
      }),
    }) as unknown as GoogleGmailClient;

  it('initializes parseSchemaRegistry once in standalone fallback mode and retries after rejection', async () => {
    const server = createHttpServer();
    const originalInit = ParseSchemaRegistryAdapter.prototype.initialize;
    let initCalls = 0;
    const initSpy = vi
      .spyOn(ParseSchemaRegistryAdapter.prototype, 'initialize')
      .mockImplementation(async function (this: ParseSchemaRegistryAdapter) {
        initCalls++;
        if (initCalls === 1) {
          throw new Error('Transient parse registry init failure');
        }
        return originalInit.call(this);
      });

    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/comm-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'comm-doc',
        name: 'Comm Doc',
        documentSchema: {
          fields: [
            { key: 'description', name: 'Description', type: 'string' },
          ],
        },
        documentUiSchema: {
          layout: ['description'],
          fields: {
            description: { widget: 'textInput', label: 'Description' },
          },
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'gmail',
              fields: {
                description: { from: 'email.subjectClean' },
              },
            },
          ],
        },
      }),
    };

    wireWorkspaceAddonRoutes({
      server,
      authVerifier: createAuthVerifier(),
      manifestProvider,
      documentSpaceService: createSpaceService(),
      gmailClient: createGmailClient(),
    });

    const payload = {
      hostApp: 'GMAIL',
      gmail: {
        messageId: 'msg-1',
        accessToken: 'ya29.token',
      },
    };

    // First request triggers initialization which rejects -> parseRegistryInitPromise must reset
    const res1 = await server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid' },
      payload,
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.payload).toContain('Transient parse registry init failure');
    expect(initSpy).toHaveBeenCalledTimes(1);

    // Second request retries initialization and succeeds with Pass 2 populated field
    const res2 = await server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid' },
      payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(initSpy).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(res2.payload) as GoogleWorkspaceActionResponse;
    const descWidget = body2.action?.navigations?.[0]?.pushCard?.sections
      .find((s) => s.header === 'Document Data')
      ?.widgets.find((w) => w.textInput?.name?.startsWith('description'));
    expect(descWidget?.textInput?.value).toBe('Standalone Test Subject');

    // Third request reuses the memoized initialization promise (no extra initialize call)
    const res3 = await server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid' },
      payload,
    });
    expect(res3.statusCode).toBe(200);
    expect(initSpy).toHaveBeenCalledTimes(2);

    initSpy.mockRestore();
  });

  it('accepts SourceParserFactory directly in createSourceParser without type casts', async () => {
    const server = createHttpServer();
    const documentSpaceService = createSpaceService();
    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({ documentTypes: [] }),
      readParsedSchema: vi.fn().mockResolvedValue(undefined),
    };

    const sourceParserWiring = createSourceParserWiring({
      spaceTypesProvider: documentSpaceService,
      manifestProvider,
    });
    await sourceParserWiring.parseSchemaRegistry.initialize();

    wireWorkspaceAddonRoutes({
      server,
      authVerifier: createAuthVerifier(),
      manifestProvider,
      documentSpaceService,
      gmailClient: createGmailClient(),
      createSourceParser: sourceParserWiring.createSourceParser,
    });

    const res = await server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid' },
      payload: {
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', accessToken: 'ya29.token' },
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('wires workspace timeZone lazily and driveContextClient in standalone wireWorkspaceAddonRoutes (#307)', async () => {
    const server = createHttpServer();
    const documentSpaceService = createSpaceService();
    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/comm-doc.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'comm-doc',
        name: 'Comm Doc',
        documentSchema: {
          fields: [
            { key: 'date', name: 'Date', type: 'string' },
          ],
        },
        documentUiSchema: {
          layout: ['date'],
          fields: {
            date: { widget: 'textInput', label: 'Date' },
          },
        },
        documentParseSchema: {
          extractors: [
            {
              source: 'drive',
              fields: {
                date: { from: 'drive.modifiedTime' },
              },
            },
          ],
        },
      }),
    };

    let currentTimeZone: string | undefined = undefined;
    const configProvider = {
      getWorkspaceConfig: vi.fn().mockImplementation(async () => ({
        defaultDocumentSpaceType: 'projects',
        defaultDocumentType: 'comm-doc',
        ...(currentTimeZone !== undefined ? { timeZone: currentTimeZone } : {}),
      })),
    };

    const driveContextClient = {
      getFile: vi.fn().mockResolvedValue({
        id: 'drive-file-1',
        name: 'Notes.pdf',
        parents: [],
        modifiedTime: '2026-03-16T02:30:00Z',
      }),
      listSharedDrives: vi.fn().mockResolvedValue({ drives: [] }),
    };

    wireWorkspaceAddonRoutes({
      server,
      authVerifier: createAuthVerifier(),
      manifestProvider,
      configProvider,
      documentSpaceService,
      gmailClient: createGmailClient(),
      driveContextClient,
    });

    currentTimeZone = 'America/New_York';

    const res = await server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid' },
      payload: {
        hostApp: 'DRIVE',
        drive: {
          selectedItems: [{ id: 'drive-file-1', title: 'Notes.pdf' }],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    const dateWidget = body.action?.navigations?.[0]?.pushCard?.sections
      .find((s) => s.header === 'Document Data')
      ?.widgets.find((w) => w.textInput?.name?.startsWith('date'));
    expect(dateWidget?.textInput?.value).toBe('260315');
  });
});

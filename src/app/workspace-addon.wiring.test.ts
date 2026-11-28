import { describe, it, expect, vi } from 'vitest';
import type { docs_v1 } from '@googleapis/docs';
import { createHttpServer } from '../infrastructure/http';
import { GoogleDocsClient } from '../infrastructure/docs';
import { getDocumentInfoWidgetName } from '../features/schema-driven-ui/blocks/document-info';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../features/schema-driven-ui/blocks/document-type-selection';
import { wireWorkspaceAddonRoutes } from './workspace-addon.wiring';
import { createUiProcessManagerWiring } from './ui-process-manager.wiring';
import { createDocumentLogWiring } from './document-log.wiring';
import { createSourceParserWiring } from './source-parser.wiring';
import { ParseSchemaRegistryAdapter } from '../features/source-parser/adapters/parse-schema-registry.adapter';
import { LogSchemaRegistryAdapter } from '../features/document-log';
import { CompiledSchemaRegistry } from '../features/document/adapters/compiled-schema-registry';
import type { DocumentSchemaRegistryPort } from '../features/document/ports';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { SheetsClient } from '../infrastructure/sheets';
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

  it('initializes logSchemaRegistry once in standalone fallback mode, retries after rejection, and caches on success', async () => {
    const server = createHttpServer();
    const originalInit = LogSchemaRegistryAdapter.prototype.initialize;
    let initCalls = 0;
    const initSpy = vi
      .spyOn(LogSchemaRegistryAdapter.prototype, 'initialize')
      .mockImplementation(async function (this: LogSchemaRegistryAdapter) {
        initCalls++;
        if (initCalls === 1) {
          throw new Error('Transient log registry init failure');
        }
        return originalInit.call(this);
      });

    const docTypeDef = {
      key: 'comm-doc',
      name: 'Comm Doc',
      documentSchema: {
        fields: [{ key: 'description', name: 'Description', type: 'string', required: true }],
        identity: { idGroup: '{{description}}', id: '{{description}}' },
      },
      documentUiSchema: {
        layout: ['description'],
        fields: {
          description: { widget: 'textInput', label: 'Description' },
        },
        events: {
          onSubmit: { catchAllWorkflow: 'LogOnly' },
        },
      },
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'LogOnly',
            activitySequence: [{ type: 'WRITE_LOG', payload: {} }],
          },
        ],
      },
      documentLogSchema: {
        provider: 'google_sheets',
        target: {
          sheetName: 'Log',
          rangeName: 'Log_Range',
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
          Description: { template: '{{description}}' },
        },
      },
    };

    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/comm-doc.json'],
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
      readParsedSchema: vi.fn().mockResolvedValue(docTypeDef),
    };

    const documentSchemaRegistry: DocumentSchemaRegistryPort = {
      loadAll: vi.fn().mockResolvedValue([docTypeDef]),
    };
    const compiledSchemaRegistry = new CompiledSchemaRegistry(documentSchemaRegistry);
    await compiledSchemaRegistry.initialize();

    const documentSpaceService = {
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
      getCollection: async () => ({
        spaces: [
          {
            id: 'space-1',
            typeId: 'projects',
            name: 'Harborview',
            abstractStorageId: 'drive-1',
          },
        ],
      }),
    } as unknown as DocumentSpaceService;

    const mockDriveClient = {
      searchFiles: vi.fn().mockResolvedValue([
        {
          id: 'log-sheet-1',
          name: 'Harborview Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]),
    } as unknown as GoogleDriveClient;

    const mockSheetsClient: SheetsClient = {
      readTable: vi.fn(),
      insertIntoGroupedList: vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' }),
      readNamedRange: vi.fn(),
      writeNamedRange: vi.fn(),
    };

    wireWorkspaceAddonRoutes({
      server,
      authVerifier: createAuthVerifier(),
      manifestProvider,
      documentSpaceService,
      documentSchemaRegistry,
      compiledSchemaRegistry,
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
      gmailClient: createGmailClient(),
    });

    const submitPayload = {
      drive: { selectedItems: [{ id: 'file-1', title: 'Notes.pdf' }] },
      commonEventObject: {
        hostApp: 'DRIVE',
        parameters: { action: 'processDocument' },
        formInputs: {
          SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
          [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Harborview'] } },
          [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['comm-doc'] } },
          SelectFiles: { stringInputs: { value: ['file-1'] } },
          [getDocumentInfoWidgetName('description', 'comm-doc')]: {
            stringInputs: { value: ['Initial submittal'] },
          },
        },
      },
    };

    // First request triggers lazy initialization which rejects -> initializer must reset
    const res1 = await server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid' },
      payload: submitPayload,
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.payload).toContain('Transient log registry init failure');
    expect(initSpy).toHaveBeenCalledTimes(1);

    // Second request retries initialization and completes WRITE_LOG
    const res2 = await server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid' },
      payload: submitPayload,
    });
    expect(res2.statusCode).toBe(200);
    expect(initSpy).toHaveBeenCalledTimes(2);
    const res2Body = JSON.parse(res2.payload);
    expect(res2Body.action?.notification).toBeUndefined();
    expect(res2Body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Comm Doc Filed');
    expect(mockSheetsClient.insertIntoGroupedList).toHaveBeenCalledTimes(1);

    // Third request reuses the memoized initialization promise (no extra initialize call)
    const res3 = await server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid' },
      payload: submitPayload,
    });
    expect(res3.statusCode).toBe(200);
    expect(initSpy).toHaveBeenCalledTimes(2);
    expect(mockSheetsClient.insertIntoGroupedList).toHaveBeenCalledTimes(2);

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

  it('wires docsClient in standalone wireWorkspaceAddonRoutes without pre-wired createSourceParser (#321)', async () => {
    const server = createHttpServer();
    const documentSpaceService = {
      getAllTypes: () => [
        {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: {
            allowedDocumentTypes: ['submittal-arch'],
            defaultDocumentType: 'submittal-arch',
          },
          storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
        },
      ],
      getCollection: async () => ({
        spaces: [
          {
            id: 'projects-shared-drive-001',
            typeId: 'projects',
            name: 'Projects Shared Drive 001',
            abstractStorageId: 'projects-shared-drive-001',
          },
        ],
      }),
    } as unknown as DocumentSpaceService;

    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/submittal-arch.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'submittal-arch',
        name: 'Submittal Arch',
        documentSchema: {
          fields: [
            { key: 'section', name: 'Section', type: 'string', required: true, pattern: '^\\d{6}$' },
            { key: 'number', name: 'Number', type: 'string', required: true, pattern: '^\\d{3,}$' },
            { key: 'revision', name: 'Revision', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$' },
          ],
        },
        documentUiSchema: {
          layout: ['section', 'number', 'revision'],
          fields: {
            section: { widget: 'textInput', label: 'Section' },
            number: { widget: 'textInput', label: 'Number' },
            revision: { widget: 'textInput', label: 'Revision' },
          },
        },
        documentFormSchema: {
          fields: {
            'Submittal No': {
              template: '{{section}}-{{number}}-{{revision}}',
            },
          },
        },
        documentParseSchema: {
          extractors: [{ source: 'form' }],
        },
      }),
    };

    const driveContextClient = {
      getFile: vi.fn().mockResolvedValue({
        id: 'gdoc-wiring-321',
        name: 'Waterproofing_Stamped',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['projects-shared-drive-001'],
        driveId: 'projects-shared-drive-001',
      }),
      listSharedDrives: vi.fn().mockResolvedValue({
        drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
      }),
    };

    const mockGet = vi.fn().mockResolvedValue({
      data: {
        documentId: 'gdoc-wiring-321',
        body: null,
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  {
                    table: {
                      rows: 1,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            {
                              content: [
                                { paragraph: { elements: [{ textRun: { content: 'Submittal No.\n' } }] } },
                              ],
                            },
                            {
                              content: [
                                { paragraph: { elements: [{ textRun: { content: '071200-001-1\n' } }] } },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const docsClient = new GoogleDocsClient({
      docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
    });

    wireWorkspaceAddonRoutes({
      server,
      authVerifier: createAuthVerifier(),
      manifestProvider,
      documentSpaceService,
      gmailClient: createGmailClient(),
      driveContextClient,
      docsClient,
    });

    const res = await server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid' },
      payload: {
        hostApp: 'DRIVE',
        drive: {
          selectedItems: [{ id: 'gdoc-wiring-321', title: 'Waterproofing_Stamped' }],
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockGet).toHaveBeenCalledWith(
      {
        documentId: 'gdoc-wiring-321',
        includeTabsContent: true,
        suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
      },
      { timeout: 10_000 }
    );

    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    const docDataSection = body.action?.navigations?.[0]?.pushCard?.sections.find(
      (s) => s.header === 'Document Data'
    );
    const readText = (fieldKey: string) =>
      docDataSection?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
      )?.textInput?.value;

    expect(readText('section')).toBe('071200');
    expect(readText('number')).toBe('001');
    expect(readText('revision')).toBe('1');
  });

  it('memoizes createDocumentSpaceService per request (calling getCollection once across UiProcessManager and UiContextQueryAdapter) and shares one registry initializer across consumers (#349)', async () => {
    const server = createHttpServer();
    const initSpy = vi.spyOn(LogSchemaRegistryAdapter.prototype, 'initialize');

    const docTypeDef = {
      key: 'submittal-arch',
      name: 'Submittal Arch',
      documentSchema: {
        fields: [{ key: 'section', name: 'Section', type: 'string', required: true }],
        identity: { idGroup: '{{section}}', id: '{{section}}' },
      },
      documentUiSchema: {
        layout: ['section'],
        fields: { section: { widget: 'textInput', label: 'Section' } },
        events: { onSubmit: { catchAllWorkflow: 'LogOnly' } },
      },
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'LogOnly',
            activitySequence: [{ type: 'WRITE_LOG', payload: {} }],
          },
        ],
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
          Section: { template: '{{section}}' },
        },
      },
    };

    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/submittal-arch.json'],
        DocumentSpaceTypes: [
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: {
              allowedDocumentTypes: ['submittal-arch'],
              defaultDocumentType: 'submittal-arch',
            },
            storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
          },
          {
            id: 'proposals',
            displayName: 'Proposals',
            spaceSchema: {
              allowedDocumentTypes: ['submittal-arch'],
              defaultDocumentType: 'submittal-arch',
            },
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
      readParsedSchema: vi.fn().mockResolvedValue(docTypeDef),
    };

    const getCollectionSpy = vi.fn().mockImplementation(async (typeId: string) => ({
      type: {
        id: typeId,
        displayName: typeId,
        spaceSchema: { allowedDocumentTypes: ['submittal-arch'], defaultDocumentType: 'submittal-arch' },
        storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
      },
      spaces:
        typeId === 'projects'
          ? [
              {
                id: 'space-proj-1',
                typeId: 'projects',
                name: 'Harborview',
                abstractStorageId: 'drive-proj-1',
              },
            ]
          : [],
    }));

    const createDocumentSpaceService = vi.fn().mockImplementation(
      () =>
        ({
          getAllTypes: () => [
            {
              id: 'projects',
              displayName: 'Projects',
              spaceSchema: {
                allowedDocumentTypes: ['submittal-arch'],
                defaultDocumentType: 'submittal-arch',
              },
              storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
            },
            {
              id: 'proposals',
              displayName: 'Proposals',
              spaceSchema: {
                allowedDocumentTypes: ['submittal-arch'],
                defaultDocumentType: 'submittal-arch',
              },
              storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
            },
          ],
          getCollection: getCollectionSpy,
        }) as unknown as DocumentSpaceService
    );

    const mockDriveClient = {
      searchFiles: vi.fn().mockResolvedValue([
        {
          id: 'log-sheet-1',
          name: 'Harborview Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ]),
    } as unknown as GoogleDriveClient;

    const mockSheetsClient: SheetsClient = {
      readTable: vi.fn(),
      insertIntoGroupedList: vi.fn().mockResolvedValue({ rowNumber: 6, action: 'inserted' }),
      readNamedRange: vi.fn(),
      writeNamedRange: vi.fn(),
    };

    const documentLogWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient: mockDriveClient,
      sheetsClient: mockSheetsClient,
    });

    wireWorkspaceAddonRoutes({
      server,
      authVerifier: createAuthVerifier(),
      manifestProvider,
      createDocumentSpaceService,
      documentLogWiring,
      gmailClient: createGmailClient(),
      createAdditionalActivityHandlers: (ctx) => [
        documentLogWiring.createPerRequestActivityHandler(ctx),
      ],
    });

    const onChangePayload = {
      drive: { selectedItems: [{ id: 'file-1', title: 'Notes.pdf' }] },
      commonEventObject: {
        hostApp: 'DRIVE',
        parameters: { action: 'onFormChange' },
        formInputs: {
          SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
          [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Harborview'] } },
          [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
          SelectFiles: { stringInputs: { value: ['file-1'] } },
        },
      },
    };

    // Request 1: UiProcessManager + UiContextQueryAdapter must invoke createDocumentSpaceService and getCollection('projects') ONLY ONCE
    const res1 = await server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid' },
      payload: onChangePayload,
    });
    expect(res1.statusCode).toBe(200);
    expect(createDocumentSpaceService).toHaveBeenCalledTimes(1);
    expect(getCollectionSpy).toHaveBeenCalledTimes(1);
    expect(getCollectionSpy).toHaveBeenCalledWith('projects');
    expect(initSpy).toHaveBeenCalledTimes(1);

    const body1 = JSON.parse(res1.payload) as GoogleWorkspaceActionResponse;
    const logSection = body1.action?.navigations?.[0]?.updateCard?.sections.find(
      (s) => s.header === 'Document Log'
    );
    expect(logSection).toBeDefined();
    expect(logSection?.widgets[0].decoratedText?.text).toContain('Harborview Document Log');

    // Request 2: Distinct request constructs fresh space service and calls getCollection once more (zero cross-request caching)
    const res2 = await server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid' },
      payload: onChangePayload,
    });
    expect(res2.statusCode).toBe(200);
    expect(createDocumentSpaceService).toHaveBeenCalledTimes(2);
    expect(getCollectionSpy).toHaveBeenCalledTimes(2);
    expect(initSpy).toHaveBeenCalledTimes(1);

    initSpy.mockRestore();
  });

  it('wires uiContextQuery through createUiProcessManagerWiring default SchemaDrivenUiService path (#349)', async () => {
    const mockSpaceService = {
      getAllTypes: () => [
        {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: {
            allowedDocumentTypes: ['submittal-arch'],
            defaultDocumentType: 'submittal-arch',
          },
          storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
        },
      ],
      getCollection: vi.fn().mockResolvedValue({
        spaces: [
          {
            id: 'space-1',
            typeId: 'projects',
            name: 'Harborview',
            abstractStorageId: 'drive-1',
          },
        ],
      }),
    } as unknown as DocumentSpaceService;

    const manifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/submittal-arch.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'submittal-arch',
        name: 'Submittal Arch',
        documentSchema: { fields: [{ key: 'section', type: 'string' }] },
        documentUiSchema: { layout: ['section'], fields: { section: { label: 'Section' } } },
      }),
    };

    const uiContextQuery = {
      queryContext: vi.fn().mockResolvedValue({
        'document-log': {
          status: 'missing',
          spaceName: 'Harborview',
          targetFolderPath: '1 Admin',
          targetFileName: 'Harborview Document Log',
        },
      }),
    };

    const wiring = createUiProcessManagerWiring({
      manifestProvider,
      documentSpaceService: mockSpaceService,
      uiContextQuery,
    });

    const response = (await wiring.requestScopedWrapper.processUiEvent({
      actionName: 'onFormChange',
      formData: {
        SelectDocumentSpaceType: 'projects',
        [getDocumentSpaceWidgetName('projects')]: 'Harborview',
        [getDocumentTypeWidgetName('projects')]: 'submittal-arch',
      },
    })) as GoogleWorkspaceActionResponse;

    expect(uiContextQuery.queryContext).toHaveBeenCalledTimes(1);
    const updateCard = response.action.navigations?.[0]?.updateCard;
    const logSection = updateCard?.sections.find((s) => s.header === 'Document Log');
    expect(logSection).toBeDefined();
    expect(logSection?.widgets).toHaveLength(2);
    expect(logSection?.widgets[0].decoratedText?.text).toContain('Harborview Document Log');
    expect(logSection?.widgets[1].buttonList?.buttons[0].text).toBe('Copy Log');
  });
});

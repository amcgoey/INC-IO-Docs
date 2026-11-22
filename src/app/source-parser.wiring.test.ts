import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  createSourceParserWiring,
} from './source-parser.wiring';
import { SourceParserService } from '../features/source-parser/domain';
import type { DriveSourceContextClientPort, FormExtractorPort } from '../features/source-parser';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';

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

  it('wires HandlebarsAdapter, PdfProcessor, and DriveFormExtractorAdapter per request while supporting formExtractor and googleDocsFormReader overrides (#315)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 400]);
    const form = doc.getForm();
    const radio = form.createRadioGroup('Submittal Response');
    radio.addOptionToPage('No Exceptions Taken', doc.getPage(0), { x: 20, y: 300, width: 12, height: 12 });
    radio.select('No Exceptions Taken');
    const stampedBytes = await doc.save();

    const mockManifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./types/submittal-arch.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue({
        key: 'submittal-arch',
        documentSchema: {
          fields: [
            {
              key: 'action',
              type: 'string',
              options: { source: 'actions', key: 'key', name: 'name' },
            },
          ],
          options: {
            actions: [{ key: 'NET', name: 'No Exceptions Taken' }],
          },
        },
        documentFormSchema: {
          fields: {
            'Submittal Response': { template: '{{action.name}}' },
          },
        },
        documentParseSchema: {
          extractors: [{ source: 'form' }],
        },
      }),
    };

    const getFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
      id: 'pdf-1',
      name: 'Stamped.pdf',
      mimeType: 'application/pdf',
      parents: [],
    });
    const downloadMediaSpy = vi
      .spyOn(GoogleDriveClient.prototype, 'downloadFileMedia')
      .mockResolvedValue(stampedBytes);

    try {
      // Production mode (no driveContextClient): uses per-request GoogleDriveClient for both metadata & media
      const wiring = createSourceParserWiring({
        spaceTypesProvider: mockSpaceTypesProvider,
        manifestProvider: mockManifestProvider,
      });

      await wiring.parseSchemaRegistry.initialize();

      const req1Parser = wiring.createSourceParser({ userOAuthToken: 'token-1' });
      const res1 = await req1Parser.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'pdf-1' }] },
      });
      expect(res1.fields.action).toBe('NET');

      // Second request has fresh DriveFormExtractorAdapter cache
      const req2Parser = wiring.createSourceParser({ userOAuthToken: 'token-2' });
      const res2 = await req2Parser.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'pdf-1' }] },
      });
      expect(res2.fields.action).toBe('NET');
      expect(getFileSpy).toHaveBeenCalledTimes(2);
      expect(downloadMediaSpy).toHaveBeenCalledTimes(2);

      // With driveContextClient mock + googleDocsFormReader slot
      const mockDriveContextClient: DriveSourceContextClientPort = {
        getFile: vi.fn().mockResolvedValue({
          id: 'gdoc-1',
          name: 'Cover Sheet',
          mimeType: 'application/vnd.google-apps.document',
          parents: [],
        }),
      };
      const googleDocsFormReader = {
        extractDocumentFormFields: vi.fn().mockResolvedValue({
          widgetCount: 1,
          fields: { 'Submittal Response': 'No Exceptions Taken' },
        }),
      };
      const docsWiring = createSourceParserWiring({
        spaceTypesProvider: mockSpaceTypesProvider,
        manifestProvider: mockManifestProvider,
        driveContextClient: mockDriveContextClient,
        googleDocsFormReader,
      });
      await docsWiring.parseSchemaRegistry.initialize();
      const docsRes = await docsWiring.createSourceParser({}).extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'gdoc-1' }] },
      });
      expect(docsRes.fields.action).toBe('NET');
      expect(googleDocsFormReader.extractDocumentFormFields).toHaveBeenCalledWith('gdoc-1');

      // With explicit formExtractor override
      const overrideExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 1,
          fields: { 'Submittal Response': 'NET' },
        }),
      };
      const overrideWiring = createSourceParserWiring({
        spaceTypesProvider: mockSpaceTypesProvider,
        manifestProvider: mockManifestProvider,
        driveContextClient: {
          getFile: vi.fn().mockResolvedValue({
            id: 'pdf-override',
            name: 'Override.pdf',
            mimeType: 'application/pdf',
            parents: [],
          }),
        },
        formExtractor: overrideExtractor,
      });
      await overrideWiring.parseSchemaRegistry.initialize();
      const overrideRes = await overrideWiring.createSourceParser({}).extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'pdf-override' }] },
      });
      expect(overrideRes.fields.action).toBe('NET');
      expect(overrideExtractor.extractFormFields).toHaveBeenCalledWith({
        id: 'pdf-override',
        mimeType: 'application/pdf',
      });
    } finally {
      getFileSpy.mockRestore();
      downloadMediaSpy.mockRestore();
    }
  });

  it('resolves FormTemplateParserPort from templateEvaluator option when parseMustacheTemplate is present', async () => {
    const customParseMustache = vi.fn().mockReturnValue({
      tokens: [{ original: 'action.name', parts: ['action', 'name'] }],
      literals: ['', ''],
    });
    const wiring = createSourceParserWiring({
      spaceTypesProvider: { getAllTypes: () => [] },
      manifestProvider: {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./types/submittal-arch.json'],
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'submittal-arch',
          documentSchema: {
            fields: [
              {
                key: 'action',
                type: 'string',
                options: { source: 'actions', key: 'key', name: 'name' },
              },
            ],
            options: {
              actions: [{ key: 'NET', name: 'No Exceptions Taken' }],
            },
          },
          documentFormSchema: {
            fields: {
              'Submittal Response': { template: '{{action.name}}' },
            },
          },
          documentParseSchema: {
            extractors: [{ source: 'form' }],
          },
        }),
      },
      templateEvaluator: {
        parseMustacheTemplate: customParseMustache,
      },
    });

    await wiring.parseSchemaRegistry.initialize();
    expect(customParseMustache).toHaveBeenCalledWith('{{action.name}}');

    // Non-matching templateEvaluator falls back cleanly to default HandlebarsAdapter
    const fallbackWiring = createSourceParserWiring({
      spaceTypesProvider: { getAllTypes: () => [] },
      manifestProvider: {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./types/submittal-arch.json'],
        }),
        readParsedSchema: vi.fn().mockResolvedValue({
          key: 'submittal-arch',
          documentSchema: {
            fields: [{ key: 'date', type: 'string' }],
          },
          documentFormSchema: {
            fields: {
              Date: { template: '{{date}}' },
            },
          },
        }),
      },
      templateEvaluator: { evaluate: vi.fn() },
    });

    await expect(fallbackWiring.parseSchemaRegistry.initialize()).resolves.toBeUndefined();
  });
});

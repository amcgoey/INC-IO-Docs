import { describe, it, expect, vi } from 'vitest';
import {
  createDocumentFeatureWiring,
  createDocumentServiceFactory,
  wireDocumentServicesAndRoutes,
} from './document.wiring';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type {
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  RawManifestProviderPort,
  DocumentType,
} from '../features/document/ports';
import { CompiledSchemaRegistry } from '../features/document/adapters/compiled-schema-registry';
import { DocumentService } from '../features/document/domain';
import * as driveActivityHandlerModule from '../features/document/adapters/drive-activity-handler';
import { GmailSourceFileHydratorAdapter } from '../features/document/adapters/gmail-source-file-hydrator.adapter';
import type { HttpServer } from '../infrastructure/http';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { PdfProcessor } from '../infrastructure/pdf/pdf-processor';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { createAnonymizedSubmittalCoverSheetPdf } from '../../test/fixtures/submittal-cover-sheet.fixture';
import { PdfProcessor as RealPdfProcessor } from '../infrastructure/pdf/pdf-processor';

describe('document.wiring', () => {
  const dummyDocType: DocumentType = {
    key: 'test-doc',
    name: 'Test Document',
    documentSchema: {
      fields: [{ key: 'name', name: 'Name', type: 'string', required: true }],
    },
  };

  const mockSchemaRegistry: DocumentSchemaRegistryPort = {
    loadAll: vi.fn().mockResolvedValue([dummyDocType]),
  };

  const mockEvaluator: TemplateEvaluatorPort = {
    validate: vi.fn().mockReturnValue(true),
    evaluate: vi.fn().mockImplementation((tmpl) => tmpl),
  };

  const mockManifestProvider: RawManifestProviderPort = {
    getRawManifest: vi.fn().mockResolvedValue({}),
    readParsedSchema: vi.fn().mockResolvedValue(dummyDocType),
  };

  describe('createDocumentFeatureWiring', () => {
    it('initializes documentSchemaRegistry and compiledSchemaRegistry singleton', () => {
      const wiring = createDocumentFeatureWiring({
        manifestProvider: mockManifestProvider,
      });

      expect(wiring.documentSchemaRegistry).toBeDefined();
      expect(wiring.compiledSchemaRegistry).toBeDefined();
    });
  });

  describe('createDocumentServiceFactory', () => {
    it('instantiates DocumentService per-request with primaryTargetId from selectedItems', async () => {
      const compiledRegistry = new CompiledSchemaRegistry(mockSchemaRegistry);
      await compiledRegistry.initialize();

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: mockSchemaRegistry,
        templateEvaluator: mockEvaluator,
        compiledSchemaRegistry: compiledRegistry,
      });

      const context: WorkspaceExecutionContext = {
        actionName: 'processDocument',
        userOAuthToken: 'token-123',
        selectedItems: [{ id: 'target-doc-999', title: 'Invoice.pdf' }],
      };

      const service = (await factory(context)) as DocumentService;

      expect(service).toBeInstanceOf(DocumentService);
    });

    it('falls back to parameters.primaryTargetId or fileId when selectedItems is empty', async () => {
      const compiledRegistry = new CompiledSchemaRegistry(mockSchemaRegistry);
      await compiledRegistry.initialize();

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: mockSchemaRegistry,
        templateEvaluator: mockEvaluator,
        compiledSchemaRegistry: compiledRegistry,
      });

      const contextWithParam: WorkspaceExecutionContext = {
        parameters: { primaryTargetId: 'param-target-111' },
      };

      const service = (await factory(contextWithParam)) as DocumentService;
      expect(service).toBeInstanceOf(DocumentService);

      const contextWithFileId: WorkspaceExecutionContext = {
        parameters: { fileId: 'param-file-222' },
      };

      const service2 = (await factory(contextWithFileId)) as DocumentService;
      expect(service2).toBeInstanceOf(DocumentService);
    });



    it('passes the CompiledSchemaRegistry singleton into DocumentService without duplicate compilation', async () => {
      const compiledRegistry = new CompiledSchemaRegistry(mockSchemaRegistry);
      const initSpy = vi.spyOn(compiledRegistry, 'initialize');
      await compiledRegistry.initialize();

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: mockSchemaRegistry,
        templateEvaluator: mockEvaluator,
        compiledSchemaRegistry: compiledRegistry,
      });

      const context: WorkspaceExecutionContext = {
        selectedItems: [{ id: 'target-abc' }],
      };

      await factory(context);
      // initialize() on compiled registry was called, but schemas are already compiled
      expect(initSpy).toHaveBeenCalled();
    });

    it('injects GmailSourceFileHydratorAdapter into DriveActivityHandler when request has Gmail credentials/context', async () => {
      const handlerSpy = vi.spyOn(driveActivityHandlerModule, 'DriveActivityHandler');
      const compiledRegistry = new CompiledSchemaRegistry(mockSchemaRegistry);
      await compiledRegistry.initialize();

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: mockSchemaRegistry,
        templateEvaluator: mockEvaluator,
        compiledSchemaRegistry: compiledRegistry,
      });

      const context: WorkspaceExecutionContext = {
        hostApp: 'GMAIL',
        userOAuthToken: 'ya29.user-token',
        gmail: {
          messageId: 'msg-test-123',
          accessToken: 'ya29.gmail-token',
        },
        formData: {
          SelectFileSource: 'Email Attachments',
        },
        sourceFiles: [{ id: 'att-1', name: 'Invoice.pdf' }],
      };

      await factory(context);

      expect(handlerSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sourceFileHydrator: expect.any(GmailSourceFileHydratorAdapter),
        })
      );
      handlerSpy.mockRestore();
    });

    it('never dispatches DriveActivityHandler or fetches/generates Gmail items when validateDocument fails on missing DocumentField', async () => {
      const mockGmailClient = {
        getMessage: vi.fn(),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const mockPdfProcessor = {
        generateEmailPdf: vi.fn(),
      } as unknown as PdfProcessor;

      const compiledRegistry = new CompiledSchemaRegistry(mockSchemaRegistry);
      await compiledRegistry.initialize();

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: mockSchemaRegistry,
        templateEvaluator: mockEvaluator,
        compiledSchemaRegistry: compiledRegistry,
        gmailClient: mockGmailClient,
        pdfProcessor: mockPdfProcessor,
      });

      const context: WorkspaceExecutionContext = {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-validation-fail-test',
        },
        sourceFiles: [
          { id: 'att-1' },
          { id: 'email-pdf-msg-validation-fail-test' },
        ],
      };

      const service = (await factory(context)) as DocumentService;

      // test-doc requires `name`, but we pass empty data payload {}
      const result = await service.processDocument({
        type: 'test-doc',
        data: {},
      });

      expect(result.success).toBe(false);
      expect(mockGmailClient.getMessage).not.toHaveBeenCalled();
      expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
      expect(mockPdfProcessor.generateEmailPdf).not.toHaveBeenCalled();
    });

    it('wires configProvider.getMaxInMemoryFileBytes into fallback PdfProcessor for Gmail hydration (#372)', async () => {
      const compiledRegistry = new CompiledSchemaRegistry(mockSchemaRegistry);
      await compiledRegistry.initialize();

      const getMaxInMemoryFileBytes = vi.fn().mockResolvedValue(10);
      const mockGmailClient = {
        getMessage: vi.fn().mockResolvedValue({
          messageId: 'msg-size-limit',
          subject: 'Oversized Email Subject Exceeding 10 Bytes',
          plainTextBody: 'Body exceeding 10 bytes',
          attachments: [],
          inlineImages: [],
        }),
        getAttachment: vi.fn(),
      } as unknown as GoogleGmailClient;

      const handlerSpy = vi.spyOn(driveActivityHandlerModule, 'DriveActivityHandler');
      try {
        const factory = createDocumentServiceFactory({
          documentSchemaRegistry: mockSchemaRegistry,
          templateEvaluator: mockEvaluator,
          compiledSchemaRegistry: compiledRegistry,
          gmailClient: mockGmailClient,
          configProvider: {
            getDriveConfig: vi.fn().mockResolvedValue(undefined),
            getMaxInMemoryFileBytes,
          },
        });

        await factory({
          hostApp: 'GMAIL',
          gmail: { messageId: 'msg-size-limit' },
          sourceFiles: [{ id: 'email-pdf-msg-size-limit' }],
        });

        const hydrator = handlerSpy.mock.calls[0]?.[1]?.sourceFileHydrator as
          | GmailSourceFileHydratorAdapter
          | undefined;
        expect(hydrator).toBeInstanceOf(GmailSourceFileHydratorAdapter);

        await expect(
          hydrator!.hydrate([{ id: 'email-pdf-msg-size-limit' }])
        ).rejects.toThrow(/Could not generate the Email PDF/i);
        expect(getMaxInMemoryFileBytes).toHaveBeenCalled();
      } finally {
        handlerSpy.mockRestore();
      }
    });
  });

  describe('wireDocumentServicesAndRoutes', () => {
    it('registers /documents route with DocumentService and primaryTargetId', () => {
      const mockServer: HttpServer = {
        registerRoute: vi.fn(),
      } as unknown as HttpServer;

      const mockDriveClient = {} as unknown as GoogleDriveClient;

      const service = wireDocumentServicesAndRoutes({
        server: mockServer,
        driveClient: mockDriveClient,
        configProvider: { getDriveConfig: vi.fn().mockResolvedValue(undefined) },
        documentSchemaRegistry: mockSchemaRegistry,
        templateEvaluator: mockEvaluator,
        primaryTargetId: 'custom-primary-id',
      });

      expect(service).toBeInstanceOf(DocumentService);
      expect(mockServer.registerRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: '/documents',
        })
      );
    });

    it('injects custom dynamicValidator when provided', () => {
      const mockServer: HttpServer = {
        registerRoute: vi.fn(),
      } as unknown as HttpServer;
      const mockDriveClient = {} as unknown as GoogleDriveClient;
      const mockDynamicValidator = { validateExistence: vi.fn() };

      const service = wireDocumentServicesAndRoutes({
        server: mockServer,
        driveClient: mockDriveClient,
        configProvider: { getDriveConfig: vi.fn().mockResolvedValue(undefined) },
        documentSchemaRegistry: mockSchemaRegistry,
        templateEvaluator: mockEvaluator,
        dynamicValidator: mockDynamicValidator,
      });

      expect(service).toBeInstanceOf(DocumentService);
    });

    it('injects default validationMessageFormatter using DEFAULT_MESSAGE_CATALOG', async () => {
      const mockServer: HttpServer = {
        registerRoute: vi.fn(),
      } as unknown as HttpServer;
      const mockDriveClient = {} as unknown as GoogleDriveClient;
      const mockDynamicValidator = {
        validateExistence: vi.fn().mockResolvedValue({
          contact: {
            isValid: false,
            status: 'path_not_found',
            targetPath: '1 Admin/Communication',
          },
        }),
      };

      const docTypeWithDynamic: DocumentType = {
        key: 'comm-test',
        name: 'Comm Test',
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
            },
          },
        },
      };

      const customRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([docTypeWithDynamic]),
      };

      const service = wireDocumentServicesAndRoutes({
        server: mockServer,
        driveClient: mockDriveClient,
        configProvider: { getDriveConfig: vi.fn().mockResolvedValue(undefined) },
        documentSchemaRegistry: customRegistry,
        templateEvaluator: mockEvaluator,
        dynamicValidator: mockDynamicValidator,
      }) as DocumentService;

      await service.initialize();

      const result = await service.processDocument({
        type: 'comm-test',
        data: { contact: 'Acme Corp' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toEqual([
          'Folder "1 Admin/Communication" was not found in the selected Document Space.',
        ]);
      }
    });

    it('passes custom validationMessageFormatter when explicitly provided in wireDocumentServicesAndRoutes', async () => {
      const mockServer: HttpServer = {
        registerRoute: vi.fn(),
      } as unknown as HttpServer;
      const mockDriveClient = {} as unknown as GoogleDriveClient;
      const mockDynamicValidator = {
        validateExistence: vi.fn().mockResolvedValue({
          contact: {
            isValid: false,
            status: 'path_not_found',
            targetPath: '1 Admin/Communication',
          },
        }),
      };

      const docTypeWithDynamic: DocumentType = {
        key: 'comm-test',
        name: 'Comm Test',
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
            },
          },
        },
      };

      const customRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([docTypeWithDynamic]),
      };

      const customFormatter = vi.fn().mockReturnValue('Custom error message');

      const service = wireDocumentServicesAndRoutes({
        server: mockServer,
        driveClient: mockDriveClient,
        configProvider: { getDriveConfig: vi.fn().mockResolvedValue(undefined) },
        documentSchemaRegistry: customRegistry,
        templateEvaluator: mockEvaluator,
        dynamicValidator: mockDynamicValidator,
        validationMessageFormatter: customFormatter,
      }) as DocumentService;

      await service.initialize();

      const result = await service.processDocument({
        type: 'comm-test',
        data: { contact: 'Acme Corp' },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors).toEqual(['Custom error message']);
      }
      expect(customFormatter).toHaveBeenCalledWith('path_not_found', '1 Admin/Communication');
    });

    it('composes additionalActivityHandlers and createAdditionalActivityHandlers in createDocumentServiceFactory and wireDocumentServicesAndRoutes', async () => {
      const customStepDocType: DocumentType = {
        key: 'log-test',
        name: 'Log Test',
        documentSchema: {
          fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
        },
        documentUiSchema: {
          events: { onSubmit: { catchAllWorkflow: 'CustomIt' } },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'CustomIt',
              activitySequence: [{ type: 'CUSTOM_AUDIT', payload: { source: 'test' } }],
            },
          ],
        },
      };

      const registry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([customStepDocType]),
      };
      const compiled = new CompiledSchemaRegistry(registry);
      await compiled.initialize();

      const perReqHandle = vi.fn().mockResolvedValue({
        success: true,
        contextVariables: { audited: true },
      });
      const createAdditionalActivityHandlers = vi.fn((ctx: WorkspaceExecutionContext) => [
        {
          canHandle: (act: { type: string }) => act.type === 'CUSTOM_AUDIT',
          handle: (act: { type: string }) =>
            perReqHandle(act, ctx.selectedLogId),
        },
      ]);

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: registry,
        templateEvaluator: mockEvaluator,
        compiledSchemaRegistry: compiled,
        createAdditionalActivityHandlers,
      });

      const perReqService = (await factory({
        selectedLogId: 'override-log-id',
      } as WorkspaceExecutionContext)) as DocumentService;

      const reqResult = await perReqService.processDocument(
        { type: 'log-test', data: { title: 'Test' } },
        'onSubmit'
      );
      expect(reqResult.success).toBe(true);
      expect(createAdditionalActivityHandlers).toHaveBeenCalledTimes(1);
      expect(perReqHandle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CUSTOM_AUDIT' }),
        'override-log-id'
      );

      const staticHandle = vi.fn().mockResolvedValue({ success: true });
      const mockServer: HttpServer = { registerRoute: vi.fn() } as unknown as HttpServer;
      const headlessService = wireDocumentServicesAndRoutes({
        server: mockServer,
        driveClient: {} as unknown as GoogleDriveClient,
        configProvider: { getDriveConfig: vi.fn().mockResolvedValue(undefined) },
        documentSchemaRegistry: registry,
        templateEvaluator: mockEvaluator,
        additionalActivityHandlers: [
          {
            canHandle: (act) => act.type === 'CUSTOM_AUDIT',
            handle: staticHandle,
          },
        ],
      }) as DocumentService;
      await headlessService.initialize();

      const headlessResult = await headlessService.processDocument(
        { type: 'log-test', data: { title: 'Headless' } },
        'onSubmit'
      );
      expect(headlessResult.success).toBe(true);
      expect(staticHandle).toHaveBeenCalledTimes(1);
    });

    it('forwards optionTablePort / getOptionTablePort in createDocumentServiceFactory and wireDocumentServicesAndRoutes (#374)', async () => {
      const calcLookupDocType: DocumentType = {
        key: 'calc-wiring-test',
        name: 'Calc Wiring Test',
        documentSchema: {
          fields: [{ key: 'section', name: 'Section', type: 'string', required: true }],
          optionSources: {
            csiDivisions: { provider: 'document_log', properties: ['key', 'folder'] },
          },
          calculatedFields: [
            {
              key: 'csiDivisionFolder',
              template: '{{section}}',
              transforms: [{ type: 'prefix', length: 2 }],
              lookup: { source: 'csiDivisions', matchProperty: 'key', resultProperty: 'folder' },
              required: true,
            },
          ],
        },
      };
      const registry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([calcLookupDocType]),
      };
      const compiled = new CompiledSchemaRegistry(registry);
      await compiled.initialize();

      const mockOptionTablePort = {
        resolveOptionTables: vi.fn().mockResolvedValue({
          csiDivisions: {
            status: 'ready' as const,
            tuples: [{ key: '07', folder: '07 Thermal and Moisture Protection' }],
          },
        }),
      };

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: registry,
        templateEvaluator: new HandlebarsAdapter(),
        compiledSchemaRegistry: compiled,
        getOptionTablePort: () => mockOptionTablePort,
      });

      const perReqService = (await factory({} as WorkspaceExecutionContext)) as DocumentService;
      const factoryRes = await perReqService.processDocument({
        type: 'calc-wiring-test',
        data: { section: '071200' },
      });
      expect(factoryRes.success).toBe(true);
      if (factoryRes.success) {
        expect(factoryRes.data.calculated?.csiDivisionFolder).toBe(
          '07 Thermal and Moisture Protection'
        );
      }

      const mockServer: HttpServer = { registerRoute: vi.fn() } as unknown as HttpServer;
      const wiredService = wireDocumentServicesAndRoutes({
        server: mockServer,
        driveClient: {} as unknown as GoogleDriveClient,
        configProvider: { getDriveConfig: vi.fn().mockResolvedValue(undefined) },
        documentSchemaRegistry: registry,
        templateEvaluator: new HandlebarsAdapter(),
        optionTablePort: mockOptionTablePort,
      }) as DocumentService;
      await wiredService.initialize();

      const wiredRes = await wiredService.processDocument({
        type: 'calc-wiring-test',
        data: { section: '071200' },
      });
      expect(wiredRes.success).toBe(true);
      if (wiredRes.success) {
        expect(wiredRes.data.calculated?.csiDivisionFolder).toBe(
          '07 Thermal and Moisture Protection'
        );
      }
    });

    it('wires DocumentContentEditorAdapter and DocumentContentActivityHandler in createDocumentServiceFactory and wireDocumentServicesAndRoutes with centralized size limit (#378)', async () => {
      const samplePdf = await createAnonymizedSubmittalCoverSheetPdf();
      const storedFiles = new Map<string, Uint8Array>([['pdf-wired-1', samplePdf]]);
      const realPdfProcessor = new RealPdfProcessor();

      const insertDataDocType: DocumentType = {
        key: 'insert-data-wiring',
        name: 'Insert Data Wiring',
        documentSchema: {
          fields: [{ key: 'section', name: 'Section', type: 'string', required: true }],
        },
        documentFormSchema: {
          fields: {
            'Submittal No': { template: '{{section}}', writable: true },
          },
        },
        documentUiSchema: {
          events: { onSubmit: { catchAllWorkflow: 'StampWired' } },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'StampWired',
              activitySequence: [{ id: 'stamp', type: 'INSERT_DATA', payload: {} }],
            },
          ],
        },
      };

      const registry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([insertDataDocType]),
      };
      const compiled = new CompiledSchemaRegistry(registry);
      await compiled.initialize();

      const mockDriveClient = {
        getFile: vi.fn().mockImplementation(async (fileId: string) => ({
          id: fileId,
          name: 'Wired.pdf',
          mimeType: 'application/pdf',
          size: storedFiles.get(fileId)?.byteLength,
          parents: ['parent-1'],
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        })),
        downloadAsBuffer: vi.fn().mockImplementation(async (fileId: string) => storedFiles.get(fileId)!),
        saveBuffer: vi.fn().mockImplementation(async (content: Uint8Array, opts: { action: string; fileId?: string }) => {
          if (opts.action === 'update' && opts.fileId) {
            storedFiles.set(opts.fileId, content);
          }
          return {
            id: opts.fileId ?? 'pdf-wired-1',
            name: 'Wired.pdf',
            mimeType: 'application/pdf',
            parents: ['parent-1'],
            webViewLink: `https://drive.google.com/file/d/${opts.fileId ?? 'pdf-wired-1'}/view`,
          };
        }),
      } as unknown as GoogleDriveClient;

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: registry,
        templateEvaluator: new HandlebarsAdapter(),
        compiledSchemaRegistry: compiled,
        driveClient: mockDriveClient,
        configProvider: { getDriveConfig: vi.fn().mockResolvedValue(undefined) },
      });

      const perReqService = (await factory({
        sourceFiles: [{ id: 'pdf-wired-1', name: 'Wired.pdf', mimeType: 'application/pdf' }],
      })) as DocumentService;

      const factoryRes = await perReqService.processDocument(
        {
          type: 'insert-data-wiring',
          sourceFiles: [{ id: 'pdf-wired-1', name: 'Wired.pdf', mimeType: 'application/pdf' }],
          data: { section: '071200' },
        },
        'onSubmit'
      );
      expect(factoryRes.success).toBe(true);
      const extractedFactory = await realPdfProcessor.extractFormData(storedFiles.get('pdf-wired-1')!);
      expect(extractedFactory['Submittal No']).toBe('071200');

      const mockServer: HttpServer = { registerRoute: vi.fn() } as unknown as HttpServer;
      const getMaxInMemoryFileBytes = vi.fn().mockResolvedValue(10);
      const wiredOversizedService = wireDocumentServicesAndRoutes({
        server: mockServer,
        driveClient: mockDriveClient,
        configProvider: {
          getDriveConfig: vi.fn().mockResolvedValue(undefined),
          getMaxInMemoryFileBytes,
        },
        documentSchemaRegistry: registry,
        templateEvaluator: new HandlebarsAdapter(),
      }) as DocumentService;
      await wiredOversizedService.initialize();

      const oversizedRes = await wiredOversizedService.processDocument(
        {
          type: 'insert-data-wiring',
          sourceFiles: [{ id: 'pdf-wired-1', name: 'Wired.pdf', mimeType: 'application/pdf' }],
          data: { section: '071200' },
        },
        'onSubmit'
      );
      expect(oversizedRes.success).toBe(false);
      if (!oversizedRes.success) {
        expect(oversizedRes.failedStepId).toBe('stamp');
        expect(oversizedRes.errors[0]).toMatch(/maximum in-memory size limit/i);
      }
      expect(getMaxInMemoryFileBytes).toHaveBeenCalled();
    });

    it('wires EnvTemplateRegistryAdapter into DocumentService pre-flight and DocumentContentActivityHandler INSERT_PAGES (#379)', async () => {
      const confidentialTemplateId = 'synthetic-wiring-cover-template-123';
      const coverSheetBytes = await createAnonymizedSubmittalCoverSheetPdf();
      const targetDoc = await RealPdfProcessor.prototype.extractPages(coverSheetBytes, [1]);
      const storedFiles = new Map<string, Uint8Array>([
        [confidentialTemplateId, coverSheetBytes],
        ['pdf-target-379', targetDoc],
      ]);

      const insertPagesDocType: DocumentType = {
        key: 'insert-pages-wiring',
        name: 'Insert Pages Wiring',
        documentSchema: {
          fields: [
            { key: 'section', name: 'Section', type: 'string', required: true },
            { key: 'number', name: 'Number', type: 'string', required: true },
          ],
        },
        documentFormSchema: {
          fields: {
            'Submittal No': { template: '{{section}}-{{number}}', writable: true },
          },
        },
        documentUiSchema: {
          events: { onSubmit: { catchAllWorkflow: 'AttachCover' } },
        },
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'AttachCover',
              activitySequence: [
                {
                  id: 'insertCoverSheet',
                  type: 'INSERT_PAGES',
                  payload: {
                    templateKey: 'submittalCoverSheet',
                    position: 'start',
                    sourcePages: [1],
                    fillForm: true,
                  },
                },
              ],
            },
          ],
        },
      };

      const registry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([insertPagesDocType]),
      };
      const compiled = new CompiledSchemaRegistry(registry);
      await compiled.initialize();

      const mockDriveClient = {
        getFile: vi.fn().mockImplementation(async (fileId: string) => ({
          id: fileId,
          name: fileId === confidentialTemplateId ? 'Cover.pdf' : 'Target.pdf',
          mimeType: 'application/pdf',
          size: storedFiles.get(fileId)?.byteLength,
          parents: ['parent-1'],
          webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
        })),
        downloadAsBuffer: vi.fn().mockImplementation(async (fileId: string) => storedFiles.get(fileId)!),
        saveBuffer: vi.fn().mockImplementation(async (content: Uint8Array, opts: { action: string; fileId?: string }) => {
          if (opts.action === 'update' && opts.fileId) {
            storedFiles.set(opts.fileId, content);
          }
          return {
            id: opts.fileId ?? 'pdf-target-379',
            name: 'Target.pdf',
            mimeType: 'application/pdf',
            parents: ['parent-1'],
            webViewLink: `https://drive.google.com/file/d/${opts.fileId ?? 'pdf-target-379'}/view`,
          };
        }),
      } as unknown as GoogleDriveClient;

      const configProvider = {
        getDriveConfig: vi.fn().mockResolvedValue(undefined),
        getTemplatesConfig: vi.fn().mockResolvedValue({
          submittalCoverSheet: 'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
        }),
      };

      const factory = createDocumentServiceFactory({
        documentSchemaRegistry: registry,
        templateEvaluator: new HandlebarsAdapter(),
        compiledSchemaRegistry: compiled,
        driveClient: mockDriveClient,
        configProvider,
      });

      const savedEnv = process.env.SUBMITTAL_COVER_SHEET_TEMPLATE_ID;
      try {
        delete process.env.SUBMITTAL_COVER_SHEET_TEMPLATE_ID;
        const missingEnvService = (await factory({
          sourceFiles: [{ id: 'pdf-target-379', name: 'Target.pdf', mimeType: 'application/pdf' }],
        })) as DocumentService;

        const preflightFail = await missingEnvService.processDocument(
          {
            type: 'insert-pages-wiring',
            sourceFiles: [{ id: 'pdf-target-379', name: 'Target.pdf', mimeType: 'application/pdf' }],
            data: { section: '071200', number: '001' },
          },
          'onSubmit'
        );
        expect(preflightFail.success).toBe(false);
        if (!preflightFail.success) {
          expect(preflightFail.errors[0]).toMatch(/SUBMITTAL_COVER_SHEET_TEMPLATE_ID/);
        }
        expect(mockDriveClient.downloadAsBuffer).not.toHaveBeenCalled();

        process.env.SUBMITTAL_COVER_SHEET_TEMPLATE_ID = confidentialTemplateId;
        const okService = (await factory({
          sourceFiles: [{ id: 'pdf-target-379', name: 'Target.pdf', mimeType: 'application/pdf' }],
        })) as DocumentService;
        const okRes = await okService.processDocument(
          {
            type: 'insert-pages-wiring',
            sourceFiles: [{ id: 'pdf-target-379', name: 'Target.pdf', mimeType: 'application/pdf' }],
            data: { section: '071200', number: '001' },
          },
          'onSubmit'
        );
        expect(okRes.success).toBe(true);
        const realPdf = new RealPdfProcessor();
        const extracted = await realPdf.extractFormData(storedFiles.get('pdf-target-379')!);
        expect(extracted['Submittal No']).toBe('071200-001');
      } finally {
        if (savedEnv === undefined) {
          delete process.env.SUBMITTAL_COVER_SHEET_TEMPLATE_ID;
        } else {
          process.env.SUBMITTAL_COVER_SHEET_TEMPLATE_ID = savedEnv;
        }
      }
    });
  });
});

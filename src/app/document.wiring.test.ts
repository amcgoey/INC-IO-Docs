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
                dynamicConfig: {
                  provider: 'google_drive',
                  method: 'list_folders',
                  relativePath: '1 Admin/Communication',
                },
              },
            },
          ],
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
                dynamicConfig: {
                  provider: 'google_drive',
                  method: 'list_folders',
                  relativePath: '1 Admin/Communication',
                },
              },
            },
          ],
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
  });
});

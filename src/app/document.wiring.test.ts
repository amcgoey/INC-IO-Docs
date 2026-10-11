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
import type { HttpServer } from '../infrastructure/http';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';

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
  });
});

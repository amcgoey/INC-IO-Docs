import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceUiOrchestratorPort,
} from '../infrastructure/workspace-addon/api';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { evaluateFormChange } from '../infrastructure/workspace-addon/json-logic-evaluator';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { HttpServer } from '../infrastructure/http';
import {
  createDocumentServiceFactory,
  type InjectedDocumentService,
} from './document.wiring';
import {
  createDocumentSpaceServiceFactory,
} from './document-space.wiring';
import type {
  DocumentSpaceCollection,
  DocumentSpaceService,
} from '../features/document-space/domain';
import {
  createUiProcessManagerWiring,
  type DocumentServiceFactory,
  type DocumentSpaceServiceFactory,
  type SchemaDrivenUiServiceFactory,
} from './ui-process-manager.wiring';
import { createSchemaDrivenUiWiring } from './schema-driven-ui.wiring';
import { DynamicOptionsAdapter } from './dynamic-options.adapter';
import { UiContextQueryAdapter } from './ui-context-query.adapter';
import type {
  RawManifestProviderPort,
  UiProcessDocumentLogPort,
} from '../features/ui-process-manager';
import type { WorkspaceConfigProviderPort } from '../infrastructure/workspace-addon/config';
import type {
  ActivityHandler,
  CompiledSchemaRegistryPort,
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  AppConfigurationProviderPort,
} from '../features/document/ports';
import { createSourceParserWiring } from './source-parser.wiring';
import type {
  SourceParserPort,
  CanonicalOptionsProviderPort,
  DriveSourceContextClientPort,
} from '../features/source-parser';
import type { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';
import type { DocumentSpaceStoragePort } from '../features/document-space/ports';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { GoogleDocsClient } from '../infrastructure/docs';
import { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { UiProcessGmailPort } from '../features/ui-process-manager';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import type { PdfProcessor } from '../infrastructure/pdf/pdf-processor';
import type { SheetsClient } from '../infrastructure/sheets';
import type { DocumentLogPort } from '../features/document-log';
import {
  createDocumentLogWiring,
  type DocumentLogWiring,
} from './document-log.wiring';

export interface WorkspaceAddonWiringOptions {
  server: HttpServer;
  documentService?: InjectedDocumentService | undefined;
  createDocumentService?: DocumentServiceFactory | undefined;
  documentSpaceService?: DocumentSpaceService | undefined;
  createDocumentSpaceService?: DocumentSpaceServiceFactory | undefined;
  createSchemaDrivenUiService?: SchemaDrivenUiServiceFactory | undefined;
  authVerifier?: WorkspaceAuthVerifierPort | undefined;
  configProvider?: (WorkspaceConfigProviderPort & Partial<AppConfigurationProviderPort>) | undefined;
  driveConfigProvider?: AppConfigurationProviderPort | undefined;
  manifestProvider?: RawManifestProviderPort | undefined;
  uiOrchestrator?: WorkspaceUiOrchestratorPort | undefined;
  appBaseUrl?: string | undefined;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  gmailClient?: GoogleGmailClient | undefined;
  gmailPort?: UiProcessGmailPort | undefined;
  documentSpaceRegistry?: DocumentSpaceManifestRegistryAdapter | undefined;
  storageAdapter?: DocumentSpaceStoragePort | undefined;
  pdfProcessor?: PdfProcessor | undefined;
  sourceParser?: SourceParserPort | undefined;
  createSourceParser?:
    | ((
        context: WorkspaceExecutionContext,
        overrides?: { canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined }
      ) => SourceParserPort | Promise<SourceParserPort>)
    | undefined;
  driveContextClient?: DriveSourceContextClientPort | undefined;
  docsClient?: GoogleDocsClient | undefined;
  sheetsClient?: SheetsClient | undefined;
  documentLogService?: DocumentLogPort | undefined;
  documentLogWiring?: DocumentLogWiring | undefined;
  createAdditionalActivityHandlers?:
    | ((
        context: WorkspaceExecutionContext
      ) => readonly ActivityHandler[] | Promise<readonly ActivityHandler[]>)
    | undefined;
}

function wrapWithPerRequestCollectionCache(
  service: DocumentSpaceService
): DocumentSpaceService {
  const collectionCache = new Map<string, Promise<DocumentSpaceCollection>>();
  const proxy = Object.create(service) as DocumentSpaceService;
  proxy.getCollection = (typeId: string): Promise<DocumentSpaceCollection> => {
    const existing = collectionCache.get(typeId);
    if (existing) {
      return existing;
    }
    const pending = Promise.resolve()
      .then(() => service.getCollection(typeId))
      .catch((error) => {
        collectionCache.delete(typeId);
        throw error;
      });
    collectionCache.set(typeId, pending);
    return pending;
  };
  return proxy;
}

function createRetryableInitializer(init: () => Promise<void>): () => Promise<void> {
  let initPromise: Promise<void> | undefined;
  return async (): Promise<void> => {
    if (!initPromise) {
      initPromise = init().catch((err) => {
        initPromise = undefined;
        throw err;
      });
    }
    await initPromise;
  };
}

export function wireWorkspaceAddonRoutes(
  options: WorkspaceAddonWiringOptions
): void {
  const authVerifier: WorkspaceAuthVerifierPort = options.authVerifier ?? new GoogleJwtVerifier();

  let uiOrchestrator = options.uiOrchestrator;
  if (!uiOrchestrator) {
    const manifestProvider: RawManifestProviderPort = options.manifestProvider ?? {
      getRawManifest: async () => ({}),
      readParsedSchema: async () => undefined,
    };

    const appConfigProvider: AppConfigurationProviderPort | undefined =
      options.driveConfigProvider ??
      (options.configProvider &&
      typeof (options.configProvider as AppConfigurationProviderPort).getDriveConfig === 'function'
        ? (options.configProvider as AppConfigurationProviderPort)
        : undefined);

    const gmailClient = options.gmailClient ?? new GoogleGmailClient();

    let createDocumentSpaceService = options.createDocumentSpaceService;
    if (!createDocumentSpaceService) {
      if (options.documentSpaceService) {
        createDocumentSpaceService = () => options.documentSpaceService!;
      } else if (options.documentSpaceRegistry) {
        createDocumentSpaceService = createDocumentSpaceServiceFactory({
          documentSpaceRegistry: options.documentSpaceRegistry,
          configProvider: appConfigProvider,
          driveClient: options.driveClient,
          storageAdapter: options.storageAdapter,
        });
      }
    }

    const rawCreateDocumentSpaceService = createDocumentSpaceService;
    if (rawCreateDocumentSpaceService) {
      const memoizedSpaceServices = new WeakMap<
        WorkspaceExecutionContext,
        Promise<DocumentSpaceService>
      >();
      createDocumentSpaceService = (
        context: WorkspaceExecutionContext
      ): Promise<DocumentSpaceService> => {
        const existing = memoizedSpaceServices.get(context);
        if (existing) {
          return existing;
        }
        const pending = Promise.resolve()
          .then(() => rawCreateDocumentSpaceService(context))
          .then((service) => wrapWithPerRequestCollectionCache(service))
          .catch((error) => {
            memoizedSpaceServices.delete(context);
            throw error;
          });
        memoizedSpaceServices.set(context, pending);
        return pending;
      };
    }

    const resolvedDocumentLogWiring =
      options.documentLogWiring ??
      (options.manifestProvider || options.sheetsClient || options.documentLogService
        ? createDocumentLogWiring({
            manifestProvider,
            configProvider: appConfigProvider,
            driveClient: options.driveClient,
            sheetsClient: options.sheetsClient,
            templateEvaluator: options.templateEvaluator,
            documentLogService: options.documentLogService,
          })
        : undefined);

    const ensureLogRegistryInitialized = resolvedDocumentLogWiring
      ? createRetryableInitializer(() => resolvedDocumentLogWiring.logSchemaRegistry.initialize())
      : undefined;

    let createAdditionalActivityHandlers = options.createAdditionalActivityHandlers;
    if (createAdditionalActivityHandlers && ensureLogRegistryInitialized) {
      const providedHandlers = createAdditionalActivityHandlers;
      createAdditionalActivityHandlers = async (context: WorkspaceExecutionContext) => {
        await ensureLogRegistryInitialized();
        return providedHandlers(context);
      };
    } else if (
      !createAdditionalActivityHandlers &&
      resolvedDocumentLogWiring &&
      ensureLogRegistryInitialized
    ) {
      createAdditionalActivityHandlers = async (context: WorkspaceExecutionContext) => {
        await ensureLogRegistryInitialized();
        return [resolvedDocumentLogWiring.createPerRequestActivityHandler(context)];
      };
    }

    let createDocumentService = options.createDocumentService;
    if (!createDocumentService) {
      if (options.documentService) {
        createDocumentService = () => options.documentService!;
      } else if (options.documentSchemaRegistry && options.compiledSchemaRegistry) {
        createDocumentService = createDocumentServiceFactory({
          documentSchemaRegistry: options.documentSchemaRegistry,
          templateEvaluator: options.templateEvaluator ?? new HandlebarsAdapter(),
          compiledSchemaRegistry: options.compiledSchemaRegistry,
          configProvider: appConfigProvider,
          driveClient: options.driveClient,
          gmailClient,
          pdfProcessor: options.pdfProcessor,
          ...(createAdditionalActivityHandlers !== undefined
            ? { createAdditionalActivityHandlers }
            : {}),
        });
      }
    }

    const documentSpaceService: DocumentSpaceService | undefined =
      options.documentSpaceService ??
      (!createDocumentSpaceService
        ? ({
            getAllTypes: () => [],
            getCollection: async () => ({ spaces: [] }),
          } as unknown as DocumentSpaceService)
        : undefined);

    const dynamicOptionsAdapters = new WeakMap<WorkspaceExecutionContext, DynamicOptionsAdapter>();

    const getDynamicOptionsAdapter = (context: WorkspaceExecutionContext): DynamicOptionsAdapter => {
      let adapter = dynamicOptionsAdapters.get(context);
      if (!adapter) {
        const oauthCredential = context.userOAuthToken ?? context.gmail?.accessToken;
        const driveClient = oauthCredential
          ? new GoogleDriveClient({
              auth: oauthCredential,
              configProvider: appConfigProvider,
            })
          : (options.driveClient ?? new GoogleDriveClient({ configProvider: appConfigProvider }));
        adapter = new DynamicOptionsAdapter(driveClient);
        dynamicOptionsAdapters.set(context, adapter);
      }
      return adapter;
    };

    const perRequestDocLogServices = new WeakMap<WorkspaceExecutionContext, DocumentLogPort>();
    const getPerRequestDocLogService =
      resolvedDocumentLogWiring !== undefined
        ? (context: WorkspaceExecutionContext): DocumentLogPort => {
            let service = perRequestDocLogServices.get(context);
            if (!service) {
              service = resolvedDocumentLogWiring.createDocumentLogService(context);
              perRequestDocLogServices.set(context, service);
            }
            return service;
          }
        : undefined;

    const createDocumentLogPort =
      getPerRequestDocLogService && ensureLogRegistryInitialized
        ? async (context: WorkspaceExecutionContext): Promise<UiProcessDocumentLogPort> => {
            await ensureLogRegistryInitialized();
            const service = getPerRequestDocLogService(context);
            return {
              requiresDocumentLog: (documentTypeKey) =>
                service.requiresDocumentLog(documentTypeKey),
              resolveLog: async (space) => {
                const res = await service.resolveLog({
                  id: space.id,
                  typeId: space.typeId,
                  name: space.name,
                  abstractStorageId: space.abstractStorageId,
                });
                if (res.status === 'missing') {
                  return { status: 'missing', expectedFolderPath: res.expectedFolderPath };
                }
                if (res.status === 'resolved') {
                  return {
                    status: 'resolved',
                    candidate: { id: res.candidate.id, name: res.candidate.name },
                  };
                }
                return {
                  status: 'ambiguous',
                  candidates: res.candidates.map((c) => ({ id: c.id, name: c.name })),
                };
              },
              copyLog: async (space) => {
                const res = await service.copyLog({
                  id: space.id,
                  typeId: space.typeId,
                  name: space.name,
                  abstractStorageId: space.abstractStorageId,
                });
                return {
                  created: res.created,
                  candidate: { id: res.candidate.id, name: res.candidate.name },
                  folderPath: res.folderPath,
                };
              },
            };
          }
        : undefined;

    const uiContextQueryAdapters = new WeakMap<WorkspaceExecutionContext, UiContextQueryAdapter>();
    const getUiContextQueryAdapter =
      getPerRequestDocLogService && ensureLogRegistryInitialized
        ? (context: WorkspaceExecutionContext): UiContextQueryAdapter => {
            let adapter = uiContextQueryAdapters.get(context);
            if (!adapter) {
              adapter = new UiContextQueryAdapter({
                documentLogService: getPerRequestDocLogService(context),
                getDocumentSpaceService: () =>
                  createDocumentSpaceService
                    ? createDocumentSpaceService(context)
                    : documentSpaceService!,
                ensureInitialized: ensureLogRegistryInitialized,
              });
              uiContextQueryAdapters.set(context, adapter);
            }
            return adapter;
          }
        : undefined;

    let createSchemaDrivenUiService = options.createSchemaDrivenUiService;
    if (!createSchemaDrivenUiService) {
      createSchemaDrivenUiService = (context: WorkspaceExecutionContext) => {
        const optionsFetcher = getDynamicOptionsAdapter(context);
        const uiContextQuery = getUiContextQueryAdapter
          ? getUiContextQueryAdapter(context)
          : undefined;
        return createSchemaDrivenUiWiring({
          manifestProvider,
          optionsFetcher,
          ...(uiContextQuery !== undefined ? { uiContextQuery } : {}),
        }).schemaDrivenUiService;
      };
    }

    let sourceParser = options.sourceParser;
    const rawCreateSourceParser = options.createSourceParser;
    let createSourceParser:
      | ((context: WorkspaceExecutionContext) => SourceParserPort | Promise<SourceParserPort>)
      | undefined;

    if (!sourceParser && !rawCreateSourceParser) {
      const spaceTypesProvider =
        options.documentSpaceService ??
        options.documentSpaceRegistry ?? {
          getAllTypes: () => [],
        };
      const sourceParserWiring = createSourceParserWiring({
        spaceTypesProvider,
        manifestProvider,
        driveClient: options.driveClient,
        driveContextClient: options.driveContextClient,
        configProvider: appConfigProvider,
        workspaceConfigProvider: options.configProvider,
        ...(options.pdfProcessor !== undefined ? { pdfProcessor: options.pdfProcessor } : {}),
        ...(options.docsClient !== undefined ? { docsClient: options.docsClient } : {}),
        ...(options.templateEvaluator !== undefined
          ? { templateEvaluator: options.templateEvaluator }
          : {}),
        getCanonicalOptionsProvider: (ctx) => getDynamicOptionsAdapter(ctx),
      });
      sourceParser = sourceParserWiring.sourceParser;
      const ensureParseRegistryInitialized = createRetryableInitializer(() =>
        sourceParserWiring.parseSchemaRegistry.initialize()
      );
      createSourceParser = async (context: WorkspaceExecutionContext) => {
        await ensureParseRegistryInitialized();
        const adapter = getDynamicOptionsAdapter(context);
        return sourceParserWiring.createSourceParser(context, { canonicalOptionsProvider: adapter });
      };
    } else if (rawCreateSourceParser) {
      createSourceParser = (context: WorkspaceExecutionContext) => {
        const adapter = getDynamicOptionsAdapter(context);
        return rawCreateSourceParser(context, { canonicalOptionsProvider: adapter });
      };
    }

    const uiProcessWiring = createUiProcessManagerWiring({
      configProvider: options.configProvider,
      documentSpaceService,
      createDocumentSpaceService,
      manifestProvider,
      documentService: options.documentService,
      createDocumentService,
      ...(options.compiledSchemaRegistry !== undefined ? { compiledSchemaRegistry: options.compiledSchemaRegistry } : {}),
      ...(options.documentSchemaRegistry !== undefined ? { documentSchemaRegistry: options.documentSchemaRegistry } : {}),
      ...(createSchemaDrivenUiService !== undefined ? { createSchemaDrivenUiService } : {}),
      ...(createDocumentLogPort !== undefined ? { createDocumentLogPort } : {}),
      ...(options.driveClient !== undefined ? { driveClient: options.driveClient } : {}),
      gmailClient,
      ...(options.gmailPort !== undefined ? { gmailPort: options.gmailPort } : {}),
      ...(options.pdfProcessor !== undefined ? { pdfProcessor: options.pdfProcessor } : {}),
      ...(sourceParser !== undefined ? { sourceParser } : {}),
      ...(createSourceParser !== undefined ? { createSourceParser } : {}),
      evaluateFormChange,
    });
    uiOrchestrator = uiProcessWiring.requestScopedWrapper;
  }

  registerWorkspaceAddonRoutes(options.server, {
    authVerifier,
    uiOrchestrator: uiOrchestrator!,
    appBaseUrl: options.appBaseUrl,
  });
}




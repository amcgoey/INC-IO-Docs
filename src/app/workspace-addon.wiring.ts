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
import type { DocumentSpaceService } from '../features/document-space/domain';
import {
  createUiProcessManagerWiring,
  type DocumentServiceFactory,
  type DocumentSpaceServiceFactory,
  type SchemaDrivenUiServiceFactory,
} from './ui-process-manager.wiring';
import { createSchemaDrivenUiWiring } from './schema-driven-ui.wiring';
import { DynamicOptionsAdapter } from './dynamic-options.adapter';
import type { RawManifestProviderPort } from '../features/ui-process-manager';
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
import { createDocumentLogWiring } from './document-log.wiring';

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
  createAdditionalActivityHandlers?:
    | ((
        context: WorkspaceExecutionContext
      ) => readonly ActivityHandler[] | Promise<readonly ActivityHandler[]>)
    | undefined;
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

    let createAdditionalActivityHandlers = options.createAdditionalActivityHandlers;
    if (
      !createAdditionalActivityHandlers &&
      (options.manifestProvider || options.sheetsClient || options.documentLogService)
    ) {
      const documentLogWiring = createDocumentLogWiring({
        manifestProvider,
        configProvider: appConfigProvider,
        driveClient: options.driveClient,
        sheetsClient: options.sheetsClient,
        templateEvaluator: options.templateEvaluator,
        documentLogService: options.documentLogService,
      });
      const ensureLogRegistryInitialized = createRetryableInitializer(() =>
        documentLogWiring.logSchemaRegistry.initialize()
      );
      createAdditionalActivityHandlers = async (context: WorkspaceExecutionContext) => {
        await ensureLogRegistryInitialized();
        return [documentLogWiring.createPerRequestActivityHandler(context)];
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

    let createSchemaDrivenUiService = options.createSchemaDrivenUiService;
    if (!createSchemaDrivenUiService) {
      createSchemaDrivenUiService = (context: WorkspaceExecutionContext) => {
        const optionsFetcher = getDynamicOptionsAdapter(context);
        return createSchemaDrivenUiWiring({
          manifestProvider,
          optionsFetcher,
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




import { DocumentSchemaRegistryAdapter } from '../features/document/adapters/document-schema-registry';
import type {
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  DriveServicePort,
  ActivityDispatcherPort,
  ActivityHandler,
  AppConfigurationProviderPort,
  RawManifestProviderPort,
  DocumentServicePort,
  CompiledSchemaRegistryPort,
  DocumentDynamicValidationPort,
  DocumentOptionTablePort,
  DynamicValidationMessageFormatter,
  DocumentContentEditorPort,
  TemplateRegistryPort,
} from '../features/document/ports';
import {
  DEFAULT_MESSAGE_CATALOG,
  formatValidationError,
} from '../features/schema-driven-ui/message-catalog';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { DocumentService } from '../features/document/domain';
import { CompiledSchemaRegistry } from '../features/document/adapters/compiled-schema-registry';
import {
  createDocumentDynamicValidationAdapter,
  createDocumentOptionTableAdapter,
  createLookupOptionsService,
} from './lookup-options.wiring';
import type { LookupOptionsPort } from '../features/lookup-options';
import type { DocumentLogPort } from '../features/document-log';
import type { DocumentSpaceService } from '../features/document-space/domain';

export type InjectedDocumentService =
  | DocumentService
  | (DocumentServicePort & { initialize?: unknown });
import { DriveServiceAdapter } from '../features/document/adapters/drive-service-adapter';
import { DriveActivityHandler } from '../features/document/adapters/drive-activity-handler';
import { ActivityEngine } from '../features/document/adapters/activity-engine';
import { registerDocumentFeatureRoutes } from '../features/document/adapters/api';
import type { HttpServer } from '../infrastructure/http';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import { PdfProcessor } from '../infrastructure/pdf/pdf-processor';
import { createMaxInMemoryFileBytesProvider } from '../infrastructure/manifest/app-manifest-provider';
import { GmailSourceFileHydratorAdapter } from '../features/document/adapters/gmail-source-file-hydrator.adapter';
import { DocumentContentEditorAdapter } from '../features/document/adapters/document-content-editor.adapter';
import { DocumentContentActivityHandler } from '../features/document/adapters/document-content-activity-handler';
import { EnvTemplateRegistryAdapter } from '../features/document/adapters/env-template-registry.adapter';

export interface DocumentFeatureWiringOptions {
  manifestProvider: RawManifestProviderPort;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
}

export interface DocumentFeatureWiring {
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  compiledSchemaRegistry: CompiledSchemaRegistryPort;
}

function resolveCompiledSchemaRegistry(
  documentSchemaRegistry: DocumentSchemaRegistryPort,
  override?: CompiledSchemaRegistryPort
): CompiledSchemaRegistryPort {
  return override ?? new CompiledSchemaRegistry(documentSchemaRegistry);
}

export function createDocumentFeatureWiring(
  options: DocumentFeatureWiringOptions
): DocumentFeatureWiring {
  const templateEvaluator = options.templateEvaluator ?? new HandlebarsAdapter();
  const documentSchemaRegistry =
    options.documentSchemaRegistry ??
    new DocumentSchemaRegistryAdapter(
      options.manifestProvider,
      templateEvaluator,
      ensureEvaluationOrder
    );
  const compiledSchemaRegistry = resolveCompiledSchemaRegistry(
    documentSchemaRegistry,
    options.compiledSchemaRegistry
  );

  return {
    documentSchemaRegistry,
    compiledSchemaRegistry,
  };
}

import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { DocumentServiceFactory } from './ui-process-manager.wiring';

function createTemplateRegistry(params: {
  templateRegistry?: TemplateRegistryPort | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  manifestProvider?: RawManifestProviderPort | undefined;
}): TemplateRegistryPort {
  if (params.templateRegistry) {
    return params.templateRegistry;
  }
  return new EnvTemplateRegistryAdapter({
    getTemplatesConfig: async () => {
      if (params.configProvider && typeof params.configProvider.getTemplatesConfig === 'function') {
        const fromConfig = await params.configProvider.getTemplatesConfig();
        if (fromConfig !== undefined) {
          return fromConfig;
        }
      }
      if (params.manifestProvider) {
        const raw = (await params.manifestProvider.getRawManifest()) as {
          configuration?: { templates?: Record<string, string> };
        };
        return raw?.configuration?.templates;
      }
      return undefined;
    },
  });
}

function createDocumentContentHandler(params: {
  driveService: DriveServicePort;
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  templateEvaluator: TemplateEvaluatorPort;
  templateRegistry: TemplateRegistryPort;
  pdfProcessor: PdfProcessor;
  getMaxInMemoryFileBytes: () => Promise<number>;
  contentEditor?: DocumentContentEditorPort | undefined;
}): DocumentContentActivityHandler {
  const contentEditor =
    params.contentEditor ??
    new DocumentContentEditorAdapter({
      driveService: params.driveService,
      pdfProcessor: params.pdfProcessor,
      getMaxInMemoryFileBytes: params.getMaxInMemoryFileBytes,
    });
  return new DocumentContentActivityHandler({
    contentEditor,
    documentSchemaRegistry: params.documentSchemaRegistry,
    templateEvaluator: params.templateEvaluator,
    templateRegistry: params.templateRegistry,
  });
}

export interface CreateDocumentServiceFactoryOptions {
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  templateEvaluator: TemplateEvaluatorPort;
  compiledSchemaRegistry: CompiledSchemaRegistryPort;
  manifestProvider?: RawManifestProviderPort | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  gmailClient?: GoogleGmailClient | undefined;
  pdfProcessor?: PdfProcessor | undefined;
  contentEditor?: DocumentContentEditorPort | undefined;
  templateRegistry?: TemplateRegistryPort | undefined;
  dynamicValidator?: DocumentDynamicValidationPort | undefined;
  getDynamicValidator?: ((requestContext: WorkspaceExecutionContext) => DocumentDynamicValidationPort) | undefined;
  optionTablePort?: DocumentOptionTablePort | undefined;
  getOptionTablePort?: ((requestContext: WorkspaceExecutionContext) => DocumentOptionTablePort) | undefined;
  validationMessageFormatter?: DynamicValidationMessageFormatter | undefined;
  documentLogService?: DocumentLogPort | undefined;
  ensureDocumentLogInitialized?: (() => Promise<void>) | undefined;
  getDocumentSpaceService?:
    | ((requestContext: WorkspaceExecutionContext) => Promise<DocumentSpaceService> | DocumentSpaceService)
    | undefined;
  lookupTimeoutMs?: number | undefined;
  additionalActivityHandlers?: readonly ActivityHandler[] | undefined;
  createAdditionalActivityHandlers?:
    | ((
        context: WorkspaceExecutionContext,
        requestContext?: WorkspaceExecutionContext
      ) => readonly ActivityHandler[] | Promise<readonly ActivityHandler[]>)
    | undefined;
}

export function createDocumentServiceFactory(
  options: CreateDocumentServiceFactoryOptions
): DocumentServiceFactory {
  return async (
    context: WorkspaceExecutionContext,
    requestContext?: WorkspaceExecutionContext
  ): Promise<DocumentService> => {
    const effectiveRequestContext = requestContext ?? context;
    const primaryTargetId =
      context.sourceFiles?.[0]?.id ??
      context.selectedItems?.[0]?.id ??
      context.parameters?.primaryTargetId ??
      context.parameters?.fileId ??
      (context.formData?.fileId as string | undefined);

    const sourceFiles =
      context.sourceFiles !== undefined
        ? context.sourceFiles.map((file) => ({
            id: file.id,
            ...(file.name !== undefined ? { name: file.name } : {}),
            ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
            ...(file.content !== undefined ? { content: file.content } : {}),
          }))
        : context.selectedItems?.map((item) => ({
            id: item.id,
            ...(item.title !== undefined ? { name: item.title } : {}),
            ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
          }));

    const driveClient = context.userOAuthToken
      ? new GoogleDriveClient({
          auth: context.userOAuthToken,
          configProvider: options.configProvider,
        })
      : options.driveClient ??
        new GoogleDriveClient({ configProvider: options.configProvider });

    const driveService = new DriveServiceAdapter(driveClient);
    const getMaxInMemoryFileBytes = createMaxInMemoryFileBytesProvider(options.configProvider);
    const pdfProcessor =
      options.pdfProcessor ?? new PdfProcessor({ getMaxInMemoryFileBytes });

    const hasGmailContext = Boolean(
      context.hostApp === 'GMAIL' ||
      context.gmail?.messageId ||
      context.gmail?.accessToken
    );

    let sourceFileHydrator: GmailSourceFileHydratorAdapter | undefined;
    let isFileSourceEmailAttachments: boolean | undefined;
    if (hasGmailContext) {
      const auth = context.userOAuthToken ?? context.gmail?.accessToken;
      const messageId = context.gmail?.messageId;
      const selectFileSource =
        (context.formData?.SelectFileSource as string | undefined) ??
        context.parameters?.SelectFileSource;
      isFileSourceEmailAttachments =
        selectFileSource !== undefined
          ? selectFileSource === 'Email Attachments'
          : true;

      const gmailClient = options.gmailClient ?? new GoogleGmailClient();
      sourceFileHydrator = new GmailSourceFileHydratorAdapter(gmailClient, {
        auth,
        messageId,
        isFileSourceEmailAttachments,
        pdfProcessor,
      });
    }

    const driveActivityHandler = new DriveActivityHandler(driveService, {
      configProvider: options.configProvider,
      primaryTargetId,
      sourceFiles,
      sourceFileHydrator,
      isFileSourceEmailAttachments,
    });

    const templateRegistry = createTemplateRegistry({
      templateRegistry: options.templateRegistry,
      configProvider: options.configProvider,
      manifestProvider: options.manifestProvider,
    });

    const contentActivityHandler = createDocumentContentHandler({
      driveService,
      documentSchemaRegistry: options.documentSchemaRegistry,
      templateEvaluator: options.templateEvaluator,
      templateRegistry,
      pdfProcessor,
      getMaxInMemoryFileBytes,
      contentEditor: options.contentEditor,
    });

    const perRequestHandlers = options.createAdditionalActivityHandlers
      ? await options.createAdditionalActivityHandlers(context, effectiveRequestContext)
      : [];
    const handlers: ActivityHandler[] = [
      driveActivityHandler,
      contentActivityHandler,
      ...(options.additionalActivityHandlers ?? []),
      ...perRequestHandlers,
    ];

    const activityEngine = new ActivityEngine(handlers);

    let fallbackLookupOptions: LookupOptionsPort | undefined;
    const getFallbackLookupOptions = (): LookupOptionsPort => {
      if (!fallbackLookupOptions) {
        fallbackLookupOptions = createLookupOptionsService({
          manifestProvider: options.manifestProvider,
          documentSchemaRegistry: options.documentSchemaRegistry,
          driveClient,
          configProvider: options.configProvider,
          documentLogService: options.documentLogService,
          ensureDocumentLogInitialized: options.ensureDocumentLogInitialized,
          ...(options.getDocumentSpaceService !== undefined
            ? {
                getDocumentSpaceService: (ctx: WorkspaceExecutionContext) =>
                  options.getDocumentSpaceService!(
                    Object.keys(ctx).length > 0 ? ctx : effectiveRequestContext
                  ),
              }
            : {}),
          ...(options.lookupTimeoutMs !== undefined
            ? { lookupTimeoutMs: options.lookupTimeoutMs }
            : {}),
        });
      }
      return fallbackLookupOptions;
    };

    const dynamicValidator =
      options.dynamicValidator ??
      (options.getDynamicValidator
        ? options.getDynamicValidator(effectiveRequestContext)
        : createDocumentDynamicValidationAdapter(getFallbackLookupOptions()));

    const optionTablePort =
      options.optionTablePort ??
      (options.getOptionTablePort
        ? options.getOptionTablePort(effectiveRequestContext)
        : createDocumentOptionTableAdapter(getFallbackLookupOptions()));

    const validationMessageFormatter =
      options.validationMessageFormatter ??
      ((status, targetPath) =>
        formatValidationError(DEFAULT_MESSAGE_CATALOG, status, targetPath) ??
        'Option not found.');

    const service = new DocumentService(
      activityEngine,
      options.documentSchemaRegistry,
      options.templateEvaluator,
      options.compiledSchemaRegistry,
      dynamicValidator,
      validationMessageFormatter,
      context.selectedLogId,
      driveService,
      isFileSourceEmailAttachments === true,
      optionTablePort,
      templateRegistry
    );

    await service.initialize();
    return service;
  };
}

export interface WireDocumentServicesOptions {
  server: HttpServer;
  driveClient: GoogleDriveClient;
  configProvider: AppConfigurationProviderPort;
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  templateEvaluator: TemplateEvaluatorPort;
  manifestProvider?: RawManifestProviderPort | undefined;
  driveService?: DriveServicePort | undefined;
  pdfProcessor?: PdfProcessor | undefined;
  contentEditor?: DocumentContentEditorPort | undefined;
  templateRegistry?: TemplateRegistryPort | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  documentService?: InjectedDocumentService | undefined;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
  primaryTargetId?: string | undefined;
  dynamicValidator?: DocumentDynamicValidationPort | undefined;
  getDynamicValidator?: ((requestContext: WorkspaceExecutionContext) => DocumentDynamicValidationPort) | undefined;
  optionTablePort?: DocumentOptionTablePort | undefined;
  getOptionTablePort?: ((requestContext: WorkspaceExecutionContext) => DocumentOptionTablePort) | undefined;
  validationMessageFormatter?: DynamicValidationMessageFormatter | undefined;
  documentLogService?: DocumentLogPort | undefined;
  getDocumentLogService?: ((context: WorkspaceExecutionContext) => DocumentLogPort) | undefined;
  ensureDocumentLogInitialized?: (() => Promise<void>) | undefined;
  getDocumentSpaceService?:
    | ((requestContext: WorkspaceExecutionContext) => Promise<DocumentSpaceService> | DocumentSpaceService)
    | undefined;
  getLookupOptions?: ((requestContext: WorkspaceExecutionContext) => LookupOptionsPort) | undefined;
  lookupTimeoutMs?: number | undefined;
  additionalActivityHandlers?: readonly ActivityHandler[] | undefined;
  createAdditionalActivityHandlers?:
    | ((
        lookupOptions: LookupOptionsPort,
        requestContext: WorkspaceExecutionContext
      ) => readonly ActivityHandler[] | Promise<readonly ActivityHandler[]>)
    | undefined;
}

export function wireDocumentServicesAndRoutes(
  options: WireDocumentServicesOptions
): InjectedDocumentService {
  const compiledSchemaRegistry = resolveCompiledSchemaRegistry(
    options.documentSchemaRegistry,
    options.compiledSchemaRegistry
  );

  const validationMessageFormatter: DynamicValidationMessageFormatter =
    options.validationMessageFormatter ??
    ((status, targetPath) =>
      formatValidationError(DEFAULT_MESSAGE_CATALOG, status, targetPath) ??
      'Option not found.');

  const buildDefaultLookupOptions = (
    requestContext: WorkspaceExecutionContext = {}
  ): LookupOptionsPort =>
    createLookupOptionsService({
      manifestProvider: options.manifestProvider,
      documentSchemaRegistry: options.documentSchemaRegistry,
      driveClient: options.driveClient,
      configProvider: options.configProvider,
      documentLogService:
        options.getDocumentLogService
          ? options.getDocumentLogService(requestContext)
          : options.documentLogService,
      ensureDocumentLogInitialized: options.ensureDocumentLogInitialized,
      ...(options.getDocumentSpaceService !== undefined
        ? {
            getDocumentSpaceService: (ctx: WorkspaceExecutionContext) =>
              options.getDocumentSpaceService!(
                Object.keys(ctx).length > 0 ? ctx : requestContext
              ),
          }
        : {}),
      ...(options.lookupTimeoutMs !== undefined
        ? { lookupTimeoutMs: options.lookupTimeoutMs }
        : {}),
    });

  const resolvePerRequestLookups = (requestContext: WorkspaceExecutionContext) => {
    let fallbackLookupOptions: LookupOptionsPort | undefined;
    const getLookupOptions = (): LookupOptionsPort => {
      if (options.getLookupOptions) {
        return options.getLookupOptions(requestContext);
      }
      if (!fallbackLookupOptions) {
        fallbackLookupOptions = buildDefaultLookupOptions(requestContext);
      }
      return fallbackLookupOptions;
    };

    const dynamicValidator =
      options.dynamicValidator ??
      (options.getDynamicValidator
        ? options.getDynamicValidator(requestContext)
        : createDocumentDynamicValidationAdapter(getLookupOptions()));

    const optionTablePort =
      options.optionTablePort ??
      (options.getOptionTablePort
        ? options.getOptionTablePort(requestContext)
        : createDocumentOptionTableAdapter(getLookupOptions()));

    return {
      getLookupOptions,
      dynamicValidator,
      optionTablePort,
    };
  };

  const getMaxInMemoryFileBytes = createMaxInMemoryFileBytesProvider(options.configProvider);
  const pdfProcessor =
    options.pdfProcessor ?? new PdfProcessor({ getMaxInMemoryFileBytes });
  const templateRegistry = createTemplateRegistry({
    templateRegistry: options.templateRegistry,
    configProvider: options.configProvider,
    manifestProvider: options.manifestProvider,
  });

  const buildActivityEngine = async (
    lookupOptions?: LookupOptionsPort,
    requestContext?: WorkspaceExecutionContext
  ): Promise<ActivityDispatcherPort> => {
    if (options.activityEngine) {
      return options.activityEngine;
    }
    const driveService: DriveServicePort =
      options.driveService ?? new DriveServiceAdapter(options.driveClient);

    const driveActivityHandler = new DriveActivityHandler(driveService, {
      configProvider: options.configProvider,
      primaryTargetId: options.primaryTargetId,
    });

    const contentActivityHandler = createDocumentContentHandler({
      driveService,
      documentSchemaRegistry: options.documentSchemaRegistry,
      templateEvaluator: options.templateEvaluator,
      templateRegistry,
      pdfProcessor,
      getMaxInMemoryFileBytes,
      contentEditor: options.contentEditor,
    });

    const dynamicHandlers =
      lookupOptions && options.createAdditionalActivityHandlers
        ? await options.createAdditionalActivityHandlers(lookupOptions, requestContext ?? {})
        : (options.additionalActivityHandlers ?? []);

    const handlers: ActivityHandler[] = [
      driveActivityHandler,
      contentActivityHandler,
      ...dynamicHandlers,
    ];
    return new ActivityEngine(handlers);
  };

  let documentService = options.documentService;
  if (!documentService) {
    const driveService: DriveServicePort =
      options.driveService ?? new DriveServiceAdapter(options.driveClient);

    const driveActivityHandler = new DriveActivityHandler(driveService, {
      configProvider: options.configProvider,
      primaryTargetId: options.primaryTargetId,
    });

    const contentActivityHandler = createDocumentContentHandler({
      driveService,
      documentSchemaRegistry: options.documentSchemaRegistry,
      templateEvaluator: options.templateEvaluator,
      templateRegistry,
      pdfProcessor,
      getMaxInMemoryFileBytes,
      contentEditor: options.contentEditor,
    });

    const singletonLookups = resolvePerRequestLookups({});
    const handlers: ActivityHandler[] = [
      driveActivityHandler,
      contentActivityHandler,
      ...(options.additionalActivityHandlers ?? []),
    ];

    const activityEngine = options.activityEngine ?? new ActivityEngine(handlers);

    documentService = new DocumentService(
      activityEngine,
      options.documentSchemaRegistry,
      options.templateEvaluator,
      compiledSchemaRegistry,
      singletonLookups.dynamicValidator,
      validationMessageFormatter,
      undefined,
      driveService,
      undefined,
      singletonLookups.optionTablePort,
      templateRegistry
    );
  }

  if (options.documentService || options.dynamicValidator) {
    registerDocumentFeatureRoutes(options.server, {
      service: documentService,
    });
  } else {
    registerDocumentFeatureRoutes(options.server, {
      createService: async () => {
        const reqContext: WorkspaceExecutionContext = {};
        const reqLookups = resolvePerRequestLookups(reqContext);
        const reqLookupOptionsForHandlers =
          !options.activityEngine && options.createAdditionalActivityHandlers
            ? reqLookups.getLookupOptions()
            : undefined;
        const activityEngine = await buildActivityEngine(reqLookupOptionsForHandlers, reqContext);
        const reqDriveService: DriveServicePort =
          options.driveService ?? new DriveServiceAdapter(options.driveClient);
        const reqService = new DocumentService(
          activityEngine,
          options.documentSchemaRegistry,
          options.templateEvaluator,
          compiledSchemaRegistry,
          reqLookups.dynamicValidator,
          validationMessageFormatter,
          undefined,
          reqDriveService,
          undefined,
          reqLookups.optionTablePort,
          templateRegistry
        );
        await reqService.initialize();
        return reqService;
      },
    });
  }

  return documentService;
}

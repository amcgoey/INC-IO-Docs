import { DocumentSchemaRegistryAdapter } from '../features/document/adapters/document-schema-registry';
import type {
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  DriveServicePort,
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  RawManifestProviderPort,
  DocumentServicePort,
  CompiledSchemaRegistryPort,
  DocumentDynamicValidationPort,
  DynamicValidationMessageFormatter,
} from '../features/document/ports';
import {
  DEFAULT_MESSAGE_CATALOG,
  formatValidationError,
} from '../features/schema-driven-ui/message-catalog';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { DocumentService } from '../features/document/domain';
import { CompiledSchemaRegistry } from '../features/document/adapters/compiled-schema-registry';
import { DynamicOptionsAdapter } from './dynamic-options.adapter';

export type InjectedDocumentService =
  | DocumentService
  | (DocumentServicePort & { initialize?: unknown });
import { DriveServiceAdapter } from '../features/document/adapters/drive-service-adapter';
import { DriveActivityHandler } from '../features/document/adapters/drive-activity-handler';
import { ActivityEngine } from '../features/document/adapters/activity-engine';
import { registerDocumentFeatureRoutes } from '../features/document/adapters/api';
import type { HttpServer } from '../infrastructure/http';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';

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

export interface CreateDocumentServiceFactoryOptions {
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  templateEvaluator: TemplateEvaluatorPort;
  compiledSchemaRegistry: CompiledSchemaRegistryPort;
  configProvider?: AppConfigurationProviderPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  dynamicValidator?: DocumentDynamicValidationPort | undefined;
  validationMessageFormatter?: DynamicValidationMessageFormatter | undefined;
}

export function createDocumentServiceFactory(
  options: CreateDocumentServiceFactoryOptions
): DocumentServiceFactory {
  return async (context: WorkspaceExecutionContext): Promise<DocumentService> => {
    const primaryTargetId =
      context.selectedItems?.[0]?.id ??
      context.parameters?.primaryTargetId ??
      context.parameters?.fileId ??
      (context.formData?.fileId as string | undefined);

    const sourceFiles = context.selectedItems?.map((item) => ({
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

    const driveActivityHandler = new DriveActivityHandler(driveService, {
      configProvider: options.configProvider,
      primaryTargetId,
      sourceFiles,
    });

    const activityEngine = new ActivityEngine([driveActivityHandler]);

    const dynamicValidator =
      options.dynamicValidator ?? new DynamicOptionsAdapter(driveClient);

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
      validationMessageFormatter
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
  driveService?: DriveServicePort | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
  documentService?: InjectedDocumentService | undefined;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
  primaryTargetId?: string | undefined;
  dynamicValidator?: DocumentDynamicValidationPort | undefined;
  validationMessageFormatter?: DynamicValidationMessageFormatter | undefined;
}

export function wireDocumentServicesAndRoutes(
  options: WireDocumentServicesOptions
): InjectedDocumentService {
  let documentService = options.documentService;
  if (!documentService) {
    const driveService: DriveServicePort =
      options.driveService ?? new DriveServiceAdapter(options.driveClient);

    const driveActivityHandler = new DriveActivityHandler(driveService, {
      configProvider: options.configProvider,
      primaryTargetId: options.primaryTargetId,
    });

    const activityEngine =
      options.activityEngine ??
      new ActivityEngine([driveActivityHandler]);

    const compiledSchemaRegistry = resolveCompiledSchemaRegistry(
      options.documentSchemaRegistry,
      options.compiledSchemaRegistry
    );

    const dynamicValidator =
      options.dynamicValidator ?? new DynamicOptionsAdapter(options.driveClient);

    const validationMessageFormatter =
      options.validationMessageFormatter ??
      ((status, targetPath) =>
        formatValidationError(DEFAULT_MESSAGE_CATALOG, status, targetPath) ??
        'Option not found.');

    documentService = new DocumentService(
      activityEngine,
      options.documentSchemaRegistry,
      options.templateEvaluator,
      compiledSchemaRegistry,
      dynamicValidator,
      validationMessageFormatter
    );
  }

  registerDocumentFeatureRoutes(options.server, {
    service: documentService,
  });

  return documentService;
}

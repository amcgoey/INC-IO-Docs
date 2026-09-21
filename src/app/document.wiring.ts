import { DocumentSchemaRegistryAdapter } from '../features/document/adapters/document-schema-registry';
import type {
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  DriveServicePort,
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  RawManifestProviderPort,
  DocumentServicePort,
} from '../features/document/ports';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { DocumentService } from '../features/document/domain';

export type InjectedDocumentService =
  | DocumentService
  | (DocumentServicePort & { initialize?: unknown });
import { DriveServiceAdapter } from '../features/document/adapters/drive-service-adapter';
import { DriveActivityHandler } from '../features/document/adapters/drive-activity-handler';
import { ActivityEngine } from '../features/document/adapters/activity-engine';
import { registerDocumentFeatureRoutes } from '../features/document/adapters/api';
import type { HttpServer } from '../infrastructure/http';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';

export interface DocumentFeatureWiringOptions {
  manifestProvider: RawManifestProviderPort;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
}

export interface DocumentFeatureWiring {
  documentSchemaRegistry: DocumentSchemaRegistryPort;
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

  return {
    documentSchemaRegistry,
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
    });

    const activityEngine =
      options.activityEngine ?? new ActivityEngine([driveActivityHandler]);
    documentService = new DocumentService(
      activityEngine,
      options.documentSchemaRegistry,
      options.templateEvaluator
    );
  }

  registerDocumentFeatureRoutes(options.server, {
    service: documentService,
  });

  return documentService;
}

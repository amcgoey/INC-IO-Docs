import { DocumentSchemaRegistryAdapter } from '../features/document/adapters/document-schema-registry';
import { DocumentUiSchemaQueryAdapter } from '../features/document/adapters/document-ui-schema-query';
import { DocumentUiBlockAdapter } from '../features/document/adapters/ui-block';

export type { DocumentUiBlockAdapter };
import type {
  DocumentSchemaRegistryPort,
  DocumentUiSchemaQueryPort,
  SchemaQueryPort,
  TemplateEvaluatorPort,
  DriveServicePort,
  ActivityDispatcherPort,
  AppConfigurationProviderPort,
  RawManifestProviderPort
} from '../features/document/ports';
import {
  computeEvaluationOrder,
  ensureEvaluationOrder,
} from '../infrastructure/validation/json-logic-graph';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import {
  buildCard,
  buildTitleBlock,
} from '../infrastructure/workspace-addon/ui-blocks';
import { DocumentService } from '../features/document/domain';
import { DriveServiceAdapter } from '../features/document/adapters/drive-service-adapter';
import { DriveActivityHandler } from '../features/document/adapters/drive-activity-handler';
import { ActivityEngine } from '../features/document/adapters/activity-engine';
import { registerDocumentFeatureRoutes } from '../features/document/adapters/api';
import type { HttpServer } from '../infrastructure/http';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';

export interface DocumentFeatureWiringOptions {
  manifestProvider: RawManifestProviderPort;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  documentSchemaRegistry?: (DocumentSchemaRegistryPort & SchemaQueryPort) | undefined;
}

export interface DocumentFeatureWiring {
  documentSchemaRegistry: DocumentSchemaRegistryPort & SchemaQueryPort;
  documentUiSchemaQuery: DocumentUiSchemaQueryPort;
  documentUiBlock: DocumentUiBlockAdapter;
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

  const documentUiSchemaQuery = new DocumentUiSchemaQueryAdapter(
    options.manifestProvider,
    ensureEvaluationOrder,
    documentSchemaRegistry
  );

  const cardBuilder = {
    buildCard,
    buildTitleBlock,
  };

  const documentUiBlock = new DocumentUiBlockAdapter(
    documentUiSchemaQuery,
    cardBuilder,
    computeEvaluationOrder
  );

  return {
    documentSchemaRegistry,
    documentUiSchemaQuery,
    documentUiBlock,
  };
}

export interface WireDocumentServicesOptions {
  server: HttpServer;
  driveClient: GoogleDriveClient;
  configProvider: AppConfigurationProviderPort;
  documentSchemaRegistry: DocumentSchemaRegistryPort & SchemaQueryPort;
  templateEvaluator: TemplateEvaluatorPort;
  driveService?: DriveServicePort | undefined;
  activityEngine?: ActivityDispatcherPort | undefined;
}

export function wireDocumentServicesAndRoutes(options: WireDocumentServicesOptions): DocumentService {
  const driveService: DriveServicePort =
    options.driveService ??
    new DriveServiceAdapter(options.driveClient);

  const driveActivityHandler = new DriveActivityHandler(driveService, {
    configProvider: options.configProvider,
  });
  
  const activityEngine = options.activityEngine ?? new ActivityEngine([driveActivityHandler]);
  const documentService = new DocumentService(activityEngine, options.documentSchemaRegistry, options.templateEvaluator);

  registerDocumentFeatureRoutes(options.server, { 
    service: documentService, 
    schemaQuery: options.documentSchemaRegistry 
  });

  return documentService;
}


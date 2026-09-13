import type {
  RawManifestProviderPort,
  DocumentSpaceStoragePort,
  DocumentSpaceUiSchemaQueryPort,
} from '../features/document-space/ports';
import { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';
import { DocumentSpaceUiSchemaQueryAdapter } from '../features/document-space/adapters/document-space-ui-schema-query';
import { DocumentSpaceService } from '../features/document-space/domain';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';

export interface DocumentSpaceFeatureWiringOptions {
  rawManifestProvider: RawManifestProviderPort;
  storageAdapter: DocumentSpaceStoragePort;
}

export interface DocumentSpaceFeatureWiring {
  documentSpaceRegistry: DocumentSpaceManifestRegistryAdapter;
  documentSpaceService: DocumentSpaceService;
  documentSpaceUiSchemaQuery: DocumentSpaceUiSchemaQueryPort;
}

export function createDocumentSpaceFeatureWiring(
  options: DocumentSpaceFeatureWiringOptions
): DocumentSpaceFeatureWiring {
  const documentSpaceRegistry = new DocumentSpaceManifestRegistryAdapter(
    options.rawManifestProvider,
    ensureEvaluationOrder
  );
  const documentSpaceService = new DocumentSpaceService(
    documentSpaceRegistry,
    options.storageAdapter
  );
  const documentSpaceUiSchemaQuery = new DocumentSpaceUiSchemaQueryAdapter(
    options.rawManifestProvider,
    ensureEvaluationOrder,
    documentSpaceRegistry
  );

  return {
    documentSpaceRegistry,
    documentSpaceService,
    documentSpaceUiSchemaQuery,
  };
}

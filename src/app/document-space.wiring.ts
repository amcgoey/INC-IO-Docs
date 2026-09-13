import type { RawManifestProviderPort, DocumentSpaceStoragePort } from '../features/document-space/ports';
import { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';
import { DocumentSpaceService } from '../features/document-space/domain';
import { computeEvaluationOrder } from '../infrastructure/validation/json-logic-graph';

export interface DocumentSpaceFeatureWiringOptions {
  rawManifestProvider: RawManifestProviderPort;
  storageAdapter: DocumentSpaceStoragePort;
}

export interface DocumentSpaceFeatureWiring {
  documentSpaceRegistry: DocumentSpaceManifestRegistryAdapter;
  documentSpaceService: DocumentSpaceService;
}

export function createDocumentSpaceFeatureWiring(
  options: DocumentSpaceFeatureWiringOptions
): DocumentSpaceFeatureWiring {
  const documentSpaceRegistry = new DocumentSpaceManifestRegistryAdapter(
    options.rawManifestProvider,
    computeEvaluationOrder
  );
  const documentSpaceService = new DocumentSpaceService(
    documentSpaceRegistry,
    options.storageAdapter
  );

  return {
    documentSpaceRegistry,
    documentSpaceService,
  };
}

import type {
  RawManifestProviderPort,
  DocumentSpaceStoragePort,
  DocumentSpaceUiSchemaQueryPort,
} from '../features/document-space/ports';
import { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';
import { DocumentSpaceUiSchemaQueryAdapter } from '../features/document-space/adapters/document-space-ui-schema-query';
import { DocumentSpaceService } from '../features/document-space/domain';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';
import { GoogleDriveStorageAdapter } from '../features/document-space/adapters/google-drive-storage-adapter';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';

export interface DocumentSpaceFeatureWiringOptions {
  rawManifestProvider: RawManifestProviderPort;
  storageAdapter?: DocumentSpaceStoragePort | undefined;
  driveClient?: GoogleDriveClient | undefined;
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
  
  let storageAdapter = options.storageAdapter;
  if (!storageAdapter) {
    if (!options.driveClient) {
      throw new Error("Must provide either storageAdapter or driveClient");
    }
    storageAdapter = new GoogleDriveStorageAdapter(options.driveClient);
  }

  const documentSpaceService = new DocumentSpaceService(
    documentSpaceRegistry,
    storageAdapter
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


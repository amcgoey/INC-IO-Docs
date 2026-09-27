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
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';

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

import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { DocumentSpaceServiceFactory } from './ui-process-manager.wiring';
import type { AppConfigurationProviderPort } from '../features/document/ports';

export interface CreateDocumentSpaceServiceFactoryOptions {
  documentSpaceRegistry: DocumentSpaceManifestRegistryAdapter;
  configProvider?: AppConfigurationProviderPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  storageAdapter?: DocumentSpaceStoragePort | undefined;
}

export function createDocumentSpaceServiceFactory(
  options: CreateDocumentSpaceServiceFactoryOptions
): DocumentSpaceServiceFactory {
  return async (context: WorkspaceExecutionContext): Promise<DocumentSpaceService> => {
    let storageAdapter = options.storageAdapter;
    if (!storageAdapter) {
      const driveClient = context.userOAuthToken
        ? new GoogleDriveClient({
            auth: context.userOAuthToken,
            configProvider: options.configProvider,
          })
        : options.driveClient ??
          new GoogleDriveClient({ configProvider: options.configProvider });
      storageAdapter = new GoogleDriveStorageAdapter(driveClient);
    }

    const service = new DocumentSpaceService(
      options.documentSpaceRegistry,
      storageAdapter
    );
    await service.initialize();
    return service;
  };
}


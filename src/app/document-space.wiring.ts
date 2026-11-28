import type {
  RawManifestProviderPort,
  DocumentSpaceStoragePort,
  DocumentSpaceUiSchemaQueryPort,
} from '../features/document-space/ports';
import { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';
import { DocumentSpaceUiSchemaQueryAdapter } from '../features/document-space/adapters/document-space-ui-schema-query';
import {
  DocumentSpaceService,
  type DocumentSpaceCollection,
} from '../features/document-space/domain';
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
      const oauthCredential = context.userOAuthToken ?? context.gmail?.accessToken;
      const driveClient = oauthCredential
        ? new GoogleDriveClient({
            auth: oauthCredential,
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

const memoizedSpaceServiceFactories = new WeakSet<DocumentSpaceServiceFactory>();

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

/**
 * Memoizes a `DocumentSpaceServiceFactory` per `WorkspaceExecutionContext` and wraps
 * each resolved service with a per-request `getCollection` cache. Idempotent if called twice.
 */
export function memoizeDocumentSpaceServiceFactory(
  factory: DocumentSpaceServiceFactory
): DocumentSpaceServiceFactory {
  if (memoizedSpaceServiceFactories.has(factory)) {
    return factory;
  }
  const memoizedSpaceServices = new WeakMap<
    WorkspaceExecutionContext,
    Promise<DocumentSpaceService>
  >();
  const wrapped: DocumentSpaceServiceFactory = (
    context: WorkspaceExecutionContext
  ): Promise<DocumentSpaceService> => {
    const existing = memoizedSpaceServices.get(context);
    if (existing) {
      return existing;
    }
    const pending = Promise.resolve()
      .then(() => factory(context))
      .then((service) => wrapWithPerRequestCollectionCache(service))
      .catch((error) => {
        memoizedSpaceServices.delete(context);
        throw error;
      });
    memoizedSpaceServices.set(context, pending);
    return pending;
  };
  memoizedSpaceServiceFactories.add(wrapped);
  return wrapped;
}


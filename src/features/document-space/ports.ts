import type {
  DocumentSpace,
  DocumentSpaceCollection,
  DocumentSpaceType,
  StorageContextConfig,
} from './domain';

export type {
  DocumentSpace,
  DocumentSpaceCollection,
  DocumentSpaceType,
  StorageContextConfig,
};

export interface DocumentSpaceManifestRegistryPort {
  getDocumentSpaceTypes(): Promise<DocumentSpaceType[]>;
}

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
}

export interface DocumentSpaceStoragePort {
  fetchSpaces(config: StorageContextConfig, typeId?: string): Promise<DocumentSpace[]>;
}



import type {
  DocumentSpace,
  DocumentSpaceCollection,
  DocumentSpaceType,
  StorageContextConfig,
  StorageLocation,
} from './domain';

export type {
  DocumentSpace,
  DocumentSpaceCollection,
  DocumentSpaceType,
  StorageContextConfig,
  StorageLocation,
};

export interface DocumentSpaceManifestRegistryPort {
  getDocumentSpaceTypes(): Promise<DocumentSpaceType[]>;
}

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
}

export type EvaluationOrderCalculator = (
  schemaOrKeys?: string[] | { fields?: Array<{ key: string }> } | Record<string, unknown>,
  uiSchema?: { layout?: string[]; fields?: Record<string, { computeValue?: unknown }> }
) => string[];

export interface DocumentSpaceStoragePort {
  fetchSpaces(config: StorageContextConfig, typeId: string): Promise<DocumentSpace[]>;
  resolveStorageLocation(abstractStorageId: string): Promise<StorageLocation>;
}



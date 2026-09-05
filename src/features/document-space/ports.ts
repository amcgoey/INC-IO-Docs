import type { DocumentSpaceType } from './domain';

export type { DocumentSpaceType };

export interface DocumentSpaceManifestRegistryPort {
  getDocumentSpaceTypes(): Promise<DocumentSpaceType[]>;
}


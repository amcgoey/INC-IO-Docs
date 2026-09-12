import type { AppManifestProvider } from '../infrastructure/manifest/app-manifest-provider';
import { DocumentUiSchemaQueryAdapter } from '../features/document/adapters/document-ui-schema-query';
import { DocumentUiBlockAdapter } from '../features/document/adapters/ui-block';
import type { DocumentUiSchemaQueryPort } from '../features/document/ports';

export interface DocumentFeatureWiringOptions {
  manifestProvider: AppManifestProvider;
}

export interface DocumentFeatureWiring {
  documentUiSchemaQuery: DocumentUiSchemaQueryPort;
  documentUiBlock: DocumentUiBlockAdapter;
}

export function createDocumentFeatureWiring(
  options: DocumentFeatureWiringOptions
): DocumentFeatureWiring {
  const documentUiSchemaQuery = new DocumentUiSchemaQueryAdapter(options.manifestProvider);
  const documentUiBlock = new DocumentUiBlockAdapter(documentUiSchemaQuery);

  return {
    documentUiSchemaQuery,
    documentUiBlock,
  };
}

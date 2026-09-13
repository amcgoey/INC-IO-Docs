import type { AppManifestProvider } from '../infrastructure/manifest/app-manifest-provider';
import { DocumentUiSchemaQueryAdapter } from '../features/document/adapters/document-ui-schema-query';
import { DocumentUiBlockAdapter } from '../features/document/adapters/ui-block';
import type { DocumentUiSchemaQueryPort } from '../features/document/ports';
import {
  computeEvaluationOrder,
  ensureEvaluationOrder,
} from '../infrastructure/validation/json-logic-graph';

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
  const documentUiSchemaQuery = new DocumentUiSchemaQueryAdapter(
    options.manifestProvider,
    ensureEvaluationOrder
  );
  const documentUiBlock = new DocumentUiBlockAdapter(
    documentUiSchemaQuery,
    computeEvaluationOrder
  );

  return {
    documentUiSchemaQuery,
    documentUiBlock,
  };
}

import type { AppManifestProvider } from '../infrastructure/manifest/app-manifest-provider';
import { DocumentSchemaRegistryAdapter } from '../features/document/adapters/document-schema-registry';
import { DocumentUiSchemaQueryAdapter } from '../features/document/adapters/document-ui-schema-query';
import { DocumentUiBlockAdapter } from '../features/document/adapters/ui-block';
import type {
  DocumentSchemaRegistryPort,
  DocumentUiSchemaQueryPort,
  SchemaQueryPort,
  TemplateEvaluatorPort,
} from '../features/document/ports';
import {
  computeEvaluationOrder,
  ensureEvaluationOrder,
} from '../infrastructure/validation/json-logic-graph';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';

export interface DocumentFeatureWiringOptions {
  manifestProvider: AppManifestProvider;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  documentSchemaRegistry?: (DocumentSchemaRegistryPort & SchemaQueryPort) | undefined;
}

export interface DocumentFeatureWiring {
  documentSchemaRegistry: DocumentSchemaRegistryPort & SchemaQueryPort;
  documentUiSchemaQuery: DocumentUiSchemaQueryPort;
  documentUiBlock: DocumentUiBlockAdapter;
}

export function createDocumentFeatureWiring(
  options: DocumentFeatureWiringOptions
): DocumentFeatureWiring {
  const templateEvaluator = options.templateEvaluator ?? new HandlebarsAdapter();
  const documentSchemaRegistry =
    options.documentSchemaRegistry ??
    new DocumentSchemaRegistryAdapter(
      options.manifestProvider,
      templateEvaluator,
      ensureEvaluationOrder
    );

  const documentUiSchemaQuery = new DocumentUiSchemaQueryAdapter(
    options.manifestProvider,
    ensureEvaluationOrder,
    documentSchemaRegistry
  );

  const documentUiBlock = new DocumentUiBlockAdapter(
    documentUiSchemaQuery,
    computeEvaluationOrder
  );

  return {
    documentSchemaRegistry,
    documentUiSchemaQuery,
    documentUiBlock,
  };
}

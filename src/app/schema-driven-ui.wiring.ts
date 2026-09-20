import { SchemaDrivenUiService, type UiSchema } from '../features/schema-driven-ui/domain';
import {
  WorkspaceAddonAdapter,
  ManifestUiAdapter,
  type RawManifestProviderPort,
  type EvaluationOrderEnsurer,
} from '../features/schema-driven-ui/adapters';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';

export type { RawManifestProviderPort };

export interface SchemaDrivenUiWiringOptions {
  manifestProvider: RawManifestProviderPort;
  evaluationOrderEnsurer?: EvaluationOrderEnsurer;
}

export interface SchemaDrivenUiWiring {
  schemaDrivenUiService: SchemaDrivenUiService;
}

export function createSchemaDrivenUiWiring(
  options: SchemaDrivenUiWiringOptions
): SchemaDrivenUiWiring {
  const ensurer: EvaluationOrderEnsurer =
    options.evaluationOrderEnsurer ??
    ((uiSchema, docSchema) =>
      ensureEvaluationOrder<UiSchema>(uiSchema, docSchema) ?? uiSchema);

  const manifestAdapter = new ManifestUiAdapter(options.manifestProvider, ensurer);
  const workspaceAddonAdapter = new WorkspaceAddonAdapter();
  const service = new SchemaDrivenUiService(manifestAdapter, [workspaceAddonAdapter]);

  return {
    schemaDrivenUiService: service,
  };
}

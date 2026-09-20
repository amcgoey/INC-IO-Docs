import { SchemaDrivenUiService, type UiSchema } from '../features/schema-driven-ui/domain';
import { WorkspaceAddonAdapter } from '../features/schema-driven-ui/adapters/workspace-addon.adapter';
import {
  ManifestUiAdapter,
  type RawManifestProviderPort,
  type EvaluationOrderEnsurer,
} from '../features/schema-driven-ui/adapters/manifest.adapter';
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
      (ensureEvaluationOrder(uiSchema, docSchema) as UiSchema) ?? uiSchema);

  const manifestAdapter = new ManifestUiAdapter(options.manifestProvider, ensurer);
  const workspaceAddonAdapter = new WorkspaceAddonAdapter();
  const service = new SchemaDrivenUiService(manifestAdapter, [workspaceAddonAdapter]);

  return {
    schemaDrivenUiService: service,
  };
}

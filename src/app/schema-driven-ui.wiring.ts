import { SchemaDrivenUiService, type UiSchema } from '../features/schema-driven-ui/domain';
import { WorkspaceAddonAdapter } from '../features/schema-driven-ui/adapters/workspace-addon.adapter';

import {
  ManifestUiAdapter,
  type RawManifestProviderPort,
  type EvaluationOrderEnsurer,
} from '../features/schema-driven-ui/adapters/manifest.adapter';
import { translateUiViewToNavigationAction } from '../infrastructure/workspace-addon/translator';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';
import type { GenerateViewRequest } from '../features/schema-driven-ui/ports';

export type { RawManifestProviderPort };

export interface SchemaDrivenUiWiringOptions {
  manifestProvider: RawManifestProviderPort;
  evaluationOrderEnsurer?: EvaluationOrderEnsurer;
}

export interface SchemaDrivenUiWiring {
  schemaDrivenUiService: SchemaDrivenUiService;
  generateWorkspaceProcessCard: (
    request: GenerateViewRequest
  ) => Promise<unknown>;
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
    generateWorkspaceProcessCard: async (
      request: GenerateViewRequest
    ): Promise<unknown> => {
      const view = await service.generateView(request);
      return translateUiViewToNavigationAction(view);
    },
  };
}

import { SchemaDrivenUiService, type UiSchema } from '../features/schema-driven-ui/domain';
import {
  WorkspaceAddonAdapter,
  ManifestUiAdapter,
  type RawManifestProviderPort,
  type EvaluationOrderEnsurer,
} from '../features/schema-driven-ui/adapters';
import type { OptionsFetcherPort } from '../features/schema-driven-ui/ports';
import { DynamicOptionsAdapter, type DynamicOptionsDriveClient } from './dynamic-options.adapter';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';

export type { RawManifestProviderPort };

export interface SchemaDrivenUiWiringOptions {
  manifestProvider: RawManifestProviderPort;
  evaluationOrderEnsurer?: EvaluationOrderEnsurer | undefined;
  optionsFetcher?: OptionsFetcherPort | undefined;
  driveClient?: DynamicOptionsDriveClient | undefined;
}

export interface SchemaDrivenUiWiring {
  schemaDrivenUiService: SchemaDrivenUiService;
  optionsFetcher?: OptionsFetcherPort | undefined;
}

export function createSchemaDrivenUiWiring(
  options: SchemaDrivenUiWiringOptions
): SchemaDrivenUiWiring {
  const ensurer: EvaluationOrderEnsurer =
    options.evaluationOrderEnsurer ??
    ((uiSchema, docSchema) =>
      ensureEvaluationOrder<UiSchema>(uiSchema, docSchema) ?? uiSchema);

  const manifestAdapter = new ManifestUiAdapter(options.manifestProvider, ensurer);
  const workspaceAddonAdapter = new WorkspaceAddonAdapter(manifestAdapter);
  const optionsFetcher =
    options.optionsFetcher ??
    (options.driveClient ? new DynamicOptionsAdapter(options.driveClient) : undefined);
  const service = new SchemaDrivenUiService(manifestAdapter, [workspaceAddonAdapter], optionsFetcher);

  return {
    schemaDrivenUiService: service,
    ...(optionsFetcher !== undefined ? { optionsFetcher } : {}),
  };
}

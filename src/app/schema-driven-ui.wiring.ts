import { SchemaDrivenUiService, type UiSchema } from '../features/schema-driven-ui/domain';
import {
  WorkspaceAddonAdapter,
  GmailWorkspaceAddonAdapter,
  ManifestUiAdapter,
  type RawManifestProviderPort,
  type EvaluationOrderEnsurer,
} from '../features/schema-driven-ui/adapters';
import type { OptionsFetcherPort, UiContextQueryPort } from '../features/schema-driven-ui/ports';
import {
  createLookupOptionsService,
  createOptionsFetcherAdapter,
} from './lookup-options.wiring';
import type { DriveFolderListClient } from '../features/lookup-options';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';

export type { RawManifestProviderPort };

export interface SchemaDrivenUiWiringOptions {
  manifestProvider: RawManifestProviderPort;
  evaluationOrderEnsurer?: EvaluationOrderEnsurer | undefined;
  optionsFetcher?: OptionsFetcherPort | undefined;
  uiContextQuery?: UiContextQueryPort | undefined;
  driveClient?: DriveFolderListClient | undefined;
}

export interface SchemaDrivenUiWiring {
  schemaDrivenUiService: SchemaDrivenUiService;
  optionsFetcher?: OptionsFetcherPort | undefined;
  uiContextQuery?: UiContextQueryPort | undefined;
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
  const gmailWorkspaceAddonAdapter = new GmailWorkspaceAddonAdapter(manifestAdapter);
  const optionsFetcher =
    options.optionsFetcher ??
    (options.driveClient
      ? createOptionsFetcherAdapter(
          createLookupOptionsService({
            manifestProvider: options.manifestProvider,
            driveClient: options.driveClient,
          })
        )
      : undefined);
  const service = new SchemaDrivenUiService(
    manifestAdapter,
    [workspaceAddonAdapter, gmailWorkspaceAddonAdapter],
    optionsFetcher,
    options.uiContextQuery
  );

  return {
    schemaDrivenUiService: service,
    ...(optionsFetcher !== undefined ? { optionsFetcher } : {}),
    ...(options.uiContextQuery !== undefined ? { uiContextQuery: options.uiContextQuery } : {}),
  };
}

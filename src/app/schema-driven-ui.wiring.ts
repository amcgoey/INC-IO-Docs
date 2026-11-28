import { SchemaDrivenUiService, type UiSchema } from '../features/schema-driven-ui/domain';
import {
  WorkspaceAddonAdapter,
  GmailWorkspaceAddonAdapter,
  DocumentSuccessCardAdapter,
  ManifestUiAdapter,
  type RawManifestProviderPort,
  type EvaluationOrderEnsurer,
} from '../features/schema-driven-ui/adapters';
import type {
  OptionsFetcherPort,
  TemplateParserPort,
  UiContextQueryPort,
} from '../features/schema-driven-ui/ports';
import {
  createLookupOptionsService,
  createOptionsFetcherAdapter,
} from './lookup-options.wiring';
import type { DriveFolderListClient } from '../features/lookup-options';
import { ensureEvaluationOrder } from '../infrastructure/validation/json-logic-graph';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';

export type { RawManifestProviderPort };

export interface SchemaDrivenUiWiringOptions {
  manifestProvider: RawManifestProviderPort;
  evaluationOrderEnsurer?: EvaluationOrderEnsurer | undefined;
  optionsFetcher?: OptionsFetcherPort | undefined;
  uiContextQuery?: UiContextQueryPort | undefined;
  driveClient?: DriveFolderListClient | undefined;
  templateParser?: TemplateParserPort | undefined;
  lookupTimeoutMs?: number | undefined;
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
  const templateParser = options.templateParser ?? new HandlebarsAdapter();
  const documentSuccessCardAdapter = new DocumentSuccessCardAdapter(
    manifestAdapter,
    templateParser
  );
  const optionsFetcher =
    options.optionsFetcher ??
    (options.driveClient
      ? createOptionsFetcherAdapter(
          createLookupOptionsService({
            manifestProvider: options.manifestProvider,
            driveClient: options.driveClient,
            ...(options.lookupTimeoutMs !== undefined
              ? { lookupTimeoutMs: options.lookupTimeoutMs }
              : {}),
          })
        )
      : undefined);
  const service = new SchemaDrivenUiService(
    manifestAdapter,
    [workspaceAddonAdapter, gmailWorkspaceAddonAdapter, documentSuccessCardAdapter],
    optionsFetcher,
    options.uiContextQuery
  );

  return {
    schemaDrivenUiService: service,
    ...(optionsFetcher !== undefined ? { optionsFetcher } : {}),
    ...(options.uiContextQuery !== undefined ? { uiContextQuery: options.uiContextQuery } : {}),
  };
}

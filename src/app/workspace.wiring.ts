import { registerWorkspaceFeatureRoutes } from '../features/workspace/adapters/api';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import * as uiBlocks from '../infrastructure/workspace-addon/ui-blocks';
import type { HttpServer } from '../infrastructure/http';
import type {
  AuthVerifierPort,
  WorkspaceConfigProviderPort,
  WorkspaceProcessCardOrchestratorPort,
  WorkspaceProcessCardRequest,
  WorkspaceUiBuilderPort,
} from '../features/workspace/ports';

export type { WorkspaceUiBuilderPort };
import type { DocumentService } from '../features/document/domain';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { DocumentSchemaRegistryPort, SchemaQueryPort } from '../features/document/ports';
import { translateUiViewToNavigationAction } from '../infrastructure/workspace-addon/translator';
import { createSchemaDrivenUiWiring, type RawManifestProviderPort } from './schema-driven-ui.wiring';

export interface WorkspaceFeatureWiringOptions {
  server: HttpServer;
  documentService: DocumentService;
  documentSpaceService: DocumentSpaceService;
  documentSchemaRegistry: DocumentSchemaRegistryPort & SchemaQueryPort;
  authVerifier?: AuthVerifierPort | undefined;
  uiBuilder?: WorkspaceUiBuilderPort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
  manifestProvider?: RawManifestProviderPort | undefined;
  processCardOrchestrator?: WorkspaceProcessCardOrchestratorPort | undefined;
}

function mapSelectionItems(items: Array<{ text: string; value: string; selected?: boolean | undefined }>) {
  return items.map((item) => ({
    text: item.text,
    value: item.value,
    ...(item.selected !== undefined ? { selected: item.selected } : {}),
  }));
}


export function wireWorkspaceFeature(
  options: WorkspaceFeatureWiringOptions
): void {
  const authVerifier: AuthVerifierPort = options.authVerifier ?? new GoogleJwtVerifier();
  const uiBuilder: WorkspaceUiBuilderPort = options.uiBuilder ?? uiBlocks;

  let processCardOrchestrator = options.processCardOrchestrator;
  if (!processCardOrchestrator && options.manifestProvider) {
    const schemaDrivenUi = createSchemaDrivenUiWiring({
      manifestProvider: options.manifestProvider,
    });
    processCardOrchestrator = {
      async generateCard(request: WorkspaceProcessCardRequest) {
        const view = await schemaDrivenUi.schemaDrivenUiService.generateView({
          viewId: request.viewId,
          ...(request.documentTypeKey !== undefined ? { documentTypeKey: request.documentTypeKey } : {}),
          ...(request.validationErrors !== undefined ? { validationErrors: request.validationErrors } : {}),
          ...(request.selectionState !== undefined
            ? {
                selectionState: {
                  spaces: request.selectionState.spaces,
                  spaceTypes: mapSelectionItems(request.selectionState.spaceTypes),
                  documentTypes: mapSelectionItems(request.selectionState.documentTypes),
                },
              }
            : {}),
        });
        return translateUiViewToNavigationAction(view);
      },
    };
  }


  registerWorkspaceFeatureRoutes(options.server, {
    authVerifier,
    uiBuilder,
    documentService: options.documentService,
    schemaQuery: options.documentSchemaRegistry,
    documentSpaceService: options.documentSpaceService,
    configProvider: options.configProvider,
    processCardOrchestrator,
  });
}



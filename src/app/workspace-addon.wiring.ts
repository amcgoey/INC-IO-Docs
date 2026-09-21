import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceUiOrchestratorPort,
} from '../infrastructure/workspace-addon/api';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { evaluateFormChange } from '../infrastructure/workspace-addon/json-logic-evaluator';
import type { HttpServer } from '../infrastructure/http';
import type { InjectedDocumentService } from './document.wiring';
import type { DocumentSpaceService } from '../features/document-space/domain';
import { createUiProcessManagerWiring } from './ui-process-manager.wiring';
import type { RawManifestProviderPort } from '../features/ui-process-manager';
import type { WorkspaceConfigProviderPort } from '../infrastructure/workspace-addon/config';

export interface WorkspaceAddonWiringOptions {
  server: HttpServer;
  documentService?: InjectedDocumentService | undefined;
  documentSpaceService?: DocumentSpaceService | undefined;
  authVerifier?: WorkspaceAuthVerifierPort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
  manifestProvider?: RawManifestProviderPort | undefined;
  uiOrchestrator?: WorkspaceUiOrchestratorPort | undefined;
}

export function wireWorkspaceAddonRoutes(
  options: WorkspaceAddonWiringOptions
): void {
  const authVerifier: WorkspaceAuthVerifierPort = options.authVerifier ?? new GoogleJwtVerifier();

  let uiOrchestrator = options.uiOrchestrator;
  if (!uiOrchestrator) {
    const manifestProvider: RawManifestProviderPort = options.manifestProvider ?? {
      getRawManifest: async () => ({}),
      readParsedSchema: async () => undefined,
    };
    const documentSpaceService: DocumentSpaceService = options.documentSpaceService ?? ({
      getAllTypes: () => [],
      getCollection: async () => ({ spaces: [] }),
    } as unknown as DocumentSpaceService);

    const uiProcessWiring = createUiProcessManagerWiring({
      configProvider: options.configProvider,
      documentSpaceService,
      manifestProvider,
      documentService: options.documentService,
      evaluateFormChange,
    });
    uiOrchestrator = uiProcessWiring.orchestrator;
  }

  registerWorkspaceAddonRoutes(options.server, {
    authVerifier,
    uiOrchestrator: uiOrchestrator!,
  });
}




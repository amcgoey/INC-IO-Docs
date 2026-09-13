import { registerWorkspaceFeatureRoutes } from '../features/workspace/adapters/api';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import * as uiBlocks from '../infrastructure/workspace-addon/ui-blocks';
import type { HttpServer } from '../infrastructure/http';
import type { AuthVerifierPort, WorkspaceConfigProviderPort } from '../features/workspace/ports';
import type { WorkspaceUiBuilderPort } from '../features/workspace/adapters/ui-builder';
import type { DocumentService } from '../features/document/domain';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { DocumentSchemaRegistryPort, SchemaQueryPort } from '../features/document/ports';

export interface WorkspaceFeatureWiringOptions {
  server: HttpServer;
  documentService: DocumentService;
  documentSpaceService: DocumentSpaceService;
  documentSchemaRegistry: DocumentSchemaRegistryPort & SchemaQueryPort;
  authVerifier?: AuthVerifierPort | undefined;
  uiBuilder?: WorkspaceUiBuilderPort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
}

export function wireWorkspaceFeature(
  options: WorkspaceFeatureWiringOptions
): void {
  const authVerifier: AuthVerifierPort = options.authVerifier ?? new GoogleJwtVerifier();
  const uiBuilder: WorkspaceUiBuilderPort = options.uiBuilder ?? uiBlocks;

  registerWorkspaceFeatureRoutes(options.server, {
    authVerifier,
    uiBuilder,
    documentService: options.documentService,
    schemaQuery: options.documentSchemaRegistry,
    documentSpaceService: options.documentSpaceService,
    configProvider: options.configProvider,
  });
}


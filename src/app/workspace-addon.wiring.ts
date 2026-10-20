import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceUiOrchestratorPort,
} from '../infrastructure/workspace-addon/api';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { evaluateFormChange } from '../infrastructure/workspace-addon/json-logic-evaluator';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { HttpServer } from '../infrastructure/http';
import {
  createDocumentServiceFactory,
  type InjectedDocumentService,
} from './document.wiring';
import {
  createDocumentSpaceServiceFactory,
} from './document-space.wiring';
import type { DocumentSpaceService } from '../features/document-space/domain';
import {
  createUiProcessManagerWiring,
  type DocumentServiceFactory,
  type DocumentSpaceServiceFactory,
  type SchemaDrivenUiServiceFactory,
} from './ui-process-manager.wiring';
import { createSchemaDrivenUiWiring } from './schema-driven-ui.wiring';
import { DynamicOptionsAdapter } from './dynamic-options.adapter';
import type { RawManifestProviderPort } from '../features/ui-process-manager';
import type { WorkspaceConfigProviderPort } from '../infrastructure/workspace-addon/config';
import type {
  CompiledSchemaRegistryPort,
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  AppConfigurationProviderPort,
} from '../features/document/ports';
import type { DocumentSpaceManifestRegistryAdapter } from '../features/document-space/adapters/document-space-manifest-registry';
import type { DocumentSpaceStoragePort } from '../features/document-space/ports';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import type { UiProcessGmailPort } from '../features/ui-process-manager';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import type { PdfProcessor } from '../infrastructure/pdf/pdf-processor';

export interface WorkspaceAddonWiringOptions {
  server: HttpServer;
  documentService?: InjectedDocumentService | undefined;
  createDocumentService?: DocumentServiceFactory | undefined;
  documentSpaceService?: DocumentSpaceService | undefined;
  createDocumentSpaceService?: DocumentSpaceServiceFactory | undefined;
  createSchemaDrivenUiService?: SchemaDrivenUiServiceFactory | undefined;
  authVerifier?: WorkspaceAuthVerifierPort | undefined;
  configProvider?: (WorkspaceConfigProviderPort & Partial<AppConfigurationProviderPort>) | undefined;
  driveConfigProvider?: AppConfigurationProviderPort | undefined;
  manifestProvider?: RawManifestProviderPort | undefined;
  uiOrchestrator?: WorkspaceUiOrchestratorPort | undefined;
  appBaseUrl?: string | undefined;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  gmailClient?: GoogleGmailClient | undefined;
  gmailPort?: UiProcessGmailPort | undefined;
  documentSpaceRegistry?: DocumentSpaceManifestRegistryAdapter | undefined;
  storageAdapter?: DocumentSpaceStoragePort | undefined;
  pdfProcessor?: PdfProcessor | undefined;
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

    const appConfigProvider: AppConfigurationProviderPort | undefined =
      options.driveConfigProvider ??
      (options.configProvider &&
      typeof (options.configProvider as AppConfigurationProviderPort).getDriveConfig === 'function'
        ? (options.configProvider as AppConfigurationProviderPort)
        : undefined);

    const gmailClient = options.gmailClient ?? new GoogleGmailClient();

    let createDocumentSpaceService = options.createDocumentSpaceService;
    if (!createDocumentSpaceService) {
      if (options.documentSpaceService) {
        createDocumentSpaceService = () => options.documentSpaceService!;
      } else if (options.documentSpaceRegistry) {
        createDocumentSpaceService = createDocumentSpaceServiceFactory({
          documentSpaceRegistry: options.documentSpaceRegistry,
          configProvider: appConfigProvider,
          driveClient: options.driveClient,
          storageAdapter: options.storageAdapter,
        });
      }
    }

    let createDocumentService = options.createDocumentService;
    if (!createDocumentService) {
      if (options.documentService) {
        createDocumentService = () => options.documentService!;
      } else if (options.documentSchemaRegistry && options.compiledSchemaRegistry) {
        createDocumentService = createDocumentServiceFactory({
          documentSchemaRegistry: options.documentSchemaRegistry,
          templateEvaluator: options.templateEvaluator ?? new HandlebarsAdapter(),
          compiledSchemaRegistry: options.compiledSchemaRegistry,
          configProvider: appConfigProvider,
          driveClient: options.driveClient,
          gmailClient,
          pdfProcessor: options.pdfProcessor,
        });
      }
    }

    const documentSpaceService: DocumentSpaceService | undefined =
      options.documentSpaceService ??
      (!createDocumentSpaceService
        ? ({
            getAllTypes: () => [],
            getCollection: async () => ({ spaces: [] }),
          } as unknown as DocumentSpaceService)
        : undefined);

    let createSchemaDrivenUiService = options.createSchemaDrivenUiService;
    if (!createSchemaDrivenUiService && options.driveClient) {
      createSchemaDrivenUiService = (context: WorkspaceExecutionContext) => {
        const driveClient = context.userOAuthToken
          ? new GoogleDriveClient({
              auth: context.userOAuthToken,
              configProvider: appConfigProvider,
            })
          : options.driveClient!;
        const optionsFetcher = new DynamicOptionsAdapter(driveClient);
        return createSchemaDrivenUiWiring({
          manifestProvider,
          optionsFetcher,
        }).schemaDrivenUiService;
      };
    }

    const uiProcessWiring = createUiProcessManagerWiring({
      configProvider: options.configProvider,
      documentSpaceService,
      createDocumentSpaceService,
      manifestProvider,
      documentService: options.documentService,
      createDocumentService,
      ...(options.compiledSchemaRegistry !== undefined ? { compiledSchemaRegistry: options.compiledSchemaRegistry } : {}),
      ...(options.documentSchemaRegistry !== undefined ? { documentSchemaRegistry: options.documentSchemaRegistry } : {}),
      ...(createSchemaDrivenUiService !== undefined ? { createSchemaDrivenUiService } : {}),
      ...(options.driveClient !== undefined ? { driveClient: options.driveClient } : {}),
      gmailClient,
      ...(options.gmailPort !== undefined ? { gmailPort: options.gmailPort } : {}),
      ...(options.pdfProcessor !== undefined ? { pdfProcessor: options.pdfProcessor } : {}),
      evaluateFormChange,
    });
    uiOrchestrator = uiProcessWiring.requestScopedWrapper;
  }

  registerWorkspaceAddonRoutes(options.server, {
    authVerifier,
    uiOrchestrator: uiOrchestrator!,
    appBaseUrl: options.appBaseUrl,
  });
}




import type { DocumentSpaceService } from '../features/document-space/domain';
import type { DocumentService } from '../features/document/domain';
import {
  WorkspaceAddonAdapter,
  ManifestAdapter,
  FormEvaluatorAdapter,
  type UiProcessSpaceProviderPort,
  type UiProcessConfigProviderPort,
  type UiProcessViewGeneratorPort,
  type UiProcessCardRequest,
  type UiProcessDocumentRunnerPort,
  type UiProcessFormEvaluatorPort,
} from '../features/ui-process-manager';
import {
  createSchemaDrivenUiWiring,
  type RawManifestProviderPort,
} from './schema-driven-ui.wiring';
import type { SchemaDrivenUiService } from '../features/schema-driven-ui/domain';
import {
  translateUiViewToNavigationAction,
  translateUiViewToUpdateCardAction,
} from '../infrastructure/workspace-addon/translator';
import {
  mapUiViewToAbstractUiView,
  mapSelectionItems,
  type WorkspaceConfigProviderPort,
} from './workspace-addon.wiring';

export type FormChangeEvaluator = (
  formData: Record<string, unknown>,
  docSchema?: unknown,
  uiSchema?: unknown
) => {
  computedData: Record<string, unknown>;
  hiddenFields: string[];
  disabledFields: string[];
};

export interface UiProcessManagerWiringOptions {
  configProvider?: WorkspaceConfigProviderPort | undefined;
  documentSpaceService: DocumentSpaceService;
  manifestProvider: RawManifestProviderPort;
  schemaDrivenUiService?: SchemaDrivenUiService | undefined;
  documentService?: DocumentService | undefined;
  evaluateFormChange?: FormChangeEvaluator | undefined;
}

export interface UiProcessManagerWiring {
  orchestrator: WorkspaceAddonAdapter;
}

export function createUiProcessManagerWiring(
  options: UiProcessManagerWiringOptions
): UiProcessManagerWiring {
  const schemaDrivenUi =
    options.schemaDrivenUiService !== undefined
      ? { schemaDrivenUiService: options.schemaDrivenUiService }
      : createSchemaDrivenUiWiring({
          manifestProvider: options.manifestProvider,
        });

  const spaceProvider: UiProcessSpaceProviderPort = {
    getAllTypes: () => options.documentSpaceService.getAllTypes(),
    getCollection: (typeId: string) => options.documentSpaceService.getCollection(typeId),
  };

  const configProvider: UiProcessConfigProviderPort = {
    getWorkspaceConfig: async () => {
      if (!options.configProvider) {
        return undefined;
      }
      const cfg = await options.configProvider.getWorkspaceConfig();
      if (!cfg) {
        return undefined;
      }
      return {
        defaultDocumentType: cfg.defaultDocumentType,
        defaultDocumentSpaceType: cfg.defaultDocumentSpaceType,
      };
    },
  };

  const manifestPort = new ManifestAdapter(options.manifestProvider);

  const viewGenerator: UiProcessViewGeneratorPort = {
    async generateCard(request: UiProcessCardRequest) {
      const view = await schemaDrivenUi.schemaDrivenUiService.generateView({
        viewId: request.viewId,
        ...(request.documentTypeKey !== undefined ? { documentTypeKey: request.documentTypeKey } : {}),
        ...(request.validationErrors !== undefined ? { validationErrors: request.validationErrors } : {}),
        ...(request.formData !== undefined ? { formData: request.formData } : {}),
        ...(request.hiddenFields !== undefined ? { hiddenFields: request.hiddenFields } : {}),
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

      const mappedView = mapUiViewToAbstractUiView(view);
      if (request.isUpdateCard) {
        return translateUiViewToUpdateCardAction(mappedView);
      }
      return translateUiViewToNavigationAction(mappedView);
    },
  };

  const documentRunner: UiProcessDocumentRunnerPort | undefined = options.documentService
    ? {
        processDocument: async (payload, eventName, context) => {
          return options.documentService!.processDocument(payload, eventName, context);
        },
      }
    : undefined;

  const formEvaluator: UiProcessFormEvaluatorPort | undefined = options.evaluateFormChange
    ? new FormEvaluatorAdapter(options.manifestProvider, options.evaluateFormChange)
    : undefined;

  const orchestrator = new WorkspaceAddonAdapter({
    spaceProvider,
    configProvider,
    manifestPort,
    viewGenerator,
    documentRunner,
    formEvaluator,
  });

  return {
    orchestrator,
  };
}

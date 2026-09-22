import type { DocumentSpaceService } from '../features/document-space/domain';
import type { InjectedDocumentService } from './document.wiring';
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
  type RawManifestProviderPort,
} from '../features/ui-process-manager';
import {
  createSchemaDrivenUiWiring,
} from './schema-driven-ui.wiring';
import type {
  SchemaDrivenUiService,
  UiView,
} from '../features/schema-driven-ui/domain';
import {
  translateUiViewToNavigationAction,
  translateUiViewToUpdateCardAction,
  type UiView as WorkspaceUiView,
  type UiViewWidget,
  type UiAction,
} from '../infrastructure/workspace-addon/translator';
import type { WorkspaceConfigProviderPort } from '../infrastructure/workspace-addon/config';
import type { FormChangeEvaluatorFn as FormChangeEvaluator } from '../features/ui-process-manager';

function mapSelectionItems(
  items: Array<{ text: string; value: string; selected?: boolean | undefined }>
) {
  return items.map((item) => ({
    text: item.text,
    value: item.value,
    ...(item.selected !== undefined ? { selected: item.selected } : {}),
  }));
}

function mapUiAction(
  action?: { action: string; parameters?: Record<string, unknown> | undefined } | undefined
): UiAction | undefined {
  if (!action) {
    return undefined;
  }
  const parameters: Record<string, string> | undefined = action.parameters
    ? Object.fromEntries(
        Object.entries(action.parameters)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => [k, String(v)])
      )
    : undefined;
  return {
    action: action.action,
    route: action.action === 'onFormChange' ? '/workspace/on-form-change' : '/workspace/action',
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

export function mapUiViewToWorkspaceUiView(view: UiView): WorkspaceUiView {
  return {
    ...(view.id !== undefined ? { id: view.id } : {}),
    ...(view.header !== undefined
      ? {
          header: {
            title: view.header.title,
            ...(view.header.subtitle !== undefined ? { subtitle: view.header.subtitle } : {}),
            ...(view.header.imageUrl !== undefined ? { imageUrl: view.header.imageUrl } : {}),
            ...(view.header.imageType !== undefined ? { imageType: view.header.imageType } : {}),
          },
        }
      : {}),
    sections: view.sections.map((section) => ({
      ...(section.header !== undefined ? { header: section.header } : {}),
      ...(section.collapsible !== undefined ? { collapsible: section.collapsible } : {}),
      ...(section.uncollapsibleWidgetsCount !== undefined
        ? { uncollapsibleWidgetsCount: section.uncollapsibleWidgetsCount }
        : {}),
      widgets: section.widgets
        .map((widget): UiViewWidget | undefined => {
          if (widget.textParagraph) {
            return { textParagraph: { text: widget.textParagraph.text } };
          }
          if (widget.textInput) {
            const mappedAction = mapUiAction(widget.textInput.onChangeAction);
            return {
              textInput: {
                name: widget.textInput.name,
                ...(widget.textInput.label !== undefined ? { label: widget.textInput.label } : {}),
                ...(widget.textInput.hintText !== undefined ? { hintText: widget.textInput.hintText } : {}),
                ...(widget.textInput.value !== undefined ? { value: widget.textInput.value } : {}),
                ...(widget.textInput.autocomplete !== undefined
                  ? { autocomplete: mapSelectionItems(widget.textInput.autocomplete) }
                  : {}),
                ...(mappedAction !== undefined ? { onChangeAction: mappedAction } : {}),
              },
            };
          }
          if (widget.selectionInput) {
            const mappedAction = mapUiAction(widget.selectionInput.onChangeAction);
            return {
              selectionInput: {
                name: widget.selectionInput.name,
                ...(widget.selectionInput.label !== undefined ? { label: widget.selectionInput.label } : {}),
                ...(widget.selectionInput.type !== undefined
                  ? {
                      type: widget.selectionInput.type as 'DROPDOWN' | 'CHECK_BOX' | 'RADIO_BUTTON',
                    }
                  : {}),
                ...(widget.selectionInput.items !== undefined
                  ? { items: mapSelectionItems(widget.selectionInput.items) }
                  : {}),
                ...(mappedAction !== undefined ? { onChangeAction: mappedAction } : {}),
              },
            };
          }
          if (widget.buttonList) {
            return {
              buttonList: {
                buttons: widget.buttonList.buttons.map((btn) => {
                  const mappedOnClick = mapUiAction(btn.onClick);
                  return {
                    text: btn.text,
                    ...(mappedOnClick !== undefined ? { onClick: mappedOnClick } : {}),
                  };
                }),
              },
            };
          }
          return undefined;
        })
        .filter((w): w is UiViewWidget => w !== undefined),
    })),
    ...(view.evaluationOrder !== undefined ? { evaluationOrder: view.evaluationOrder } : {}),
  };
}

export interface UiProcessManagerWiringOptions {
  configProvider?: WorkspaceConfigProviderPort | undefined;
  documentSpaceService: DocumentSpaceService;
  manifestProvider: RawManifestProviderPort;
  schemaDrivenUiService?: SchemaDrivenUiService | undefined;
  documentService?: InjectedDocumentService | undefined;
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
    getCollection: (typeId: string, opts?: { auth?: string | undefined }) =>
      options.documentSpaceService.getCollection(typeId, opts),
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

      const mappedView = mapUiViewToWorkspaceUiView(view);
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
    ? new FormEvaluatorAdapter(manifestPort, options.evaluateFormChange)
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

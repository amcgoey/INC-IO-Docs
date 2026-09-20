import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceConfigProviderPort,
  type WorkspaceProcessCardOrchestratorPort,
  type WorkspaceProcessCardRequest,
} from '../infrastructure/workspace-addon/api';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { evaluateFormChange } from '../infrastructure/workspace-addon/json-logic-evaluator';
import type { HttpServer } from '../infrastructure/http';
import type { DocumentService } from '../features/document/domain';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { UiView } from '../features/schema-driven-ui/domain';
import {
  translateUiViewToNavigationAction,
  translateUiViewToUpdateCardAction,
  type AbstractUiView,
  type AbstractUiViewWidget,
  type AbstractUiAction,
} from '../infrastructure/workspace-addon/translator';
import { createSchemaDrivenUiWiring, type RawManifestProviderPort } from './schema-driven-ui.wiring';

export interface WorkspaceAddonWiringOptions {
  server: HttpServer;
  documentService: DocumentService;
  documentSpaceService?: DocumentSpaceService | undefined;
  authVerifier?: WorkspaceAuthVerifierPort | undefined;
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

function mapActionParameters(
  parameters?: Record<string, unknown> | undefined
): Array<{ key: string; value: string }> | undefined {
  if (!parameters) {
    return undefined;
  }
  return Object.entries(parameters).map(([key, value]) => ({
    key,
    value: String(value),
  }));
}

function mapUiAction(
  action?: { action: string; parameters?: Record<string, unknown> | undefined } | undefined
): AbstractUiAction | undefined {
  if (!action) {
    return undefined;
  }
  const params = mapActionParameters(action.parameters);
  return {
    action: action.action,
    ...(params !== undefined ? { parameters: params } : {}),
  };
}

function mapUiViewToAbstractUiView(view: UiView): AbstractUiView {
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
        .map((widget): AbstractUiViewWidget | undefined => {
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
        .filter((w): w is AbstractUiViewWidget => w !== undefined),
    })),
    ...(view.evaluationOrder !== undefined ? { evaluationOrder: view.evaluationOrder } : {}),
  };
}

export function wireWorkspaceAddonRoutes(
  options: WorkspaceAddonWiringOptions
): void {
  const authVerifier: WorkspaceAuthVerifierPort = options.authVerifier ?? new GoogleJwtVerifier();

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
  }

  registerWorkspaceAddonRoutes(options.server, {
    authVerifier,
    documentService: options.documentService,
    documentSpaceService: options.documentSpaceService,
    configProvider: options.configProvider,
    processCardOrchestrator,
    manifestProvider: options.manifestProvider,
    evaluateFormChange,
  });
}

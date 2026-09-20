import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceUiOrchestratorPort,
} from '../infrastructure/workspace-addon/api';
import { GoogleJwtVerifier } from '../infrastructure/workspace-addon/jwt-verifier';
import { evaluateFormChange } from '../infrastructure/workspace-addon/json-logic-evaluator';
import type { HttpServer } from '../infrastructure/http';
import type { DocumentService } from '../features/document/domain';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { UiView } from '../features/schema-driven-ui/domain';
import {
  type AbstractUiView,
  type AbstractUiViewWidget,
  type AbstractUiAction,
} from '../infrastructure/workspace-addon/translator';
import { createUiProcessManagerWiring } from './ui-process-manager.wiring';
import type { RawManifestProviderPort } from './schema-driven-ui.wiring';

export interface WorkspaceConfiguration {
  appTitle?: string | undefined;
  actionButtonText?: string | undefined;
  defaultDocumentType?: string | undefined;
  defaultDocumentSpaceType?: string | undefined;
  defaultEventName?: string | undefined;
}

export interface WorkspaceConfigProviderPort {
  getWorkspaceConfig(): Promise<WorkspaceConfiguration | undefined>;
}

export interface WorkspaceAddonWiringOptions {
  server: HttpServer;
  documentService?: DocumentService | undefined;
  documentSpaceService?: DocumentSpaceService | undefined;
  authVerifier?: WorkspaceAuthVerifierPort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
  manifestProvider?: RawManifestProviderPort | undefined;
  uiOrchestrator?: WorkspaceUiOrchestratorPort | undefined;
}


export function mapSelectionItems(items: Array<{ text: string; value: string; selected?: boolean | undefined }>) {
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

export function mapUiViewToAbstractUiView(view: UiView): AbstractUiView {
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
    uiOrchestrator,
  });
}




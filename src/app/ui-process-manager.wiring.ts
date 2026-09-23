import type { DocumentSpaceService } from '../features/document-space/domain';
import type { InjectedDocumentService } from './document.wiring';
import {
  WorkspaceAddonAdapter,
  ManifestAdapter,
  FormEvaluatorAdapter,
  type UiProcessOrchestratorPort,
  type UiProcessEventContext,
  type UiProcessResult,
  type UiProcessSpaceProviderPort,
  type UiProcessConfigProviderPort,
  type UiProcessDocumentRunnerPort,
  type UiProcessFormEvaluatorPort,
  type RawManifestProviderPort,
  type UiProcessAuthOptions,
} from '../features/ui-process-manager';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
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

export function resolveActionRoute(route: string, baseUrl?: string): string {
  try {
    // If already an absolute URL (e.g., starts with http:// or https://), return as-is
    const parsed = new URL(route);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // Not an absolute URL, continue to resolve with baseUrl
  }
  if (baseUrl) {
    try {
      return new URL(route, baseUrl).toString();
    } catch {
      // Fallback to route if URL construction fails
    }
  }
  return route;
}

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
  action?: { action: string; parameters?: Record<string, unknown> | undefined } | undefined,
  baseUrl?: string | undefined
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

  const rawRoute = action.action === 'onFormChange' ? '/workspace/on-form-change' : '/workspace/action';
  const route = resolveActionRoute(rawRoute, baseUrl);

  return {
    action: action.action,
    route,
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

export function mapUiViewToWorkspaceUiView(view: UiView, baseUrl?: string | undefined): WorkspaceUiView {
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
            const mappedAction = mapUiAction(widget.textInput.onChangeAction, baseUrl);
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
            const mappedAction = mapUiAction(widget.selectionInput.onChangeAction, baseUrl);
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
                  const mappedOnClick = mapUiAction(btn.onClick, baseUrl);
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

export interface RequestScopedUiWrapper {
  (context: WorkspaceExecutionContext): Promise<unknown>;
  processUiEvent(context: WorkspaceExecutionContext): Promise<unknown>;
}

export function createUiProcessRequestWrapper(
  orchestrator: UiProcessOrchestratorPort,
  schemaDrivenUiService: SchemaDrivenUiService
): RequestScopedUiWrapper {
  const handler = async (context: WorkspaceExecutionContext): Promise<unknown> => {
    const eventContext: UiProcessEventContext = {
      actionName: context.actionName,
      formData: context.formData,
      parameters: context.parameters,
      validationErrors: context.validationErrors,
      userOAuthToken: context.userOAuthToken,
      selectedItems: context.selectedItems?.map((item) => ({
        id: item.id,
        title: item.title,
      })),
    };

    const intent: UiProcessResult = await orchestrator.processUiEvent(eventContext);

    if (intent.type === 'notification') {
      return {
        action: {
          notification: {
            text: intent.text,
          },
        },
      };
    }

    const view = await schemaDrivenUiService.generateView({
      viewId: intent.viewId,
      ...(intent.documentTypeKey !== undefined ? { documentTypeKey: intent.documentTypeKey } : {}),
      ...(intent.validationErrors !== undefined ? { validationErrors: intent.validationErrors } : {}),
      ...(intent.formData !== undefined ? { formData: intent.formData } : {}),
      ...(intent.hiddenFields !== undefined ? { hiddenFields: intent.hiddenFields } : {}),
      ...(intent.selectionState !== undefined
        ? {
            selectionState: {
              spaces: intent.selectionState.spaces,
              spaceTypes: mapSelectionItems(intent.selectionState.spaceTypes),
              documentTypes: mapSelectionItems(intent.selectionState.documentTypes),
            },
          }
        : {}),
    });

    const mappedView = mapUiViewToWorkspaceUiView(view, context.baseUrl);
    if (intent.isUpdateCard) {
      return translateUiViewToUpdateCardAction(mappedView);
    }
    return translateUiViewToNavigationAction(mappedView);
  };

  const wrapper = handler as RequestScopedUiWrapper;
  wrapper.processUiEvent = handler;
  return wrapper;
}

export interface UiProcessManagerWiring {
  orchestrator: WorkspaceAddonAdapter;
  requestScopedWrapper: RequestScopedUiWrapper;
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
    getCollection: (typeId: string, opts?: UiProcessAuthOptions) =>
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
    documentRunner,
    formEvaluator,
  });

  const requestScopedWrapper = createUiProcessRequestWrapper(
    orchestrator,
    schemaDrivenUi.schemaDrivenUiService
  );

  return {
    orchestrator,
    requestScopedWrapper,
  };
}

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
  type UiProcessSpaceItem,
  type UiProcessDocumentSpaceDto,
  type UiProcessGmailPort,
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
import type { OptionsFetcherPort } from '../features/schema-driven-ui/ports';
import type { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleGmailClient } from '../infrastructure/gmail/gmail-client';
import { PdfProcessor } from '../infrastructure/pdf/pdf-processor';
import type {
  CompiledSchemaRegistryPort,
  DocumentSchemaRegistryPort,
  DocumentDynamicValidationPort,
  DynamicValidationMessageFormatter,
  DocumentModel,
} from '../features/document/ports';

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
                      type: widget.selectionInput.type as 'DROPDOWN' | 'RADIO_BUTTON' | 'CHECK_BOX' | 'SWITCH',
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

export type DocumentSpaceServiceFactory = (
  context: WorkspaceExecutionContext
) => DocumentSpaceService | Promise<DocumentSpaceService>;

export type DocumentServiceFactory = (
  context: WorkspaceExecutionContext
) => InjectedDocumentService | Promise<InjectedDocumentService>;

export type SchemaDrivenUiServiceFactory = (
  context: WorkspaceExecutionContext
) => SchemaDrivenUiService | Promise<SchemaDrivenUiService>;

export type UiProcessOrchestratorFactory = (
  context: WorkspaceExecutionContext
) => UiProcessOrchestratorPort | Promise<UiProcessOrchestratorPort>;

export interface UiProcessManagerWiringOptions {
  configProvider?: WorkspaceConfigProviderPort | undefined;
  documentSpaceService?: DocumentSpaceService | undefined;
  createDocumentSpaceService?: DocumentSpaceServiceFactory | undefined;
  manifestProvider: RawManifestProviderPort;
  schemaDrivenUiService?: SchemaDrivenUiService | undefined;
  createSchemaDrivenUiService?: SchemaDrivenUiServiceFactory | undefined;
  documentService?: InjectedDocumentService | undefined;
  createDocumentService?: DocumentServiceFactory | undefined;
  evaluateFormChange?: FormChangeEvaluator | undefined;
  createOrchestrator?: UiProcessOrchestratorFactory | undefined;
  optionsFetcher?: OptionsFetcherPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  gmailClient?: GoogleGmailClient | undefined;
  gmailPort?: UiProcessGmailPort | undefined;
  compiledSchemaRegistry?: CompiledSchemaRegistryPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  dynamicValidator?: DocumentDynamicValidationPort | undefined;
  validationMessageFormatter?: DynamicValidationMessageFormatter | undefined;
  pdfProcessor?: PdfProcessor | undefined;
}

export type UiProcessOrchestratorResolver = (
  context: WorkspaceExecutionContext
) => Promise<UiProcessOrchestratorPort> | UiProcessOrchestratorPort;

export type SchemaDrivenUiServiceResolver = (
  context: WorkspaceExecutionContext
) => Promise<SchemaDrivenUiService> | SchemaDrivenUiService;

export interface RequestScopedUiWrapper {
  (context: WorkspaceExecutionContext): Promise<unknown>;
  processUiEvent(context: WorkspaceExecutionContext): Promise<unknown>;
}

export function createUiProcessRequestWrapper(
  orchestrator: UiProcessOrchestratorPort | UiProcessOrchestratorResolver,
  schemaDrivenUiService: SchemaDrivenUiService | SchemaDrivenUiServiceResolver
): RequestScopedUiWrapper {
  const handler = async (context: WorkspaceExecutionContext): Promise<unknown> => {
    const orchestratorInstance =
      typeof orchestrator === 'function' ? await orchestrator(context) : orchestrator;
    const schemaDrivenUiInstance =
      typeof schemaDrivenUiService === 'function'
        ? await schemaDrivenUiService(context)
        : schemaDrivenUiService;

    const eventContext: UiProcessEventContext = {
      actionName: context.actionName,
      formData: context.formData,
      parameters: context.parameters,
      validationErrors: context.validationErrors,
      hostApp: context.hostApp,
      gmail: context.gmail,
      userOAuthToken: context.userOAuthToken,
      selectedItems: context.selectedItems?.map((item) => ({
        id: item.id,
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
      })),
    };

    const intent: UiProcessResult = await orchestratorInstance.processUiEvent(eventContext);

    if (intent.type === 'notification') {
      return {
        action: {
          notification: {
            text: intent.text,
          },
        },
      };
    }

    const view = await schemaDrivenUiInstance.generateView({
      viewId: intent.viewId,
      ...(intent.spaceId !== undefined ? { spaceId: intent.spaceId } : {}),
      ...(intent.documentTypeKey !== undefined ? { documentTypeKey: intent.documentTypeKey } : {}),
      ...(intent.validationErrors !== undefined ? { validationErrors: intent.validationErrors } : {}),
      ...(intent.statusMessages !== undefined ? { statusMessages: intent.statusMessages } : {}),
      ...(intent.formData !== undefined ? { formData: intent.formData } : {}),
      ...(intent.hiddenFields !== undefined ? { hiddenFields: intent.hiddenFields } : {}),
      ...(intent.selectionState !== undefined
        ? {
            selectionState: {
              spaces: intent.selectionState.spaces,
              spaceTypes: mapSelectionItems(intent.selectionState.spaceTypes),
              documentTypes: mapSelectionItems(intent.selectionState.documentTypes),
              ...(intent.selectionState.files !== undefined
                ? { files: mapSelectionItems(intent.selectionState.files) }
                : {}),
              ...(intent.selectionState.fileSources !== undefined
                ? { fileSources: mapSelectionItems(intent.selectionState.fileSources) }
                : {}),
              ...(intent.selectionState.threadMessages !== undefined
                ? { threadMessages: mapSelectionItems(intent.selectionState.threadMessages) }
                : {}),
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
  if (!options.documentSpaceService && !options.createDocumentSpaceService) {
    throw new Error(
      'Either documentSpaceService or createDocumentSpaceService must be provided to createUiProcessManagerWiring'
    );
  }

  const schemaDrivenUi =
    options.schemaDrivenUiService !== undefined
      ? { schemaDrivenUiService: options.schemaDrivenUiService }
      : createSchemaDrivenUiWiring({
          manifestProvider: options.manifestProvider,
          ...(options.optionsFetcher !== undefined ? { optionsFetcher: options.optionsFetcher } : {}),
          ...(options.driveClient !== undefined ? { driveClient: options.driveClient } : {}),
        });

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

  const formEvaluator: UiProcessFormEvaluatorPort | undefined = options.evaluateFormChange
    ? new FormEvaluatorAdapter(manifestPort, options.evaluateFormChange)
    : undefined;

  const fallbackSpaceProvider: UiProcessSpaceProviderPort = {
    getAllTypes: () => (options.documentSpaceService ? options.documentSpaceService.getAllTypes() : []),
    getCollection: (typeId: string) => {
      if (!options.documentSpaceService) {
        throw new Error(
          'documentSpaceService was not provided at startup; use requestScopedWrapper with createDocumentSpaceService'
        );
      }
      return options.documentSpaceService.getCollection(typeId);
    },
  };

  function toStructuredDocumentSpace(
    space:
      | UiProcessDocumentSpaceDto
      | UiProcessSpaceItem
      | string
      | undefined
  ): UiProcessDocumentSpaceDto | undefined {
    if (!space) {
      return undefined;
    }
    if (typeof space === 'object') {
      return {
        id: space.id,
        name: space.name,
        typeId: ('typeId' in space && space.typeId) ? space.typeId : 'default',
        abstractStorageId: ('abstractStorageId' in space && space.abstractStorageId)
          ? space.abstractStorageId
          : space.id,
      };
    }
    return {
      id: space,
      name: space,
      typeId: 'default',
      abstractStorageId: space,
    };
  }

  const gmailClient = options.gmailClient ?? new GoogleGmailClient();

  const fallbackDocumentRunner: UiProcessDocumentRunnerPort | undefined = options.documentService
    ? {
        processDocument: async (payload, eventName) => {
          const space = toStructuredDocumentSpace(payload.space);
          const documentPayload: DocumentModel = {
            type: payload.type,
            data: payload.data,
            ...(space ? { space } : {}),
          };

          return options.documentService!.processDocument(
            documentPayload,
            eventName
          );
        },
      }
    : undefined;

  function createGmailPortForToken(token?: string): UiProcessGmailPort {
    return {
      getMessageAttachments: async (messageId: string, accessToken?: string) => {
        const msg = await gmailClient.getMessage(messageId, { auth: accessToken ?? token });
        return (msg.attachments ?? []).map((att) => ({
          id: (att.partId && att.partId.trim().length > 0) ? att.partId.trim() : att.attachmentId,
          partId: att.partId,
          attachmentId: att.attachmentId,
          title: att.filename,
          mimeType: att.mimeType,
        }));
      },
      getThreadMessages: async (threadId: string, opts?: { skipCache?: boolean }) => {
        if (typeof (gmailClient as any).getThread === 'function') {
          try {
            const details = await (gmailClient as any).getThread(threadId, {
              auth: token,
              skipCache: opts?.skipCache,
            });
            return (details?.messages ?? []).map((msg: any) => ({
              id: (msg.id && typeof msg.id === 'string' && msg.id.trim().length > 0)
                ? msg.id
                : (typeof msg.messageId === 'string' ? msg.messageId : threadId),
              ...(msg.from !== undefined ? { from: msg.from } : {}),
              ...(msg.date !== undefined ? { date: msg.date } : {}),
              attachments: (msg.attachments ?? []).map((att: any) => ({
                id: (att.partId && att.partId.trim().length > 0)
                  ? att.partId.trim()
                  : (att.id && att.id.trim().length > 0)
                    ? att.id.trim()
                    : att.attachmentId,
                ...(att.partId !== undefined ? { partId: att.partId } : {}),
                ...(att.attachmentId !== undefined ? { attachmentId: att.attachmentId } : {}),
                title: att.filename,
                mimeType: att.mimeType,
              })),
            }));
          } catch {
            return [];
          }
        }
        return [];
      },
      getMessageDetails: async (messageId: string, opts?: { skipCache?: boolean }) => {
        const msg = await gmailClient.getMessage(messageId, {
          auth: token,
          skipCache: opts?.skipCache,
        });
        return {
          id: (msg.id && typeof msg.id === 'string' && msg.id.trim().length > 0)
            ? msg.id
            : (typeof msg.messageId === 'string' ? msg.messageId : messageId),
          ...(msg.from !== undefined ? { from: msg.from } : {}),
          ...(msg.date !== undefined ? { date: msg.date } : {}),
          attachments: (msg.attachments ?? []).map((att) => ({
            id: (att.partId && att.partId.trim().length > 0)
              ? att.partId.trim()
              : ((att as any).id && typeof (att as any).id === 'string' && (att as any).id.trim().length > 0)
                ? (att as any).id.trim()
                : att.attachmentId,
            ...(att.partId !== undefined ? { partId: att.partId } : {}),
            ...(att.attachmentId !== undefined ? { attachmentId: att.attachmentId } : {}),
            title: att.filename,
            mimeType: att.mimeType,
          })),
        };
      },
    };
  }

  const gmailPort: UiProcessGmailPort = options.gmailPort ?? createGmailPortForToken(undefined);

  const orchestrator = new WorkspaceAddonAdapter({
    spaceProvider: fallbackSpaceProvider,
    configProvider,
    manifestPort,
    documentRunner: fallbackDocumentRunner,
    formEvaluator,
    gmailPort,
  });

  const orchestratorResolver: UiProcessOrchestratorResolver = async (
    context: WorkspaceExecutionContext
  ): Promise<UiProcessOrchestratorPort> => {
    if (options.createOrchestrator) {
      return options.createOrchestrator(context);
    }

    const token = context.userOAuthToken ?? context.gmail?.accessToken;
    const reqGmailPort: UiProcessGmailPort = options.gmailPort ?? createGmailPortForToken(token);

    if (!options.createDocumentSpaceService && !options.createDocumentService && !token) {
      return orchestrator;
    }

    const docSpaceService = options.createDocumentSpaceService
      ? await options.createDocumentSpaceService(context)
      : options.documentSpaceService;

    const reqSpaceProvider: UiProcessSpaceProviderPort = {
      getAllTypes: () => (docSpaceService ? docSpaceService.getAllTypes() : []),
      getCollection: (typeId: string) => {
        if (!docSpaceService) {
          throw new Error('DocumentSpaceService not provided');
        }
        return docSpaceService.getCollection(typeId);
      },
    };

    const reqDocumentRunner: UiProcessDocumentRunnerPort | undefined =
      options.documentService || options.createDocumentService
        ? {
            processDocument: async (payload, eventName) => {
              const { sourceFiles, ...documentPayload } = payload;
              const space = toStructuredDocumentSpace(documentPayload.space);
              const targetDocPayload: DocumentModel = {
                type: documentPayload.type,
                data: documentPayload.data,
                ...(space ? { space } : {}),
              };

              const activeSourceFiles = sourceFiles ?? [];
              const activeContext: WorkspaceExecutionContext = {
                ...context,
                sourceFiles: activeSourceFiles,
                selectedItems: activeSourceFiles.map((file) => ({
                  id: file.id,
                  ...(file.name !== undefined ? { title: file.name } : {}),
                  ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
                })),
              };

              const docService = options.createDocumentService
                ? await options.createDocumentService(activeContext)
                : options.documentService;

              if (!docService) {
                throw new Error('DocumentService not provided');
              }

              return docService.processDocument(
                targetDocPayload,
                eventName
              );
            },
          }
        : undefined;


    return new WorkspaceAddonAdapter({
      spaceProvider: reqSpaceProvider,
      configProvider,
      manifestPort,
      documentRunner: reqDocumentRunner,
      formEvaluator,
      gmailPort: reqGmailPort,
    });
  };

  const schemaDrivenUiOrResolver: SchemaDrivenUiService | SchemaDrivenUiServiceResolver = options.createSchemaDrivenUiService
    ? (context: WorkspaceExecutionContext) => options.createSchemaDrivenUiService!(context)
    : schemaDrivenUi.schemaDrivenUiService;

  const requestScopedWrapper = createUiProcessRequestWrapper(
    orchestratorResolver,
    schemaDrivenUiOrResolver
  );

  return {
    orchestrator,
    requestScopedWrapper,
  };
}

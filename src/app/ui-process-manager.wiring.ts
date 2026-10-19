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
import { GmailSourceFileHydrator } from './gmail-source-file-hydrator';
import {
  formatValidationErrors,
} from '../features/document/domain';
import type {
  CompiledSchemaRegistryPort,
  DocumentSchemaRegistryPort,
  DocumentDynamicValidationPort,
  DynamicValidationMessageFormatter,
  DynamicValidationQuery,
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

  const compiledSchemaRegistry = options.compiledSchemaRegistry;
  const documentSchemaRegistry = options.documentSchemaRegistry;

  const gmailClient = options.gmailClient ?? new GoogleGmailClient();
  const hydrator = new GmailSourceFileHydrator(gmailClient);

  const preValidateDocument = async (
    type: string,
    data: Record<string, unknown>,
    space?: UiProcessDocumentSpaceDto
  ): Promise<{ success: boolean; errors?: string[] }> => {
    if (compiledSchemaRegistry) {
      await compiledSchemaRegistry.initialize();
      const compiled = compiledSchemaRegistry.get(type);
      if (compiled && !compiled.Check(data)) {
        const errors = formatValidationErrors(compiled.Schema(), data);
        return {
          success: false,
          errors: errors.length > 0 ? errors : ['Invalid document data payload'],
        };
      }
    }

    if (options.dynamicValidator && documentSchemaRegistry) {
      const docTypes = await documentSchemaRegistry.loadAll();
      const documentType = docTypes.find((dt) => dt.key === type);
      if (documentType) {
        const dynamicQueries: DynamicValidationQuery[] = [];
        for (const field of documentType.documentSchema.fields) {
          if (field.options && 'dynamicConfig' in field.options && field.options.dynamicConfig) {
            const dynamicOption = field.options;
            const rawValue = data[field.key];
            const valuesToValidate: string[] = [];
            const normalizedValues = Array.isArray(rawValue) ? rawValue : [rawValue];
            for (const item of normalizedValues) {
              if (typeof item === 'string') {
                valuesToValidate.push(item);
              }
            }

            valuesToValidate.forEach((val, index) => {
              const queryId = valuesToValidate.length > 1 ? `${field.key}_${index}` : field.key;
              dynamicQueries.push({
                sourceKey: dynamicOption.source,
                config: dynamicOption.dynamicConfig as Record<string, unknown>,
                valueToValidate: val,
                queryId,
                ...(dynamicOption.allowUserInput !== undefined
                  ? { allowUserInput: dynamicOption.allowUserInput }
                  : {}),
              });
            });
          }
        }

        if (dynamicQueries.length > 0) {
          const spaceId = space?.abstractStorageId ?? space?.id;
          const validationResults = await options.dynamicValidator.validateExistence(dynamicQueries, {
            ...(spaceId !== undefined ? { spaceId } : {}),
            formData: data,
          });

          const dynamicErrors: string[] = [];
          for (const query of dynamicQueries) {
            const result = validationResults[query.queryId] ?? validationResults[query.sourceKey];
            if (!result || !result.isValid) {
              if (result?.errorMessage !== undefined) {
                dynamicErrors.push(result.errorMessage);
              } else if (result?.status !== undefined && options.validationMessageFormatter) {
                dynamicErrors.push(options.validationMessageFormatter(result.status, result.targetPath));
              } else if (result?.status === 'timeout') {
                dynamicErrors.push('Validation timed out.');
              } else {
                dynamicErrors.push('Option not found.');
              }
            }
          }

          if (dynamicErrors.length > 0) {
            return {
              success: false,
              errors: dynamicErrors,
            };
          }
        }
      }
    }

    return { success: true };
  };

  const fallbackDocumentRunner: UiProcessDocumentRunnerPort | undefined = options.documentService
    ? {
        processDocument: async (payload, eventName) => {
          const space = toStructuredDocumentSpace(payload.space);
          const preValidation = await preValidateDocument(payload.type, payload.data, space);
          if (!preValidation.success) {
            return {
              success: false,
              errors: preValidation.errors,
            };
          }

          return options.documentService!.processDocument(
            {
              type: payload.type,
              data: payload.data,
              ...(space ? { space } : {}),
            },
            eventName
          );
        },
      }
    : undefined;

  const gmailPort: UiProcessGmailPort = options.gmailPort ?? {
    getMessageAttachments: async (messageId: string, accessToken?: string) => {
      const msg = await gmailClient.getMessage(messageId, { auth: accessToken });
      return (msg.attachments ?? []).map((att) => ({
        id: att.attachmentId,
        title: att.filename,
        mimeType: att.mimeType,
      }));
    },
  };

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

    if (!options.createDocumentSpaceService && !options.createDocumentService) {
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

              // 1. Pre-validate documentPayload.data BEFORE any external network calls or hydration
              const preValidation = await preValidateDocument(
                documentPayload.type,
                documentPayload.data,
                space
              );
              if (!preValidation.success) {
                return {
                  success: false,
                  errors: preValidation.errors,
                };
              }

              // 2. Hydrate source files via GmailSourceFileHydrator (only after validation passes)
              const hydratedSourceFiles = hydrator
                ? await hydrator.hydrate(sourceFiles ?? [], context)
                : (sourceFiles ?? []);

              // 3. Assign activeContext.sourceFiles = hydratedSourceFiles
              const activeContext: WorkspaceExecutionContext = {
                ...context,
                sourceFiles: hydratedSourceFiles,
                selectedItems: hydratedSourceFiles.map((file) => ({
                  id: file.id,
                  ...(file.name !== undefined ? { title: file.name } : {}),
                  ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
                })),
              };

              const activeDocService = options.createDocumentService
                ? await options.createDocumentService(activeContext)
                : options.documentService;

              if (!activeDocService) {
                throw new Error('DocumentService not provided');
              }

              return activeDocService.processDocument(
                {
                  ...documentPayload,
                  ...(space ? { space } : {}),
                },
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
      gmailPort,
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

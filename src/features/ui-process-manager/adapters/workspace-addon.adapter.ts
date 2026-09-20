import type {
  UiProcessOrchestratorPort,
  UiProcessEventContext,
  UiProcessSpaceProviderPort,
  UiProcessConfigProviderPort,
  UiProcessManifestPort,
  UiProcessViewGeneratorPort,
  UiProcessDocumentRunnerPort,
  UiProcessFormEvaluatorPort,
} from '../ports';
import { evaluateProcessUiState, resolveSpaceType, extractDocumentData } from '../domain';

export interface WorkspaceAddonAdapterOptions {
  spaceProvider: UiProcessSpaceProviderPort;
  configProvider?: UiProcessConfigProviderPort | undefined;
  manifestPort?: UiProcessManifestPort | undefined;
  viewGenerator: UiProcessViewGeneratorPort;
  documentRunner?: UiProcessDocumentRunnerPort | undefined;
  formEvaluator?: UiProcessFormEvaluatorPort | undefined;
}


export class WorkspaceAddonAdapter implements UiProcessOrchestratorPort {
  constructor(private readonly options: WorkspaceAddonAdapterOptions) {}

  async processUiEvent(context: UiProcessEventContext): Promise<unknown> {
    const { spaceProvider, configProvider, manifestPort, viewGenerator, documentRunner, formEvaluator } =
      this.options;

    const actionName = context.actionName ?? context.parameters?.action;
    const config = configProvider ? await configProvider.getWorkspaceConfig() : undefined;
    const mappedConfig = {
      ...(config?.defaultDocumentType ? { defaultDocumentType: config.defaultDocumentType } : {}),
      ...(config?.defaultDocumentSpaceType
        ? { defaultDocumentSpaceType: config.defaultDocumentSpaceType }
        : {}),
    };
    const spaceTypes = spaceProvider.getAllTypes();

    const currentSpaceType = resolveSpaceType(context.formData, config);

    let collectionSpaces: string[] = [];
    try {
      const collection = await spaceProvider.getCollection(currentSpaceType);
      collectionSpaces = collection.spaces.map((s) => s.name);
    } catch (e) {
      console.warn(`Could not fetch collection for space type: ${currentSpaceType}`, e);
    }

    const rawSelectedDocType =
      (context.formData?.SelectDocumentType as string | undefined) ??
      context.parameters?.documentTypeKey ??
      config?.defaultDocumentType;

    let resolvedDocumentTypeKey = rawSelectedDocType;
    if (rawSelectedDocType && manifestPort) {
      try {
        const resolved = await manifestPort.resolveDocumentTypeKey(rawSelectedDocType);
        if (resolved) {
          resolvedDocumentTypeKey = resolved;
        }
      } catch (e) {
        console.warn(`Could not resolve document type key for: ${rawSelectedDocType}`, e);
      }
    }

    const renderCard = async (options: {
      formData?: Record<string, unknown> | undefined;
      validationErrors?: string[] | undefined;
      isUpdateCard?: boolean | undefined;
      hiddenFields?: string[] | undefined;
    }) => {
      const state = evaluateProcessUiState({
        context: {
          ...context,
          ...(options.formData !== undefined ? { formData: options.formData } : {}),
          ...(options.validationErrors ? { validationErrors: options.validationErrors } : {}),
          ...(options.isUpdateCard ? { isUpdateCard: true } : {}),
        },
        resolvedDocumentTypeKey,
        resolvedSpaceType: currentSpaceType,
        config: mappedConfig,
        spaceTypes,
        collectionSpaces,
      });

      return await viewGenerator.generateCard({
        viewId: state.viewId,
        documentTypeKey: state.documentTypeKey,
        selectionState: state.selectionState,
        formData: state.formData,
        isUpdateCard: state.isUpdateCard,
        ...(options.hiddenFields !== undefined ? { hiddenFields: options.hiddenFields } : {}),
        ...(state.validationErrors ? { validationErrors: state.validationErrors } : {}),
      });
    };

    const renderErrorCard = async (validationErrors: string[]) =>
      renderCard({ validationErrors, isUpdateCard: true });

    if (actionName === 'processDocument') {
      const selectedSpace = context.formData?.SelectDocumentSpace as string | undefined;
      const data = extractDocumentData(context.formData);

      const selectedItem = context.selectedItems?.[0];
      const execContext = {
        ...(context.userOAuthToken ? { credentials: { oauthToken: context.userOAuthToken } } : {}),
        ...(selectedItem?.id ? { resources: { primaryTargetId: selectedItem.id } } : {}),
      };

      try {
        if (documentRunner) {
          const result = await documentRunner.processDocument(
            {
              type: resolvedDocumentTypeKey ?? 'default',
              data,
              ...(selectedSpace ? { space: selectedSpace } : {}),
            },
            'onSubmit',
            execContext
          );

          if (result && result.success === false) {
            const validationErrors =
              result.errors ??
              (result.error ? [result.error] : ['Document validation failed']);
            return await renderErrorCard(validationErrors);
          }
        }

        return {
          action: {
            notification: {
              text: 'Document processed successfully',
            },
          },
        };
      } catch (error) {
        const validationErrors = [error instanceof Error ? error.message : 'Document processing failed'];
        return await renderErrorCard(validationErrors);
      }

    }

    let evaluatedFormData = context.formData;
    let hiddenFields: string[] | undefined;
    if (actionName === 'onFormChange' && formEvaluator) {
      try {
        const evaluation = await formEvaluator.evaluate(
          context.formData ?? {},
          resolvedDocumentTypeKey
        );
        evaluatedFormData = evaluation.computedData;
        hiddenFields = evaluation.hiddenFields;
      } catch (e) {
        console.warn('Form change evaluation failed:', e);
        return await renderErrorCard([
          e instanceof Error ? e.message : 'Form change evaluation failed',
        ]);
      }
    }

    return await renderCard({
      formData: evaluatedFormData,
      hiddenFields,
      isUpdateCard: actionName === 'onFormChange',
    });
  }
}


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


export function normalizeFormData(
  formData?: Record<string, unknown>,
  activeSpaceType?: string
): Record<string, unknown> | undefined {
  if (!formData) {
    return formData;
  }
  const spaceType = activeSpaceType ?? resolveSpaceType(formData);
  const activeSpaceKey = spaceType ? `SelectDocumentSpace_${spaceType}` : undefined;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(formData)) {
    let targetKey = key;
    if (key.startsWith('SelectDocumentType_')) {
      targetKey = 'SelectDocumentType';
    } else if (activeSpaceKey && key === activeSpaceKey) {
      targetKey = 'SelectDocumentSpace';
    }
    normalized[targetKey] = value;
  }
  return normalized;
}

export class WorkspaceAddonAdapter implements UiProcessOrchestratorPort {
  constructor(private readonly options: WorkspaceAddonAdapterOptions) {}

  async processUiEvent(context: UiProcessEventContext): Promise<unknown> {
    const { spaceProvider, configProvider, manifestPort, viewGenerator, documentRunner, formEvaluator } =
      this.options;

    const config = configProvider ? await configProvider.getWorkspaceConfig() : undefined;
    const currentSpaceType = resolveSpaceType(context.formData, config);

    const normalizedFormData = normalizeFormData(context.formData, currentSpaceType);
    const normalizedContext: UiProcessEventContext =
      normalizedFormData !== context.formData
        ? { ...context, formData: normalizedFormData }
        : context;

    const actionName = normalizedContext.actionName ?? normalizedContext.parameters?.action;
    const mappedConfig = {
      ...(config?.defaultDocumentType ? { defaultDocumentType: config.defaultDocumentType } : {}),
      ...(config?.defaultDocumentSpaceType
        ? { defaultDocumentSpaceType: config.defaultDocumentSpaceType }
        : {}),
    };
    const spaceTypes = spaceProvider.getAllTypes();

    let collectionSpaces: string[] = [];
    try {
      const collection = await spaceProvider.getCollection(currentSpaceType);
      collectionSpaces = collection.spaces.map((s) => s.name);
    } catch (e) {
      console.warn(`Could not fetch collection for space type: ${currentSpaceType}`, e);
    }

    const rawSelectedDocType =
      (normalizedContext.formData?.SelectDocumentType as string | undefined) ??
      normalizedContext.parameters?.documentTypeKey ??
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
          ...normalizedContext,
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
      const selectedSpace = normalizedContext.formData?.SelectDocumentSpace as string | undefined;
      const data = extractDocumentData(normalizedContext.formData);

      const selectedItem = normalizedContext.selectedItems?.[0];
      const execContext = {
        ...(normalizedContext.userOAuthToken ? { credentials: { oauthToken: normalizedContext.userOAuthToken } } : {}),
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

    let evaluatedFormData = normalizedContext.formData;
    let hiddenFields: string[] | undefined;
    if (actionName === 'onFormChange' && formEvaluator) {
      try {
        const evaluation = await formEvaluator.evaluate(
          normalizedContext.formData ?? {},
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


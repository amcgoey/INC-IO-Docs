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
import {
  evaluateProcessUiState,
  resolveSpaceType,
  resolveDocumentType,
  extractDocumentData,
  getSpaceSelectorKey,
  getDocTypeSelectorKey,
  SELECT_DOCUMENT_SPACE_KEY,
  SELECT_DOCUMENT_TYPE_KEY,
  SELECT_DOCUMENT_SPACE_PREFIX,
  SELECT_DOCUMENT_TYPE_PREFIX,
  type UiStateResolutionContext,
} from '../domain';

export interface WorkspaceAddonAdapterOptions {
  spaceProvider: UiProcessSpaceProviderPort;
  configProvider?: UiProcessConfigProviderPort | undefined;
  manifestPort?: UiProcessManifestPort | undefined;
  viewGenerator: UiProcessViewGeneratorPort;
  documentRunner?: UiProcessDocumentRunnerPort | undefined;
  formEvaluator?: UiProcessFormEvaluatorPort | undefined;
}


export function normalizeFormData(
  context?: UiStateResolutionContext,
  activeDocumentType?: string
): Record<string, unknown> | undefined {
  if (!context?.formData) {
    return context?.formData;
  }
  const spaceType = context.activeSpaceType ?? resolveSpaceType(context);
  const activeSpaceKey = spaceType ? getSpaceSelectorKey(spaceType) : undefined;
  const activeDocTypeSelectorKey = spaceType ? getDocTypeSelectorKey(spaceType) : undefined;

  const docType =
    activeDocumentType ??
    resolveDocumentType({ ...context, activeSpaceType: spaceType });
  const docTypeSuffix = docType ? `_${docType}` : undefined;

  const normalized: Record<string, unknown> = {};
  const strippedKeys = new Set<string>();

  for (const [key, value] of Object.entries(context.formData)) {
    let targetKey = key;
    if (activeDocTypeSelectorKey && key === activeDocTypeSelectorKey) {
      targetKey = SELECT_DOCUMENT_TYPE_KEY;
      strippedKeys.add(targetKey);
    } else if (activeSpaceKey && key === activeSpaceKey) {
      targetKey = SELECT_DOCUMENT_SPACE_KEY;
      strippedKeys.add(targetKey);
    } else if (
      docTypeSuffix &&
      key.endsWith(docTypeSuffix) &&
      !key.startsWith(SELECT_DOCUMENT_TYPE_PREFIX) &&
      !key.startsWith(SELECT_DOCUMENT_SPACE_PREFIX)
    ) {
      targetKey = key.slice(0, -docTypeSuffix.length);
      strippedKeys.add(targetKey);
    }
    if (targetKey === key && strippedKeys.has(targetKey)) {
      continue;
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
    const currentSpaceType = resolveSpaceType({ formData: context.formData, config });
    const actionName = context.actionName ?? context.parameters?.action;
    const isSpaceTypeChange = actionName === 'onSpaceTypeChange';

    const spaceTypes = spaceProvider.getAllTypes();
    const activeSpaceObj = spaceTypes.find((t) => t.id === currentSpaceType);
    const allowedDocTypes = activeSpaceObj?.spaceSchema.allowedDocumentTypes ?? [];

    const rawSelectedDocType =
      isSpaceTypeChange && allowedDocTypes.length > 0
        ? allowedDocTypes[0]
        : resolveDocumentType({
            formData: context.formData,
            config,
            activeSpaceType: currentSpaceType,
            parameters: context.parameters,
          });

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

    if (
      !resolvedDocumentTypeKey ||
      (allowedDocTypes.length > 0 && !allowedDocTypes.includes(resolvedDocumentTypeKey))
    ) {
      resolvedDocumentTypeKey = allowedDocTypes[0] ?? resolvedDocumentTypeKey;
    }

    const normalizedFormData = normalizeFormData(
      {
        formData: context.formData,
        activeSpaceType: currentSpaceType,
        config,
      },
      resolvedDocumentTypeKey
    );
    const normalizedContext: UiProcessEventContext =
      normalizedFormData !== context.formData
        ? { ...context, formData: normalizedFormData }
        : context;

    let collectionSpaces: string[] = [];
    try {
      const collection = await spaceProvider.getCollection(currentSpaceType, {
        auth: normalizedContext.userOAuthToken,
      });
      collectionSpaces = collection.spaces.map((s) => s.name);
    } catch (e) {
      console.warn(`Could not fetch collection for space type: ${currentSpaceType}`, e);
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
        config,
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


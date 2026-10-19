import type {
  UiProcessOrchestratorPort,
  UiProcessEventContext,
  UiProcessResult,
  UiProcessSpaceProviderPort,
  UiProcessConfigProviderPort,
  UiProcessManifestPort,
  UiProcessDocumentRunnerPort,
  UiProcessFormEvaluatorPort,
  UiProcessDocumentSpaceDto,
  UiProcessSourceFileDto,
  UiProcessGmailPort,
} from '../ports';

import {
  evaluateProcessUiState,
  resolveSpace,
  resolveSpaceType,
  resolveDocumentType,
  extractDocumentData,
  getSpaceSelectorKey,
  getDocTypeSelectorKey,
  SELECT_DOCUMENT_SPACE_KEY,
  SELECT_DOCUMENT_TYPE_KEY,
  SELECT_DOCUMENT_SPACE_PREFIX,
  SELECT_DOCUMENT_TYPE_PREFIX,
  isGmailContext,
  type UiStateResolutionContext,
  type UiProcessSpaceItem,
} from '../domain';

export interface WorkspaceAddonAdapterOptions {
  spaceProvider: UiProcessSpaceProviderPort;
  configProvider?: UiProcessConfigProviderPort | undefined;
  manifestPort?: UiProcessManifestPort | undefined;
  documentRunner?: UiProcessDocumentRunnerPort | undefined;
  formEvaluator?: UiProcessFormEvaluatorPort | undefined;
  gmailPort?: UiProcessGmailPort | undefined;
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
  private readonly gmailPort?: UiProcessGmailPort | undefined;

  constructor(private readonly options: WorkspaceAddonAdapterOptions) {
    this.gmailPort = options.gmailPort;
  }

  async processUiEvent(context: UiProcessEventContext): Promise<UiProcessResult> {
    const { spaceProvider, configProvider, manifestPort, documentRunner, formEvaluator } =
      this.options;

    const actionName = context.actionName ?? context.parameters?.action;
    let effectiveContext = context;

    const isGmail = isGmailContext(context);

    if (
      isGmail &&
      this.gmailPort &&
      context.gmail?.messageId &&
      (!effectiveContext.selectedItems || effectiveContext.selectedItems.length === 0 || actionName === 'refresh')
    ) {
      try {
        const token = context.userOAuthToken ?? context.gmail.accessToken;
        const attachments = await this.gmailPort.getMessageAttachments(
          context.gmail.messageId,
          token
        );
        effectiveContext = {
          ...effectiveContext,
          selectedItems: attachments.map((att) => ({
            id: att.id,
            title: att.title,
            mimeType: att.mimeType,
          })),
        };
      } catch (e) {
        console.warn(`Could not fetch attachments for message: ${context.gmail.messageId}`, e);
      }
    }

    const config = configProvider ? await configProvider.getWorkspaceConfig() : undefined;
    const currentSpaceType = resolveSpaceType({ formData: effectiveContext.formData, config });
    const isSpaceTypeChange = actionName === 'onSpaceTypeChange';

    const spaceTypes = spaceProvider.getAllTypes();
    const activeSpaceObj = spaceTypes.find((t) => t.id === currentSpaceType);
    const allowedDocTypes = activeSpaceObj?.spaceSchema.allowedDocumentTypes ?? [];

    const rawSelectedDocType =
      isSpaceTypeChange && allowedDocTypes.length > 0
        ? allowedDocTypes[0]
        : resolveDocumentType({
            formData: effectiveContext.formData,
            config,
            activeSpaceType: currentSpaceType,
            parameters: effectiveContext.parameters,
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
        formData: effectiveContext.formData,
        activeSpaceType: currentSpaceType,
        config,
      },
      resolvedDocumentTypeKey
    );
    const normalizedContext: UiProcessEventContext =
      normalizedFormData !== effectiveContext.formData
        ? { ...effectiveContext, formData: normalizedFormData }
        : effectiveContext;

    let spaces: UiProcessSpaceItem[] = [];
    const collectionErrors: string[] = [];
    try {
      const collection = await spaceProvider.getCollection(currentSpaceType);
      spaces = collection.spaces.map((s) => ({
        id: s.id,
        name: s.name,
        ...(s.typeId !== undefined ? { typeId: s.typeId } : {}),
        ...(s.abstractStorageId !== undefined ? { abstractStorageId: s.abstractStorageId } : {}),
      }));
    } catch (e) {
      console.warn(`Could not fetch collection for space type: ${currentSpaceType}`, e);
      if (activeSpaceObj) {
        const errMsg = e instanceof Error ? e.message : `Could not fetch collection for space type: ${currentSpaceType}`;
        collectionErrors.push(errMsg);
      }
    }

    const createRenderResult = (options: {
      formData?: Record<string, unknown> | undefined;
      validationErrors?: string[] | undefined;
      statusMessages?: string[] | undefined;
      isUpdateCard?: boolean | undefined;
      hiddenFields?: string[] | undefined;
    }): UiProcessResult => {
      const combinedValidationErrors = [
        ...(options.validationErrors ?? normalizedContext.validationErrors ?? []),
        ...collectionErrors,
      ];

      const state = evaluateProcessUiState({
        context: {
          ...normalizedContext,
          ...(options.formData !== undefined ? { formData: options.formData } : {}),
          ...(combinedValidationErrors.length > 0 ? { validationErrors: combinedValidationErrors } : {}),
          ...(options.statusMessages !== undefined
            ? { statusMessages: options.statusMessages }
            : {}),
          ...(options.isUpdateCard ? { isUpdateCard: true } : {}),
        },
        resolvedDocumentTypeKey,
        resolvedSpaceType: currentSpaceType,
        config,
        spaceTypes,
        spaces,
      });

      return {
        type: 'render',
        viewId: state.viewId,
        documentTypeKey: state.documentTypeKey,
        ...(state.spaceId !== undefined ? { spaceId: state.spaceId } : {}),
        selectionState: state.selectionState,
        formData: state.formData,
        isUpdateCard: state.isUpdateCard,
        ...(options.hiddenFields !== undefined ? { hiddenFields: options.hiddenFields } : {}),
        ...(state.validationErrors ? { validationErrors: state.validationErrors } : {}),
        ...(state.statusMessages ? { statusMessages: state.statusMessages } : {}),
      };
    };

    const createErrorRenderResult = (validationErrors: string[]): UiProcessResult =>
      createRenderResult({ validationErrors, isUpdateCard: true });

    if (actionName === 'processDocument') {
      const currentUiState = evaluateProcessUiState({
        context: normalizedContext,
        resolvedDocumentTypeKey,
        resolvedSpaceType: currentSpaceType,
        config,
        spaceTypes,
        spaces,
      });

      const checkedFileIds = new Set(
        (currentUiState.selectionState.files ?? [])
          .filter((f) => f.selected)
          .map((f) => f.value.trim())
      );

      const validSelectedItems = (normalizedContext.selectedItems ?? []).filter(
        (item): item is { id: string; title?: string | undefined; mimeType?: string | undefined } =>
          typeof item?.id === 'string' && item.id.trim().length > 0
      );

      const activeSourceFiles: UiProcessSourceFileDto[] = validSelectedItems
        .filter((item) => checkedFileIds.has(item.id.trim()))
        .map((item) => ({
          id: item.id,
          ...(item.title !== undefined ? { name: item.title } : {}),
          ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
        }));

      let allowEmptySourceFiles = false;
      if (resolvedDocumentTypeKey && manifestPort) {
        try {
          const schemas = await manifestPort.getDocumentTypeSchemas(resolvedDocumentTypeKey);
          allowEmptySourceFiles = Boolean(schemas?.allowEmptySourceFiles);
        } catch (e) {
          console.warn(`Could not fetch schemas for: ${resolvedDocumentTypeKey}`, e);
        }
      }

      const hasExplicitFileId =
        typeof context.parameters?.fileId === 'string' &&
        context.parameters.fileId.trim().length > 0;

      if (activeSourceFiles.length === 0 && !hasExplicitFileId) {
        if (!allowEmptySourceFiles) {
          const isGmail = isGmailContext(normalizedContext);
          const errorMsg = isGmail
            ? 'Please select at least one file to process or enable Save Email to PDF.'
            : 'Please select at least one file in Google Drive to process.';
          return createErrorRenderResult([errorMsg]);
        }
      }

      const spaceResolution = resolveSpace(
        {
          formData: normalizedContext.formData,
          activeSpaceType: currentSpaceType,
          config,
        },
        spaces
      );

      if (spaceResolution.collisionError) {
        return createErrorRenderResult([spaceResolution.collisionError]);
      }

      if (spaceResolution.notFoundError) {
        return createErrorRenderResult([spaceResolution.notFoundError]);
      }

      if (!spaceResolution.matchedSpace) {
        return createErrorRenderResult(['Please select a Document Space.']);
      }

      const matchedSpace = spaceResolution.matchedSpace;
      const space: UiProcessDocumentSpaceDto = {
        id: matchedSpace.id,
        name: matchedSpace.name,
        typeId: matchedSpace.typeId ?? currentSpaceType,
        abstractStorageId: matchedSpace.abstractStorageId ?? matchedSpace.id,
      };

      const data = extractDocumentData(normalizedContext.formData);

      try {
        if (documentRunner) {
          const result = await documentRunner.processDocument(
            {
              type: resolvedDocumentTypeKey ?? 'default',
              data,
              space,
              ...(activeSourceFiles.length > 0 || allowEmptySourceFiles
                ? { sourceFiles: activeSourceFiles }
                : {}),
            },
            'onSubmit'
          );


          if (result && result.success === false) {
            const validationErrors =
              result.errors ??
              (result.error ? [result.error] : ['Document validation failed']);
            return createErrorRenderResult(validationErrors);
          }
        }

        return {
          type: 'notification',
          text: 'Document processed successfully',
        };
      } catch (error) {
        const validationErrors = [error instanceof Error ? error.message : 'Document processing failed'];
        return createErrorRenderResult(validationErrors);
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
        return createErrorRenderResult([
          e instanceof Error ? e.message : 'Form change evaluation failed',
        ]);
      }
    }

    return createRenderResult({
      formData: evaluatedFormData,
      hiddenFields,
      isUpdateCard: actionName === 'onFormChange',
    });
  }
}


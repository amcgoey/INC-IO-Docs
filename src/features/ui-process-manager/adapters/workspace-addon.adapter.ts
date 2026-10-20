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
  UiProcessGmailMessageDescriptor,
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
  SELECT_FILE_SOURCE_KEY,
  SELECT_ATTACHMENTS_KEY,
  INPUT_DRIVE_URL_KEY,
  SAVE_EMAIL_TO_PDF_KEY,
  SELECT_EMAIL_MESSAGE_KEY,
  extractSelectFilesSet,
  resolveAttachmentId,
  parseGoogleDriveUrl,
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
    let threadMessages: UiProcessGmailMessageDescriptor[] | undefined;

    const inCardActions = new Set([
      'onSpaceTypeChange',
      'onDocumentTypeChange',
      'onFormChange',
      'onFileSourceChange',
      'onEmailMessageChange',
    ]);
    const isInCardAction = actionName !== undefined && inCardActions.has(actionName);

    const needsGmailFetch =
      !effectiveContext.selectedItems ||
      effectiveContext.selectedItems.length === 0 ||
      actionName === 'refresh' ||
      isInCardAction;

    if (isGmail && this.gmailPort && needsGmailFetch) {
      const token = context.userOAuthToken ?? context.gmail?.accessToken;
      const skipCache = actionName === 'refresh';

      if (context.gmail?.threadId && typeof this.gmailPort.getThreadMessages === 'function') {
        try {
          const msgs = await this.gmailPort.getThreadMessages(context.gmail.threadId, { skipCache });
          if (msgs && msgs.length > 0) {
            threadMessages = msgs;
          }
        } catch (e) {
          console.warn(`Could not fetch thread messages for thread: ${context.gmail.threadId}`, e);
        }
      }

      if (!threadMessages && context.gmail?.messageId) {
        if (typeof this.gmailPort.getMessageDetails === 'function') {
          try {
            const msg = await this.gmailPort.getMessageDetails(context.gmail.messageId, { skipCache });
            if (msg) {
              threadMessages = [msg];
            }
          } catch (e) {
            console.warn(`Could not fetch message details for message: ${context.gmail.messageId}`, e);
          }
        } else if (typeof this.gmailPort.getMessageAttachments === 'function') {
          try {
            const attachments = await this.gmailPort.getMessageAttachments(
              context.gmail.messageId,
              token
            );
            threadMessages = [
              {
                id: context.gmail.messageId,
                attachments,
              },
            ];
          } catch (e) {
            console.warn(`Could not fetch attachments for message: ${context.gmail.messageId}`, e);
          }
        }
      }

      if (threadMessages && threadMessages.length > 0) {
        const formMsgId = actionName === 'refresh'
          ? undefined
          : (effectiveContext.formData?.[SELECT_EMAIL_MESSAGE_KEY] as string | undefined);
        const activeMsg =
          threadMessages.find((m) => m.id === (formMsgId ?? context.gmail?.messageId)) ??
          threadMessages[threadMessages.length - 1];

        const isEmailSwitch =
          actionName === 'onEmailMessageChange' ||
          Boolean(
            effectiveContext.parameters?.previousMessageId &&
              effectiveContext.parameters.previousMessageId !== activeMsg?.id
          );

        if (
          !effectiveContext.selectedItems ||
          effectiveContext.selectedItems.length === 0 ||
          actionName === 'refresh' ||
          isEmailSwitch
        ) {
          effectiveContext = {
            ...effectiveContext,
            selectedItems: (activeMsg?.attachments ?? []).map((att) => ({
              id: resolveAttachmentId(att),
              title: att.title,
              mimeType: att.mimeType,
            })),
          };
        }
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
        threadMessages,
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
        threadMessages,
      });

      const isGmail = isGmailContext(normalizedContext);
      const triggerMessageId = context.gmail?.messageId ?? normalizedContext.gmail?.messageId;
      const selectedMessageId = isGmail
        ? (currentUiState.selectedMessageId ??
            (currentUiState.formData[SELECT_EMAIL_MESSAGE_KEY] as string | undefined) ??
            (normalizedContext.formData?.[SELECT_EMAIL_MESSAGE_KEY] as string | undefined) ??
            triggerMessageId)
        : undefined;

      const isDriveUrlSource =
        isGmail &&
        (normalizedContext.formData?.[SELECT_FILE_SOURCE_KEY] === 'Google Drive URL' ||
          currentUiState.formData[SELECT_FILE_SOURCE_KEY] === 'Google Drive URL');

      let activeSourceFiles: UiProcessSourceFileDto[] = [];

      if (isDriveUrlSource) {
        const rawDriveUrl =
          (normalizedContext.formData?.[INPUT_DRIVE_URL_KEY] ??
            currentUiState.formData[INPUT_DRIVE_URL_KEY]) as string | undefined;
        const driveUrl = typeof rawDriveUrl === 'string' ? rawDriveUrl.trim() : '';
        if (driveUrl.length > 0) {
          const parsed = parseGoogleDriveUrl(driveUrl);
          if (!parsed) {
            return createErrorRenderResult([
              'Invalid Google Drive URL. Please enter a valid Google Drive file or folder link.',
            ]);
          }
          activeSourceFiles.push({ id: parsed.id, name: parsed.id });
        }
      } else if (isGmail) {
        const formAttachmentIds = extractSelectFilesSet(normalizedContext.formData, SELECT_ATTACHMENTS_KEY);
        const stateCheckedIds = new Set(
          (currentUiState.selectionState.files ?? [])
            .filter((f) => f.selected)
            .map((f) => f.value.trim())
        );

        let checkedIds = stateCheckedIds;
        if (checkedIds.size === 0 && formAttachmentIds.size > 0) {
          checkedIds = formAttachmentIds;
        }

        if (formAttachmentIds.size > 0) {
          for (const id of formAttachmentIds) {
            checkedIds.add(id);
          }
        }

        const metaMap = new Map<string, { name?: string; mimeType?: string }>();
        for (const item of normalizedContext.selectedItems ?? []) {
          if (item?.id) {
            metaMap.set(item.id.trim(), {
              ...(item.title !== undefined ? { name: item.title } : {}),
              ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
            });
          }
        }

        const selectedMsg = threadMessages?.find((m) => m.id === selectedMessageId);
        if (selectedMsg?.attachments) {
          for (const att of selectedMsg.attachments) {
            const attId = resolveAttachmentId(att);
            const meta = {
              ...(att.title !== undefined ? { name: att.title } : {}),
              ...(att.mimeType !== undefined ? { mimeType: att.mimeType } : {}),
            };
            if (attId) metaMap.set(attId, meta);
            if (att.id && att.id.trim()) metaMap.set(att.id.trim(), meta);
            if (att.partId && att.partId.trim()) metaMap.set(att.partId.trim(), meta);
            if (att.attachmentId && att.attachmentId.trim()) metaMap.set(att.attachmentId.trim(), meta);
          }
        }

        for (const f of currentUiState.selectionState.files ?? []) {
          const val = f.value.trim();
          const existing = metaMap.get(val);
          if (!existing) {
            metaMap.set(val, { name: f.text });
          } else if (!existing.name && f.text) {
            existing.name = f.text;
          }
        }

        activeSourceFiles = Array.from(checkedIds).map((id) => {
          const meta = metaMap.get(id);
          return {
            id,
            ...(meta?.name !== undefined ? { name: meta.name } : {}),
            ...(meta?.mimeType !== undefined ? { mimeType: meta.mimeType } : {}),
          };
        });
      } else {
        const checkedFileIds = new Set(
          (currentUiState.selectionState.files ?? [])
            .filter((f) => f.selected)
            .map((f) => f.value.trim())
        );

        const validSelectedItems = (normalizedContext.selectedItems ?? []).filter(
          (item): item is { id: string; title?: string | undefined; mimeType?: string | undefined } =>
            typeof item?.id === 'string' && item.id.trim().length > 0
        );

        activeSourceFiles = validSelectedItems
          .filter((item) => checkedFileIds.has(item.id.trim()))
          .map((item) => ({
            id: item.id,
            ...(item.title !== undefined ? { name: item.title } : {}),
            ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
          }));
      }

      if (isGmail) {
        const isSaveEmail =
          currentUiState.formData[SAVE_EMAIL_TO_PDF_KEY] === true ||
          currentUiState.formData[SAVE_EMAIL_TO_PDF_KEY] === 'true' ||
          normalizedContext.formData?.[SAVE_EMAIL_TO_PDF_KEY] === true ||
          normalizedContext.formData?.[SAVE_EMAIL_TO_PDF_KEY] === 'true';

        if (isSaveEmail && selectedMessageId) {
          activeSourceFiles.push({
            id: `email-pdf-${selectedMessageId}`,
            mimeType: 'application/pdf',
          });
        }
      }

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
              sourceFiles: activeSourceFiles,
              ...(selectedMessageId !== undefined ? { targetMessageId: selectedMessageId } : {}),
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


import type {
  UiProcessOrchestratorPort,
  UiProcessEventContext,
  UiProcessResult,
  UiProcessSpaceProviderPort,
  UiProcessConfigProviderPort,
  UiProcessManifestPort,
  UiProcessDocumentLogPort,
  UiProcessDocumentRunnerPort,
  UiProcessFormEvaluatorPort,
  UiProcessDocumentSpaceDto,
  UiProcessSourceFileDto,
  UiProcessGmailPort,
  UiProcessGmailMessageDescriptor,
  UiProcessSourceParserPort,
  UiProcessLockedFieldsPort,
  UiProcessInferredRoutingResult,
  UiProcessSourceContext,
  UiProcessSourceContextItem,
  UiProcessSourceEmailDescriptor,
  UiProcessCandidateSpaceDescriptor,
  UiProcessSpaceCollection,
  ProcessUiStateConfig,
  UiProcessSpaceType,
  UiProcessDocumentExecutionOutcome,
  UiProcessRenderResult,
} from '../ports';
import { DOCUMENT_SUCCESS_CARD_VIEW_ID } from '../ports';

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
  SELECT_DOCUMENT_SPACE_TYPE_KEY,
  SELECT_DOCUMENT_SPACE_PREFIX,
  SELECT_DOCUMENT_TYPE_PREFIX,
  SELECT_FILE_SOURCE_KEY,
  SELECT_ATTACHMENTS_KEY,
  INPUT_DRIVE_URL_KEY,
  SAVE_EMAIL_TO_PDF_KEY,
  SELECT_EMAIL_MESSAGE_KEY,
  SELECT_DOCUMENT_LOG_KEY,
  DRIVE_ROUTING_FALLBACK_NOTICE,
  DRIVE_METADATA_FALLBACK_NOTICE,
  hasProposalOpportunityMarkers,
  extractSelectFilesSet,
  resolveCheckedDriveItems,
  resolveAttachmentId,
  parseGoogleDriveUrl,
  isGmailContext,
  isInCardAction,
  isResetOrInitialLoad,
  sanitizeFormDataForSourceReset,
  reconcileDocumentLogSelection,
  pruneFormDataForTypeSwitch,
  extractActiveTypeExistingData,
  type UiStateResolutionContext,
  type UiProcessSpaceItem,
} from '../domain';

function resolveValidatedSpaceDto(
  params: {
    formData?: Record<string, unknown> | undefined;
    activeSpaceType: string;
    config?: ProcessUiStateConfig | undefined;
  },
  spaces: UiProcessSpaceItem[],
  missingSpaceError: string
): { ok: true; space: UiProcessDocumentSpaceDto } | { ok: false; error: string } {
  const spaceResolution = resolveSpace(params, spaces);
  if (spaceResolution.collisionError) {
    return { ok: false, error: spaceResolution.collisionError };
  }
  if (spaceResolution.notFoundError) {
    return { ok: false, error: spaceResolution.notFoundError };
  }
  if (!spaceResolution.matchedSpace) {
    return { ok: false, error: missingSpaceError };
  }
  const matchedSpace = spaceResolution.matchedSpace;
  return {
    ok: true,
    space: {
      id: matchedSpace.id,
      name: matchedSpace.name,
      typeId: matchedSpace.typeId ?? params.activeSpaceType,
      abstractStorageId: matchedSpace.abstractStorageId ?? matchedSpace.id,
    },
  };
}

interface GmailDriveSelection {
  effectiveFileSource: string | undefined;
  currentDriveUrl: string;
  previousDriveUrl: string;
  parsedCurrentDriveUrl: { id: string; resourceType: 'file' | 'folder' } | undefined;
}

function resolveGmailDriveSelection(
  isGmail: boolean,
  isResetOrInitial: boolean,
  effectiveContext: UiProcessEventContext
): GmailDriveSelection {
  const effectiveFileSource = isGmail
    ? (isResetOrInitial
        ? 'Email Attachments'
        : ((effectiveContext.formData?.[SELECT_FILE_SOURCE_KEY] as string | undefined) ?? 'Email Attachments'))
    : undefined;

  const currentDriveUrl = isGmail
    ? ((effectiveContext.formData?.[INPUT_DRIVE_URL_KEY] as string | undefined)?.trim() ??
       (effectiveContext.parameters?.previousDriveUrl?.trim() ?? ''))
    : '';

  const previousDriveUrl = isGmail
    ? (effectiveContext.parameters?.previousDriveUrl?.trim() ?? '')
    : '';

  const parsedCurrentDriveUrl =
    isGmail && currentDriveUrl.length > 0 ? parseGoogleDriveUrl(currentDriveUrl) : undefined;

  return {
    effectiveFileSource,
    currentDriveUrl,
    previousDriveUrl,
    parsedCurrentDriveUrl,
  };
}

function buildSourceContextItems(params: {
  isGmail: boolean;
  isDriveUrlMode?: boolean | undefined;
  driveUrlId?: string | undefined;
  activeMsg?: UiProcessGmailMessageDescriptor | undefined;
  selectedItems?: UiProcessEventContext['selectedItems'];
  isResetOrInitial: boolean;
  formData?: Record<string, unknown> | undefined;
}): UiProcessSourceContextItem[] {
  if (params.driveUrlId !== undefined) {
    return [{ id: params.driveUrlId }];
  }
  if (params.isDriveUrlMode) {
    return [];
  }
  if (params.isGmail) {
    return (params.activeMsg?.attachments ?? []).map((att) => ({
      id: resolveAttachmentId(att),
      name: att.title,
      ...(att.mimeType !== undefined ? { mimeType: att.mimeType } : {}),
    }));
  }
  return resolveCheckedDriveItems({
    selectedItems: params.selectedItems,
    formData: params.formData,
    isResetOrInitial: params.isResetOrInitial,
  }).map((item) => ({
    id: item.id.trim(),
    ...(item.title !== undefined ? { name: item.title } : {}),
    ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
  }));
}

function buildSourceEmailDescriptor(
  activeMsg: UiProcessGmailMessageDescriptor | undefined
): UiProcessSourceEmailDescriptor | undefined {
  if (!activeMsg) {
    return undefined;
  }
  return {
    id: activeMsg.id,
    ...(activeMsg.threadId !== undefined ? { threadId: activeMsg.threadId } : {}),
    ...(activeMsg.subject !== undefined ? { subject: activeMsg.subject } : {}),
    ...(activeMsg.from !== undefined ? { from: activeMsg.from } : {}),
    ...(activeMsg.to !== undefined ? { to: activeMsg.to } : {}),
    ...(activeMsg.cc !== undefined ? { cc: activeMsg.cc } : {}),
    ...(activeMsg.date !== undefined ? { date: activeMsg.date } : {}),
    ...(activeMsg.plainTextBody !== undefined ? { plainTextBody: activeMsg.plainTextBody } : {}),
    ...(activeMsg.htmlBody !== undefined ? { htmlBody: activeMsg.htmlBody } : {}),
    ...(activeMsg.labels !== undefined ? { labels: activeMsg.labels } : {}),
    attachments: (activeMsg.attachments ?? []).map((att) => ({
      id: resolveAttachmentId(att),
      name: att.title,
      ...(att.mimeType !== undefined ? { mimeType: att.mimeType } : {}),
    })),
  };
}

const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

function resolveActiveSourceFiles(params: {
  isGmail: boolean;
  isDriveUrlSource: boolean;
  selectedMessageId?: string | undefined;
  normalizedContext: UiProcessEventContext;
  currentUiState: ReturnType<typeof evaluateProcessUiState>;
  threadMessages?: UiProcessGmailMessageDescriptor[] | undefined;
}): {
  files: UiProcessSourceFileDto[];
  invalidDriveUrl: boolean;
} {
  const {
    isGmail,
    isDriveUrlSource,
    selectedMessageId,
    normalizedContext,
    currentUiState,
    threadMessages,
  } = params;
  let activeSourceFiles: UiProcessSourceFileDto[] = [];

  if (isDriveUrlSource) {
    const rawDriveUrl =
      (normalizedContext.formData?.[INPUT_DRIVE_URL_KEY] ??
        currentUiState.formData[INPUT_DRIVE_URL_KEY]) as string | undefined;
    const driveUrl = typeof rawDriveUrl === 'string' ? rawDriveUrl.trim() : '';
    if (driveUrl.length > 0) {
      const parsed = parseGoogleDriveUrl(driveUrl);
      if (!parsed) {
        return { files: [], invalidDriveUrl: true };
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

  return { files: activeSourceFiles, invalidDriveUrl: false };
}

function buildMaxSourceFilesMessage(
  maxSourceFiles: number,
  selectedCount: number,
  isGmail: boolean,
  isWarning: boolean
): string {
  const unit = maxSourceFiles === 1 ? 'file' : 'files';
  const gmailHint = isGmail ? ' or disable Save Email to PDF' : '';
  if (isWarning) {
    return `Note: This document type allows at most ${maxSourceFiles} ${unit} (${selectedCount} currently selected). Please uncheck extra files${gmailHint} before submitting.`;
  }
  return maxSourceFiles === 1
    ? `This document type allows only 1 ${unit} (${selectedCount} selected). Please select at most 1 file${gmailHint} and try again.`
    : `This document type allows at most ${maxSourceFiles} ${unit} (${selectedCount} selected). Please deselect extra files${gmailHint} and try again.`;
}

function omitPreviousSelectedLogParam(
  parameters?: Record<string, string>
): Record<string, string> | undefined {
  if (!parameters || !('previousSelectedLogId' in parameters)) {
    return parameters;
  }
  const next = { ...parameters };
  delete next.previousSelectedLogId;
  return next;
}

export interface WorkspaceAddonAdapterOptions {
  spaceProvider: UiProcessSpaceProviderPort;
  configProvider?: UiProcessConfigProviderPort | undefined;
  manifestPort?: UiProcessManifestPort | undefined;
  documentLogPort?: UiProcessDocumentLogPort | undefined;
  documentRunner?: UiProcessDocumentRunnerPort | undefined;
  formEvaluator?: UiProcessFormEvaluatorPort | undefined;
  gmailPort?: UiProcessGmailPort | undefined;
  sourceParser?: UiProcessSourceParserPort | undefined;
  lockedFieldsResolver?: UiProcessLockedFieldsPort | undefined;
  onLogCopied?: ((spaceId: string) => void) | undefined;
}

function extractFieldKeysFromDocSchema(docSchema: unknown): Set<string> | undefined {
  if (!docSchema || typeof docSchema !== 'object') {
    return undefined;
  }
  const fields = (docSchema as { fields?: unknown }).fields;
  if (!fields) {
    return undefined;
  }
  const keys = new Set<string>();
  if (Array.isArray(fields)) {
    for (const f of fields) {
      if (f && typeof f === 'object' && typeof (f as { key?: unknown }).key === 'string') {
        keys.add((f as { key: string }).key);
      }
    }
    return keys;
  }
  if (typeof fields === 'object') {
    for (const k of Object.keys(fields)) {
      keys.add(k);
    }
    return keys;
  }
  return undefined;
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

function extractErrorStatusCode(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown } | undefined;
    cause?: unknown;
  };
  if (typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  if (typeof err.status === 'number') {
    return err.status;
  }
  if (err.response && typeof err.response === 'object' && typeof err.response.status === 'number') {
    return err.response.status;
  }
  if (typeof err.code === 'number') {
    return err.code;
  }
  if (depth < 3 && err.cause !== undefined) {
    return extractErrorStatusCode(err.cause, depth + 1);
  }
  return undefined;
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
    const isStartOver = actionName === 'startOver';
    let effectiveContext = context.actionName === actionName ? context : { ...context, actionName };
    if (isStartOver) {
      effectiveContext = {
        ...effectiveContext,
        formData: undefined,
      };
    }

    const isGmail = isGmailContext(context);
    let threadMessages: UiProcessGmailMessageDescriptor[] | undefined;
    let activeMsg: UiProcessGmailMessageDescriptor | undefined;

    const isInCard = isInCardAction(actionName);

    if (isGmail && this.gmailPort) {
      const gmailResolution = await this.resolveActiveGmailMessage({
        context,
        effectiveContext,
        actionName,
        isInCardAction: isInCard,
      });
      threadMessages = gmailResolution.threadMessages;
      activeMsg = gmailResolution.activeMsg;
      effectiveContext = gmailResolution.effectiveContext;
    }

    const config = configProvider ? await configProvider.getWorkspaceConfig() : undefined;
    const spaceTypes = spaceProvider.getAllTypes();

    const fetchedCollections = new Map<string, UiProcessSpaceCollection>();
    const getCachedCollection = async (typeId: string): Promise<UiProcessSpaceCollection> => {
      let col = fetchedCollections.get(typeId);
      if (!col) {
        col = await spaceProvider.getCollection(typeId);
        fetchedCollections.set(typeId, col);
      }
      return col;
    };

    const isResetOrInitial = isResetOrInitialLoad(effectiveContext);
    const gmailDriveSelection = resolveGmailDriveSelection(
      isGmail,
      isResetOrInitial,
      effectiveContext
    );
    const {
      effectiveFileSource,
      currentDriveUrl,
      previousDriveUrl,
      parsedCurrentDriveUrl,
    } = gmailDriveSelection;

    const isSourceReset =
      isResetOrInitial ||
      actionName === 'refresh' ||
      actionName === 'startOver' ||
      (isGmail && (
        actionName === 'onEmailMessageChange' ||
        (actionName === 'onFileSourceChange' && (
          effectiveFileSource !== 'Google Drive URL' || Boolean(parsedCurrentDriveUrl)
        )) ||
        (actionName === 'onFormChange' &&
          effectiveFileSource === 'Google Drive URL' &&
          Boolean(parsedCurrentDriveUrl) &&
          currentDriveUrl !== previousDriveUrl)
      ));

    if (isSourceReset && effectiveContext.formData) {
      effectiveContext = {
        ...effectiveContext,
        formData: sanitizeFormDataForSourceReset(effectiveContext.formData),
      };
    }

    const {
      inferred,
      isDrivePass1Event,
      isGmailPass1Event,
      isGmailDriveUrlPass1Event,
      isGmailEmailPass1Event,
    } = await this.inferPass1Routing({
      isGmail,
      isResetOrInitial,
      actionName,
      effectiveContext,
      gmailDriveSelection,
      activeMsg,
      config,
      spaceTypes,
      getCachedCollection,
    });

    const inferredSpaceType =
      inferred?.spaceTypeId && spaceTypes.some((t) => t.id === inferred.spaceTypeId)
        ? inferred.spaceTypeId
        : undefined;

    const currentSpaceType =
      inferredSpaceType ??
      resolveSpaceType({
        formData: effectiveContext.formData,
        config,
        spaceTypes,
      });

    if (
      inferredSpaceType &&
      effectiveContext.formData?.[SELECT_DOCUMENT_SPACE_TYPE_KEY] !== inferredSpaceType
    ) {
      effectiveContext = {
        ...effectiveContext,
        formData: {
          ...effectiveContext.formData,
          [SELECT_DOCUMENT_SPACE_TYPE_KEY]: inferredSpaceType,
        },
      };
    }

    const activeSpaceObj = spaceTypes.find((t) => t.id === currentSpaceType);
    const allowedDocTypes = activeSpaceObj?.spaceSchema.allowedDocumentTypes ?? [];
    const defaultDocTypeForSpace =
      (activeSpaceObj?.spaceSchema.defaultDocumentType &&
        (allowedDocTypes.length === 0 || allowedDocTypes.includes(activeSpaceObj.spaceSchema.defaultDocumentType)))
        ? activeSpaceObj.spaceSchema.defaultDocumentType
        : (allowedDocTypes[0] ?? config?.defaultDocumentType);

    const isSpaceTypeChange = actionName === 'onSpaceTypeChange';
    const isPass1Reset = isDrivePass1Event || isGmailPass1Event;

    const inferredDocType =
      inferred?.documentTypeKey && (allowedDocTypes.length === 0 || allowedDocTypes.includes(inferred.documentTypeKey))
        ? inferred.documentTypeKey
        : undefined;

    const rawSelectedDocType =
      isSpaceTypeChange
        ? defaultDocTypeForSpace
        : (isPass1Reset
            ? (inferredDocType ?? defaultDocTypeForSpace)
            : (inferredDocType ??
              resolveDocumentType({
                formData: effectiveContext.formData,
                config,
                activeSpaceType: currentSpaceType,
                parameters: effectiveContext.parameters,
                spaceTypes,
              })));

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
      resolvedDocumentTypeKey = defaultDocTypeForSpace ?? resolvedDocumentTypeKey;
    }

    const docTypeSelectorKey = currentSpaceType ? getDocTypeSelectorKey(currentSpaceType) : undefined;
    if (!isResetOrInitial && isPass1Reset && resolvedDocumentTypeKey) {
      effectiveContext = {
        ...effectiveContext,
        formData: {
          ...effectiveContext.formData,
          [SELECT_DOCUMENT_TYPE_KEY]: resolvedDocumentTypeKey,
          ...(docTypeSelectorKey ? { [docTypeSelectorKey]: resolvedDocumentTypeKey } : {}),
        },
      };
    }

    let spaces: UiProcessSpaceItem[] = [];
    const collectionErrors: string[] = [];
    if (currentSpaceType) {
      try {
        const collection = await getCachedCollection(currentSpaceType);
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
    }

    const spaceSelectorKey = currentSpaceType ? getSpaceSelectorKey(currentSpaceType) : undefined;
    if (isPass1Reset) {
      if (inferred?.spaceIdOrName && spaceSelectorKey) {
        const inferredSpaceRes = resolveSpace(
          {
            formData: { spaceId: inferred.spaceIdOrName },
            activeSpaceType: currentSpaceType,
            config,
          },
          spaces
        );

        if (inferredSpaceRes.matchedSpace) {
          effectiveContext = {
            ...effectiveContext,
            formData: {
              ...effectiveContext.formData,
              [spaceSelectorKey]: inferredSpaceRes.matchedSpace.name,
              [SELECT_DOCUMENT_SPACE_KEY]: inferredSpaceRes.matchedSpace.name,
            },
          };
        } else {
          if (effectiveContext.formData) {
            const nextFormData = { ...effectiveContext.formData };
            delete nextFormData[spaceSelectorKey];
            delete nextFormData[SELECT_DOCUMENT_SPACE_KEY];
            delete nextFormData.spaceId;
            effectiveContext = { ...effectiveContext, formData: nextFormData };
          }
        }
      } else if (
        actionName === 'onEmailMessageChange' ||
        actionName === 'refresh' ||
        actionName === 'startOver' ||
        isGmailDriveUrlPass1Event ||
        (isGmailEmailPass1Event && actionName === 'onFileSourceChange')
      ) {
        if (effectiveContext.formData) {
          const nextFormData = { ...effectiveContext.formData };
          if (spaceSelectorKey) {
            delete nextFormData[spaceSelectorKey];
          }
          delete nextFormData[SELECT_DOCUMENT_SPACE_KEY];
          delete nextFormData.spaceId;
          effectiveContext = { ...effectiveContext, formData: nextFormData };
        }
      }
    }

    if (inferred?.statusMessages && inferred.statusMessages.length > 0) {
      effectiveContext = {
        ...effectiveContext,
        statusMessages: [
          ...(effectiveContext.statusMessages ?? []),
          ...inferred.statusMessages,
        ],
      };
    }

    let normalizedFormData = normalizeFormData(
      {
        formData: effectiveContext.formData,
        activeSpaceType: currentSpaceType,
        config,
        spaceTypes,
      },
      resolvedDocumentTypeKey
    );

    const isDocTypeChange = actionName === 'onDocumentTypeChange';
    const isManualTypeSwitch = isSpaceTypeChange || isDocTypeChange;

    let cachedDocTypeSchemas:
      | Awaited<ReturnType<UiProcessManifestPort['getDocumentTypeSchemas']>>
      | undefined;

    const allKnownDocTypes = new Set<string>();
    if (isManualTypeSwitch) {
      for (const st of spaceTypes) {
        for (const dt of st.spaceSchema.allowedDocumentTypes) {
          allKnownDocTypes.add(dt);
        }
      }
      if (manifestPort) {
        try {
          const allDocDefs = await manifestPort.getAllDocumentTypes();
          for (const def of allDocDefs) {
            if (def?.key) {
              allKnownDocTypes.add(def.key);
            }
          }
        } catch (e) {
          console.warn('Could not fetch all document types from manifestPort', e);
        }
      }

      if (normalizedFormData) {
        let docSchemaFields: Set<string> | undefined;
        if (resolvedDocumentTypeKey && manifestPort) {
          try {
            cachedDocTypeSchemas = await manifestPort.getDocumentTypeSchemas(resolvedDocumentTypeKey);
            docSchemaFields = extractFieldKeysFromDocSchema(cachedDocTypeSchemas?.docSchema);
          } catch (e) {
            console.warn(`Could not fetch schemas for: ${resolvedDocumentTypeKey}`, e);
          }
        }
        normalizedFormData = pruneFormDataForTypeSwitch(
          normalizedFormData,
          resolvedDocumentTypeKey,
          allKnownDocTypes,
          docSchemaFields
        );
      }
    }

    const postPass1SpaceResolution = resolveSpace(
      {
        formData: normalizedFormData,
        activeSpaceType: currentSpaceType,
        config,
      },
      spaces
    );

    const logSelectionReconciliation = reconcileDocumentLogSelection({
      formData: normalizedFormData,
      actionName,
      parameters: effectiveContext.parameters,
      currentSpaceId: postPass1SpaceResolution.spaceId,
      isSourceReset: isSourceReset || isPass1Reset,
    });
    normalizedFormData = logSelectionReconciliation.formData;
    if (logSelectionReconciliation.cleared && effectiveContext.parameters) {
      effectiveContext = {
        ...effectiveContext,
        parameters: omitPreviousSelectedLogParam(effectiveContext.parameters),
      };
    }

    const isPass2Event =
      actionName !== 'processDocument' &&
      actionName !== 'copyDocumentLog' &&
      actionName !== 'viewJson' &&
      (isSourceReset || isManualTypeSwitch);

    if (
      isPass2Event &&
      resolvedDocumentTypeKey &&
      typeof this.options.sourceParser?.extractFields === 'function'
    ) {
      const activeTypeExistingData = isManualTypeSwitch
        ? extractActiveTypeExistingData(
            normalizedFormData,
            resolvedDocumentTypeKey,
            allKnownDocTypes
          )
        : {};

      const pass2SpaceId = postPass1SpaceResolution.matchedSpace?.id;

      const isGmailDriveUrlMode =
        isGmail && gmailDriveSelection.effectiveFileSource === 'Google Drive URL';

      const pass2CandidateItems = buildSourceContextItems({
        isGmail,
        isDriveUrlMode: isGmailDriveUrlMode,
        driveUrlId: isGmailDriveUrlMode ? gmailDriveSelection.parsedCurrentDriveUrl?.id : undefined,
        activeMsg,
        selectedItems: effectiveContext.selectedItems,
        isResetOrInitial,
        formData: effectiveContext.formData,
      });

      const pass2EmailContext = buildSourceEmailDescriptor(activeMsg);

      const pass2Context: UiProcessSourceContext = {
        items: pass2CandidateItems,
        ...(pass2EmailContext ? { email: pass2EmailContext } : {}),
        ...(isGmailDriveUrlMode ? { isDriveUrl: true } : {}),
      };

      const pass2SelectedLogId =
        typeof normalizedFormData?.[SELECT_DOCUMENT_LOG_KEY] === 'string' &&
        normalizedFormData[SELECT_DOCUMENT_LOG_KEY].trim().length > 0
          ? normalizedFormData[SELECT_DOCUMENT_LOG_KEY].trim()
          : undefined;

      try {
        const extractedResult = await this.options.sourceParser.extractFields({
          documentTypeKey: resolvedDocumentTypeKey,
          ...(pass2SpaceId !== undefined ? { spaceId: pass2SpaceId } : {}),
          ...(pass2SelectedLogId !== undefined ? { selectedLogId: pass2SelectedLogId } : {}),
          context: pass2Context,
          ...(isManualTypeSwitch ? { existingData: activeTypeExistingData } : {}),
        });

        if (extractedResult?.fields) {
          const updatedFormData = { ...(normalizedFormData ?? {}) };
          for (const [key, value] of Object.entries(extractedResult.fields)) {
            const currentVal = updatedFormData[key];
            const isBlank =
              currentVal === undefined ||
              currentVal === null ||
              (typeof currentVal === 'string' && currentVal.trim().length === 0);

            if (isBlank && value !== undefined && value !== null) {
              updatedFormData[key] = value;
            }
          }
          normalizedFormData = updatedFormData;
        }

        if (extractedResult?.statusMessages && extractedResult.statusMessages.length > 0) {
          const pass1EmittedDriveWarning = Boolean(
            inferred?.statusMessages?.includes(DRIVE_ROUTING_FALLBACK_NOTICE)
          );
          const filteredPass2StatusMessages = pass1EmittedDriveWarning
            ? extractedResult.statusMessages.filter(
                (msg) => msg !== DRIVE_METADATA_FALLBACK_NOTICE
              )
            : extractedResult.statusMessages;

          if (filteredPass2StatusMessages.length > 0) {
            effectiveContext = {
              ...effectiveContext,
              statusMessages: Array.from(
                new Set([
                  ...(effectiveContext.statusMessages ?? []),
                  ...filteredPass2StatusMessages,
                ])
              ),
            };
          }
        }
      } catch (e) {
        console.warn('SourceParser Pass 2 extractFields error in UiProcessManager:', e);
      }
    }

    const normalizedContext: UiProcessEventContext =
      normalizedFormData !== effectiveContext.formData
        ? { ...effectiveContext, formData: normalizedFormData }
        : effectiveContext;

    const createRenderResult = async (options: {
      formData?: Record<string, unknown> | undefined;
      validationErrors?: string[] | undefined;
      statusMessages?: string[] | undefined;
      isUpdateCard?: boolean | undefined;
      popToRoot?: boolean | undefined;
      hiddenFields?: string[] | undefined;
      clearPreviousSelectedLogId?: boolean | undefined;
      notification?: string | undefined;
    }): Promise<UiProcessResult> => {
      const combinedValidationErrors = [
        ...(options.validationErrors ?? normalizedContext.validationErrors ?? []),
        ...collectionErrors,
      ];
      const renderParameters = options.clearPreviousSelectedLogId
        ? omitPreviousSelectedLogParam(normalizedContext.parameters)
        : normalizedContext.parameters;

      const state = evaluateProcessUiState({
        context: {
          ...normalizedContext,
          ...(renderParameters !== normalizedContext.parameters
            ? { parameters: renderParameters }
            : {}),
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
        isResetOrInitial,
      });

      let lockedFields: Record<string, string> | undefined;
      if (state.documentTypeKey && this.options.lockedFieldsResolver) {
        const matchedSpace = state.spaceId
          ? spaces.find((s) => s.id === state.spaceId)
          : undefined;
        const spaceDto: UiProcessDocumentSpaceDto | undefined = matchedSpace
          ? {
              id: matchedSpace.id,
              name: matchedSpace.name,
              typeId: matchedSpace.typeId ?? currentSpaceType,
              abstractStorageId: matchedSpace.abstractStorageId ?? matchedSpace.id,
            }
          : undefined;
        const rawSelectedLogId = state.formData?.[SELECT_DOCUMENT_LOG_KEY];
        const selectedLogId =
          typeof rawSelectedLogId === 'string' && rawSelectedLogId.trim().length > 0
            ? rawSelectedLogId.trim()
            : undefined;
        try {
          const derived = await this.options.lockedFieldsResolver.deriveLockedFields({
            documentTypeKey: state.documentTypeKey,
            ...(spaceDto !== undefined ? { space: spaceDto } : {}),
            ...(selectedLogId !== undefined ? { selectedLogId } : {}),
            formData: state.formData ?? {},
          });
          if (Object.keys(derived).length > 0) {
            lockedFields = derived;
          }
        } catch {
          lockedFields = undefined;
        }
      }

      return {
        type: 'render',
        viewId: state.viewId,
        documentTypeKey: state.documentTypeKey,
        ...(state.spaceId !== undefined ? { spaceId: state.spaceId } : {}),
        selectionState: state.selectionState,
        formData: state.formData,
        isUpdateCard: state.isUpdateCard,
        ...(options.popToRoot ? { popToRoot: true } : {}),
        ...(options.hiddenFields !== undefined ? { hiddenFields: options.hiddenFields } : {}),
        ...(lockedFields !== undefined ? { lockedFields } : {}),
        ...(state.validationErrors ? { validationErrors: state.validationErrors } : {}),
        ...(state.statusMessages ? { statusMessages: state.statusMessages } : {}),
        ...(options.notification !== undefined ? { notification: options.notification } : {}),
      };
    };

    const createErrorRenderResult = (
      validationErrors: string[],
      statusMessages?: string[] | undefined
    ): Promise<UiProcessResult> =>
      createRenderResult({
        validationErrors,
        ...(statusMessages !== undefined && statusMessages.length > 0
          ? { statusMessages }
          : {}),
        isUpdateCard: true,
      });

    if (actionName === 'copyDocumentLog') {
      if (!this.options.documentLogPort) {
        return createErrorRenderResult([
          'Document Log provisioning is not configured for this workspace.',
        ]);
      }

      const spaceResult = resolveValidatedSpaceDto(
        {
          formData: normalizedContext.formData,
          activeSpaceType: currentSpaceType,
          config,
        },
        spaces,
        'Please select a Document Space before copying a Document Log.'
      );
      if (!spaceResult.ok) {
        return createErrorRenderResult([spaceResult.error]);
      }
      const space = spaceResult.space;

      try {
        const copyResult = await this.options.documentLogPort.copyLog(space);
        const primarySpaceId = space.abstractStorageId ?? space.id;
        this.options.onLogCopied?.(primarySpaceId);
        if (space.id && space.id !== primarySpaceId) {
          this.options.onLogCopied?.(space.id);
        }
        const notification = copyResult.created
          ? `Created "${copyResult.candidate.name}" in "${copyResult.folderPath}".`
          : `Document Log already exists: "${copyResult.candidate.name}".`;

        let evaluatedFormData = normalizedContext.formData;
        let hiddenFields: string[] | undefined;
        if (formEvaluator) {
          try {
            const evaluation = await formEvaluator.evaluate(
              normalizedContext.formData ?? {},
              resolvedDocumentTypeKey
            );
            evaluatedFormData = evaluation.computedData;
            hiddenFields = evaluation.hiddenFields;
          } catch (e) {
            console.warn('Form evaluation failed after copyDocumentLog:', e);
          }
        }

        return createRenderResult({
          formData: evaluatedFormData,
          hiddenFields,
          isUpdateCard: true,
          notification,
        });
      } catch (error) {
        if (extractErrorStatusCode(error) === 403) {
          return createErrorRenderResult([
            `Permission denied (403) while copying the Document Log template into "${space.name}". Ensure you have Contributor (or higher) access to the Shared Drive and permission to copy the Document Log template spreadsheet, then try again.`,
          ]);
        }
        return createErrorRenderResult([
          error instanceof Error ? error.message : 'Failed to copy Document Log',
        ]);
      }
    }

    if (actionName === 'processDocument') {
      const currentUiState = evaluateProcessUiState({
        context: normalizedContext,
        resolvedDocumentTypeKey,
        resolvedSpaceType: currentSpaceType,
        config,
        spaceTypes,
        spaces,
        threadMessages,
        isResetOrInitial,
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

      const resolvedSelection = resolveActiveSourceFiles({
        isGmail,
        isDriveUrlSource,
        selectedMessageId,
        normalizedContext,
        currentUiState,
        threadMessages,
      });

      if (resolvedSelection.invalidDriveUrl) {
        return createErrorRenderResult([
          'Invalid Google Drive URL. Please enter a valid Google Drive file or folder link.',
        ]);
      }

      const activeSourceFiles = resolvedSelection.files;

      let allowEmptySourceFiles = false;
      let maxSourceFiles: number | undefined;
      if (resolvedDocumentTypeKey && manifestPort) {
        try {
          const schemas = await manifestPort.getDocumentTypeSchemas(resolvedDocumentTypeKey);
          allowEmptySourceFiles = Boolean(schemas?.allowEmptySourceFiles);
          maxSourceFiles =
            typeof schemas?.maxSourceFiles === 'number' ? schemas.maxSourceFiles : undefined;
        } catch (e) {
          console.warn(`Could not fetch schemas for: ${resolvedDocumentTypeKey}`, e);
        }
      }

      const hasExplicitFileId =
        typeof context.parameters?.fileId === 'string' &&
        context.parameters.fileId.trim().length > 0;

      if (activeSourceFiles.length === 0 && !hasExplicitFileId) {
        if (!allowEmptySourceFiles) {
          const errorMsg = isGmail
            ? 'Please select at least one file to process or enable Save Email to PDF.'
            : 'Please select at least one file in Google Drive to process.';
          return createErrorRenderResult([errorMsg]);
        }
      }

      if (maxSourceFiles !== undefined) {
        if (activeSourceFiles.length > maxSourceFiles) {
          return createErrorRenderResult([
            buildMaxSourceFilesMessage(maxSourceFiles, activeSourceFiles.length, isGmail, false),
          ]);
        }
        if (activeSourceFiles.some((f) => f.mimeType === GOOGLE_FOLDER_MIME_TYPE)) {
          return createErrorRenderResult([
            'Folders cannot be submitted for this document type. Please select a single file instead.',
          ]);
        }
      }

      const spaceResult = resolveValidatedSpaceDto(
        {
          formData: normalizedContext.formData,
          activeSpaceType: currentSpaceType,
          config,
        },
        spaces,
        'Please select a Document Space.'
      );
      if (!spaceResult.ok) {
        return createErrorRenderResult([spaceResult.error]);
      }
      const space = spaceResult.space;

      let selectedLogId: string | undefined;
      if (this.options.documentLogPort && resolvedDocumentTypeKey) {
        try {
          const needsLog = await this.options.documentLogPort.requiresDocumentLog(
            resolvedDocumentTypeKey
          );
          if (needsLog) {
            const logResolution = await this.options.documentLogPort.resolveLog(space);
            if (logResolution.status === 'missing') {
              return createErrorRenderResult([
                `No DocumentLog spreadsheet found for space "${space.name}". Expected a DocumentLog spreadsheet in "${logResolution.expectedFolderPath}".`,
              ]);
            }
            if (logResolution.status === 'ambiguous') {
              const rawSelectedLog = normalizedContext.formData?.[SELECT_DOCUMENT_LOG_KEY];
              const effectiveSelectedLogId =
                typeof rawSelectedLog === 'string' && rawSelectedLog.trim().length > 0
                  ? rawSelectedLog.trim()
                  : undefined;

              const matchedCandidate = effectiveSelectedLogId
                ? logResolution.candidates.find((c) => c.id === effectiveSelectedLogId)
                : undefined;

              if (matchedCandidate) {
                selectedLogId = matchedCandidate.id;
              } else {
                const cleanedFormData = { ...(normalizedContext.formData ?? {}) };
                delete cleanedFormData[SELECT_DOCUMENT_LOG_KEY];
                const candidateSummary = logResolution.candidates
                  .map((c) => `"${c.name}" (${c.id})`)
                  .join(', ');
                return createRenderResult({
                  formData: cleanedFormData,
                  validationErrors: [
                    `Multiple DocumentLog spreadsheets found for space "${space.name}": ${candidateSummary}. Please select a Document Log and try again.`,
                  ],
                  isUpdateCard: true,
                  clearPreviousSelectedLogId: true,
                });
              }
            } else {
              selectedLogId = logResolution.candidate.id;
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Failed to verify DocumentLog availability';
          return createErrorRenderResult([message]);
        }
      }

      const data = extractDocumentData(normalizedContext.formData);

      try {
        const buildSuccessCardRenderResult = (
          executionOutcome: UiProcessDocumentExecutionOutcome
        ): UiProcessRenderResult => ({
          type: 'render',
          viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
          ...(resolvedDocumentTypeKey !== undefined
            ? { documentTypeKey: resolvedDocumentTypeKey }
            : {}),
          spaceId: space.id,
          isUpdateCard: false,
          executionOutcome,
        });

        let result:
          | Awaited<ReturnType<NonNullable<typeof documentRunner>['processDocument']>>
          | undefined;
        if (documentRunner) {
          result = await documentRunner.processDocument(
            {
              type: resolvedDocumentTypeKey ?? 'default',
              data,
              space,
              sourceFiles: activeSourceFiles,
              ...(selectedMessageId !== undefined ? { targetMessageId: selectedMessageId } : {}),
              ...(selectedLogId !== undefined ? { selectedLogId } : {}),
            },
            'onSubmit'
          );
        }

        const rawNotices = result?.contextVariables?.notices;
        const notices = Array.isArray(rawNotices)
          ? rawNotices.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
          : [];

        if (result && result.success === false) {
          const validationErrors =
            result.errors && result.errors.length > 0
              ? result.errors
              : result.executionOutcome?.errors && result.executionOutcome.errors.length > 0
                ? result.executionOutcome.errors
                : result.error
                  ? [result.error]
                  : ['Document validation failed'];

          const outcome = result.executionOutcome;
          const completedStepCount = outcome?.completedStepCount ?? 0;
          const producedFiles =
            outcome?.stepResults.flatMap((step) => step.files) ?? [];

          if (outcome && (completedStepCount >= 1 || producedFiles.length >= 1)) {
            return buildSuccessCardRenderResult({
              ...outcome,
              success: false,
              notices: outcome.notices.length > 0 ? outcome.notices : notices,
              errors: outcome.errors.length > 0 ? outcome.errors : validationErrors,
            });
          }

          return createErrorRenderResult(
            validationErrors,
            notices.length > 0 ? notices : undefined
          );
        }

        const executionOutcome: UiProcessDocumentExecutionOutcome = result?.executionOutcome ?? {
          success: true,
          completedStepCount: 0,
          spaceName: space.name,
          documentData: data,
          stepResults: [],
          notices,
          errors: [],
        };

        return buildSuccessCardRenderResult(executionOutcome);
      } catch (error) {
        const validationErrors = [error instanceof Error ? error.message : 'Document processing failed'];
        return createErrorRenderResult(validationErrors);
      }

    }

    let docTypeStatusWarnings: string[] | undefined;
    if (isDocTypeChange && resolvedDocumentTypeKey && manifestPort) {
      if (!cachedDocTypeSchemas) {
        try {
          cachedDocTypeSchemas = await manifestPort.getDocumentTypeSchemas(resolvedDocumentTypeKey);
        } catch (e) {
          console.warn(`Could not fetch schemas for: ${resolvedDocumentTypeKey}`, e);
        }
      }
      const maxSourceFiles =
        typeof cachedDocTypeSchemas?.maxSourceFiles === 'number'
          ? cachedDocTypeSchemas.maxSourceFiles
          : undefined;
      if (maxSourceFiles !== undefined) {
        const previewUiState = evaluateProcessUiState({
          context: normalizedContext,
          resolvedDocumentTypeKey,
          resolvedSpaceType: currentSpaceType,
          config,
          spaceTypes,
          spaces,
          threadMessages,
          isResetOrInitial,
        });
        const previewMessageId = isGmail
          ? (previewUiState.selectedMessageId ??
              (previewUiState.formData[SELECT_EMAIL_MESSAGE_KEY] as string | undefined) ??
              (normalizedContext.formData?.[SELECT_EMAIL_MESSAGE_KEY] as string | undefined) ??
              context.gmail?.messageId ??
              normalizedContext.gmail?.messageId)
          : undefined;
        const previewIsDriveUrl =
          isGmail &&
          (normalizedContext.formData?.[SELECT_FILE_SOURCE_KEY] === 'Google Drive URL' ||
            previewUiState.formData[SELECT_FILE_SOURCE_KEY] === 'Google Drive URL');
        const previewSelection = resolveActiveSourceFiles({
          isGmail,
          isDriveUrlSource: previewIsDriveUrl,
          selectedMessageId: previewMessageId,
          normalizedContext,
          currentUiState: previewUiState,
          threadMessages,
        });
        const warnings: string[] = [];
        if (previewSelection.files.length > maxSourceFiles) {
          warnings.push(
            buildMaxSourceFilesMessage(maxSourceFiles, previewSelection.files.length, isGmail, true)
          );
        }
        if (previewSelection.files.some((f) => f.mimeType === GOOGLE_FOLDER_MIME_TYPE)) {
          warnings.push(
            'Note: Folders cannot be submitted for this document type. Please select a single file instead.'
          );
        }
        if (warnings.length > 0) {
          docTypeStatusWarnings = Array.from(
            new Set([...(normalizedContext.statusMessages ?? []), ...warnings])
          );
        }
      }
    }

    let evaluatedFormData = normalizedContext.formData;
    let hiddenFields: string[] | undefined;
    if (formEvaluator) {
      try {
        const evaluation = await formEvaluator.evaluate(
          normalizedContext.formData ?? {},
          resolvedDocumentTypeKey
        );
        evaluatedFormData = evaluation.computedData;
        hiddenFields = evaluation.hiddenFields;
      } catch (e) {
        console.warn('Form evaluation failed:', e);
        return createErrorRenderResult([
          e instanceof Error ? e.message : 'Form evaluation failed',
        ]);
      }
    }

    return createRenderResult({
      formData: evaluatedFormData,
      hiddenFields,
      ...(docTypeStatusWarnings !== undefined ? { statusMessages: docTypeStatusWarnings } : {}),
      isUpdateCard: isStartOver || actionName === 'onFormChange',
      ...(isStartOver ? { popToRoot: true } : {}),
    });
  }

  private async resolveActiveGmailMessage(params: {
    context: UiProcessEventContext;
    effectiveContext: UiProcessEventContext;
    actionName: string | undefined;
    isInCardAction: boolean;
  }): Promise<{
    threadMessages?: UiProcessGmailMessageDescriptor[] | undefined;
    activeMsg?: UiProcessGmailMessageDescriptor | undefined;
    effectiveContext: UiProcessEventContext;
  }> {
    const { context, actionName, isInCardAction } = params;
    let { effectiveContext } = params;
    if (!this.gmailPort) {
      return { effectiveContext };
    }

    let threadMessages: UiProcessGmailMessageDescriptor[] | undefined;
    let activeMsg: UiProcessGmailMessageDescriptor | undefined;

    const needsGmailFetch =
      !effectiveContext.selectedItems ||
      effectiveContext.selectedItems.length === 0 ||
      actionName === 'refresh' ||
      actionName === 'startOver' ||
      isInCardAction;

    if (needsGmailFetch) {
      const token = context.userOAuthToken ?? context.gmail?.accessToken;
      const skipCache = actionName === 'refresh' || actionName === 'startOver';

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
        const formMsgId =
          actionName === 'refresh' || actionName === 'startOver'
            ? undefined
            : (effectiveContext.formData?.[SELECT_EMAIL_MESSAGE_KEY] as string | undefined);
        activeMsg =
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
          actionName === 'startOver' ||
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

    return { threadMessages, activeMsg, effectiveContext };
  }

  private async inferPass1Routing(params: {
    isGmail: boolean;
    isResetOrInitial: boolean;
    actionName: string | undefined;
    effectiveContext: UiProcessEventContext;
    gmailDriveSelection: GmailDriveSelection;
    activeMsg: UiProcessGmailMessageDescriptor | undefined;
    config: ProcessUiStateConfig | undefined;
    spaceTypes: UiProcessSpaceType[];
    getCachedCollection: (typeId: string) => Promise<UiProcessSpaceCollection>;
  }): Promise<{
    inferred: UiProcessInferredRoutingResult | undefined;
    isDrivePass1Event: boolean;
    isGmailPass1Event: boolean;
    isGmailDriveUrlPass1Event: boolean;
    isGmailEmailPass1Event: boolean;
  }> {
    const {
      isGmail,
      isResetOrInitial,
      actionName,
      effectiveContext,
      gmailDriveSelection,
      activeMsg,
      config,
      spaceTypes,
      getCachedCollection,
    } = params;

    let inferred: UiProcessInferredRoutingResult | undefined;
    const sourceParser = this.options.sourceParser;

    const isDrivePass1Event = !isGmail && isResetOrInitial;

    const {
      effectiveFileSource,
      currentDriveUrl,
      previousDriveUrl,
      parsedCurrentDriveUrl,
    } = gmailDriveSelection;

    const isGmailDriveUrlPass1Event =
      isGmail &&
      Boolean(parsedCurrentDriveUrl) &&
      effectiveFileSource === 'Google Drive URL' &&
      (actionName === 'refresh' ||
        actionName === 'startOver' ||
        (actionName === 'onFormChange' && currentDriveUrl !== previousDriveUrl) ||
        actionName === 'onFileSourceChange');

    const isGmailEmailPass1Event =
      isGmail &&
      Boolean(activeMsg) &&
      (effectiveFileSource === 'Email Attachments' || !effectiveFileSource) &&
      (isResetOrInitial ||
        actionName === 'refresh' ||
        actionName === 'startOver' ||
        actionName === 'onEmailMessageChange' ||
        actionName === 'onFileSourceChange');

    const isGmailPass1Event = isGmailDriveUrlPass1Event || isGmailEmailPass1Event;

    if (!sourceParser) {
      return {
        inferred,
        isDrivePass1Event,
        isGmailPass1Event,
        isGmailDriveUrlPass1Event,
        isGmailEmailPass1Event,
      };
    }

    if (isDrivePass1Event) {
      const candidateItems = buildSourceContextItems({
        isGmail: false,
        selectedItems: effectiveContext.selectedItems,
        isResetOrInitial: true,
        formData: effectiveContext.formData,
      });

      if (candidateItems.length > 0) {
        try {
          inferred = await sourceParser.inferRouting({ items: candidateItems });
        } catch (e) {
          console.warn('SourceParser Pass 1 inferRouting error:', e);
          inferred = {
            statusMessages: [DRIVE_ROUTING_FALLBACK_NOTICE],
          };
        }
      }
    } else if (isGmailPass1Event && (Boolean(activeMsg) || isGmailDriveUrlPass1Event)) {
      const candidateItems = buildSourceContextItems({
        isGmail: true,
        driveUrlId: isGmailDriveUrlPass1Event ? parsedCurrentDriveUrl!.id : undefined,
        activeMsg,
        isResetOrInitial,
        formData: effectiveContext.formData,
      });

      const emailContext = buildSourceEmailDescriptor(activeMsg);

      const defaultSpaceTypeId = config?.defaultDocumentSpaceType ?? spaceTypes[0]?.id;
      const selectedSpaceTypeId = effectiveContext.formData?.[SELECT_DOCUMENT_SPACE_TYPE_KEY] as string | undefined;

      const spaceTypesToFetch = new Set<string>();
      if (defaultSpaceTypeId) {
        spaceTypesToFetch.add(defaultSpaceTypeId);
      }
      if (selectedSpaceTypeId && spaceTypes.some((st) => st.id === selectedSpaceTypeId)) {
        spaceTypesToFetch.add(selectedSpaceTypeId);
      }

      const hasProposalMarkers = activeMsg
        ? hasProposalOpportunityMarkers(
            activeMsg.subject,
            activeMsg.plainTextBody,
            activeMsg.htmlBody,
            activeMsg.labels
          )
        : false;

      if (hasProposalMarkers) {
        for (const st of spaceTypes) {
          if (
            st.id !== defaultSpaceTypeId &&
            (st.id === 'proposals' ||
              st.spaceSchema.allowedDocumentTypes.some((d) =>
                d.toLowerCase().includes('proposal')
              ))
          ) {
            spaceTypesToFetch.add(st.id);
          }
        }
      }

      const candidateSpaces: UiProcessCandidateSpaceDescriptor[] = [];
      for (const typeId of spaceTypesToFetch) {
        try {
          const col = await getCachedCollection(typeId);
          for (const s of col.spaces) {
            candidateSpaces.push({
              id: s.id,
              name: s.name,
              typeId: s.typeId ?? typeId,
            });
          }
        } catch (e) {
          console.warn(`Could not fetch candidate spaces for space type: ${typeId}`, e);
        }
      }

      try {
        inferred = await sourceParser.inferRouting({
          items: candidateItems,
          ...(emailContext ? { email: emailContext } : {}),
          candidateSpaces,
          ...(isGmailDriveUrlPass1Event ? { isDriveUrl: true } : {}),
        });
      } catch (e) {
        console.warn('SourceParser Pass 1 inferRouting error in Gmail:', e);
        if (isGmailDriveUrlPass1Event) {
          inferred = {
            statusMessages: [DRIVE_ROUTING_FALLBACK_NOTICE],
          };
        }
      }
    }

    return {
      inferred,
      isDrivePass1Event,
      isGmailPass1Event,
      isGmailDriveUrlPass1Event,
      isGmailEmailPass1Event,
    };
  }
}


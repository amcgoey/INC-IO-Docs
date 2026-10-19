import { Type, type Static } from '@sinclair/typebox';

export const UiSelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type UiSelectionItem = Static<typeof UiSelectionItemSchema>;

export const UiSelectionStateSchema = Type.Object({
  spaceTypes: Type.Array(UiSelectionItemSchema),
  spaces: Type.Array(Type.String()),
  documentTypes: Type.Array(UiSelectionItemSchema),
  files: Type.Optional(Type.Union([Type.Array(UiSelectionItemSchema), Type.Undefined()])),
  fileSources: Type.Optional(Type.Union([Type.Array(UiSelectionItemSchema), Type.Undefined()])),
});
export type UiSelectionState = Static<typeof UiSelectionStateSchema>;

export const UiProcessSpaceItemSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  typeId: Type.Optional(Type.String()),
  abstractStorageId: Type.Optional(Type.String()),
});
export type UiProcessSpaceItem = Static<typeof UiProcessSpaceItemSchema>;

export const UiProcessSpaceTypeSchema = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  spaceSchema: Type.Object({
    allowedDocumentTypes: Type.Array(Type.String()),
  }),
});
export type UiProcessSpaceType = Static<typeof UiProcessSpaceTypeSchema>;

export const ProcessUiStateConfigSchema = Type.Object({
  defaultDocumentType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  defaultDocumentSpaceType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type ProcessUiStateConfig = Static<typeof ProcessUiStateConfigSchema>;

export const UiStateResolutionContextSchema = Type.Object({
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  config: Type.Optional(Type.Union([ProcessUiStateConfigSchema, Type.Undefined()])),
  activeSpaceType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  parameters: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
  spaces: Type.Optional(Type.Union([Type.Array(UiProcessSpaceItemSchema), Type.Undefined()])),
});
export type UiStateResolutionContext = Static<typeof UiStateResolutionContextSchema>;

export const UiProcessGmailEventContextSchema = Type.Object({
  messageId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  threadId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  accessToken: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type UiProcessGmailEventContext = Static<typeof UiProcessGmailEventContextSchema>;

export const ProcessUiStateEventSchema = Type.Object({
  actionName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  parameters: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  hostApp: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  gmail: Type.Optional(Type.Union([UiProcessGmailEventContextSchema, Type.Undefined()])),
  userOAuthToken: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectedItems: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          id: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
          title: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
          mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
        })
      ),
      Type.Undefined(),
    ])
  ),
});
export type ProcessUiStateEvent = Static<typeof ProcessUiStateEventSchema>;

export const ProcessUiStateInputSchema = Type.Object({
  context: ProcessUiStateEventSchema,
  resolvedDocumentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  resolvedSpaceType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  config: Type.Optional(Type.Union([ProcessUiStateConfigSchema, Type.Undefined()])),
  spaceTypes: Type.Array(UiProcessSpaceTypeSchema),
  spaces: Type.Array(UiProcessSpaceItemSchema),
});
export type ProcessUiStateInput = Static<typeof ProcessUiStateInputSchema>;

export const ProcessUiStateOutputSchema = Type.Object({
  viewId: Type.String(),
  documentTypeKey: Type.String(),
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectionState: UiSelectionStateSchema,
  formData: Type.Record(Type.String(), Type.Unknown()),
  isUpdateCard: Type.Boolean(),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
});
export type ProcessUiStateOutput = Static<typeof ProcessUiStateOutputSchema>;

export const DRIVE_WORKSPACE_ADDON_VIEW_ID = 'drive-document-process-card';
export const GMAIL_WORKSPACE_ADDON_VIEW_ID = 'gmail-document-process-card';

export const SELECT_FILES_KEY = 'SelectFiles';
export const SELECT_FILE_SOURCE_KEY = 'SelectFileSource';
export const SELECT_ATTACHMENTS_KEY = 'SelectAttachments';
export const INPUT_DRIVE_URL_KEY = 'InputDriveURL';
export const SAVE_EMAIL_TO_PDF_KEY = 'SaveEmailToPdf';

export const EPHEMERAL_UI_SELECTION_KEYS = new Set([
  SELECT_FILES_KEY,
  SELECT_FILE_SOURCE_KEY,
  SELECT_ATTACHMENTS_KEY,
  INPUT_DRIVE_URL_KEY,
  SAVE_EMAIL_TO_PDF_KEY,
]);

export const SELECTION_KEY_PREFIX = 'SelectDocument';
export const SELECT_DOCUMENT_SPACE_TYPE_KEY = 'SelectDocumentSpaceType';
export const SELECT_DOCUMENT_SPACE_KEY = 'SelectDocumentSpace';
export const SELECT_DOCUMENT_TYPE_KEY = 'SelectDocumentType';
export const SELECT_DOCUMENT_SPACE_PREFIX = `${SELECT_DOCUMENT_SPACE_KEY}_`;
export const SELECT_DOCUMENT_TYPE_PREFIX = `${SELECT_DOCUMENT_TYPE_KEY}_`;

export function getSpaceSelectorKey(spaceType: string): string {
  return `${SELECT_DOCUMENT_SPACE_PREFIX}${spaceType}`;
}

export function getDocTypeSelectorKey(spaceType: string): string {
  return `${SELECT_DOCUMENT_TYPE_PREFIX}${spaceType}`;
}

export function isSelectionKey(key: string): boolean {
  return key.startsWith(SELECTION_KEY_PREFIX) || EPHEMERAL_UI_SELECTION_KEYS.has(key);
}

/**
 * Parses a Google Drive file, folder, or Google Workspace collaborative doc URL.
 * Returns { id, resourceType: 'file' | 'folder' } or undefined if invalid.
 */
export function parseGoogleDriveUrl(
  url: string
): { id: string; resourceType: 'file' | 'folder' } | undefined {
  if (typeof url !== 'string') {
    return undefined;
  }
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return undefined;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== 'drive.google.com' && hostname !== 'docs.google.com') {
    return undefined;
  }

  const pathname = parsedUrl.pathname as string;

  if (hostname === 'drive.google.com') {
    // 2. Standard Drive Folders:
    // https://drive.google.com/(?:drive/)?(?:u/\d+/)?folders/([a-zA-Z0-9_-]+)
    const folderMatch = pathname.match(/^(?:\/(?:drive|u\/\d+))*\/folders\/([a-zA-Z0-9_-]+)(?:\/.*)?$/);
    if (folderMatch) {
      return { id: folderMatch[1], resourceType: 'folder' };
    }

    // 3. Drive Open ID:
    // https://drive.google.com/open?.*id=([a-zA-Z0-9_-]+) (or query parameter id=<id>)
    if (/^(?:\/u\/\d+)?\/open(?:\/.*)?$/.test(pathname)) {
      const idParam = parsedUrl.searchParams.get('id');
      if (idParam && /^[a-zA-Z0-9_-]+$/.test(idParam)) {
        return { id: idParam, resourceType: 'file' };
      }
    }

    // 1. Standard Drive Files:
    // https://drive.google.com/(?:file/)?(?:u/\d+/)?d/([a-zA-Z0-9_-]+)
    const fileMatch = pathname.match(/^(?:\/(?:file|u\/\d+))*\/d\/([a-zA-Z0-9_-]+)(?:\/.*)?$/);
    if (fileMatch) {
      return { id: fileMatch[1], resourceType: 'file' };
    }
  }

  if (hostname === 'docs.google.com') {
    // 4. Google Workspace Collaborative Docs:
    // https://docs.google.com/(?:document|spreadsheets|presentation|forms)/(?:u/\d+/)?d/([a-zA-Z0-9_-]+)
    const docsMatch = pathname.match(
      /^(?:\/u\/\d+)?\/(?:document|spreadsheets|presentation|forms)(?:\/u\/\d+)?\/d\/([a-zA-Z0-9_-]+)(?:\/.*)?$/
    );
    if (docsMatch) {
      return { id: docsMatch[1], resourceType: 'file' };
    }
  }

  return undefined;
}

/**
 * Checks whether an event context corresponds to a Gmail context.
 */
export function isGmailContext(context?: {
  hostApp?: string | undefined;
  gmail?: { messageId?: string | undefined } | undefined;
} | undefined): boolean {
  if (!context) {
    return false;
  }
  return context.hostApp?.toUpperCase() === 'GMAIL' || Boolean(context.gmail?.messageId);
}

/**
 * Normalizes formData[keyName] (string | string[] | undefined) into a Set of non-empty trimmed strings.
 */
export function extractSelectFilesSet(
  formData?: Record<string, unknown>,
  keyName: string = SELECT_FILES_KEY
): Set<string> {
  const raw = formData?.[keyName];
  const set = new Set<string>();
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed.length > 0) {
          set.add(trimmed);
        }
      }
    }
  }
  return set;
}

function filterFormData(
  formData: Record<string, unknown> | undefined,
  predicate: (key: string) => boolean
): Record<string, unknown> {
  if (!formData) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(formData)) {
    if (predicate(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extracts data fields from formData by stripping selection state keys
 * (keys starting with 'SelectDocument').
 */
export function extractDocumentData(
  formData?: Record<string, unknown>
): Record<string, unknown> {
  return filterFormData(formData, (key) => !isSelectionKey(key));
}

/**
 * Translates a human-readable document type display name into its canonical backend key.
 * If the input is already a backend key or no mapping is found, returns it unchanged.
 */
export function translateDocumentType(
  nameOrKey: string,
  nameToKeyMap?: Record<string, string>
): string {
  if (!nameToKeyMap) {
    return nameOrKey;
  }
  return nameToKeyMap[nameOrKey] ?? nameOrKey;
}

/**
 * Resolves the active space type from context form data or configuration fallback.
 */
export function resolveSpaceType(context?: UiStateResolutionContext): string {
  return (
    (context?.formData?.[SELECT_DOCUMENT_SPACE_TYPE_KEY] as string | undefined) ??
    context?.config?.defaultDocumentSpaceType ??
    'projects'
  );
}

/**
 * Resolves the active document type from context form data, parameters, or configuration fallback.
 */
export function resolveDocumentType(context?: UiStateResolutionContext): string | undefined {
  const spaceType = context?.activeSpaceType ?? resolveSpaceType(context);
  if (spaceType) {
    const spaceSelectorKey = getDocTypeSelectorKey(spaceType);
    if (
      context?.formData?.[spaceSelectorKey] !== undefined &&
      typeof context.formData[spaceSelectorKey] === 'string'
    ) {
      return context.formData[spaceSelectorKey] as string;
    }
  }

  if (
    context?.formData?.[SELECT_DOCUMENT_TYPE_KEY] !== undefined &&
    typeof context.formData[SELECT_DOCUMENT_TYPE_KEY] === 'string'
  ) {
    return context.formData[SELECT_DOCUMENT_TYPE_KEY] as string;
  }

  if (context?.parameters?.documentTypeKey) {
    return context.parameters.documentTypeKey;
  }

  return context?.config?.defaultDocumentType;
}

function cleanTrimmedString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    const trimmed = value[0].trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

export const ResolveSpaceResultSchema = Type.Object({
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  matchedSpace: Type.Optional(Type.Union([UiProcessSpaceItemSchema, Type.Undefined()])),
  collisionError: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  notFoundError: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  isIdMatch: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type ResolveSpaceResult = Static<typeof ResolveSpaceResultSchema>;

/**
 * Detailed space resolution evaluating exact ID matches, case-insensitive name matches,
 * ambiguity collisions, and unknown space rejection.
 */
export function resolveSpace(
  context?: UiStateResolutionContext,
  spaces?: UiProcessSpaceItem[]
): ResolveSpaceResult {
  const spaceList = spaces ?? context?.spaces ?? [];
  // nosemgrep: domain-pass-through-read
  const formData = context?.formData;
  if (!formData) {
    return {};
  }
  const spaceType = context.activeSpaceType ?? resolveSpaceType(context);
  const spaceSelectorKey = spaceType ? getSpaceSelectorKey(spaceType) : undefined;

  let rawInput: string | undefined;
  if (
    spaceSelectorKey &&
    (spaceSelectorKey in formData || formData[spaceSelectorKey] !== undefined)
  ) {
    rawInput = cleanTrimmedString(formData[spaceSelectorKey]);
  } else if (
    SELECT_DOCUMENT_SPACE_KEY in formData ||
    formData[SELECT_DOCUMENT_SPACE_KEY] !== undefined
  ) {
    rawInput = cleanTrimmedString(formData[SELECT_DOCUMENT_SPACE_KEY]);
  } else {
    rawInput = cleanTrimmedString(formData.spaceId);
  }

  if (!rawInput) {
    return {};
  }

  // 1. Exact ID match
  const idMatch = spaceList.find((s) => s.id === rawInput);
  if (idMatch) {
    return {
      spaceId: idMatch.id,
      matchedSpace: idMatch,
      isIdMatch: true,
    };
  }

  // 2. Case-insensitive name match
  const normalizedRaw = rawInput.toLowerCase();
  const nameMatches = spaceList.filter((s) => s.name.trim().toLowerCase() === normalizedRaw);

  if (nameMatches.length > 1) {
    return {
      collisionError: `Multiple spaces match "${rawInput}". Please choose or enter a unique space identifier.`,
    };
  }

  if (nameMatches.length === 1) {
    return {
      spaceId: nameMatches[0].id,
      matchedSpace: nameMatches[0],
      isIdMatch: false,
    };
  }

  // 3. Unknown space rejection (no unlisted ID fallback)
  return {
    spaceId: undefined,
    matchedSpace: undefined,
    notFoundError: `Document space "${rawInput}" was not found. Please select an existing space.`,
  };
}

/**
 * Resolves the active space ID from context form data.
 * Checks direct 'spaceId', generic 'SelectDocumentSpace', or active space selector 'SelectDocumentSpace_<spaceType>'.
 */
export function resolveSpaceId(
  context?: UiStateResolutionContext,
  spaces?: UiProcessSpaceItem[]
): string | undefined {
  return resolveSpace(context, spaces).spaceId;
}

/**
 * Pure domain state evaluation for CQRS UI Orchestration.
 * Enforces:
 * 1. UI reload (isUpdateCard) on Space Type change.
 * 2. Defaulting Document Type to first allowed type when Space Type changes.
 * 3. Retains all formData across Document Type or Space Type change (dynamic-widget-suffix system prevents collisions).
 * 4. Resolves spaceId, derives selectionState.spaces, and auto-translates raw space ID to display name in effectiveFormData.
 */
export function evaluateProcessUiState(input: ProcessUiStateInput): ProcessUiStateOutput {
  const { context } = input;
  const action = context.actionName ?? context.parameters?.action;
  const isSpaceTypeChange = action === 'onSpaceTypeChange';
  const isDocTypeChange = action === 'onDocumentTypeChange';
  const isFileSourceChange = action === 'onFileSourceChange';

  const currentSpaceType =
    input.resolvedSpaceType ?? resolveSpaceType({ formData: context.formData, config: input.config });

  const selectedSpaceTypeObj = input.spaceTypes.find((t) => t.id === currentSpaceType);
  const allowedDocumentTypes = selectedSpaceTypeObj?.spaceSchema.allowedDocumentTypes ?? [];

  const effectiveFormData: Record<string, unknown> = { ...context.formData };
  const isRefresh = action === 'refresh';
  let isUpdateCard = isRefresh
    ? false
    : Boolean(context.isUpdateCard || isSpaceTypeChange || isDocTypeChange || isFileSourceChange);

  const rawSelectedDocType =
    resolveDocumentType({
      formData: effectiveFormData,
      config: input.config,
      activeSpaceType: currentSpaceType,
      parameters: context.parameters,
    });

  let currentDocTypeKey = input.resolvedDocumentTypeKey ?? rawSelectedDocType;

  if (isSpaceTypeChange && allowedDocumentTypes.length > 0) {
    currentDocTypeKey = allowedDocumentTypes[0];
  }

  if (isSpaceTypeChange || isDocTypeChange) {
    effectiveFormData[SELECT_DOCUMENT_SPACE_TYPE_KEY] = currentSpaceType;
  }

  // If still unassigned or invalid, fallback to first allowed or default
  if (!currentDocTypeKey || (allowedDocumentTypes.length > 0 && !allowedDocumentTypes.includes(currentDocTypeKey))) {
    currentDocTypeKey = allowedDocumentTypes[0] ?? input.config?.defaultDocumentType ?? '';
  }

  if (currentDocTypeKey) {
    effectiveFormData[SELECT_DOCUMENT_TYPE_KEY] = currentDocTypeKey;
  }

  const spaceTypes: UiSelectionItem[] = input.spaceTypes.map((t) => ({
    text: t.displayName,
    value: t.id,
    selected: t.id === currentSpaceType,
  }));

  const documentTypes: UiSelectionItem[] = allowedDocumentTypes.map((typeKey) => ({
    text: typeKey,
    value: typeKey,
    selected: typeKey === currentDocTypeKey,
  }));

  const inCardActions = new Set([
    'onSpaceTypeChange',
    'onDocumentTypeChange',
    'onFormChange',
    'onFileSourceChange',
    'processDocument',
    'viewJson',
  ]);
  const hasInCardAction = action !== undefined && inCardActions.has(action);

  const hasSelectionKeysInFormData = Boolean(
    context.formData &&
    Object.keys(context.formData).some((k) => isSelectionKey(k))
  );

  const isResetOrInitialLoad =
    isRefresh || (!hasInCardAction && !hasSelectionKeysInFormData);

  const isGmail = isGmailContext(context);

  const validSelectedItems = (context.selectedItems ?? []).filter(
    (item): item is { id: string; title?: string | undefined; mimeType?: string | undefined } =>
      typeof item?.id === 'string' && item.id.trim().length > 0
  );

  let fileSources: UiSelectionItem[] | undefined;
  let effectiveFileSource: string | undefined;
  if (isGmail) {
    if (isResetOrInitialLoad) {
      effectiveFileSource = 'Email Attachments';
      effectiveFormData[SELECT_FILE_SOURCE_KEY] = 'Email Attachments';
      effectiveFormData[INPUT_DRIVE_URL_KEY] = '';
    } else {
      effectiveFileSource =
        (context.formData?.[SELECT_FILE_SOURCE_KEY] as string) ?? 'Email Attachments';
      effectiveFormData[SELECT_FILE_SOURCE_KEY] = effectiveFileSource;
      if (context.formData?.[INPUT_DRIVE_URL_KEY] !== undefined) {
        effectiveFormData[INPUT_DRIVE_URL_KEY] = String(context.formData[INPUT_DRIVE_URL_KEY]).trim();
      } else if (context.parameters?.previousDriveUrl) {
        // nosemgrep: domain-pass-through-read
        effectiveFormData[INPUT_DRIVE_URL_KEY] = context.parameters.previousDriveUrl;
      } else {
        effectiveFormData[INPUT_DRIVE_URL_KEY] = '';
      }
    }

    fileSources = [
      {
        text: 'Email Attachments',
        value: 'Email Attachments',
        selected: effectiveFileSource === 'Email Attachments',
      },
      {
        text: 'Google Drive URL',
        value: 'Google Drive URL',
        selected: effectiveFileSource === 'Google Drive URL',
      },
    ];
  }

  let files: UiSelectionItem[];
  if (isGmail) {
    if (validSelectedItems.length > 0) {
      const hasAttachmentFormKey = context.formData?.[SELECT_ATTACHMENTS_KEY] !== undefined;
      const selectedSet = hasAttachmentFormKey
        ? extractSelectFilesSet(context.formData, SELECT_ATTACHMENTS_KEY)
        : undefined;

      let parsedParamSet: Set<string> | undefined;
      if (!hasAttachmentFormKey && !isResetOrInitialLoad && context.parameters?.previousAttachments) {
        try {
          const parsed = JSON.parse(context.parameters.previousAttachments);
          if (Array.isArray(parsed)) {
            parsedParamSet = new Set(parsed.map(String));
          }
        } catch {
          // ignore malformed JSON
        }
      }

      files = validSelectedItems.map((item) => {
        const trimmedTitle = typeof item.title === 'string' ? item.title.trim() : '';
        const fileId = item.id.trim();
        let selected: boolean;
        if (isRefresh) {
          selected = true;
        } else if (hasAttachmentFormKey) {
          selected = selectedSet!.has(fileId) || selectedSet!.has(item.id);
        } else if (!isResetOrInitialLoad && parsedParamSet !== undefined) {
          selected = parsedParamSet.has(fileId) || parsedParamSet.has(item.id);
        } else if (isResetOrInitialLoad) {
          selected = true;
        } else if (!isResetOrInitialLoad && effectiveFileSource === 'Email Attachments') {
          // When submitting in-card action from 'Email Attachments' mode, Google Workspace omits checkbox name when 0 checkboxes are checked
          selected = false;
        } else {
          selected = true;
        }
        return {
          text: trimmedTitle.length > 0 ? trimmedTitle : fileId,
          value: item.id,
          selected,
        };
      });
    } else {
      files = [];
    }
  } else {
    const selectedFilesSet = extractSelectFilesSet(context.formData, SELECT_FILES_KEY);
    files = validSelectedItems.map((item) => {
      const trimmedTitle = typeof item.title === 'string' ? item.title.trim() : '';
      const fileId = item.id.trim();
      return {
        text: trimmedTitle.length > 0 ? trimmedTitle : fileId,
        value: item.id,
        selected: isResetOrInitialLoad ? true : selectedFilesSet.has(fileId),
      };
    });
  }

  const selectionState: UiSelectionState = {
    spaceTypes,
    spaces: (input.spaces ?? []).map((s) => s.name),
    documentTypes,
    files,
    ...(fileSources !== undefined ? { fileSources } : {}),
  };

  const spaceResolution = resolveSpace(
    {
      formData: effectiveFormData,
      activeSpaceType: currentSpaceType,
      parameters: context.parameters,
    },
    input.spaces ?? []
  );

  const spaceSelectorKey = currentSpaceType ? getSpaceSelectorKey(currentSpaceType) : undefined;

  if (spaceResolution.spaceId === undefined) {
    delete effectiveFormData.spaceId;
  }

  if (spaceResolution.isIdMatch && spaceResolution.matchedSpace) {
    if (spaceSelectorKey && effectiveFormData[spaceSelectorKey] !== undefined) {
      // nosemgrep: domain-pass-through-read
      effectiveFormData[spaceSelectorKey] = spaceResolution.matchedSpace.name;
    }
    if (effectiveFormData[SELECT_DOCUMENT_SPACE_KEY] !== undefined) {
      // nosemgrep: domain-pass-through-read
      effectiveFormData[SELECT_DOCUMENT_SPACE_KEY] = spaceResolution.matchedSpace.name;
    }
    if (effectiveFormData.spaceId !== undefined) {
      // nosemgrep: domain-pass-through-read
      effectiveFormData.spaceId = spaceResolution.matchedSpace.name;
    }
  }

  const spaceError = spaceResolution.collisionError ?? spaceResolution.notFoundError;
  const validationErrors = [
    ...(context.validationErrors ?? []),
    ...(spaceError && !context.validationErrors?.includes(spaceError)
      ? [spaceError]
      : []),
  ];

  if (!isRefresh && (spaceResolution.collisionError || spaceResolution.notFoundError)) {
    isUpdateCard = true;
  }

  const viewId = isGmail
    ? GMAIL_WORKSPACE_ADDON_VIEW_ID
    : DRIVE_WORKSPACE_ADDON_VIEW_ID;

  if (isGmail) {
    if (isResetOrInitialLoad) {
      effectiveFormData[SAVE_EMAIL_TO_PDF_KEY] = false;
    } else {
      const rawSave = context.formData?.[SAVE_EMAIL_TO_PDF_KEY];
      effectiveFormData[SAVE_EMAIL_TO_PDF_KEY] =
        Array.isArray(rawSave)
          ? rawSave.length > 0 && Boolean(rawSave[0]) && rawSave[0] !== 'false'
          : rawSave === 'false'
            ? false
            : Boolean(rawSave);
    }
  }

  return {
    viewId,
    documentTypeKey: currentDocTypeKey,
    ...(spaceResolution.spaceId !== undefined ? { spaceId: spaceResolution.spaceId } : {}),
    selectionState,
    formData: effectiveFormData,
    isUpdateCard,
    ...(validationErrors.length > 0 ? { validationErrors } : {}),
    ...(context.statusMessages && context.statusMessages.length > 0
      ? { statusMessages: context.statusMessages }
      : {}),
  };
}

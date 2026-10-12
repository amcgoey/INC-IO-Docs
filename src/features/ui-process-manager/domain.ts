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
});
export type UiSelectionState = Static<typeof UiSelectionStateSchema>;

export const UiProcessSpaceItemSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
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

export const ProcessUiStateEventSchema = Type.Object({
  actionName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  parameters: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
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
});
export type ProcessUiStateOutput = Static<typeof ProcessUiStateOutputSchema>;

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
  return key.startsWith(SELECTION_KEY_PREFIX);
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
  isIdMatch: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type ResolveSpaceResult = Static<typeof ResolveSpaceResultSchema>;

/**
 * Detailed space resolution evaluating exact ID matches, case-insensitive name matches,
 * ambiguity collisions, and unlisted ID fallbacks.
 */
export function resolveSpace(
  context?: UiStateResolutionContext,
  spaces?: UiProcessSpaceItem[]
): ResolveSpaceResult {
  const spaceList = spaces ?? context?.spaces ?? [];
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

  // 3. Unlisted ID fallback
  return {
    spaceId: rawInput,
    isIdMatch: false,
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

  const currentSpaceType =
    input.resolvedSpaceType ?? resolveSpaceType({ formData: context.formData, config: input.config });

  const selectedSpaceTypeObj = input.spaceTypes.find((t) => t.id === currentSpaceType);
  const allowedDocumentTypes = selectedSpaceTypeObj?.spaceSchema.allowedDocumentTypes ?? [];

  const effectiveFormData: Record<string, unknown> = { ...context.formData };
  let isUpdateCard = Boolean(context.isUpdateCard || isSpaceTypeChange || isDocTypeChange);

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

  const selectionState: UiSelectionState = {
    spaceTypes,
    spaces: (input.spaces ?? []).map((s) => s.name),
    documentTypes,
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

  if (
    spaceResolution.spaceId === undefined &&
    ((spaceSelectorKey &&
      (spaceSelectorKey in effectiveFormData || effectiveFormData[spaceSelectorKey] !== undefined)) ||
      SELECT_DOCUMENT_SPACE_KEY in effectiveFormData ||
      effectiveFormData[SELECT_DOCUMENT_SPACE_KEY] !== undefined)
  ) {
    delete effectiveFormData.spaceId;
  }

  if (spaceResolution.isIdMatch && spaceResolution.matchedSpace) {
    if (spaceSelectorKey && effectiveFormData[spaceSelectorKey] !== undefined) {
      effectiveFormData[spaceSelectorKey] = spaceResolution.matchedSpace.name;
    }
    if (effectiveFormData[SELECT_DOCUMENT_SPACE_KEY] !== undefined) {
      effectiveFormData[SELECT_DOCUMENT_SPACE_KEY] = spaceResolution.matchedSpace.name;
    }
    if (effectiveFormData.spaceId !== undefined) {
      effectiveFormData.spaceId = spaceResolution.matchedSpace.name;
    }
  }

  const validationErrors = [
    ...(context.validationErrors ?? []),
    ...(spaceResolution.collisionError && !context.validationErrors?.includes(spaceResolution.collisionError)
      ? [spaceResolution.collisionError]
      : []),
  ];

  if (spaceResolution.collisionError) {
    isUpdateCard = true;
  }

  return {
    viewId: 'drive-document-process-card',
    documentTypeKey: currentDocTypeKey,
    ...(spaceResolution.spaceId !== undefined ? { spaceId: spaceResolution.spaceId } : {}),
    selectionState,
    formData: effectiveFormData,
    isUpdateCard,
    ...(validationErrors.length > 0 ? { validationErrors } : {}),
  };
}

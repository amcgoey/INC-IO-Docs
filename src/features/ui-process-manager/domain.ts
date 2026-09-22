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

export interface UiProcessSpaceType {
  id: string;
  displayName: string;
  spaceSchema: { allowedDocumentTypes: string[] };
}

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
});
export type UiStateResolutionContext = Static<typeof UiStateResolutionContextSchema>;

export interface ProcessUiStateEvent {
  actionName?: string | undefined;
  formData?: Record<string, unknown> | undefined;
  parameters?: Record<string, string> | undefined;
  validationErrors?: string[] | undefined;
  isUpdateCard?: boolean | undefined;
}

export interface ProcessUiStateInput {
  context: ProcessUiStateEvent;
  resolvedDocumentTypeKey?: string | undefined;
  resolvedSpaceType?: string | undefined;
  config?: ProcessUiStateConfig | undefined;
  spaceTypes: UiProcessSpaceType[];
  collectionSpaces: string[];
  nameToKeyMap?: Record<string, string> | undefined;
}

export interface ProcessUiStateOutput {
  viewId: string;
  documentTypeKey: string;
  selectionState: UiSelectionState;
  formData: Record<string, unknown>;
  isUpdateCard: boolean;
  validationErrors?: string[] | undefined;
}

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

/**
 * Pure domain state evaluation for CQRS UI Orchestration.
 * Enforces:
 * 1. UI reload (isUpdateCard) on Space Type change.
 * 2. Defaulting Document Type to first allowed type when Space Type changes.
 * 3. Retains all formData across Document Type or Space Type change (dynamic-widget-suffix system prevents collisions).
 * 4. Consolidates selection state and translation into effective form data.
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
  const isUpdateCard = Boolean(context.isUpdateCard || isSpaceTypeChange || isDocTypeChange);

  // If resolvedDocumentTypeKey is already provided by orchestrator translation, use it;
  // otherwise fallback to rawSelectedDocType and nameToKeyMap translation if provided
  const rawSelectedDocType =
    resolveDocumentType({
      formData: effectiveFormData,
      config: input.config,
      activeSpaceType: currentSpaceType,
      parameters: context.parameters,
    });

  let currentDocTypeKey =
    input.resolvedDocumentTypeKey ??
    (rawSelectedDocType ? translateDocumentType(rawSelectedDocType, input.nameToKeyMap) : undefined);

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
    spaces: input.collectionSpaces,
    documentTypes,
  };

  return {
    viewId: 'drive-document-process-card',
    documentTypeKey: currentDocTypeKey,
    selectionState,
    formData: effectiveFormData,
    isUpdateCard,
    ...(context.validationErrors && context.validationErrors.length > 0
      ? { validationErrors: context.validationErrors }
      : {}),
  };
}

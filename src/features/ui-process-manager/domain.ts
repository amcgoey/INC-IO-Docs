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

export interface ProcessUiStateConfig {
  defaultDocumentType?: string | undefined;
  defaultDocumentSpaceType?: string | undefined;
}

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
 * Strips all keys from formData that do not belong to the selection state
 * (keys not starting with 'SelectDocument').
 */
export function retainSelectionState(
  formData?: Record<string, unknown>
): Record<string, unknown> {
  return filterFormData(formData, (key) => key.startsWith('SelectDocument'));
}

/**
 * Extracts data fields from formData by stripping selection state keys
 * (keys starting with 'SelectDocument').
 */
export function extractDocumentData(
  formData?: Record<string, unknown>
): Record<string, unknown> {
  return filterFormData(formData, (key) => !key.startsWith('SelectDocument'));
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
 * Resolves the active space type from form data or configuration fallback.
 */
export function resolveSpaceType(
  formData?: Record<string, unknown>,
  config?: ProcessUiStateConfig
): string {
  return (
    (formData?.SelectDocumentSpaceType as string | undefined) ??
    config?.defaultDocumentSpaceType ??
    'projects'
  );
}

/**
 * Resolves the active document type from form data, context parameters, or configuration fallback.
 */
export function resolveDocumentType(
  formData?: Record<string, unknown>,
  config?: ProcessUiStateConfig,
  activeSpaceType?: string,
  parameters?: Record<string, string>
): string | undefined {
  if (formData?.SelectDocumentType && typeof formData.SelectDocumentType === 'string') {
    return formData.SelectDocumentType;
  }

  const spaceType = activeSpaceType ?? (formData ? resolveSpaceType(formData, config) : undefined);
  if (
    spaceType &&
    formData?.[`SelectDocumentType_${spaceType}`] &&
    typeof formData[`SelectDocumentType_${spaceType}`] === 'string'
  ) {
    return formData[`SelectDocumentType_${spaceType}`] as string;
  }

  if (formData) {
    for (const [key, value] of Object.entries(formData)) {
      if (key.startsWith('SelectDocumentType_') && typeof value === 'string') {
        return value;
      }
    }
  }

  if (parameters?.documentTypeKey) {
    return parameters.documentTypeKey;
  }

  return config?.defaultDocumentType;
}

/**
 * Pure domain state evaluation for CQRS UI Orchestration.
 * Enforces:
 * 1. UI reload (isUpdateCard) on Space Type change.
 * 2. Defaulting Document Type to first allowed type when Space Type changes.
 * 3. Clearing DocumentInfo segment of formData on Document Type or Space Type change.
 * 4. Consolidates selection state and translation into effective form data.
 */
export function evaluateProcessUiState(input: ProcessUiStateInput): ProcessUiStateOutput {
  const { context } = input;
  const action = context.actionName ?? context.parameters?.action;
  const isSpaceTypeChange = action === 'onSpaceTypeChange';
  const isDocTypeChange = action === 'onDocumentTypeChange';

  const currentSpaceType =
    input.resolvedSpaceType ?? resolveSpaceType(context.formData, input.config);

  const selectedSpaceTypeObj = input.spaceTypes.find((t) => t.id === currentSpaceType);
  const allowedDocumentTypes = selectedSpaceTypeObj?.spaceSchema.allowedDocumentTypes ?? [];

  let effectiveFormData: Record<string, unknown> = { ...(context.formData ?? {}) };
  const isUpdateCard = Boolean(context.isUpdateCard || isSpaceTypeChange || isDocTypeChange);

  // If resolvedDocumentTypeKey is already provided by orchestrator translation, use it;
  // otherwise fallback to rawSelectedDocType and nameToKeyMap translation if provided
  const rawSelectedDocType =
    resolveDocumentType(effectiveFormData, input.config, currentSpaceType, context.parameters);

  let currentDocTypeKey =
    input.resolvedDocumentTypeKey ??
    (rawSelectedDocType ? translateDocumentType(rawSelectedDocType, input.nameToKeyMap) : undefined);

  if (isSpaceTypeChange && allowedDocumentTypes.length > 0) {
    currentDocTypeKey = allowedDocumentTypes[0];
  }

  if (isSpaceTypeChange || isDocTypeChange) {
    effectiveFormData = retainSelectionState(effectiveFormData);
    effectiveFormData.SelectDocumentSpaceType = currentSpaceType;
  }

  // If still unassigned or invalid, fallback to first allowed or default
  if (!currentDocTypeKey || (allowedDocumentTypes.length > 0 && !allowedDocumentTypes.includes(currentDocTypeKey))) {
    currentDocTypeKey = allowedDocumentTypes[0] ?? input.config?.defaultDocumentType ?? '';
  }

  if (currentDocTypeKey) {
    effectiveFormData.SelectDocumentType = currentDocTypeKey;
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

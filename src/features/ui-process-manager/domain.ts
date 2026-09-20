import type {
  UiSelectionState,
  UiSelectionItem,
  UiProcessSpaceType,
} from './ports';

export interface ProcessUiStateConfig {
  defaultDocumentType?: string | undefined;
  defaultDocumentSpaceType?: string | undefined;
}

export interface ProcessUiStateInput {
  actionName?: string | undefined;
  parameters?: Record<string, string> | undefined;
  formData?: Record<string, unknown> | undefined;
  validationErrors?: string[] | undefined;
  isUpdateCard?: boolean | undefined;
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

/**
 * Strips all keys from formData that do not belong to the selection state
 * (keys not starting with 'SelectDocument').
 */
export function clearDocumentInfoSegment(
  formData?: Record<string, unknown>
): Record<string, unknown> {
  if (!formData) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(formData)) {
    if (key.startsWith('SelectDocument')) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Translates a human-readable document type display name into its canonical backend key.
 * If the input is already a backend key or no mapping is found, returns it unchanged.
 */
export function translateDocumentType(
  nameOrKey: string,
  mapping?: Record<string, string>
): string {
  if (!mapping) {
    return nameOrKey;
  }
  return mapping[nameOrKey] ?? nameOrKey;
}

/**
 * Pure domain state evaluation for CQRS UI Orchestration.
 * Enforces:
 * 1. UI reload (isUpdateCard) on Space Type change.
 * 2. Defaulting Document Type to first allowed type when Space Type changes.
 * 3. Clearing DocumentInfo segment of formData on Document Type change.
 * 4. Translating human-readable document type names into backend keys.
 */
export function evaluateProcessUiState(input: ProcessUiStateInput): ProcessUiStateOutput {
  const action = input.actionName ?? input.parameters?.action;
  const isSpaceTypeChange = action === 'onSpaceTypeChange';
  const isDocTypeChange = action === 'onDocumentTypeChange';

  const currentSpaceType =
    (input.formData?.SelectDocumentSpaceType as string | undefined) ??
    input.config?.defaultDocumentSpaceType ??
    'projects';

  const selectedSpaceTypeObj = input.spaceTypes.find((t) => t.id === currentSpaceType);
  const allowedDocumentTypes = selectedSpaceTypeObj?.spaceSchema.allowedDocumentTypes ?? [];

  let effectiveFormData: Record<string, unknown> = { ...(input.formData ?? {}) };
  const isUpdateCard = Boolean(input.isUpdateCard || isSpaceTypeChange || isDocTypeChange);

  const rawSelectedDocType =
    (effectiveFormData.SelectDocumentType as string | undefined) ??
    input.parameters?.documentTypeKey ??
    input.config?.defaultDocumentType;

  let currentDocTypeKey = rawSelectedDocType
    ? translateDocumentType(rawSelectedDocType, input.nameToKeyMap)
    : undefined;

  if (isSpaceTypeChange) {
    // When Space Type changes, default Document Type to first allowed type
    if (allowedDocumentTypes.length > 0) {
      currentDocTypeKey = allowedDocumentTypes[0];
    }
    // Form data for document info must be cleared because space/doc type changed
    effectiveFormData = clearDocumentInfoSegment(effectiveFormData);
    effectiveFormData.SelectDocumentSpaceType = currentSpaceType;
    if (currentDocTypeKey) {
      effectiveFormData.SelectDocumentType = currentDocTypeKey;
    }
  } else if (isDocTypeChange) {
    // When Document Type changes, explicitly clear DocumentInfo segment
    effectiveFormData = clearDocumentInfoSegment(effectiveFormData);
    effectiveFormData.SelectDocumentSpaceType = currentSpaceType;
    if (currentDocTypeKey) {
      effectiveFormData.SelectDocumentType = currentDocTypeKey;
    }
  } else {
    // Ensure translation is written back to formData
    if (currentDocTypeKey) {
      effectiveFormData.SelectDocumentType = currentDocTypeKey;
    }
  }

  // If still unassigned or invalid, fallback to first allowed or default
  if (!currentDocTypeKey || (allowedDocumentTypes.length > 0 && !allowedDocumentTypes.includes(currentDocTypeKey))) {
    currentDocTypeKey = allowedDocumentTypes[0] ?? input.config?.defaultDocumentType ?? 'default';
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
    ...(input.validationErrors && input.validationErrors.length > 0
      ? { validationErrors: input.validationErrors }
      : {}),
  };
}

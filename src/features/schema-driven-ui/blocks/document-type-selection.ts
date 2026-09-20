import type { UiViewSection, SelectionState, UiViewWidget } from '../domain';

export interface DocumentTypeSelectionOptions {
  sectionHeader?: string;
  onSpaceTypeChangeAction?: unknown;
  onDocumentTypeChangeAction?: unknown;
}

export function buildDocumentTypeSelectionSection(
  selectionState: SelectionState,
  options?: DocumentTypeSelectionOptions
): UiViewSection {
  const widgets: UiViewWidget[] = [];

  const spaceTypes =
    selectionState.spaceTypes.length > 0
      ? selectionState.spaceTypes
      : [{ text: 'No space types available', value: '' }];

  widgets.push({
    selectionInput: {
      name: 'SelectDocumentSpaceType',
      label: 'Document Space Type',
      type: 'DROPDOWN',
      items: spaceTypes,
      ...(options?.onSpaceTypeChangeAction !== undefined
        ? { onChangeAction: options.onSpaceTypeChangeAction }
        : {}),
    },
  });

  const spaceValue = selectionState.spaces.length > 0 ? selectionState.spaces[0] : undefined;
  widgets.push({
    textInput: {
      name: 'SelectDocumentSpace',
      label: 'Document Space',
      hintText: 'Enter document space',
      ...(spaceValue !== undefined ? { value: spaceValue } : {}),
    },
  });

  const documentTypes =
    selectionState.documentTypes.length > 0
      ? selectionState.documentTypes
      : [{ text: 'No document types available', value: '' }];

  widgets.push({
    selectionInput: {
      name: 'SelectDocumentType',
      label: 'Document Type',
      type: 'DROPDOWN',
      items: documentTypes,
      ...(options?.onDocumentTypeChangeAction !== undefined
        ? { onChangeAction: options.onDocumentTypeChangeAction }
        : {}),
    },
  });

  return {
    header: options?.sectionHeader ?? 'Document Type',
    widgets,
  };
}

import type { UiViewSection, SelectionState, UiViewWidget, SelectionItem } from '../domain';

export interface DocumentTypeSelectionOptions {
  sectionHeader?: string;
  onSpaceTypeChangeAction?: unknown;
  onDocumentTypeChangeAction?: unknown;
}

function withFallbackItems(items: SelectionItem[], fallbackText: string): SelectionItem[] {
  return items.length > 0 ? items : [{ text: fallbackText, value: '' }];
}

export function buildDocumentTypeSelectionSection(
  selectionState: SelectionState,
  options?: DocumentTypeSelectionOptions
): UiViewSection {
  const widgets: UiViewWidget[] = [];

  const spaceTypes = withFallbackItems(selectionState.spaceTypes, 'No space types available');

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

  const documentTypes = withFallbackItems(selectionState.documentTypes, 'No document types available');

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

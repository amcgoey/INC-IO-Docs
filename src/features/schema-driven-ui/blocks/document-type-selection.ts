import type { UiViewSection, SelectionState, UiViewWidget, SelectionItem } from '../domain';

export interface DocumentTypeSelectionOptions {
  sectionHeader?: string;
  onSpaceTypeChangeAction?: unknown;
  onDocumentTypeChangeAction?: unknown;
}

function buildDropdownWidget(
  name: string,
  label: string,
  items: SelectionItem[],
  onChangeAction?: unknown
): UiViewWidget {
  return {
    selectionInput: {
      name,
      label,
      type: 'DROPDOWN',
      items,
      ...(onChangeAction !== undefined ? { onChangeAction } : {}),
    },
  };
}

export function buildDocumentTypeSelectionSection(
  selectionState: SelectionState,
  options?: DocumentTypeSelectionOptions
): UiViewSection {
  const widgets: UiViewWidget[] = [];

  widgets.push(
    buildDropdownWidget(
      'SelectDocumentSpaceType',
      'Document Space Type',
      selectionState.spaceTypes,
      options?.onSpaceTypeChangeAction
    )
  );

  const spaceValue = selectionState.spaces.length > 0 ? selectionState.spaces[0] : undefined;
  widgets.push({
    textInput: {
      name: 'SelectDocumentSpace',
      label: 'Document Space',
      hintText: 'Enter document space',
      ...(spaceValue !== undefined ? { value: spaceValue } : {}),
    },
  });

  widgets.push(
    buildDropdownWidget(
      'SelectDocumentType',
      'Document Type',
      selectionState.documentTypes,
      options?.onDocumentTypeChangeAction
    )
  );

  return {
    header: options?.sectionHeader ?? 'Document Type',
    widgets,
  };
}

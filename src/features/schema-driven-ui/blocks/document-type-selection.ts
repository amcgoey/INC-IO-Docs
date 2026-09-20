import type { UiViewSection, UiViewWidget, UiViewAction } from '../domain';
import type { SelectionState, SelectionItem } from '../ports';

export interface DocumentTypeSelectionOptions {
  sectionHeader?: string | undefined;
  onSpaceTypeChangeAction?: UiViewAction | undefined;
  onDocumentTypeChangeAction?: UiViewAction | undefined;
}

function buildDropdownWidget(
  name: string,
  label: string,
  items: SelectionItem[],
  onChangeAction?: UiViewAction | undefined
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

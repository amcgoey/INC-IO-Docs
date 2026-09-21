import type { UiViewSection, UiViewWidget, UiViewAction } from '../domain';
import type { SelectionState, SelectionItem } from '../ports';
import { withOnChangeAction } from './common';

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
    selectionInput: withOnChangeAction(
      {
        name,
        label,
        type: 'DROPDOWN',
        items,
      },
      onChangeAction
    ),
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
  const spaceAutocomplete = selectionState.spaces.map((space) => ({ text: space, value: space }));
  widgets.push({
    textInput: {
      name: 'SelectDocumentSpace',
      label: 'Document Space',
      hintText: 'Enter document space',
      ...(spaceValue !== undefined ? { value: spaceValue } : {}),
      ...(spaceAutocomplete.length > 0 ? { autocomplete: spaceAutocomplete } : {}),
    },
  });

  const currentSpaceType = selectionState.spaceTypes.find((t) => t.selected)?.value ?? 'default';
  
  widgets.push(
    buildDropdownWidget(
      `SelectDocumentType_${currentSpaceType}`,
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

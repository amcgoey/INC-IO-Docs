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

export const DOCUMENT_SPACE_WIDGET_PREFIX = 'SelectDocumentSpace_';

export function getDocumentSpaceWidgetName(spaceType?: string): string {
  return `${DOCUMENT_SPACE_WIDGET_PREFIX}${spaceType ?? 'default'}`;
}

export const DOCUMENT_TYPE_WIDGET_PREFIX = 'SelectDocumentType_';

export function getDocumentTypeWidgetName(spaceType?: string): string {
  return `${DOCUMENT_TYPE_WIDGET_PREFIX}${spaceType ?? 'default'}`;
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

  const currentSpaceType = selectionState.spaceTypes.find((t) => t.selected)?.value ?? 'default';

  const spaceValue = selectionState.spaces.length > 0 ? selectionState.spaces[0] : undefined;
  const spaceAutocomplete = selectionState.spaces.map((space) => ({ text: space, value: space }));
  widgets.push({
    textInput: {
      name: getDocumentSpaceWidgetName(currentSpaceType),
      label: 'Document Space',
      hintText: 'Enter document space',
      ...(spaceValue !== undefined ? { value: spaceValue } : {}),
      ...(spaceAutocomplete.length > 0 ? { autocomplete: spaceAutocomplete } : {}),
    },
  });
  
  widgets.push(
    buildDropdownWidget(
      getDocumentTypeWidgetName(currentSpaceType),
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

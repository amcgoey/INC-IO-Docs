import type { UiViewSection, UiViewWidget, UiViewAction } from '../domain';
import type { SelectionState, SelectionItem } from '../ports';
import { withOnChangeAction } from './common';

export interface DocumentTypeSelectionOptions {
  sectionHeader?: string | undefined;
  onSpaceTypeChangeAction?: UiViewAction | undefined;
  onSpaceChangeAction?: UiViewAction | undefined;
  onDocumentTypeChangeAction?: UiViewAction | undefined;
  formData?: Record<string, unknown> | undefined;
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

export const SELECT_DOCUMENT_SPACE_KEY = 'SelectDocumentSpace';
export const DOCUMENT_SPACE_WIDGET_PREFIX = `${SELECT_DOCUMENT_SPACE_KEY}_`;

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

  const sortedSpaces = [...selectionState.spaces].sort((a, b) => a.localeCompare(b));
  const spaceAutocomplete = sortedSpaces.map((space) => ({ text: space, value: space }));
  const spaceWidgetName = getDocumentSpaceWidgetName(currentSpaceType);
  const rawWidgetValue =
    options?.formData?.[spaceWidgetName] ??
    (!options?.formData?.SelectDocumentSpaceType ||
    options.formData.SelectDocumentSpaceType === currentSpaceType
      ? options?.formData?.[SELECT_DOCUMENT_SPACE_KEY]
      : undefined);
  const widgetValue = typeof rawWidgetValue === 'string' ? rawWidgetValue : undefined;

  widgets.push({
    textInput: withOnChangeAction(
      {
        name: spaceWidgetName,
        label: 'Document Space',
        hintText: 'Enter document space',
        ...(typeof widgetValue === 'string' ? { value: widgetValue } : {}),
        ...(spaceAutocomplete.length > 0 ? { autocomplete: spaceAutocomplete } : {}),
      },
      options?.onSpaceChangeAction
    ),
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

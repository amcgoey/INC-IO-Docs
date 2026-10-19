import type { UiViewAction, UiViewSection, UiViewWidget } from '../domain';
import type { SelectionItem, SelectionState } from '../ports';

export interface FileSelectionOptions {
  sectionHeader?: string | undefined;
  collapsible?: boolean | undefined;
  emptyText?: string | undefined;
  inputName?: string | undefined;
  formData?: Record<string, unknown> | undefined;
  toggleInput?: {
    name: string;
    text: string;
    value?: string | undefined;
    onChangeAction?: UiViewAction | undefined;
  } | undefined;
}

export function buildFileSelectionSection(
  selectionState?: SelectionState | SelectionItem[],
  options?: FileSelectionOptions
): UiViewSection {
  const header = options?.sectionHeader ?? 'File Selection';
  const collapsible = options?.collapsible ?? true;
  const emptyText = options?.emptyText ?? 'No files selected.';
  const inputName = options?.inputName ?? 'SelectFiles';

  const normalized = Array.isArray(selectionState)
    ? { files: selectionState }
    : selectionState;
  const files = normalized?.files;

  const widgets: UiViewWidget[] = [];

  if (!files || files.length === 0) {
    widgets.push({
      textParagraph: {
        text: emptyText,
      },
    });
  } else {
    widgets.push({
      selectionInput: {
        name: inputName,
        type: 'CHECK_BOX',
        items: files,
      },
    });
  }

  if (options?.toggleInput) {
    widgets.push({
      selectionInput: {
        name: options.toggleInput.name,
        type: 'SWITCH',
        items: [
          {
            text: options.toggleInput.text,
            value: options.toggleInput.value ?? 'true',
            selected: Boolean(options.formData?.[options.toggleInput.name]),
          },
        ],
        ...(options.toggleInput.onChangeAction
          ? { onChangeAction: options.toggleInput.onChangeAction }
          : {}),
      },
    });
  }

  return {
    header,
    collapsible,
    widgets,
  };
}

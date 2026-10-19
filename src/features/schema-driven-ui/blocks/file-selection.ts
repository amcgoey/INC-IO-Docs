import type { UiViewSection } from '../domain';
import type { SelectionItem, SelectionState } from '../ports';

export interface FileSelectionOptions {
  sectionHeader?: string | undefined;
  collapsible?: boolean | undefined;
  emptyText?: string | undefined;
  inputName?: string | undefined;
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

  if (!files || files.length === 0) {
    return {
      header,
      collapsible,
      widgets: [
        {
          textParagraph: {
            text: emptyText,
          },
        },
      ],
    };
  }

  return {
    header,
    collapsible,
    widgets: [
      {
        selectionInput: {
          name: inputName,
          type: 'CHECK_BOX',
          items: files,
        },
      },
    ],
  };
}

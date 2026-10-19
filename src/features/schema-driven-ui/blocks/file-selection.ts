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
  fileSourceDropdown?: {
    name: string;
    label?: string | undefined;
    onChangeAction?: UiViewAction | undefined;
  } | undefined;
  urlInput?: {
    name: string;
    label: string;
    hintText: string;
    activeOnSourceValue: string;
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

  const normSelectionState = Array.isArray(selectionState)
    ? { files: selectionState, fileSources: undefined }
    : selectionState;
  const files = normSelectionState?.files;
  const fileSources = normSelectionState?.fileSources;

  const widgets: UiViewWidget[] = [];

  if (options?.fileSourceDropdown && fileSources && fileSources.length > 0) {
    widgets.push({
      selectionInput: {
        name: options.fileSourceDropdown.name,
        ...(options.fileSourceDropdown.label !== undefined
          ? { label: options.fileSourceDropdown.label }
          : {}),
        type: 'DROPDOWN',
        items: fileSources,
        ...(options.fileSourceDropdown.onChangeAction
          ? { onChangeAction: options.fileSourceDropdown.onChangeAction }
          : {}),
      },
    });
  }

  const isUrlActive = Boolean(
    options?.urlInput &&
      options?.fileSourceDropdown &&
      options.formData?.[options.fileSourceDropdown.name] === options.urlInput.activeOnSourceValue
  );

  if (isUrlActive) {
    widgets.push({
      textInput: {
        name: options!.urlInput!.name,
        label: options!.urlInput!.label,
        hintText: options!.urlInput!.hintText,
        value: (options?.formData?.[options!.urlInput!.name] as string) ?? '',
      },
    });
  } else {
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

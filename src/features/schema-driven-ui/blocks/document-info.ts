import type {
  UiViewSection,
  UiSchema,
  UiViewWidget,
  UiField,
  UiViewAction,
} from '../domain';
import type {
  AbstractDataSchema,
  AbstractDataField,
  StandardWidgetCustomProps,
  SelectionItem,
} from '../ports';

export interface DocumentInfoOptions {
  sectionHeader?: string | undefined;
  formData?: Record<string, unknown> | undefined;
  hiddenFields?: string[] | undefined;
  onProcessAction?: UiViewAction | string | undefined;
  documentTypeKey?: string | undefined;
}

export function getDocumentInfoWidgetName(fieldKey: string, documentTypeKey?: string): string {
  return documentTypeKey ? `${fieldKey}_${documentTypeKey}` : fieldKey;
}

export function camelCaseToTitleCase(str: string): string {
  return str
    .replace(/([A-Z]+)/g, ' $1')
    .replace(/([0-9]+)/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
    .replace(/\s+/g, ' ');
}

export function inferDefaultWidget(field: AbstractDataField): 'textInput' | 'selectionInput' {
  if ((field.options !== undefined && field.options !== null) || field.type === 'boolean') {
    return 'selectionInput';
  }
  return 'textInput';
}

import { withOnChangeAction } from './common';

interface WidgetBuilderContext {
  field: AbstractDataField;
  label: string;
  widgetName: string;
  uiField: UiField | undefined;
  customProps: StandardWidgetCustomProps;
  onChangeAction: UiViewAction | undefined;
  formValue: unknown | undefined;
  dataSchema?: AbstractDataSchema | undefined;
}

type WidgetBuilder = (ctx: WidgetBuilderContext) => UiViewWidget;

export function extractSelectionItems(
  field: AbstractDataField,
  customProps: StandardWidgetCustomProps,
  dataSchema?: AbstractDataSchema | undefined
): SelectionItem[] {
  let defaultItems: SelectionItem[] = [];
  if (Array.isArray(field.options)) {
    defaultItems = field.options.map((opt) => {
      if (typeof opt === 'string') {
        return { text: opt, value: opt };
      }
      if (typeof opt === 'object' && opt !== null && 'value' in opt) {
        const typedOpt = opt as { text?: unknown; value: unknown };
        return {
          text: String(typedOpt.text ?? typedOpt.value),
          value: String(typedOpt.value),
        };
      }
      return { text: String(opt), value: String(opt) };
    });
  } else if (
    field.options &&
    typeof field.options === 'object' &&
    'source' in field.options &&
    dataSchema?.options
  ) {
    const sourceKey = (field.options as { source: string }).source;
    const rawTuples = dataSchema.options[sourceKey];
    if (Array.isArray(rawTuples)) {
      defaultItems = rawTuples.map((tuple) => {
        if (typeof tuple === 'object' && tuple !== null) {
          const t = tuple as { key?: unknown; name?: unknown; text?: unknown; value?: unknown };
          const text = String(t.name ?? t.text ?? t.key ?? t.value);
          const value = String(t.key ?? t.value ?? t.name ?? t.text);
          return { text, value };
        }
        return { text: String(tuple), value: String(tuple) };
      });
    }
  }

  return customProps.items ?? defaultItems;
}

const widgetBuilders: Record<string, WidgetBuilder> = {
  selectionInput: ({ field, label, widgetName, customProps, onChangeAction, formValue, dataSchema }) => {
    const baseItems = extractSelectionItems(field, customProps, dataSchema);
    const resolvedValue = formValue !== undefined ? formValue : field.defaultValue;
    const items =
      resolvedValue !== undefined
        ? baseItems.map((item) => ({
            ...item,
            selected: String(item.value) === String(resolvedValue),
          }))
        : baseItems;

    return {
      selectionInput: withOnChangeAction(
        {
          name: widgetName,
          label,
          type: customProps.type ?? 'DROPDOWN',
          items,
        },
        onChangeAction
      ),
    };
  },
  textInput: ({ field, label, widgetName, customProps, onChangeAction, formValue, dataSchema }) => {
    const hintText = customProps.placeholder ?? customProps.hintText;
    const value =
      formValue !== undefined
        ? String(formValue)
        : field.defaultValue !== undefined
          ? String(field.defaultValue)
          : customProps.value;

    const autocompleteItems = extractSelectionItems(field, customProps, dataSchema);

    return {
      textInput: withOnChangeAction(
        {
          name: widgetName,
          label,
          ...(hintText !== undefined ? { hintText } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(autocompleteItems.length > 0 ? { autocomplete: autocompleteItems } : {}),
        },
        onChangeAction
      ),
    };
  },
};

export function buildDocumentInfoSection(
  dataSchema: AbstractDataSchema,
  uiSchema?: UiSchema | undefined,
  options?: DocumentInfoOptions | undefined
): UiViewSection {
  const widgets: UiViewWidget[] = [];
  const rawLayout =
    uiSchema?.layout && uiSchema.layout.length > 0
      ? uiSchema.layout
      : dataSchema.fields.map((f) => f.key);

  const hiddenSet = new Set(options?.hiddenFields ?? []);
  const layout = rawLayout.filter((key) => !hiddenSet.has(key));

  const fieldMap = new Map<string, AbstractDataField>();
  for (const field of dataSchema.fields) {
    fieldMap.set(field.key, field);
  }

  for (const fieldKey of layout) {
    const field = fieldMap.get(fieldKey);
    if (!field) {
      continue;
    }

    const uiField = uiSchema?.fields?.[fieldKey];
    const label = uiField?.label ?? camelCaseToTitleCase(field.key);
    const widgetType = uiField?.widget ?? inferDefaultWidget(field);
    const customProps = (uiField?.props as StandardWidgetCustomProps | undefined) ?? {};

    const onChangeAction: UiViewAction | undefined =
      typeof uiField?.onChange === 'string'
        ? { action: uiField.onChange }
        : uiField?.onChange === true
          ? { action: 'onFormChange' }
          : undefined;

    const widgetName = getDocumentInfoWidgetName(field.key, options?.documentTypeKey);
    const formValue =
      (options?.documentTypeKey ? options?.formData?.[widgetName] : undefined) ??
      options?.formData?.[field.key];

    const builder = widgetBuilders[widgetType] ?? widgetBuilders.textInput;
    widgets.push(
      builder({
        field,
        label,
        widgetName,
        uiField,
        customProps,
        onChangeAction,
        formValue,
        dataSchema,
      })
    );
  }

  if (options?.onProcessAction !== undefined) {
    const processAction: UiViewAction =
      typeof options.onProcessAction === 'string'
        ? { action: options.onProcessAction }
        : options.onProcessAction;
    widgets.push({
      buttonList: {
        buttons: [
          {
            text: 'Process Document',
            onClick: processAction,
          },
        ],
      },
    });
  }

  const section: UiViewSection = { widgets };
  if (options?.sectionHeader) {
    section.header = options.sectionHeader;
  }
  return section;
}

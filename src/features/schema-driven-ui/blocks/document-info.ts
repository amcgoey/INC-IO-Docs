import type {
  UiViewSection,
  UiSchema,
  UiViewWidget,
  UiField,
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

interface WidgetBuilderContext {
  field: AbstractDataField;
  label: string;
  uiField: UiField | undefined;
  customProps: StandardWidgetCustomProps;
  onChangeAction: unknown | undefined;
  formValue: unknown | undefined;
  dataSchema?: AbstractDataSchema | undefined;
}

type WidgetBuilder = (ctx: WidgetBuilderContext) => UiViewWidget;

const widgetBuilders: Record<string, WidgetBuilder> = {
  selectionInput: ({ field, label, customProps, onChangeAction, formValue, dataSchema }) => {
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

    const baseItems = customProps.items ?? defaultItems;
    const items =
      formValue !== undefined
        ? baseItems.map((item) => ({
            ...item,
            selected: String(item.value) === String(formValue),
          }))
        : baseItems;

    return {
      selectionInput: {
        name: field.key,
        label,
        type: customProps.type ?? 'DROPDOWN',
        items,
        ...(onChangeAction ? { onChangeAction } : {}),
      },
    };
  },
  textInput: ({ field, label, customProps, onChangeAction, formValue }) => {
    const hintText = customProps.placeholder ?? customProps.hintText;
    const value =
      formValue !== undefined
        ? String(formValue)
        : field.defaultValue !== undefined
          ? String(field.defaultValue)
          : customProps.value;

    return {
      textInput: {
        name: field.key,
        label,
        ...(hintText !== undefined ? { hintText } : {}),
        ...(value !== undefined ? { value } : {}),
        ...(onChangeAction ? { onChangeAction } : {}),
      },
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

    const onChangeAction =
      typeof uiField?.onChange === 'string'
        ? { action: uiField.onChange }
        : uiField?.onChange === true
          ? { action: 'onFormChange' }
          : undefined;

    const builder = widgetBuilders[widgetType] ?? widgetBuilders.textInput;
    widgets.push(
      builder({
        field,
        label,
        uiField,
        customProps,
        onChangeAction,
        formValue: options?.formData?.[field.key],
        dataSchema,
      })
    );
  }

  const section: UiViewSection = { widgets };
  if (options?.sectionHeader) {
    section.header = options.sectionHeader;
  }
  return section;
}

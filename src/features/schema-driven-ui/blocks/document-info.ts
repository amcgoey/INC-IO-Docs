import type { UiViewSection, UiSchema, UiViewWidget, SelectionItem, UiField } from '../domain';
import type { AbstractDataSchema, AbstractDataField } from './types';

export interface DocumentInfoOptions {
  sectionHeader?: string | undefined;
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
  customProps: Record<string, unknown>;
  onChangeAction: unknown | undefined;
}

type WidgetBuilder = (ctx: WidgetBuilderContext) => UiViewWidget;

const widgetBuilders: Record<string, WidgetBuilder> = {
  selectionInput: ({ field, label, customProps, onChangeAction }) => ({
    selectionInput: {
      name: field.key,
      label,
      type: typeof customProps.type === 'string' ? customProps.type : 'DROPDOWN',
      items: Array.isArray(customProps.items) ? (customProps.items as SelectionItem[]) : [],
      ...(onChangeAction ? { onChangeAction } : {}),
    },
  }),
  textInput: ({ field, label, customProps, onChangeAction }) => {
    const hintText =
      typeof customProps.placeholder === 'string'
        ? customProps.placeholder
        : typeof customProps.hintText === 'string'
          ? customProps.hintText
          : undefined;

    const value =
      field.defaultValue !== undefined
        ? String(field.defaultValue)
        : typeof customProps.value === 'string'
          ? customProps.value
          : undefined;

    return {
      textInput: {
        name: field.key,
        label,
        ...(hintText ? { hintText } : {}),
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
  const layout =
    uiSchema?.layout && uiSchema.layout.length > 0
      ? uiSchema.layout
      : dataSchema.fields.map((f) => f.key);

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
    const customProps = (uiField?.props as Record<string, unknown> | undefined) ?? {};

    const onChangeAction =
      uiField?.onChange !== undefined
        ? typeof uiField.onChange === 'string'
          ? { action: uiField.onChange }
          : { action: `${field.key}Changed` }
        : undefined;

    const builder = widgetBuilders[widgetType] ?? widgetBuilders.textInput;
    widgets.push(
      builder({
        field,
        label,
        uiField,
        customProps,
        onChangeAction,
      })
    );
  }

  const section: UiViewSection = { widgets };
  if (options?.sectionHeader) {
    section.header = options.sectionHeader;
  }
  return section;
}

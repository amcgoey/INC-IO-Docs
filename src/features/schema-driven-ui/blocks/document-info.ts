import { Type, type Static } from '@sinclair/typebox';
import {
  SelectionItemSchema,
  type UiViewSection,
  type UiSchema,
  type UiViewWidget,
  type UiField,
} from '../domain';
import type { AbstractDataSchema, AbstractDataField } from './types';

export interface DocumentInfoOptions {
  sectionHeader?: string | undefined;
}

export const StandardWidgetCustomPropsSchema = Type.Object({
  type: Type.Optional(Type.String()),
  placeholder: Type.Optional(Type.String()),
  hintText: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(SelectionItemSchema)),
});

export type StandardWidgetCustomProps = Static<typeof StandardWidgetCustomPropsSchema>;

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
}

type WidgetBuilder = (ctx: WidgetBuilderContext) => UiViewWidget;

const widgetBuilders: Record<string, WidgetBuilder> = {
  selectionInput: ({ field, label, customProps, onChangeAction }) => ({
    selectionInput: {
      name: field.key,
      label,
      type: customProps.type ?? 'DROPDOWN',
      items: customProps.items ?? [],
      ...(onChangeAction ? { onChangeAction } : {}),
    },
  }),
  textInput: ({ field, label, customProps, onChangeAction }) => {
    const hintText = customProps.placeholder ?? customProps.hintText;
    const value =
      field.defaultValue !== undefined ? String(field.defaultValue) : customProps.value;

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
    const customProps = (uiField?.props as StandardWidgetCustomProps | undefined) ?? {};

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

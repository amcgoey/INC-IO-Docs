import type { UiViewSection, UiSchema, UiViewWidget, SelectionItem } from '../domain';
import type { AbstractDataSchema, AbstractDataField } from './types';

export interface DocumentInfoOptions {
  sectionHeader?: string;
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

export function buildDocumentInfoSection(
  dataSchema: AbstractDataSchema,
  uiSchema?: UiSchema,
  options?: DocumentInfoOptions
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

    if (widgetType === 'selectionInput') {
      const items = Array.isArray(customProps.items)
        ? (customProps.items as SelectionItem[])
        : [];

      widgets.push({
        selectionInput: {
          name: field.key,
          label,
          type: typeof customProps.type === 'string' ? customProps.type : 'DROPDOWN',
          items,
          ...(onChangeAction ? { onChangeAction } : {}),
        },
      });
    } else {
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

      widgets.push({
        textInput: {
          name: field.key,
          label,
          ...(hintText ? { hintText } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(onChangeAction ? { onChangeAction } : {}),
        },
      });
    }
  }

  const section: UiViewSection = { widgets };
  if (options?.sectionHeader) {
    section.header = options.sectionHeader;
  }
  return section;
}

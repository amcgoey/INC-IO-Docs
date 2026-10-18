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
  DynamicOptionItem,
  DynamicOptionResolution,
} from '../ports';
import { normalizeDynamicOptionResolution } from '../ports';
import { DEFAULT_MESSAGE_CATALOG, formatFieldHint } from '../message-catalog';

export { normalizeDynamicOptionResolution };

export interface DocumentInfoOptions {
  sectionHeader?: string | undefined;
  formData?: Record<string, unknown> | undefined;
  hiddenFields?: string[] | undefined;
  onProcessAction?: UiViewAction | string | undefined;
  documentTypeKey?: string | undefined;
  dynamicOptions?: Record<string, DynamicOptionResolution | DynamicOptionItem[]> | undefined;
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

export function isDynamicOptionConfig(
  options: unknown
): options is { source: string; dynamicConfig: Record<string, unknown> } {
  if (!options || typeof options !== 'object') return false;
  const record = options as Record<string, unknown>;
  return (
    typeof record.source === 'string' &&
    typeof record.dynamicConfig === 'object' &&
    record.dynamicConfig !== null
  );
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
  dynamicOptions?: Record<string, DynamicOptionResolution | DynamicOptionItem[]> | undefined;
}

type WidgetBuilder = (ctx: WidgetBuilderContext) => UiViewWidget;

export function extractSelectionItems(
  field: AbstractDataField,
  customProps: StandardWidgetCustomProps,
  dataSchema?: AbstractDataSchema | undefined,
  dynamicOptions?: Record<string, DynamicOptionResolution | DynamicOptionItem[]> | undefined
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
    'source' in field.options
  ) {
    const sourceKey = (field.options as { source: string }).source;
    if (dynamicOptions && sourceKey in dynamicOptions) {
      const resolution = normalizeDynamicOptionResolution(dynamicOptions[sourceKey]);
      if (resolution) {
        if (resolution.status === 'ready') {
          defaultItems = resolution.items.map((opt) => ({
            text: opt.text,
            value: opt.value,
          }));
        } else if (isDynamicOptionConfig(field.options)) {
          const hint = formatFieldHint(DEFAULT_MESSAGE_CATALOG, resolution.status, resolution.targetPath);
          defaultItems = [{ text: hint ?? '', value: '' }];
        }
      }
    } else if (dataSchema?.options) {
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
  }

  return customProps.items ?? defaultItems;
}

const widgetBuilders: Record<string, WidgetBuilder> = {
  selectionInput: ({ field, label, widgetName, customProps, onChangeAction, formValue, dataSchema, dynamicOptions }) => {
    let baseItems: SelectionItem[];
    if (isDynamicOptionConfig(field.options)) {
      const rawRes = dynamicOptions?.[field.options.source];
      const resolution = normalizeDynamicOptionResolution(rawRes);
      if (resolution) {
        if (resolution.status === 'ready') {
          baseItems = resolution.items.map((opt) => ({ text: opt.text, value: opt.value }));
        } else {
          const hint = formatFieldHint(DEFAULT_MESSAGE_CATALOG, resolution.status, resolution.targetPath);
          baseItems = [{ text: hint ?? '', value: '' }];
        }
      } else {
        baseItems = customProps.items ?? [];
      }
    } else {
      baseItems = extractSelectionItems(field, customProps, dataSchema, dynamicOptions);
    }

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
  textInput: ({ field, label, widgetName, customProps, onChangeAction, formValue, dataSchema, dynamicOptions }) => {
    let hintText = customProps.placeholder ?? customProps.hintText;
    let autocompleteItems: SelectionItem[] = [];

    if (isDynamicOptionConfig(field.options)) {
      const rawRes = dynamicOptions?.[field.options.source];
      const resolution = normalizeDynamicOptionResolution(rawRes);
      if (resolution) {
        if (resolution.status === 'ready') {
          autocompleteItems = resolution.items.map((opt) => ({ text: opt.text, value: opt.value }));
        } else {
          hintText = formatFieldHint(DEFAULT_MESSAGE_CATALOG, resolution.status, resolution.targetPath);
          autocompleteItems = [];
        }
      }
    } else {
      autocompleteItems = extractSelectionItems(field, customProps, dataSchema, dynamicOptions);
    }

    const value =
      formValue !== undefined
        ? String(formValue)
        : field.defaultValue !== undefined
          ? String(field.defaultValue)
          : customProps.value;

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
        dynamicOptions: options?.dynamicOptions,
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

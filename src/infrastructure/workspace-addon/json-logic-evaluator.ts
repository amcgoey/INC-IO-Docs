import jsonLogic from 'json-logic-js';
import { computeEvaluationOrder } from '../validation/json-logic-graph';

export interface FormEvaluationResult {
  computedData: Record<string, unknown>;
  hiddenFields: string[];
  disabledFields: string[];
}

interface DataFieldLike {
  key: string;
  defaultValue?: unknown;
}

interface DataSchemaLike {
  fields?: DataFieldLike[] | Record<string, unknown>;
}

interface UiFieldLike {
  computeValue?: unknown;
  showIf?: unknown;
  disableIf?: unknown;
}

interface UiSchemaLike {
  layout?: string[];
  fields?: Record<string, UiFieldLike>;
  evaluationOrder?: string[];
}

/**
 * Deep module that evaluates JSON Logic expressions across form fields.
 * Computes topological execution order, applies computeValue rules in dependency sequence,
 * and checks visibility (showIf) and interactability (disableIf).
 */
export function evaluateFormChange(
  rawFormData: Record<string, unknown>,
  dataSchema?: unknown,
  uiSchema?: unknown
): FormEvaluationResult {
  const typedDataSchema = dataSchema as DataSchemaLike | undefined;
  const typedUiSchema = uiSchema as UiSchemaLike | undefined;

  const evaluationOrder = computeEvaluationOrder(
    typedDataSchema as
      | string[]
      | { fields?: Array<{ key: string }> | Record<string, unknown> }
      | Record<string, unknown>
      | undefined,
    typedUiSchema as { layout?: string[]; fields?: Record<string, unknown>; evaluationOrder?: string[] } | undefined
  );

  const computedData: Record<string, unknown> = {};

  // 1. Seed defaults from dataSchema if present
  if (typedDataSchema?.fields && Array.isArray(typedDataSchema.fields)) {
    for (const field of typedDataSchema.fields) {
      if (field.defaultValue !== undefined) {
        computedData[field.key] = field.defaultValue;
      }
    }
  }

  // 2. Overlay raw form data
  for (const [key, value] of Object.entries(rawFormData)) {
    if (value !== undefined) {
      computedData[key] = value;
    }
  }

  const hiddenFields: string[] = [];
  const disabledFields: string[] = [];

  // 3. Evaluate in topological order
  for (const fieldKey of evaluationOrder) {
    const uiField = typedUiSchema?.fields?.[fieldKey];
    if (!uiField) {
      continue;
    }

    if (uiField.computeValue !== undefined) {
      const computedValue = jsonLogic.apply(uiField.computeValue, {
        data: computedData,
      });
      computedData[fieldKey] = computedValue;
    }

    if (uiField.showIf !== undefined) {
      const isVisible = Boolean(
        jsonLogic.apply(uiField.showIf, { data: computedData })
      );
      if (!isVisible) {
        hiddenFields.push(fieldKey);
      }
    }

    if (uiField.disableIf !== undefined) {
      const isDisabled = Boolean(
        jsonLogic.apply(uiField.disableIf, { data: computedData })
      );
      if (isDisabled) {
        disabledFields.push(fieldKey);
      }
    }
  }

  return {
    computedData,
    hiddenFields,
    disabledFields,
  };
}

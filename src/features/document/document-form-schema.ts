import { Type, type Static } from '@sinclair/typebox';
import type {
  DocumentField,
  DocumentSchema,
  OptionSource,
} from './domain';
import type {
  ParsedMustacheTemplate,
  TemplateEvaluatorPort,
} from './ports';

export const DocumentFormFieldFormatSchema = Type.Literal('date');
export type DocumentFormFieldFormat = Static<typeof DocumentFormFieldFormatSchema>;

export const DocumentFormFieldBindingSchema = Type.Object(
  {
    template: Type.String({ minLength: 1 }),
    format: Type.Optional(Type.Union([DocumentFormFieldFormatSchema, Type.Undefined()])),
    valueMap: Type.Optional(
      Type.Union([
        Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 }), { minProperties: 1 }),
        Type.Undefined(),
      ])
    ),
    writable: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type DocumentFormFieldBinding = Static<typeof DocumentFormFieldBindingSchema>;

export const DocumentFormSchemaSchema = Type.Object(
  {
    fields: Type.Record(Type.String({ minLength: 1 }), DocumentFormFieldBindingSchema, { minProperties: 1 }),
  },
  { additionalProperties: false }
);
export type DocumentFormSchema = Static<typeof DocumentFormSchemaSchema>;

function collectStage1FormFieldVariables(documentSchema: DocumentSchema): string[] {
  const vars: string[] = [];
  for (const field of documentSchema.fields) {
    if (field.linkedField !== undefined) {
      continue;
    }
    vars.push(field.key);
    if (field.options) {
      const optionSource: OptionSource | undefined =
        documentSchema.optionSources?.[field.options.source];
      if (optionSource?.properties) {
        for (const prop of optionSource.properties) {
          vars.push(`${field.key}.${prop}`);
        }
      } else {
        if (field.options.key) {
          vars.push(`${field.key}.${field.options.key}`);
        }
        if (field.options.name) {
          vars.push(`${field.key}.${field.options.name}`);
        }
        const tuples = documentSchema.options?.[field.options.source] ?? [];
        for (const tuple of tuples) {
          if (tuple && typeof tuple === 'object') {
            for (const propKey of Object.keys(tuple)) {
              vars.push(`${field.key}.${propKey}`);
            }
          }
        }
      }
    }
  }
  return Array.from(new Set(vars));
}

function isValidLookupProperty(
  field: DocumentField,
  property: string,
  documentSchema: DocumentSchema
): boolean {
  if (!field.options) {
    return false;
  }
  const optionSource = documentSchema.optionSources?.[field.options.source];
  if (optionSource !== undefined) {
    if (optionSource.properties !== undefined) {
      return optionSource.properties.includes(property);
    }
    const keyProp = field.options.key ?? 'key';
    const nameProp = field.options.name ?? keyProp;
    return property === keyProp || property === nameProp;
  }
  const tuples = documentSchema.options?.[field.options.source];
  if (tuples !== undefined) {
    const keyProp = field.options.key ?? 'key';
    const nameProp = field.options.name ?? 'name';
    return (
      property === keyProp ||
      property === nameProp ||
      tuples.some((tuple) => property in tuple)
    );
  }
  return true;
}

/**
 * Validates `documentFormSchema` field bindings against Stage-1 `DocumentField`
 * definitions in `documentSchema`.
 */
export function validateDocumentFormSchema(
  documentFormSchema: DocumentFormSchema | undefined,
  documentSchema: DocumentSchema,
  evaluator: TemplateEvaluatorPort,
  errors: string[]
): void {
  if (!documentFormSchema) {
    return;
  }

  const stage1Vars = collectStage1FormFieldVariables(documentSchema);
  const fieldsByKey = new Map(documentSchema.fields.map((f) => [f.key, f]));

  for (const [formFieldName, binding] of Object.entries(documentFormSchema.fields)) {
    const prefix = `documentFormSchema.fields["${formFieldName}"]`;
    if (formFieldName.trim().length === 0) {
      errors.push(`${prefix}: form field name must be a non-empty string.`);
      continue;
    }

    if (binding.template.trim().length === 0) {
      errors.push(`${prefix}.template: must not be blank.`);
      continue;
    }

    if (!evaluator.validate(binding.template, stage1Vars)) {
      errors.push(
        `Invalid template at "${prefix}.template": references unknown fields or is malformed.`
      );
      continue;
    }

    if (!evaluator.parseMustacheTemplate) {
      continue;
    }

    let parsed;
    try {
      parsed = evaluator.parseMustacheTemplate(binding.template);
    } catch (error) {
      errors.push(
        `Invalid template at "${prefix}.template": ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }

    if (parsed.tokens.length === 0) {
      errors.push(`${prefix}.template: must reference at least one Stage-1 DocumentField token.`);
      continue;
    }

    const seenFieldKeys = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.parts.length < 1 || token.parts.length > 2) {
        errors.push(`${prefix}.template: invalid field path "${token.original}".`);
        continue;
      }
      const [fieldKey, property] = token.parts;
      if (!fieldKey || seenFieldKeys.has(fieldKey)) {
        errors.push(`${prefix}.template: duplicate or invalid field reference "${token.original}".`);
        continue;
      }
      seenFieldKeys.add(fieldKey);

      const targetField = fieldsByKey.get(fieldKey);
      if (!targetField || targetField.linkedField !== undefined) {
        errors.push(`${prefix}.template: targets unsupported field "${fieldKey}".`);
        continue;
      }

      if (property !== undefined && !isValidLookupProperty(targetField, property, documentSchema)) {
        errors.push(
          `${prefix}.template: accesses unknown property ".${property}" on field "${fieldKey}".`
        );
      }
    }

    if (parsed.tokens.length > 1) {
      if (binding.format === 'date') {
        errors.push(`${prefix}: cannot specify format: "date" on a multi-token template.`);
      }
      if (binding.valueMap !== undefined) {
        errors.push(`${prefix}: cannot specify valueMap on a multi-token template.`);
      }
    } else if (binding.valueMap !== undefined) {
      const targetField = fieldsByKey.get(parsed.tokens[0]!.parts[0]!);
      if (!targetField?.options) {
        errors.push(`${prefix}: specifies valueMap for non-LookupField.`);
      }
    }
  }
}

/**
 * Validates `INSERT_DATA` workflow activity payload, ensuring optional `fields` allowlist
 * entries reference `writable: true` bindings in `documentFormSchema`.
 */
export function validateInsertDataActivityPayload(
  payload: Record<string, unknown>,
  activityPath: string,
  documentFormSchema: DocumentFormSchema | undefined,
  errors: string[]
): void {
  if (payload['fields'] === undefined) {
    return;
  }

  const rawFields = payload['fields'];
  if (!Array.isArray(rawFields)) {
    errors.push(
      `Invalid fields at "${activityPath}.payload.fields": must be an array of form field names.`
    );
    return;
  }

  rawFields.forEach((entry, idx) => {
    const entryPath = `${activityPath}.payload.fields[${idx}]`;
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      errors.push(`Invalid field name at "${entryPath}": must be a non-empty string.`);
      return;
    }
    if (!documentFormSchema) {
      errors.push(
        `Invalid INSERT_DATA field "${entry}" at "${entryPath}": documentFormSchema is not defined.`
      );
      return;
    }
    const binding = documentFormSchema.fields[entry];
    if (!binding) {
      errors.push(
        `Invalid INSERT_DATA field "${entry}" at "${entryPath}": not declared in documentFormSchema.fields.`
      );
      return;
    }
    if (binding.writable !== true) {
      errors.push(
        `Invalid INSERT_DATA field "${entry}" at "${entryPath}": target binding in documentFormSchema must set writable: true.`
      );
    }
  });
}

/**
 * Validates `INSERT_PAGES` workflow activity payload, enforcing mutually exclusive
 * `templateKey` vs `sourceStepId`, valid `position`/`sourcePages`/`fillForm` options,
 * and `templateKey` declaration in `Manifest.configuration.templates` when provided.
 */
export function validateInsertPagesActivityPayload(
  payload: Record<string, unknown>,
  activityPath: string,
  seenStepIds: ReadonlySet<string>,
  workflowName: string,
  errors: string[],
  configuredTemplateKeys?: ReadonlySet<string>
): void {
  const rawTemplateKey = payload['templateKey'];
  const rawSourceStepId = payload['sourceStepId'];
  const hasTemplateKey = rawTemplateKey !== undefined;
  const hasSourceStepId = rawSourceStepId !== undefined;

  if (hasTemplateKey && hasSourceStepId) {
    errors.push(
      `Invalid INSERT_PAGES payload at "${activityPath}.payload": cannot specify both templateKey and sourceStepId (mutually exclusive).`
    );
  } else if (!hasTemplateKey && !hasSourceStepId) {
    errors.push(
      `Invalid INSERT_PAGES payload at "${activityPath}.payload": must specify either templateKey or sourceStepId.`
    );
  }

  if (hasTemplateKey) {
    if (typeof rawTemplateKey !== 'string' || rawTemplateKey.trim().length === 0) {
      errors.push(
        `Invalid templateKey at "${activityPath}.payload.templateKey": must be a non-empty string.`
      );
    } else if (
      configuredTemplateKeys !== undefined &&
      !rawTemplateKey.includes('{{') &&
      !configuredTemplateKeys.has(rawTemplateKey.trim())
    ) {
      errors.push(
        `Invalid templateKey "${rawTemplateKey}" at "${activityPath}.payload.templateKey": not declared in Manifest configuration.templates.`
      );
    }
  }

  if (hasSourceStepId) {
    if (typeof rawSourceStepId !== 'string' || rawSourceStepId.trim().length === 0) {
      errors.push(
        `Invalid sourceStepId at "${activityPath}.payload.sourceStepId": must be a string referencing an earlier Activity.id.`
      );
    } else if (!seenStepIds.has(rawSourceStepId)) {
      errors.push(
        `Invalid sourceStepId "${rawSourceStepId}" at "${activityPath}.payload.sourceStepId": must match an earlier Activity.id in workflow "${workflowName}".`
      );
    }
  }

  if (payload['position'] !== undefined) {
    const pos = payload['position'];
    const isValidPosition =
      pos === 'start' ||
      pos === 'end' ||
      (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0);
    if (!isValidPosition) {
      errors.push(
        `Invalid position at "${activityPath}.payload.position": expected "start", "end", or a non-negative integer.`
      );
    }
  }

  if (payload['sourcePages'] !== undefined) {
    const pages = payload['sourcePages'];
    if (!Array.isArray(pages) || pages.length === 0) {
      errors.push(
        `Invalid sourcePages at "${activityPath}.payload.sourcePages": must be a non-empty array of unique 1-indexed integers.`
      );
    } else {
      const seenPages = new Set<number>();
      for (const page of pages) {
        if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
          errors.push(
            `Invalid sourcePages at "${activityPath}.payload.sourcePages": page numbers must be integers >= 1.`
          );
          break;
        }
        if (seenPages.has(page)) {
          errors.push(
            `Invalid sourcePages at "${activityPath}.payload.sourcePages": duplicate page number ${page}.`
          );
          break;
        }
        seenPages.add(page);
      }
    }
  }

  if (payload['fillForm'] !== undefined && typeof payload['fillForm'] !== 'boolean') {
    errors.push(
      `Invalid fillForm at "${activityPath}.payload.fillForm": must be a boolean.`
    );
  }

  if (payload['onUnmodifiableTarget'] !== undefined) {
    const policy = payload['onUnmodifiableTarget'];
    if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
      errors.push(
        `Invalid onUnmodifiableTarget at "${activityPath}.payload.onUnmodifiableTarget": must be an object with strategy "error" or "createSiblingPdf".`
      );
    } else {
      const policyObj = policy as Record<string, unknown>;
      const strategy = policyObj['strategy'];
      if (strategy !== 'error' && strategy !== 'createSiblingPdf') {
        errors.push(
          `Invalid onUnmodifiableTarget.strategy at "${activityPath}.payload.onUnmodifiableTarget.strategy": expected "error" or "createSiblingPdf".`
        );
      } else if (strategy === 'createSiblingPdf') {
        const fileName = policyObj['fileName'];
        if (typeof fileName !== 'string' || fileName.trim().length === 0) {
          errors.push(
            `Invalid onUnmodifiableTarget.fileName at "${activityPath}.payload.onUnmodifiableTarget.fileName": must be a non-empty string.`
          );
        }
      }
    }
  }
}

function parseTemplateWithFallback(
  template: string,
  evaluator: TemplateEvaluatorPort
): ParsedMustacheTemplate {
  if (evaluator.parseMustacheTemplate) {
    return evaluator.parseMustacheTemplate(template);
  }
  const tokens: ParsedMustacheTemplate['tokens'] = [];
  const literals: string[] = [];
  const mustacheRegex = /\{\{([^{}]+)\}\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = mustacheRegex.exec(template)) !== null) {
    literals.push(template.slice(lastIndex, match.index));
    const expr = match[1]!.trim();
    tokens.push({ original: expr, parts: expr.split('.').map((p) => p.trim()) });
    lastIndex = mustacheRegex.lastIndex;
  }
  literals.push(template.slice(lastIndex));
  return { tokens, literals };
}

function resolveTokenValue(
  parts: readonly string[],
  data: Readonly<Record<string, unknown>>,
  fieldsByKey: ReadonlyMap<string, DocumentField>
): string {
  if (parts.length === 0) {
    return '';
  }
  let current: unknown = data;
  for (const part of parts) {
    if (current !== null && current !== undefined && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      current = undefined;
      break;
    }
  }

  if (current === undefined || current === null) {
    if (parts.length === 2) {
      const [fieldKey, prop] = parts;
      const fieldDef = fieldsByKey.get(fieldKey!);
      const keyProp = fieldDef?.options?.key ?? 'key';
      const scalar = data[fieldKey!];
      if (
        prop === keyProp &&
        (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean')
      ) {
        return String(scalar);
      }
    }
    return '';
  }

  if (typeof current === 'object') {
    const fieldDef = fieldsByKey.get(parts[0]!);
    const keyProp = fieldDef?.options?.key ?? 'key';
    const propVal = (current as Record<string, unknown>)[keyProp];
    return propVal !== undefined && propVal !== null ? String(propVal) : '';
  }

  return String(current);
}

function renderBindingTemplateCleanly(
  template: string,
  parsed: ParsedMustacheTemplate,
  data: Readonly<Record<string, unknown>>,
  fieldsByKey: ReadonlyMap<string, DocumentField>,
  evaluator: TemplateEvaluatorPort
): string {
  if (parsed.tokens.length === 0) {
    return evaluator.evaluate(template, { ...data });
  }

  const tokenValues = parsed.tokens.map((t) => resolveTokenValue(t.parts, data, fieldsByKey));
  const nonBlankIndices: number[] = [];
  tokenValues.forEach((val, idx) => {
    if (val.trim().length > 0) {
      nonBlankIndices.push(idx);
    }
  });

  if (nonBlankIndices.length === 0) {
    return '';
  }

  if (nonBlankIndices.length === parsed.tokens.length) {
    return evaluator.evaluate(template, { ...data });
  }

  const { literals } = parsed;
  let result = literals[0] ?? '';
  nonBlankIndices.forEach((idx, pos) => {
    if (pos > 0) {
      result += literals[idx] ?? '';
    }
    result += tokenValues[idx]!;
  });
  if (nonBlankIndices[nonBlankIndices.length - 1] === parsed.tokens.length - 1) {
    result += literals[parsed.tokens.length] ?? '';
  }
  return result;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCFullYear(year);
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day
  );
}

function formatWriteDateValue(rendered: string, formFieldName: string): string {
  const trimmed = rendered.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const yymmddMatch = trimmed.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (yymmddMatch) {
    const year = 2000 + parseInt(yymmddMatch[1]!, 10);
    const month = parseInt(yymmddMatch[2]!, 10);
    const day = parseInt(yymmddMatch[3]!, 10);
    if (isValidCalendarDate(year, month, day)) {
      return `${String(year).padStart(4, '0')}-${yymmddMatch[2]}-${yymmddMatch[3]}`;
    }
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]!, 10);
    const month = parseInt(isoMatch[2]!, 10);
    const day = parseInt(isoMatch[3]!, 10);
    if (isValidCalendarDate(year, month, day)) {
      return trimmed;
    }
  }

  throw new Error(
    `Invalid date value "${trimmed}" for DocumentFormSchema field "${formFieldName}" (expected yyMMdd or yyyy-MM-dd).`
  );
}

function resolveWriteValueMap(
  valueMap: Readonly<Record<string, string>>,
  fieldKey: string,
  rendered: string,
  data: Readonly<Record<string, unknown>>,
  fieldsByKey: ReadonlyMap<string, DocumentField>
): string {
  const fieldDef = fieldsByKey.get(fieldKey);
  const keyProp = fieldDef?.options?.key ?? 'key';
  const rawFieldValue = data[fieldKey];

  let canonicalKey: string | undefined;
  if (rawFieldValue !== null && typeof rawFieldValue === 'object') {
    const rawProp = (rawFieldValue as Record<string, unknown>)[keyProp];
    if (rawProp !== undefined && rawProp !== null) {
      canonicalKey = String(rawProp);
    }
  } else if (
    typeof rawFieldValue === 'string' ||
    typeof rawFieldValue === 'number' ||
    typeof rawFieldValue === 'boolean'
  ) {
    canonicalKey = String(rawFieldValue);
  }

  if (canonicalKey !== undefined && Object.prototype.hasOwnProperty.call(valueMap, canonicalKey)) {
    return valueMap[canonicalKey]!;
  }
  if (Object.prototype.hasOwnProperty.call(valueMap, rendered)) {
    return valueMap[rendered]!;
  }
  return rendered;
}

export interface EvaluateWritableDocumentFormFieldsParams {
  documentFormSchema: DocumentFormSchema | undefined;
  documentSchema: DocumentSchema;
  data: Readonly<Record<string, unknown>>;
  templateEvaluator: TemplateEvaluatorPort;
  fieldsAllowlist?: readonly string[] | undefined;
}

/**
 * Evaluates `writable: true` bindings in `documentFormSchema` for write operations
 * (`INSERT_DATA`, `INSERT_PAGES`), enforcing `valueMap` canonical key precedence,
 * `""` output for blank `format: "date"` values, and clean blank optional token formatting.
 */
export function evaluateWritableDocumentFormFields(
  params: EvaluateWritableDocumentFormFieldsParams
): Record<string, string> {
  const { documentFormSchema, documentSchema, data, templateEvaluator, fieldsAllowlist } = params;

  if (!documentFormSchema) {
    if (fieldsAllowlist && fieldsAllowlist.length > 0) {
      throw new Error(
        `INSERT_DATA fields [${fieldsAllowlist.join(', ')}] require documentFormSchema to be configured.`
      );
    }
    return {};
  }

  const fieldsByKey = new Map(documentSchema.fields.map((f) => [f.key, f]));
  const selectedEntries: Array<[string, DocumentFormFieldBinding]> = [];

  if (fieldsAllowlist !== undefined) {
    for (const fieldName of fieldsAllowlist) {
      const binding = documentFormSchema.fields[fieldName];
      if (!binding) {
        throw new Error(
          `INSERT_DATA field "${fieldName}" is not declared in documentFormSchema.fields.`
        );
      }
      if (binding.writable !== true) {
        throw new Error(
          `INSERT_DATA field "${fieldName}" is read-only and cannot be written without writable: true.`
        );
      }
      selectedEntries.push([fieldName, binding]);
    }
  } else {
    for (const [fieldName, binding] of Object.entries(documentFormSchema.fields)) {
      if (binding.writable === true) {
        selectedEntries.push([fieldName, binding]);
      }
    }
  }

  const result: Record<string, string> = {};
  for (const [formFieldName, binding] of selectedEntries) {
    const parsed = parseTemplateWithFallback(binding.template, templateEvaluator);
    const rendered = renderBindingTemplateCleanly(
      binding.template,
      parsed,
      data,
      fieldsByKey,
      templateEvaluator
    );

    if (binding.format === 'date') {
      result[formFieldName] = formatWriteDateValue(rendered, formFieldName);
    } else if (binding.valueMap !== undefined && parsed.tokens.length === 1) {
      const singleFieldKey = parsed.tokens[0]!.parts[0]!;
      result[formFieldName] = resolveWriteValueMap(
        binding.valueMap,
        singleFieldKey,
        rendered,
        data,
        fieldsByKey
      );
    } else {
      result[formFieldName] = rendered;
    }
  }

  return result;
}

/**
 * Returns true if the evaluated writable form map contains at least one non-empty value.
 */
export function hasNonEmptyWritableFormData(
  evaluatedFormData: Readonly<Record<string, string>>
): boolean {
  return Object.values(evaluatedFormData).some((value) => value.length > 0);
}


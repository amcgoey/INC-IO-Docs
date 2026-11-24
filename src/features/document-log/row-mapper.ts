import {
  DocumentLogConfigurationError,
  type DocumentLogDocument,
  type DocumentLogSchema,
  type LogCellInput,
  type LogFormulaCell,
  type LogRowKey,
  type LogRowValues,
  type LogTargetDocumentField,
  type LogTargetDocumentOptionTuple,
  type LogTargetDocumentSchema,
  type LogTemplateEvaluatorPort,
} from './ports';

function escapeSheetsFormulaLiteral(value: string): string {
  return value.replace(/"/g, '""');
}

/**
 * Formats an `http://` or `https://` URI as an explicit Sheets `=HYPERLINK(...)` formula cell,
 * returning `null` for absent, blank, or non-HTTP(S) values.
 */
export function formatFileLinkFormula(
  fileUri: string | undefined,
  label = 'Link'
): LogFormulaCell | null {
  if (typeof fileUri !== 'string') {
    return null;
  }
  const trimmed = fileUri.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) {
    return null;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return null;
  }

  return {
    formula: `=HYPERLINK("${escapeSheetsFormulaLiteral(trimmed)}", "${escapeSheetsFormulaLiteral(label)}")`,
  };
}

/**
 * Enriches raw string `LookupField` values into option tuples using `targetSchema` metadata,
 * preserving already-enriched tuples when called after `DocumentService`.
 */
export function enrichDocumentData(
  data: Readonly<Record<string, unknown>>,
  targetSchema: LogTargetDocumentSchema
): Record<string, unknown> {
  const enriched: Record<string, unknown> = {};
  const schemaFieldKeys = new Set(targetSchema.fields.map((f) => f.key));

  for (const [key, value] of Object.entries(data)) {
    if (schemaFieldKeys.has(key)) {
      enriched[key] = value;
    }
  }

  for (const field of targetSchema.fields) {
    if (!field.options) {
      continue;
    }

    const rawValue = data[field.key];
    const keyProp = field.options.key;
    const nameProp = field.options.name ?? keyProp;

    if (typeof rawValue === 'string') {
      if (!field.required && rawValue === '') {
        delete enriched[field.key];
        continue;
      }
      const optionTuples = targetSchema.options?.[field.options.source] ?? [];
      const matchedTuple = optionTuples.find(
        (tuple) =>
          tuple[keyProp] === rawValue ||
          (nameProp !== undefined && tuple[nameProp] === rawValue)
      );
      if (matchedTuple) {
        enriched[field.key] = { ...matchedTuple };
      } else if (field.options.allowUserInput) {
        const fallback: Record<string, unknown> = {
          [keyProp]: rawValue,
        };
        if (field.options.name) {
          fallback[field.options.name] = rawValue;
        }
        enriched[field.key] = fallback;
      }
    } else if (rawValue !== null && typeof rawValue === 'object') {
      enriched[field.key] = { ...(rawValue as Record<string, unknown>) };
    }
  }

  return enriched;
}

export interface MapDocumentToLogRowParams {
  document: DocumentLogDocument;
  logSchema: DocumentLogSchema;
  targetSchema: LogTargetDocumentSchema;
  templateEvaluator: LogTemplateEvaluatorPort;
  fileUri?: string | undefined;
  enrichedData?: Readonly<Record<string, unknown>> | undefined;
}

export interface MappedLogRow {
  rowData: Record<string, LogCellInput>;
  readOnlyColumns: string[];
}

/**
 * Dehydrates a `DocumentLogDocument` and optional `fileUri` into sheet column cell inputs,
 * skipping `readOnly` bindings, mapping blank strings to `null`, and preserving user text as literal strings.
 */
export function mapDocumentToLogRow(params: MapDocumentToLogRowParams): MappedLogRow {
  const { document, logSchema, targetSchema, templateEvaluator, fileUri } = params;
  const enrichedData = params.enrichedData ?? enrichDocumentData(document.data, targetSchema);
  const rowData: Record<string, LogCellInput> = {};
  const readOnlyColumns: string[] = [];

  for (const [header, binding] of Object.entries(logSchema.columns)) {
    if ('template' in binding) {
      if (binding.readOnly === true) {
        readOnlyColumns.push(header);
        continue;
      }
      const evaluated = templateEvaluator.evaluate(binding.template, enrichedData);
      rowData[header] = evaluated === '' ? null : evaluated;
    } else {
      rowData[header] = formatFileLinkFormula(fileUri, binding.label ?? 'Link');
    }
  }

  return { rowData, readOnlyColumns };
}

const SINGLE_TOKEN_REGEX = /^\s*\{\{\s*([^{}\s#>/!&]+)\s*\}\}\s*$/;
const TEMPLATE_TOKEN_GLOBAL_REGEX = /\{\{\s*([^{}\s#>/!&]+)\s*\}\}/g;

interface ParsedSingleToken {
  fieldKey: string;
  property?: string | undefined;
}

interface ColumnReverseMapping {
  header: string;
  fieldKey: string;
  property?: string | undefined;
  field?: LogTargetDocumentField | undefined;
}

function parseSingleTokenTemplate(template: string): ParsedSingleToken | null {
  const match = SINGLE_TOKEN_REGEX.exec(template);
  if (!match) {
    return null;
  }
  const parts = match[1].split('.');
  if (parts.some((p) => p.length === 0) || parts.length < 1 || parts.length > 2) {
    return null;
  }
  return {
    fieldKey: parts[0],
    ...(parts[1] !== undefined ? { property: parts[1] } : {}),
  };
}

function extractTemplateFieldTokens(template: string): string[][] {
  const tokens: string[][] = [];
  for (const match of template.matchAll(TEMPLATE_TOKEN_GLOBAL_REGEX)) {
    const parts = match[1].split('.').filter((p) => p.length > 0);
    if (parts.length > 0) {
      tokens.push(parts);
    }
  }
  return tokens;
}

function isTokenPresent(data: Readonly<Record<string, unknown>>, parts: readonly string[]): boolean {
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return false;
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === 'string') {
    return current.trim().length > 0;
  }
  return typeof current === 'number' || typeof current === 'boolean';
}

function matchOptionTupleCaseInsensitive(
  tuples: readonly LogTargetDocumentOptionTuple[],
  prop: string,
  normalizedTarget: string
): LogTargetDocumentOptionTuple | undefined {
  return tuples.find((tuple) => {
    const val = tuple[prop];
    return (
      (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') &&
      String(val).trim().toLowerCase() === normalizedTarget
    );
  });
}

function resolveGroupingTemplates(
  logSchema: DocumentLogSchema,
  targetSchema: LogTargetDocumentSchema
): {
  groupByTemplate: string;
  sortByTemplate: string;
  groupByTokens: string[][];
} {
  const groupByTemplate = targetSchema.identity?.[logSchema.grouping.groupBy];
  if (typeof groupByTemplate !== 'string' || groupByTemplate.trim().length === 0) {
    throw new DocumentLogConfigurationError(
      `grouping.groupBy "${logSchema.grouping.groupBy}" is missing from target DocumentSchema identity.`
    );
  }
  const sortByTemplate = targetSchema.identity?.[logSchema.grouping.sortBy];
  if (typeof sortByTemplate !== 'string' || sortByTemplate.trim().length === 0) {
    throw new DocumentLogConfigurationError(
      `grouping.sortBy "${logSchema.grouping.sortBy}" is missing from target DocumentSchema identity.`
    );
  }
  return {
    groupByTemplate,
    sortByTemplate,
    groupByTokens: extractTemplateFieldTokens(groupByTemplate),
  };
}

function evaluateRowKeysFromData(params: {
  data: Readonly<Record<string, unknown>>;
  groupByTemplate: string;
  sortByTemplate: string;
  groupByTokens: readonly string[][];
  templateEvaluator: LogTemplateEvaluatorPort;
}): LogRowKey | null {
  const { data, groupByTemplate, sortByTemplate, groupByTokens, templateEvaluator } = params;
  if (
    groupByTokens.length > 0 &&
    groupByTokens.every((parts) => !isTokenPresent(data, parts))
  ) {
    return null;
  }

  const evalContext = data as Record<string, unknown>;
  const groupKey = templateEvaluator.evaluate(groupByTemplate, evalContext);
  if (groupKey.trim().length === 0) {
    return null;
  }
  const sortKey = templateEvaluator.evaluate(sortByTemplate, evalContext);
  return { groupKey, sortKey };
}

export interface BuildRowKeyExtractorParams {
  logSchema: DocumentLogSchema;
  targetSchema: LogTargetDocumentSchema;
  templateEvaluator: LogTemplateEvaluatorPort;
}

/**
 * Builds a row-key extraction callback that reverse-maps sheet cells through single-token
 * `documentLogSchema.columns` bindings (with case-insensitive `LookupField` option resolution)
 * and evaluates `grouping.groupBy` / `grouping.sortBy` `Identity` templates in-app.
 * Returns `null` when all `DocumentField` tokens referenced by `grouping.groupBy` are blank.
 */
export function buildRowKeyExtractor(
  params: BuildRowKeyExtractorParams
): (row: LogRowValues) => LogRowKey | null {
  const { logSchema, targetSchema, templateEvaluator } = params;
  const { groupByTemplate, sortByTemplate, groupByTokens } = resolveGroupingTemplates(
    logSchema,
    targetSchema
  );

  const fieldsByKey = new Map<string, LogTargetDocumentField>();
  for (const field of targetSchema.fields) {
    fieldsByKey.set(field.key, field);
  }

  const mappings: ColumnReverseMapping[] = [];
  for (const [header, binding] of Object.entries(logSchema.columns)) {
    if (!('template' in binding)) {
      continue;
    }
    const parsed = parseSingleTokenTemplate(binding.template);
    if (!parsed) {
      continue;
    }
    mappings.push({
      header,
      fieldKey: parsed.fieldKey,
      ...(parsed.property !== undefined ? { property: parsed.property } : {}),
      field: fieldsByKey.get(parsed.fieldKey),
    });
  }

  return (row: LogRowValues): LogRowKey | null => {
    const reconstructed: Record<string, unknown> = {};
    const matchedLookupFields = new Set<string>();

    for (const mapping of mappings) {
      const rawCell = row[mapping.header];
      if (rawCell === null || rawCell === undefined) {
        continue;
      }
      const rawStr = typeof rawCell === 'string' ? rawCell : String(rawCell);
      const trimmedStr = rawStr.trim();
      if (trimmedStr.length === 0) {
        continue;
      }

      if (mapping.field?.options) {
        const optionTuples = targetSchema.options?.[mapping.field.options.source] ?? [];
        const keyProp = mapping.field.options.key;
        const nameProp = mapping.field.options.name;
        const normalizedTarget = trimmedStr.toLowerCase();

        const matchedTuple =
          (mapping.property !== undefined
            ? matchOptionTupleCaseInsensitive(optionTuples, mapping.property, normalizedTarget)
            : undefined) ??
          matchOptionTupleCaseInsensitive(optionTuples, keyProp, normalizedTarget) ??
          (nameProp !== undefined
            ? matchOptionTupleCaseInsensitive(optionTuples, nameProp, normalizedTarget)
            : undefined);

        if (matchedTuple) {
          reconstructed[mapping.fieldKey] = { ...matchedTuple };
          matchedLookupFields.add(mapping.fieldKey);
        } else if (
          mapping.field.options.allowUserInput &&
          !matchedLookupFields.has(mapping.fieldKey)
        ) {
          const existing = reconstructed[mapping.fieldKey];
          const fallback: Record<string, unknown> =
            existing && typeof existing === 'object'
              ? { ...(existing as Record<string, unknown>) }
              : {
                  [keyProp]: trimmedStr,
                  ...(nameProp ? { [nameProp]: trimmedStr } : {}),
                };
          if (mapping.property !== undefined) {
            fallback[mapping.property] = trimmedStr;
          }
          reconstructed[mapping.fieldKey] = fallback;
        }
      } else if (reconstructed[mapping.fieldKey] === undefined) {
        reconstructed[mapping.fieldKey] = trimmedStr;
      }
    }

    return evaluateRowKeysFromData({
      data: reconstructed,
      groupByTemplate,
      sortByTemplate,
      groupByTokens,
      templateEvaluator,
    });
  };
}

export interface ComputeTargetRowKeysParams {
  document: DocumentLogDocument;
  logSchema: DocumentLogSchema;
  targetSchema: LogTargetDocumentSchema;
  templateEvaluator: LogTemplateEvaluatorPort;
  enrichedData?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Evaluates `grouping.groupBy` and `grouping.sortBy` `Identity` templates from enriched `Document.data`.
 * Returns `null` when all tokens referenced by `grouping.groupBy` are blank/missing.
 */
export function computeTargetRowKeys(params: ComputeTargetRowKeysParams): LogRowKey | null {
  const { document, logSchema, targetSchema, templateEvaluator } = params;
  const { groupByTemplate, sortByTemplate, groupByTokens } = resolveGroupingTemplates(
    logSchema,
    targetSchema
  );
  const enrichedData = params.enrichedData ?? enrichDocumentData(document.data, targetSchema);
  return evaluateRowKeysFromData({
    data: enrichedData,
    groupByTemplate,
    sortByTemplate,
    groupByTokens,
    templateEvaluator,
  });
}

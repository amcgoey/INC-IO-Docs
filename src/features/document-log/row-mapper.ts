import {
  DocumentLogConfigurationError,
  type DocumentLogDocument,
  type DocumentLogEntry,
  type DocumentLogSchema,
  type DocumentLogUiHistoryEntry,
  type LogCellInput,
  type LogFormulaCell,
  type LogParsedMustacheTemplate,
  type LogRowKey,
  type LogRowValues,
  type LogTargetDocumentField,
  type LogTargetDocumentOptionTuple,
  type LogTargetDocumentSchema,
  type LogTemplateEvaluatorPort,
  type LogTemplateParserPort,
  type ReadLogRow,
  type RowHydrationWarning,
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
  targetSchema: LogTargetDocumentSchema,
  dynamicOptions?: Readonly<Record<string, readonly LogTargetDocumentOptionTuple[]>>
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
      const optionTuples =
        dynamicOptions?.[field.options.source] ??
        targetSchema.options?.[field.options.source] ??
        [];
      const exactTuple = optionTuples.find(
        (tuple) =>
          tuple[keyProp] === rawValue ||
          (nameProp !== undefined && tuple[nameProp] === rawValue)
      );
      const normalizedTarget = rawValue.trim().toLowerCase();
      const matchedTuple =
        exactTuple ??
        matchOptionTupleCaseInsensitive(optionTuples, keyProp, normalizedTarget) ??
        (nameProp !== undefined
          ? matchOptionTupleCaseInsensitive(optionTuples, nameProp, normalizedTarget)
          : undefined);
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
  dynamicOptions?: Readonly<Record<string, readonly LogTargetDocumentOptionTuple[]>> | undefined;
}

interface ReconstructedRowFields {
  data: Record<string, unknown>;
  invalidLookupValues: Map<string, string>;
  rawStrings: Map<string, string>;
}

function collectColumnReverseMappings(
  logSchema: DocumentLogSchema,
  targetSchema: LogTargetDocumentSchema
): { mappings: ColumnReverseMapping[]; fileLinkHeaders: string[] } {
  const fieldsByKey = new Map<string, LogTargetDocumentField>();
  for (const field of targetSchema.fields) {
    fieldsByKey.set(field.key, field);
  }

  const mappings: ColumnReverseMapping[] = [];
  const fileLinkHeaders: string[] = [];

  for (const [header, binding] of Object.entries(logSchema.columns)) {
    if (!('template' in binding)) {
      if (binding.source === 'fileLink') {
        fileLinkHeaders.push(header);
      }
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

  return { mappings, fileLinkHeaders };
}

function reconstructFieldsFromRow(
  row: LogRowValues,
  mappings: readonly ColumnReverseMapping[],
  targetSchema: LogTargetDocumentSchema,
  options: {
    synthesizeInvalidLookupFallback: boolean;
    dynamicOptions?: Readonly<Record<string, readonly LogTargetDocumentOptionTuple[]>> | undefined;
  }
): ReconstructedRowFields {
  const data: Record<string, unknown> = {};
  const matchedLookupFields = new Set<string>();
  const invalidLookupValues = new Map<string, string>();
  const rawStrings = new Map<string, string>();

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
      const optionTuples =
        options.dynamicOptions?.[mapping.field.options.source] ??
        targetSchema.options?.[mapping.field.options.source] ??
        [];
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
        data[mapping.fieldKey] = { ...matchedTuple };
        matchedLookupFields.add(mapping.fieldKey);
        invalidLookupValues.delete(mapping.fieldKey);
        rawStrings.set(mapping.fieldKey, trimmedStr);
      } else if (!matchedLookupFields.has(mapping.fieldKey)) {
        const isDynamicOrUserInput =
          Boolean(mapping.field.options.allowUserInput) ||
          targetSchema.optionSources?.[mapping.field.options.source] !== undefined;

        if (isDynamicOrUserInput) {
          const existing = data[mapping.fieldKey];
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
          data[mapping.fieldKey] = fallback;
          rawStrings.set(mapping.fieldKey, trimmedStr);
        } else {
          invalidLookupValues.set(mapping.fieldKey, trimmedStr);
          rawStrings.set(mapping.fieldKey, trimmedStr);
          if (options.synthesizeInvalidLookupFallback) {
            data[mapping.fieldKey] = {
              [keyProp]: trimmedStr,
              ...(nameProp ? { [nameProp]: trimmedStr } : {}),
            };
          }
        }
      }
    } else if (data[mapping.fieldKey] === undefined) {
      data[mapping.fieldKey] = trimmedStr;
      rawStrings.set(mapping.fieldKey, trimmedStr);
    }
  }

  return { data, invalidLookupValues, rawStrings };
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
  const { logSchema, targetSchema, templateEvaluator, dynamicOptions } = params;
  const { groupByTemplate, sortByTemplate, groupByTokens } = resolveGroupingTemplates(
    logSchema,
    targetSchema
  );
  const { mappings } = collectColumnReverseMappings(logSchema, targetSchema);

  return (row: LogRowValues): LogRowKey | null => {
    const { data } = reconstructFieldsFromRow(row, mappings, targetSchema, {
      synthesizeInvalidLookupFallback: false,
      dynamicOptions,
    });

    return evaluateRowKeysFromData({
      data,
      groupByTemplate,
      sortByTemplate,
      groupByTokens,
      templateEvaluator,
    });
  };
}

export interface BuildLogRowHydratorParams {
  documentTypeKey: string;
  logSchema: DocumentLogSchema;
  targetSchema: LogTargetDocumentSchema;
  templateEvaluator: LogTemplateEvaluatorPort;
  dynamicOptions?: Readonly<Record<string, readonly LogTargetDocumentOptionTuple[]>> | undefined;
}

export interface MapLogRowToDocumentParams extends BuildLogRowHydratorParams {
  rowNumber: number;
  values: LogRowValues;
  links?: Record<string, string | null> | undefined;
}

export interface MappedHydratedLogRow {
  entry: DocumentLogEntry;
  warnings: RowHydrationWarning[];
}

const IDENTITY_KEYS = ['idGroup', 'idDocument', 'id'] as const;

function resolveRowFileUri(
  links: Readonly<Record<string, string | null>> | undefined,
  fileLinkHeaders: readonly string[]
): string | undefined {
  if (!links) {
    return undefined;
  }
  for (const header of fileLinkHeaders) {
    const link = links[header];
    if (typeof link === 'string') {
      const trimmed = link.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function compileFieldPatterns(targetSchema: LogTargetDocumentSchema): Map<string, RegExp> {
  const patterns = new Map<string, RegExp>();
  for (const field of targetSchema.fields) {
    if (field.pattern === undefined) {
      continue;
    }
    try {
      patterns.set(field.key, new RegExp(field.pattern));
    } catch (error) {
      throw new DocumentLogConfigurationError(
        `Invalid regex pattern "${field.pattern}" on field "${field.key}".`,
        { cause: error }
      );
    }
  }
  return patterns;
}

function validateHydratedRowFields(params: {
  rowNumber: number;
  targetSchema: LogTargetDocumentSchema;
  reconstructed: ReconstructedRowFields;
  compiledPatterns: ReadonlyMap<string, RegExp>;
}): { validationErrors: string[]; warnings: RowHydrationWarning[] } {
  const { rowNumber, targetSchema, reconstructed, compiledPatterns } = params;
  const { data, invalidLookupValues, rawStrings } = reconstructed;
  const validationErrors: string[] = [];
  const warnings: RowHydrationWarning[] = [];

  for (const field of targetSchema.fields) {
    const fieldLabel = field.name ?? field.key;
    const value = data[field.key];
    if (value === undefined) {
      if (field.required) {
        const message = `Field "${field.key}" (${fieldLabel}) is required.`;
        validationErrors.push(message);
        warnings.push({ rowNumber, field: field.key, message });
      }
      continue;
    }

    const reasons: string[] = [];
    const isStaticRestrictedLookup = Boolean(
      field.options &&
        targetSchema.optionSources?.[field.options.source] === undefined &&
        !field.options.allowUserInput
    );

    if (isStaticRestrictedLookup) {
      if (invalidLookupValues.has(field.key)) {
        reasons.push(
          `value "${invalidLookupValues.get(field.key)}" is not a valid option in "${field.options!.source}"`
        );
      }
    } else {
      const strVal = typeof value === 'string' ? value : (rawStrings.get(field.key) ?? '');
      if (field.minLength !== undefined && strVal.length < field.minLength) {
        reasons.push(`must have length >= ${field.minLength}`);
      }
      const regex = compiledPatterns.get(field.key);
      if (regex && !regex.test(strVal)) {
        reasons.push(`does not match pattern "${field.pattern}"`);
      }
    }

    if (reasons.length > 0) {
      const message = `Field "${field.key}" (${fieldLabel}): ${reasons.join('; ')}.`;
      validationErrors.push(message);
      warnings.push({ rowNumber, field: field.key, message });
    }
  }

  return { validationErrors, warnings };
}

/**
 * Builds a compiled row hydrator for `READ_LOG` that reverse-maps sheet rows into enriched
 * Stage-1 `DocumentLogEntry` records, evaluates in-app `Identity` templates, and emits
 * structured `RowHydrationWarning` entries without dropping invalid hand-edited rows.
 */
export function buildLogRowHydrator(
  params: BuildLogRowHydratorParams
): (row: ReadLogRow) => MappedHydratedLogRow {
  const { documentTypeKey, logSchema, targetSchema, templateEvaluator, dynamicOptions } = params;
  const { mappings, fileLinkHeaders } = collectColumnReverseMappings(logSchema, targetSchema);
  const compiledPatterns = compileFieldPatterns(targetSchema);

  const identitySpecs = IDENTITY_KEYS.flatMap((key) => {
    const template = targetSchema.identity?.[key];
    if (typeof template !== 'string' || template.trim().length === 0) {
      return [];
    }
    return [{ key, template, tokens: extractTemplateFieldTokens(template) }];
  });

  return (row: ReadLogRow): MappedHydratedLogRow => {
    const reconstructed = reconstructFieldsFromRow(row.values, mappings, targetSchema, {
      synthesizeInvalidLookupFallback: true,
      dynamicOptions,
    });
    const { data } = reconstructed;

    const { validationErrors, warnings } = validateHydratedRowFields({
      rowNumber: row.rowNumber,
      targetSchema,
      reconstructed,
      compiledPatterns,
    });

    const identityValues: Partial<Record<(typeof IDENTITY_KEYS)[number], string>> = {};
    for (const spec of identitySpecs) {
      if (
        spec.tokens.length > 0 &&
        spec.tokens.every((parts) => !isTokenPresent(data, parts))
      ) {
        continue;
      }
      const evaluated = templateEvaluator.evaluate(spec.template, data);
      if (evaluated.trim().length > 0) {
        identityValues[spec.key] = evaluated;
      }
    }

    const fileUri = resolveRowFileUri(row.links, fileLinkHeaders);
    const document: DocumentLogDocument = {
      ...(identityValues.id !== undefined ? { id: identityValues.id } : {}),
      ...(identityValues.idDocument !== undefined ? { idDocument: identityValues.idDocument } : {}),
      ...(identityValues.idGroup !== undefined ? { idGroup: identityValues.idGroup } : {}),
      type: documentTypeKey,
      data,
    };

    const entry: DocumentLogEntry = {
      document,
      valid: validationErrors.length === 0,
      ...(fileUri !== undefined ? { fileUri } : {}),
      rowNumber: row.rowNumber,
      ...(validationErrors.length > 0 ? { validationErrors } : {}),
    };

    return { entry, warnings };
  };
}

/**
 * Convenience single-row wrapper over `buildLogRowHydrator`.
 */
export function mapLogRowToDocument(params: MapLogRowToDocumentParams): MappedHydratedLogRow {
  const hydrate = buildLogRowHydrator({
    documentTypeKey: params.documentTypeKey,
    logSchema: params.logSchema,
    targetSchema: params.targetSchema,
    templateEvaluator: params.templateEvaluator,
  });
  return hydrate({
    rowNumber: params.rowNumber,
    values: params.values,
    ...(params.links !== undefined ? { links: params.links } : {}),
  });
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

/**
 * Explicit 5-character HTML escaping for Google Workspace Card HTML-parsed text fields.
 * Preserves `=` verbatim (avoiding Handlebars' `&#x3D;`).
 */
export function escapeCardHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resolveTokenString(
  data: Readonly<Record<string, unknown>>,
  parts: readonly string[]
): string {
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return '';
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === 'string') {
    return current;
  }
  if (typeof current === 'number' || typeof current === 'boolean') {
    return String(current);
  }
  return '';
}

function stitchMustacheTemplate(
  parsed: LogParsedMustacheTemplate,
  data: Readonly<Record<string, unknown>>,
  options: { escapeHtml: boolean }
): string {
  let result = parsed.literals[0] ?? '';
  for (let i = 0; i < parsed.tokens.length; i++) {
    const raw = resolveTokenString(data, parsed.tokens[i].parts);
    const interpolated = options.escapeHtml ? escapeCardHtmlText(raw) : raw;
    result += interpolated + (parsed.literals[i + 1] ?? '');
  }
  return result;
}

export interface ExtractFormIdGroupParams {
  documentTypeKey: string;
  formData?: Readonly<Record<string, unknown>> | undefined;
  targetSchema: LogTargetDocumentSchema;
  templateParser: LogTemplateParserPort;
  templateEvaluator: LogTemplateEvaluatorPort;
}

export type ExtractFormIdGroupResult =
  | { complete: true; idGroup: string }
  | { complete: false; missingIdFields: string[] };

/**
 * Resolves widget-suffixed (`${fieldKey}_${documentTypeKey}` ?? `fieldKey`) form values referenced by
 * `targetSchema.identity.idGroup`, trims each referenced value individually BEFORE calling
 * `enrichDocumentData(...)`, and returns either the evaluated `idGroup` or missing `DocumentField` labels.
 */
export function extractFormIdGroup(params: ExtractFormIdGroupParams): ExtractFormIdGroupResult {
  const { documentTypeKey, formData, targetSchema, templateParser, templateEvaluator } = params;
  const idGroupTemplate = targetSchema.identity?.idGroup;
  if (typeof idGroupTemplate !== 'string' || idGroupTemplate.trim().length === 0) {
    return { complete: false, missingIdFields: [] };
  }

  const parsed = templateParser.parseMustacheTemplate(idGroupTemplate);
  if (parsed.tokens.length === 0) {
    return { complete: false, missingIdFields: [] };
  }

  const trimmedRawData: Record<string, unknown> = {};
  const seenFieldKeys = new Set<string>();

  for (const token of parsed.tokens) {
    const fieldKey = token.parts[0];
    if (!fieldKey || seenFieldKeys.has(fieldKey)) {
      continue;
    }
    seenFieldKeys.add(fieldKey);

    const suffixedKey = `${fieldKey}_${documentTypeKey}`;
    const rawValue = formData?.[suffixedKey] ?? formData?.[fieldKey];
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (trimmed.length > 0) {
        trimmedRawData[fieldKey] = trimmed;
      }
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      const trimmed = String(rawValue).trim();
      if (trimmed.length > 0) {
        trimmedRawData[fieldKey] = trimmed;
      }
    } else if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const cleanedObj: Record<string, unknown> = {};
      for (const [propKey, propVal] of Object.entries(rawValue as Record<string, unknown>)) {
        if (typeof propVal === 'string') {
          const trimmed = propVal.trim();
          if (trimmed.length > 0) {
            cleanedObj[propKey] = trimmed;
          }
        } else if (propVal !== undefined && propVal !== null) {
          cleanedObj[propKey] = propVal;
        }
      }
      if (Object.keys(cleanedObj).length > 0) {
        trimmedRawData[fieldKey] = cleanedObj;
      }
    }
  }

  const enrichedData = enrichDocumentData(trimmedRawData, targetSchema);

  const missingFieldKeys = new Set<string>();
  const missingIdFields: string[] = [];
  for (const token of parsed.tokens) {
    if (!isTokenPresent(enrichedData, token.parts)) {
      const fieldKey = token.parts[0];
      if (fieldKey && !missingFieldKeys.has(fieldKey)) {
        missingFieldKeys.add(fieldKey);
        const fieldDef = targetSchema.fields.find((f) => f.key === fieldKey);
        missingIdFields.push(fieldDef?.name?.trim() || fieldKey);
      }
    }
  }

  if (missingIdFields.length > 0) {
    return { complete: false, missingIdFields };
  }

  const evaluated = templateEvaluator.evaluate(idGroupTemplate, enrichedData).trim();
  if (evaluated.length === 0) {
    return { complete: false, missingIdFields: [] };
  }

  return { complete: true, idGroup: evaluated };
}

export interface FormatHistoryDisplayEntryParams {
  entry: DocumentLogEntry;
  logSchema: DocumentLogSchema;
  templateParser: LogTemplateParserPort;
}

/**
 * Formats a hydrated `DocumentLogEntry` into a presentation-ready `DocumentLogUiHistoryEntry`.
 * Stitches `historyDisplay.text` via `parseMustacheTemplate` with 5-char HTML escaping on
 * interpolated values (falling back to `"—"` when blank), keeps `topLabel`/`bottomLabel` unescaped
 * plain text, and provides a sensible HTML-escaped default format when `historyDisplay` is omitted.
 */
export function formatHistoryDisplayEntry(
  params: FormatHistoryDisplayEntryParams
): DocumentLogUiHistoryEntry {
  const { entry, logSchema, templateParser } = params;
  const data = entry.document.data;
  const trimmedUri = entry.fileUri?.trim();
  const fileUri = trimmedUri && trimmedUri.length > 0 ? trimmedUri : undefined;

  if (logSchema.historyDisplay) {
    const hd = logSchema.historyDisplay;
    const parsedText = templateParser.parseMustacheTemplate(hd.text);
    const stitchedText = stitchMustacheTemplate(parsedText, data, { escapeHtml: true }).trim();
    const visibleText = stitchedText.replace(/<[^>]*>/g, '').trim();
    const text = visibleText.length > 0 ? stitchedText : '—';

    let topLabel: string | undefined;
    if (hd.topLabel !== undefined) {
      const parsedTop = templateParser.parseMustacheTemplate(hd.topLabel);
      const renderedTop = stitchMustacheTemplate(parsedTop, data, { escapeHtml: false }).trim();
      if (renderedTop.length > 0) {
        topLabel = renderedTop;
      }
    }

    let bottomLabel: string | undefined;
    if (hd.bottomLabel !== undefined) {
      const parsedBottom = templateParser.parseMustacheTemplate(hd.bottomLabel);
      const renderedBottom = stitchMustacheTemplate(parsedBottom, data, {
        escapeHtml: false,
      }).trim();
      if (renderedBottom.length > 0) {
        bottomLabel = renderedBottom;
      }
    }

    return {
      ...(topLabel !== undefined ? { topLabel } : {}),
      text,
      ...(bottomLabel !== undefined ? { bottomLabel } : {}),
      ...(fileUri !== undefined ? { fileUri } : {}),
      valid: entry.valid,
    };
  }

  // Sensible default format when historyDisplay is omitted
  const defaultTopRaw =
    entry.document.idDocument?.trim() || entry.document.idGroup?.trim() || undefined;

  const summaryParts: string[] = [];
  for (const [, binding] of Object.entries(logSchema.columns)) {
    if (!('template' in binding)) {
      continue;
    }
    const parsedCol = templateParser.parseMustacheTemplate(binding.template);
    const rendered = stitchMustacheTemplate(parsedCol, data, { escapeHtml: false }).trim();
    if (rendered.length > 0) {
      summaryParts.push(escapeCardHtmlText(rendered));
    }
  }

  const fallbackRaw = entry.document.id?.trim() || entry.document.idDocument?.trim() || '';
  const text =
    summaryParts.length > 0
      ? summaryParts.join(' • ')
      : fallbackRaw.length > 0
        ? escapeCardHtmlText(fallbackRaw)
        : '—';

  return {
    ...(defaultTopRaw !== undefined ? { topLabel: defaultTopRaw } : {}),
    text,
    ...(fileUri !== undefined ? { fileUri } : {}),
    valid: entry.valid,
  };
}

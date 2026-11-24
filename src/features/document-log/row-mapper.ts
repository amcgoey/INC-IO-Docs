import type {
  DocumentLogDocument,
  DocumentLogSchema,
  LogCellInput,
  LogFormulaCell,
  LogTargetDocumentSchema,
  LogTemplateEvaluatorPort,
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
  const enrichedData = enrichDocumentData(document.data, targetSchema);
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

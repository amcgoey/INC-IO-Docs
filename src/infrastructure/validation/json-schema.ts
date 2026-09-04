import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';

export interface JsonParseContext {
  filePath?: string;
  description?: string;
}

export function parseJson(content: string, context: JsonParseContext): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let contextDesc: string;
    if (context.description && context.filePath) {
      contextDesc = `${context.description} at "${context.filePath}"`;
    } else if (context.filePath) {
      contextDesc = `file at "${context.filePath}"`;
    } else if (context.description) {
      contextDesc = context.description;
    } else {
      contextDesc = 'content';
    }
    throw new Error(`Invalid JSON in ${contextDesc}: ${message}`, { cause: err });
  }
}

export function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

export function validateAndCleanSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  errorMessage: string
): Static<T> {
  const cloned = structuredClone(value);
  const cleaned = Value.Clean(schema, cloned);
  if (!Value.Check(schema, cleaned)) {
    const errors = formatValidationErrors(schema, cleaned).join(', ');
    throw new Error(`${errorMessage}: ${errors}`);
  }
  return cleaned as Static<T>;
}

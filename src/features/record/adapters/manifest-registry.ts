import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { RecordTypeSchema, SystemContextSchema, formatValidationErrors, type RecordType } from '../domain';
import type { ManifestRegistryPort, TemplateEvaluatorPort } from '../ports';

export const ManifestSchema = Type.Object({
  recordTypes: Type.Array(Type.String()),
});

export type Manifest = Static<typeof ManifestSchema>;

export interface ManifestRegistryAdapterOptions {
  manifestPath: string;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
}

function parseJson(content: string, contextDescription: string): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${contextDescription}: ${message}`, { cause: err });
  }
}

function validateAndCleanSchema<T extends TSchema>(
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

export class ManifestRegistryAdapter implements ManifestRegistryPort {
  private readonly manifestPath: string;
  private readonly templateEvaluator?: TemplateEvaluatorPort | undefined;

  constructor(options?: ManifestRegistryAdapterOptions) {
    if (!options?.manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide options.manifestPath.'
      );
    }
    this.manifestPath = options.manifestPath;
    this.templateEvaluator = options.templateEvaluator;
  }

  async loadAll(): Promise<RecordType[]> {
    const manifestContent = await fs.readFile(this.manifestPath, 'utf-8');
    const manifestData = parseJson(manifestContent, `manifest file at "${this.manifestPath}"`);

    const validatedManifest = validateAndCleanSchema(
      ManifestSchema,
      manifestData,
      `Invalid manifest file structure at "${this.manifestPath}"`
    );

    const manifestDir = path.dirname(this.manifestPath);
    const recordTypes: RecordType[] = [];

    for (const recordTypeRelPath of validatedManifest.recordTypes) {
      const resolvedPath = path.resolve(manifestDir, recordTypeRelPath);
      const fileContent = await fs.readFile(resolvedPath, 'utf-8');

      const rawRecordType = parseJson(
        fileContent,
        `RecordType file "${recordTypeRelPath}" at "${resolvedPath}"`
      );

      const validatedRecordType = validateAndCleanSchema(
        RecordTypeSchema,
        rawRecordType,
        `Invalid RecordType schema in "${recordTypeRelPath}" at "${resolvedPath}"`
      );

      if (validatedRecordType.recordSchema.calculatedFields && this.templateEvaluator) {
        const allowedVariables = [
          ...validatedRecordType.recordSchema.fields.map((f) => f.key),
          ...Object.keys(SystemContextSchema.properties),
        ];

        for (const calculatedField of validatedRecordType.recordSchema.calculatedFields) {
          const isValid = this.templateEvaluator.validate(
            calculatedField.template,
            allowedVariables
          );
          if (!isValid) {
            throw new Error(
              `Invalid calculated field template in "${recordTypeRelPath}" for field "${calculatedField.key}": template "${calculatedField.template}" references unknown fields or is malformed.`
            );
          }
        }
      }

      recordTypes.push(validatedRecordType);
    }

    return recordTypes;
  }
}


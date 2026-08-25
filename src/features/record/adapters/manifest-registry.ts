import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { RecordTypeSchema, formatValidationErrors, type RecordType } from '../domain';
import type { ManifestRegistryPort } from '../ports';

export const ManifestSchema = Type.Object({
  recordTypes: Type.Array(Type.String()),
});

export type Manifest = Static<typeof ManifestSchema>;

export interface ManifestRegistryAdapterOptions {
  manifestPath?: string;
}

export function parseJson(content: string, contextDescription: string): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${contextDescription}: ${message}`, { cause: err });
  }
}

export function validateSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  errorMessage: string
): asserts value is Static<T> {
  if (!Value.Check(schema, value)) {
    const errors = formatValidationErrors(schema, value).join(', ');
    throw new Error(`${errorMessage}: ${errors}`);
  }
}

export class ManifestRegistryAdapter implements ManifestRegistryPort {
  constructor(private readonly options?: ManifestRegistryAdapterOptions) {}

  async loadAll(): Promise<RecordType[]> {
    const manifestPath = this.options?.manifestPath ?? process.env.APP_MANIFEST_PATH;

    if (!manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide a manifestPath or set the APP_MANIFEST_PATH environment variable.'
      );
    }

    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifestData = parseJson(manifestContent, `manifest file at "${manifestPath}"`);

    validateSchema(
      ManifestSchema,
      manifestData,
      `Invalid manifest file structure at "${manifestPath}"`
    );

    const manifestDir = path.dirname(manifestPath);
    const recordTypes: RecordType[] = [];

    for (const recordTypeRelPath of manifestData.recordTypes) {
      const resolvedPath = path.resolve(manifestDir, recordTypeRelPath);
      const fileContent = await fs.readFile(resolvedPath, 'utf-8');

      const rawRecordType = parseJson(
        fileContent,
        `RecordType file "${recordTypeRelPath}" at "${resolvedPath}"`
      );

      validateSchema(
        RecordTypeSchema,
        rawRecordType,
        `Invalid RecordType schema in "${recordTypeRelPath}" at "${resolvedPath}"`
      );

      recordTypes.push(rawRecordType);
    }

    return recordTypes;
  }
}


import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { RecordTypeSchema, type RecordType } from '../domain';
import type { ManifestRegistryPort } from '../ports';

export const ManifestSchema = Type.Object({
  recordTypes: Type.Array(Type.String()),
});

export type Manifest = Static<typeof ManifestSchema>;

export interface ManifestRegistryAdapterOptions {
  manifestPath?: string;
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

    let manifestData: unknown;
    try {
      manifestData = JSON.parse(manifestContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in manifest file at "${manifestPath}": ${message}`, { cause: err });
    }

    if (!Value.Check(ManifestSchema, manifestData)) {
      const errors = [...Value.Errors(ManifestSchema, manifestData)]
        .map((e) => `${e.path}: ${e.message}`)
        .join(', ');
      throw new Error(`Invalid manifest file structure at "${manifestPath}": ${errors}`);
    }

    const manifestDir = path.dirname(manifestPath);
    const recordTypes: RecordType[] = [];

    for (const recordTypeRelPath of manifestData.recordTypes) {
      const resolvedPath = path.resolve(manifestDir, recordTypeRelPath);
      const fileContent = await fs.readFile(resolvedPath, 'utf-8');

      let rawRecordType: unknown;
      try {
        rawRecordType = JSON.parse(fileContent);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Invalid JSON in RecordType file "${recordTypeRelPath}" at "${resolvedPath}": ${message}`,
          { cause: err }
        );
      }


      if (!Value.Check(RecordTypeSchema, rawRecordType)) {
        const errors = [...Value.Errors(RecordTypeSchema, rawRecordType)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        throw new Error(
          `Invalid RecordType schema in "${recordTypeRelPath}" at "${resolvedPath}": ${errors}`
        );
      }

      recordTypes.push(rawRecordType);
    }

    return recordTypes;
  }
}

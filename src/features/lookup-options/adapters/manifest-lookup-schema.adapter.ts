import { Value } from '@sinclair/typebox/value';
import {
  LookupDocumentSchemaSchema,
  type LookupDocumentSchema,
  type LookupManifestPort,
} from '../ports';

export interface RawLookupManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema(relPath: string): Promise<unknown>;
}

interface RawDocumentTypeCandidate {
  key?: unknown;
  documentSchema?: unknown;
}

export class ManifestLookupSchemaAdapter implements LookupManifestPort {
  constructor(private readonly manifestProvider: RawLookupManifestProviderPort) {}

  async getDocumentSchema(documentTypeKey: string): Promise<LookupDocumentSchema | undefined> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as
      | { documentTypes?: unknown }
      | undefined;
    const documentTypes = Array.isArray(rawManifest?.documentTypes)
      ? rawManifest.documentTypes
      : [];

    for (const relPath of documentTypes) {
      if (typeof relPath !== 'string') {
        continue;
      }
      const rawDoc = (await this.manifestProvider.readParsedSchema(relPath)) as
        | RawDocumentTypeCandidate
        | undefined;
      if (rawDoc?.key !== documentTypeKey || !rawDoc.documentSchema) {
        continue;
      }
      const cleaned = Value.Clean(
        LookupDocumentSchemaSchema,
        structuredClone(rawDoc.documentSchema)
      );
      if (!Value.Check(LookupDocumentSchemaSchema, cleaned)) {
        return undefined;
      }
      return cleaned as LookupDocumentSchema;
    }

    return undefined;
  }
}

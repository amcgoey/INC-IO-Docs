import { Value } from '@sinclair/typebox/value';
import type {
  DocumentUiSchema,
  DocumentUiSchemaQueryPort,
  RawManifestProviderPort,
  SpaceUiSchema,
} from '../ports';
import { DocumentUiSchemaType, SpaceUiSchemaType } from '../ports';
import { ensureEvaluationOrder } from '../../../infrastructure/validation/json-logic-graph';

interface ManifestWithDocumentTypes {
  documentTypes?: string[];
  DocumentSpaceTypes?: Array<Record<string, unknown>>;
  documentSpaceTypes?: Array<Record<string, unknown>>;
}

interface RawDocumentTypeRecord {
  key?: string;
  documentSchema?: { fields?: Array<{ key: string }> };
  documentUiSchema?: unknown;
}

export class DocumentUiSchemaQueryAdapter implements DocumentUiSchemaQueryPort {
  constructor(private readonly manifestProvider: RawManifestProviderPort) {}

  async getDocumentUiSchema(documentTypeKey: string): Promise<DocumentUiSchema | undefined> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as ManifestWithDocumentTypes | undefined;
    const documentTypes = rawManifest?.documentTypes ?? [];

    for (const relPath of documentTypes) {
      const rawDoc = (await this.manifestProvider.readParsedSchema(relPath)) as
        | RawDocumentTypeRecord
        | undefined;
      if (rawDoc?.key === documentTypeKey && rawDoc.documentUiSchema) {
        const cleaned = Value.Clean(
          DocumentUiSchemaType,
          structuredClone(rawDoc.documentUiSchema)
        );
        if (Value.Check(DocumentUiSchemaType, cleaned)) {
          return ensureEvaluationOrder(cleaned as DocumentUiSchema, rawDoc.documentSchema);
        }
      }
    }

    return undefined;
  }

  async getSpaceUiSchema(spaceTypeKey: string): Promise<SpaceUiSchema | undefined> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as ManifestWithDocumentTypes | undefined;
    const spaceTypes = rawManifest?.DocumentSpaceTypes ?? rawManifest?.documentSpaceTypes ?? [];

    for (const spaceType of spaceTypes) {
      const id = spaceType.id ?? spaceType.key;
      if (id === spaceTypeKey && spaceType.spaceUiSchema) {
        const cleaned = Value.Clean(
          SpaceUiSchemaType,
          structuredClone(spaceType.spaceUiSchema)
        );
        if (Value.Check(SpaceUiSchemaType, cleaned)) {
          return ensureEvaluationOrder(cleaned as SpaceUiSchema);
        }
      }
    }

    return undefined;
  }
}

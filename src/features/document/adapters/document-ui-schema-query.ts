import { Value } from '@sinclair/typebox/value';
import type {
  DocumentUiSchema,
  DocumentUiSchemaQueryPort,
  EvaluationOrderEnsurer,
  RawManifestProviderPort,
} from '../ports';
import { DocumentUiSchemaType } from '../ports';

interface ManifestWithDocumentTypes {
  documentTypes?: string[];
}

interface RawDocumentTypeRecord {
  key?: string;
  documentSchema?: { fields?: Array<{ key: string }> };
  documentUiSchema?: unknown;
}

export class DocumentUiSchemaQueryAdapter implements DocumentUiSchemaQueryPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer
  ) {}

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
          const uiSchema = cleaned as DocumentUiSchema;
          if (this.evaluationOrderEnsurer) {
            this.evaluationOrderEnsurer(uiSchema, rawDoc.documentSchema);
          }
          return uiSchema;
        }
      }
    }

    return undefined;
  }
}

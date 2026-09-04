import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentTypeSchema,
  validateManifestTemplates,
  type DocumentType,
} from '../domain';
import type {
  DocumentSchemaRegistryPort,
  RawManifestProviderPort,
  TemplateEvaluatorPort,
} from '../ports';

const RawDocumentKeySchema = Type.Object({
  key: Type.Optional(Type.String()),
});

function extractKey(raw: unknown): string {
  return Value.Check(RawDocumentKeySchema, raw) && raw.key ? ` "${raw.key}"` : '';
}

export class DocumentSchemaRegistryAdapter implements DocumentSchemaRegistryPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly templateEvaluator: TemplateEvaluatorPort
  ) {}

  async loadAll(): Promise<DocumentType[]> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as {
      documentTypes?: string[];
    };
    const documentTypes: DocumentType[] = [];

    for (const relPath of rawManifest?.documentTypes ?? []) {
      const rawDocumentType = await this.manifestProvider.readParsedSchema(relPath);
      const cloned = structuredClone(rawDocumentType);
      const cleaned = Value.Clean(DocumentTypeSchema, cloned);
      if (!Value.Check(DocumentTypeSchema, cleaned)) {
        const errors = [...Value.Errors(DocumentTypeSchema, cleaned)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        const key = extractKey(rawDocumentType);
        throw new Error(`Invalid DocumentType schema${key}: ${errors}`);
      }

      const validatedDocumentType = cleaned as DocumentType;

      const templateErrors = validateManifestTemplates(
        validatedDocumentType,
        this.templateEvaluator
      );
      if (templateErrors.length > 0) {
        throw new Error(
          `Invalid template in "${validatedDocumentType.key}": ${templateErrors.join(', ')}`
        );
      }

      documentTypes.push(validatedDocumentType);
    }

    return documentTypes;
  }
}


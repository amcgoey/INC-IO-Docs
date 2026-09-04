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

export class DocumentSchemaRegistryAdapter implements DocumentSchemaRegistryPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly templateEvaluator: TemplateEvaluatorPort
  ) {}

  async loadAll(): Promise<DocumentType[]> {
    const rawSchemas = await this.manifestProvider.loadAllParsedSchemas();
    const documentTypes: DocumentType[] = [];

    for (const rawDocumentType of rawSchemas) {
      const cloned = structuredClone(rawDocumentType);
      const cleaned = Value.Clean(DocumentTypeSchema, cloned);
      if (!Value.Check(DocumentTypeSchema, cleaned)) {
        const errors = [...Value.Errors(DocumentTypeSchema, cleaned)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        const key =
          typeof rawDocumentType === 'object' &&
          rawDocumentType !== null &&
          'key' in rawDocumentType &&
          typeof (rawDocumentType as { key: unknown }).key === 'string'
            ? ` "${(rawDocumentType as { key: string }).key}"`
            : '';
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


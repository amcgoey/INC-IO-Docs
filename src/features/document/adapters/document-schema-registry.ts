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
    let manifestObject: unknown;
    try {
      manifestObject = await this.manifestProvider.getRawManifest();
    } catch (err) {
      throw new Error(
        `Failed to load raw manifest in loadAll: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    const raw = manifestObject as { documentTypes?: string[] };
    if (!raw || !Array.isArray(raw.documentTypes)) {
      throw new Error('Invalid manifest structure: documentTypes must be an array.');
    }

    const documentTypes: DocumentType[] = [];

    for (const documentTypeRelPath of raw.documentTypes) {
      const rawDocumentType = await this.manifestProvider.readParsedSchema(documentTypeRelPath);

      const cloned = structuredClone(rawDocumentType);
      const cleaned = Value.Clean(DocumentTypeSchema, cloned);
      if (!Value.Check(DocumentTypeSchema, cleaned)) {
        const errors = [...Value.Errors(DocumentTypeSchema, cleaned)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        throw new Error(
          `Invalid DocumentType schema in "${documentTypeRelPath}": ${errors}`
        );
      }

      const validatedDocumentType = cleaned as DocumentType;

      const templateErrors = validateManifestTemplates(
        validatedDocumentType,
        this.templateEvaluator
      );
      if (templateErrors.length > 0) {
        throw new Error(
          `Invalid template in "${documentTypeRelPath}": ${templateErrors.join(', ')}`
        );
      }

      documentTypes.push(validatedDocumentType);
    }

    return documentTypes;
  }
}


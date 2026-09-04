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
import {
  parseJson,
  validateAndCleanSchema,
} from '../../../infrastructure/validation/json-schema';

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
      const fileContent = await this.manifestProvider.readSchema(documentTypeRelPath);

      const rawDocumentType = parseJson(
        fileContent,
        `DocumentType file "${documentTypeRelPath}"`
      );

      const validatedDocumentType = validateAndCleanSchema(
        DocumentTypeSchema,
        rawDocumentType,
        `Invalid DocumentType schema in "${documentTypeRelPath}"`
      );

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

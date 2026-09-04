import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import {
  DocumentTypeSchema,
  formatValidationErrors,
  validateManifestTemplates,
  type DocumentType,
} from '../domain';
import type {
  DocumentSchemaRegistryPort,
  RawManifestProviderPort,
  TemplateEvaluatorPort,
} from '../ports';

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

export class DocumentSchemaRegistryAdapter implements DocumentSchemaRegistryPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly templateEvaluator: TemplateEvaluatorPort
  ) {
    if (!manifestProvider) {
      throw new Error('Manifest provider is not defined.');
    }
    if (!templateEvaluator) {
      throw new Error('Template evaluator is not defined.');
    }
  }

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

    const manifestDir = this.manifestProvider.getManifestDir();
    const documentTypes: DocumentType[] = [];

    for (const documentTypeRelPath of raw.documentTypes) {
      const resolvedPath = path.resolve(manifestDir, documentTypeRelPath);
      let fileContent: string;
      try {
        fileContent = await fs.readFile(resolvedPath, 'utf-8');
      } catch (err) {
        throw new Error(
          `Failed to read DocumentType file "${documentTypeRelPath}" at "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }

      const rawDocumentType = parseJson(
        fileContent,
        `DocumentType file "${documentTypeRelPath}" at "${resolvedPath}"`
      );

      const validatedDocumentType = validateAndCleanSchema(
        DocumentTypeSchema,
        rawDocumentType,
        `Invalid DocumentType schema in "${documentTypeRelPath}" at "${resolvedPath}"`
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

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentTypeSchema,
  validateManifestTemplates,
  type DocumentType,
} from '../domain';
import {
  DocumentUiSchemaType,
  type DocumentSchemaRegistryPort,
  type RawManifestProviderPort,
  type TemplateEvaluatorPort,
  type SchemaQueryPort,
  type FormSchema,
  type DocumentUiSchema,
  type EvaluationOrderEnsurer,
} from '../ports';

const RawDocumentKeySchema = Type.Object({
  key: Type.Optional(Type.String()),
});

function extractKey(raw: unknown): string {
  return Value.Check(RawDocumentKeySchema, raw) && raw.key ? ` "${raw.key}"` : '';
}

export class DocumentSchemaRegistryAdapter implements DocumentSchemaRegistryPort, SchemaQueryPort {
  private cachedForms: FormSchema[] | null = null;

  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly templateEvaluator: TemplateEvaluatorPort,
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer
  ) {}

  async loadAll(): Promise<DocumentType[]> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as {
      documentTypes?: string[];
    };
    const documentTypes: DocumentType[] = [];
    const resolvedUiSchemas: Array<DocumentUiSchema | undefined> = [];

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

      let validatedDocumentType = cleaned as DocumentType;

      const templateErrors = validateManifestTemplates(
        validatedDocumentType,
        this.templateEvaluator
      );
      if (templateErrors.length > 0) {
        throw new Error(
          `Invalid template in "${validatedDocumentType.key}": ${templateErrors.join(', ')}`
        );
      }

      let resolvedUiSchema: DocumentUiSchema | undefined = undefined;
      const rawUiSchema = (rawDocumentType as { documentUiSchema?: unknown })?.documentUiSchema;
      if (rawUiSchema) {
        const cleanedUi = Value.Clean(DocumentUiSchemaType, structuredClone(rawUiSchema));
        if (!Value.Check(DocumentUiSchemaType, cleanedUi)) {
          const errors = [...Value.Errors(DocumentUiSchemaType, cleanedUi)]
            .map((e) => `${e.path}: ${e.message}`)
            .join(', ');
          throw new Error(
            `Invalid DocumentType UI schema "${validatedDocumentType.key}": ${errors}`
          );
        }
        resolvedUiSchema = cleanedUi as DocumentUiSchema;
        validatedDocumentType = {
          ...validatedDocumentType,
          documentUiSchema: resolvedUiSchema,
        };
      }

      if (resolvedUiSchema?.fields && this.evaluationOrderEnsurer) {
        try {
          resolvedUiSchema =
            (this.evaluationOrderEnsurer(
              resolvedUiSchema,
              validatedDocumentType.documentSchema
            ) as DocumentUiSchema) ?? resolvedUiSchema;

          validatedDocumentType = {
            ...validatedDocumentType,
            documentUiSchema: resolvedUiSchema,
          };
        } catch (error) {
          throw new Error(
            `Invalid DocumentType UI schema "${validatedDocumentType.key}": ${(error as Error).message}`,
            { cause: error }
          );
        }
      }

      documentTypes.push(validatedDocumentType);
      resolvedUiSchemas.push(resolvedUiSchema);
    }

    this.cachedForms = documentTypes.map((dt, idx) => {
      const formSchema: FormSchema = {
        key: dt.key,
        name: dt.name,
        documentSchema: dt.documentSchema,
      };
      const ui = resolvedUiSchemas[idx] ?? (dt.documentUiSchema as DocumentUiSchema | undefined);
      if (ui !== undefined) {
        formSchema.documentUiSchema = ui;
      }
      return formSchema;
    });

    return documentTypes;
  }

  async getForms(): Promise<FormSchema[]> {
    if (this.cachedForms) {
      return this.cachedForms;
    }
    await this.loadAll();
    return this.cachedForms ?? [];
  }
}


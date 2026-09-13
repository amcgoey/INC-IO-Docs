import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentTypeSchema,
  validateManifestTemplates,
  type DocumentType,
} from '../domain';
import {
  DocumentUiSchemaType as PortDocumentUiSchemaType,
  type DocumentSchemaRegistryPort,
  type RawManifestProviderPort,
  type TemplateEvaluatorPort,
  type SchemaQueryPort,
  type FormSchema,
  type DocumentUiSchema as PortDocumentUiSchema,
} from '../ports';
import { computeEvaluationOrder } from '../../../infrastructure/validation/json-logic-graph';

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
    private readonly templateEvaluator: TemplateEvaluatorPort
  ) {}

  async loadAll(): Promise<DocumentType[]> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as {
      documentTypes?: string[];
    };
    const documentTypes: DocumentType[] = [];
    const resolvedUiSchemas: Array<PortDocumentUiSchema | undefined> = [];

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

      let resolvedUiSchema: PortDocumentUiSchema | undefined = undefined;
      const rawUiSchema = (rawDocumentType as { documentUiSchema?: unknown })?.documentUiSchema;
      if (rawUiSchema) {
        const cleanedUi = Value.Clean(PortDocumentUiSchemaType, structuredClone(rawUiSchema));
        if (Value.Check(PortDocumentUiSchemaType, cleanedUi)) {
          resolvedUiSchema = cleanedUi as PortDocumentUiSchema;
        }
      }

      if (resolvedUiSchema?.fields) {
        try {
          const evaluationOrder = computeEvaluationOrder(
            validatedDocumentType.documentSchema,
            resolvedUiSchema
          );
          resolvedUiSchema.evaluationOrder = evaluationOrder;
          if (validatedDocumentType.documentUiSchema) {
            (validatedDocumentType.documentUiSchema as Record<string, unknown>).evaluationOrder =
              evaluationOrder;
          }
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
      const ui = resolvedUiSchemas[idx] ?? (dt.documentUiSchema as PortDocumentUiSchema | undefined);
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


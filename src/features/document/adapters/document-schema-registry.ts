import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentTypeSchema,
  validateManifestTemplates,
  UiEventType,
  type DocumentType,
  type DocumentUiEvents,
} from '../domain';
import {
  type DocumentSchemaRegistryPort,
  type RawManifestProviderPort,
  type TemplateEvaluatorPort,
  type EvaluationOrderEnsurer,
} from '../ports';

const DocumentUiValidationSchema = Type.Object({
  layout: Type.Optional(Type.Array(Type.String())),
  fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  events: Type.Optional(Type.Record(Type.String(), UiEventType)),
  evaluationOrder: Type.Optional(Type.Array(Type.String())),
});

const RawDocumentKeySchema = Type.Object({
  key: Type.Optional(Type.String()),
});

function extractKey(raw: unknown): string {
  return Value.Check(RawDocumentKeySchema, raw) && raw.key ? ` "${raw.key}"` : '';
}

export class DocumentSchemaRegistryAdapter implements DocumentSchemaRegistryPort {
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

      let resolvedUiSchema:
        | {
            layout?: string[];
            fields?: Record<string, unknown>;
            events?: Record<string, unknown>;
            evaluationOrder?: string[];
          }
        | undefined = undefined;
      const rawUiSchema = (rawDocumentType as { documentUiSchema?: unknown })?.documentUiSchema;
      if (rawUiSchema) {
        const cleanedUi = Value.Clean(DocumentUiValidationSchema, structuredClone(rawUiSchema));
        if (!Value.Check(DocumentUiValidationSchema, cleanedUi)) {
          const errors = [...Value.Errors(DocumentUiValidationSchema, cleanedUi)]
            .map((e) => `${e.path}: ${e.message}`)
            .join(', ');
          throw new Error(
            `Invalid DocumentType UI schema "${validatedDocumentType.key}": ${errors}`
          );
        }
        resolvedUiSchema = cleanedUi;
        validatedDocumentType = {
          ...validatedDocumentType,
          documentUiSchema: resolvedUiSchema as DocumentUiEvents,
        };
      }

      if (
        resolvedUiSchema &&
        (resolvedUiSchema.fields || resolvedUiSchema.layout) &&
        this.evaluationOrderEnsurer
      ) {
        try {
          const ensured = this.evaluationOrderEnsurer(
            resolvedUiSchema,
            validatedDocumentType.documentSchema
          );
          if (ensured) {
            resolvedUiSchema = ensured as typeof resolvedUiSchema;
            validatedDocumentType = {
              ...validatedDocumentType,
              documentUiSchema: resolvedUiSchema as DocumentUiEvents,
            };
          }
        } catch (error) {
          throw new Error(
            `Invalid DocumentType UI schema "${validatedDocumentType.key}": ${(error as Error).message}`,
            { cause: error }
          );
        }
      }

      documentTypes.push(validatedDocumentType);
    }

    return documentTypes;
  }
}

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentTypeSchema,
  DocumentUiSuccessViewSchema,
  validateManifestTemplates,
  UiEventType,
  type DocumentType,
  type DocumentUiEvents,
  type DocumentUiSuccessView,
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
  successView: Type.Optional(DocumentUiSuccessViewSchema),
});

const RawDocumentKeySchema = Type.Object({
  key: Type.Optional(Type.String()),
});

function extractKey(raw: unknown): string {
  return Value.Check(RawDocumentKeySchema, raw) && raw.key ? ` "${raw.key}"` : '';
}

export function stripOptionAliases(documentType: DocumentType): DocumentType {
  if (!documentType.documentSchema.options) {
    return documentType;
  }
  const strippedOptions: Record<string, Record<string, unknown>[]> = {};
  for (const [sourceKey, tuples] of Object.entries(documentType.documentSchema.options)) {
    strippedOptions[sourceKey] = tuples.map((tuple) => {
      if (tuple && typeof tuple === 'object' && 'aliases' in tuple) {
        const tupleObj = { ...(tuple as Record<string, unknown>) };
        delete tupleObj.aliases;
        return tupleObj;
      }
      return tuple;
    });
  }
  return {
    ...documentType,
    documentSchema: {
      ...documentType.documentSchema,
      options: strippedOptions,
    },
  };
}

export class DocumentSchemaRegistryAdapter implements DocumentSchemaRegistryPort {
  private cachedLoadPromise: Promise<DocumentType[]> | undefined;

  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly templateEvaluator: TemplateEvaluatorPort,
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer
  ) {}

  async loadAll(): Promise<DocumentType[]> {
    if (!this.cachedLoadPromise) {
      this.cachedLoadPromise = this.loadAndValidateAll().catch((error) => {
        this.cachedLoadPromise = undefined;
        throw error;
      });
    }
    return [...(await this.cachedLoadPromise)];
  }

  private async loadAndValidateAll(): Promise<DocumentType[]> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as {
      documentTypes?: string[];
      configuration?: {
        templates?: Record<string, unknown>;
      };
    };
    const configuredTemplateKeys = new Set(
      rawManifest?.configuration?.templates &&
      typeof rawManifest.configuration.templates === 'object' &&
      !Array.isArray(rawManifest.configuration.templates)
        ? Object.keys(rawManifest.configuration.templates)
        : []
    );
    const documentTypes: DocumentType[] = [];

    for (const relPath of rawManifest?.documentTypes ?? []) {
      const rawDocumentType = await this.manifestProvider.readParsedSchema(relPath);
      const rawFields = (rawDocumentType as { documentSchema?: { fields?: unknown } })?.documentSchema?.fields;
      if (Array.isArray(rawFields)) {
        for (const rawField of rawFields) {
          if (rawField && typeof rawField === 'object') {
            const rawOptions = (rawField as { options?: unknown }).options;
            if (
              rawOptions !== null &&
              typeof rawOptions === 'object' &&
              'dynamicConfig' in rawOptions &&
              (rawOptions as { dynamicConfig?: unknown }).dynamicConfig !== undefined
            ) {
              const fieldKey = (rawField as { key?: unknown }).key;
              const docKey = extractKey(rawDocumentType);
              throw new Error(
                `Invalid DocumentType schema${docKey}: Field "${String(fieldKey ?? '')}" uses legacy options.dynamicConfig which is no longer supported; use documentSchema.optionSources instead.`
              );
            }
          }
        }
      }
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
        this.templateEvaluator,
        { configuredTemplateKeys }
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
            successView?: DocumentUiSuccessView;
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

      documentTypes.push(stripOptionAliases(validatedDocumentType));
    }

    return documentTypes;
  }
}

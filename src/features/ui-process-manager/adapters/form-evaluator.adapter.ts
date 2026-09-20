import type { UiProcessFormEvaluatorPort, UiProcessFormEvaluationResult } from '../ports';
import type { RawManifestProviderPort } from './manifest.adapter';

export type FormChangeEvaluatorFn = (
  formData: Record<string, unknown>,
  docSchema?: unknown,
  uiSchema?: unknown
) => {
  computedData: Record<string, unknown>;
  hiddenFields: string[];
  disabledFields: string[];
};

export class FormEvaluatorAdapter implements UiProcessFormEvaluatorPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly evaluator: FormChangeEvaluatorFn
  ) {}

  private async getDocAndUiSchemas(
    documentTypeKey?: string
  ): Promise<{ docSchema?: unknown; uiSchema?: unknown }> {
    if (!documentTypeKey) {
      return {};
    }
    const rawManifest = (await this.manifestProvider.getRawManifest()) as
      | {
          documentTypes?:
            | string[]
            | Record<string, { documentSchema?: unknown; documentUiSchema?: unknown }>;
        }
      | undefined;

    if (!rawManifest) {
      return {};
    }

    if (
      rawManifest.documentTypes &&
      !Array.isArray(rawManifest.documentTypes) &&
      typeof rawManifest.documentTypes === 'object'
    ) {
      const docDef = (
        rawManifest.documentTypes as Record<
          string,
          { documentSchema?: unknown; documentUiSchema?: unknown }
        >
      )[documentTypeKey];
      if (docDef) {
        return {
          docSchema: docDef.documentSchema,
          uiSchema: docDef.documentUiSchema,
        };
      }
    }

    if (Array.isArray(rawManifest.documentTypes) && this.manifestProvider.readParsedSchema) {
      for (const relPath of rawManifest.documentTypes) {
        try {
          const rawDoc = (await this.manifestProvider.readParsedSchema(relPath)) as
            | { key?: string; documentSchema?: unknown; documentUiSchema?: unknown }
            | undefined;
          if (rawDoc?.key === documentTypeKey) {
            return {
              docSchema: rawDoc.documentSchema,
              uiSchema: rawDoc.documentUiSchema,
            };
          }
        } catch {
          // ignore unreadable schemas
        }
      }
    }

    return {};
  }

  async evaluate(
    formData: Record<string, unknown>,
    documentTypeKey?: string
  ): Promise<UiProcessFormEvaluationResult> {
    const { docSchema, uiSchema } = await this.getDocAndUiSchemas(documentTypeKey);
    return this.evaluator(formData, docSchema, uiSchema);
  }
}

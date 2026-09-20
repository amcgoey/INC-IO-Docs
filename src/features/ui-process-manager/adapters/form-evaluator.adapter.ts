import type {
  UiProcessFormEvaluatorPort,
  UiProcessFormEvaluationResult,
  UiProcessManifestPort,
} from '../ports';

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
    private readonly manifestPort: UiProcessManifestPort,
    private readonly evaluator: FormChangeEvaluatorFn
  ) {}

  async evaluate(
    formData: Record<string, unknown>,
    documentTypeKey?: string
  ): Promise<UiProcessFormEvaluationResult> {
    const { docSchema, uiSchema } = documentTypeKey
      ? await this.manifestPort.getDocumentTypeSchemas(documentTypeKey)
      : { docSchema: undefined, uiSchema: undefined };
    return this.evaluator(formData, docSchema, uiSchema);
  }
}

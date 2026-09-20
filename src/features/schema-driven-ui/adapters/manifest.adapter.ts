import { Value } from '@sinclair/typebox/value';
import type { UiManifestPort } from '../ports';
import { AbstractDataSchema } from '../ports';
import { UiSchema } from '../domain';

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema(relPath: string): Promise<unknown>;
}

export type EvaluationOrderEnsurer = (
  uiSchema: UiSchema,
  documentSchema?: unknown
) => UiSchema;

export class ManifestUiAdapter implements UiManifestPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer
  ) {}

  private async findRawDoc(
    documentTypeKey: string
  ): Promise<{ key?: string; documentSchema?: unknown; documentUiSchema?: unknown } | undefined> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as
      | { documentTypes?: string[] }
      | undefined;
    const documentTypes = rawManifest?.documentTypes ?? [];

    for (const relPath of documentTypes) {
      const rawDoc = (await this.manifestProvider.readParsedSchema(relPath)) as
        | { key?: string; documentSchema?: unknown; documentUiSchema?: unknown }
        | undefined;
      if (rawDoc?.key === documentTypeKey) {
        return rawDoc;
      }
    }
    return undefined;
  }

  async getUiSchema(documentTypeKey: string): Promise<UiSchema | undefined> {
    const rawDoc = await this.findRawDoc(documentTypeKey);
    if (!rawDoc?.documentUiSchema) {
      return undefined;
    }
    const cleaned = Value.Clean(UiSchema, structuredClone(rawDoc.documentUiSchema));
    if (!Value.Check(UiSchema, cleaned)) {
      return undefined;
    }
    let uiSchema = cleaned as UiSchema;
    if (this.evaluationOrderEnsurer) {
      uiSchema = this.evaluationOrderEnsurer(uiSchema, rawDoc.documentSchema);
    }
    return uiSchema;
  }

  async getDocumentSchema(documentTypeKey: string): Promise<AbstractDataSchema | undefined> {
    const rawDoc = await this.findRawDoc(documentTypeKey);
    if (!rawDoc?.documentSchema) {
      return undefined;
    }
    const cleaned = Value.Clean(AbstractDataSchema, structuredClone(rawDoc.documentSchema));
    if (!Value.Check(AbstractDataSchema, cleaned)) {
      return undefined;
    }
    return cleaned as AbstractDataSchema;
  }
}

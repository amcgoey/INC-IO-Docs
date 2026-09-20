import type { TSchema, Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { UiManifestPort, DocumentTypeDisplayNameResolverPort } from '../ports';
import { AbstractDataSchema } from '../ports';
import { UiSchema } from '../domain';

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema(relPath: string): Promise<unknown>;
}

export type EvaluationOrderEnsurer = (
  uiSchema: UiSchema,
  documentSchema?: AbstractDataSchema
) => UiSchema;

export type RawDocumentTypeSchema = {
  key?: string;
  name?: string;
  displayName?: string;
  documentSchema?: unknown;
  documentUiSchema?: unknown;
};

export class ManifestUiAdapter implements UiManifestPort, DocumentTypeDisplayNameResolverPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer
  ) {}

  private cleanAndCheck<T extends TSchema>(rawData: unknown, schema: T): Static<T> | undefined {
    if (!rawData) {
      return undefined;
    }
    const cleaned = Value.Clean(schema, structuredClone(rawData));
    if (!Value.Check(schema, cleaned)) {
      return undefined;
    }
    return cleaned as Static<T>;
  }

  private async findRawDoc(
    documentTypeKey: string
  ): Promise<RawDocumentTypeSchema | undefined> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as
      | { documentTypes?: string[] }
      | undefined;
    const documentTypes = rawManifest?.documentTypes ?? [];

    for (const relPath of documentTypes) {
      const rawDoc = (await this.manifestProvider.readParsedSchema(relPath)) as
        | RawDocumentTypeSchema
        | undefined;
      if (rawDoc?.key === documentTypeKey) {
        return rawDoc;
      }
    }
    return undefined;
  }

  async getUiSchema(documentTypeKey: string): Promise<UiSchema | undefined> {
    const rawDoc = await this.findRawDoc(documentTypeKey);
    let uiSchema = this.cleanAndCheck(rawDoc?.documentUiSchema, UiSchema);
    if (!uiSchema) {
      return undefined;
    }
    if (this.evaluationOrderEnsurer) {
      const docSchema = this.cleanAndCheck(rawDoc?.documentSchema, AbstractDataSchema);
      uiSchema = this.evaluationOrderEnsurer(uiSchema, docSchema);
    }
    return uiSchema;
  }

  async getDocumentSchema(documentTypeKey: string): Promise<AbstractDataSchema | undefined> {
    const rawDoc = await this.findRawDoc(documentTypeKey);
    return this.cleanAndCheck(rawDoc?.documentSchema, AbstractDataSchema);
  }

  async getDisplayName(documentTypeKey: string): Promise<string | undefined> {
    const rawDoc = await this.findRawDoc(documentTypeKey);
    if (!rawDoc) {
      return undefined;
    }
    return rawDoc.name ?? rawDoc.displayName ?? rawDoc.key;
  }
}

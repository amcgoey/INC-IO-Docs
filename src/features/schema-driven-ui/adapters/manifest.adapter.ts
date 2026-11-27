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
  private rawDocsByKeyPromise: Promise<Map<string, RawDocumentTypeSchema>> | undefined;
  private readonly uiSchemaCache = new Map<string, UiSchema | undefined>();
  private readonly docSchemaCache = new Map<string, AbstractDataSchema | undefined>();
  private readonly displayNameCache = new Map<string, string | undefined>();

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

  private async loadRawDocsByKey(): Promise<Map<string, RawDocumentTypeSchema>> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as
      | { documentTypes?: string[] }
      | undefined;
    const documentTypes = rawManifest?.documentTypes ?? [];
    const docsByKey = new Map<string, RawDocumentTypeSchema>();

    for (const relPath of documentTypes) {
      const rawDoc = (await this.manifestProvider.readParsedSchema(relPath)) as
        | RawDocumentTypeSchema
        | undefined;
      if (rawDoc?.key !== undefined && !docsByKey.has(rawDoc.key)) {
        docsByKey.set(rawDoc.key, rawDoc);
      }
    }
    return docsByKey;
  }

  private getRawDocsByKey(): Promise<Map<string, RawDocumentTypeSchema>> {
    if (!this.rawDocsByKeyPromise) {
      this.rawDocsByKeyPromise = this.loadRawDocsByKey().catch((err) => {
        this.rawDocsByKeyPromise = undefined;
        throw err;
      });
    }
    return this.rawDocsByKeyPromise;
  }

  private resolveDocumentSchema(
    documentTypeKey: string,
    rawDoc: RawDocumentTypeSchema | undefined
  ): AbstractDataSchema | undefined {
    if (this.docSchemaCache.has(documentTypeKey)) {
      const cached = this.docSchemaCache.get(documentTypeKey);
      return cached !== undefined ? structuredClone(cached) : undefined;
    }
    const docSchema = this.cleanAndCheck(rawDoc?.documentSchema, AbstractDataSchema);
    this.docSchemaCache.set(documentTypeKey, docSchema);
    return docSchema !== undefined ? structuredClone(docSchema) : undefined;
  }

  async getUiSchema(documentTypeKey: string): Promise<UiSchema | undefined> {
    if (this.uiSchemaCache.has(documentTypeKey)) {
      const cached = this.uiSchemaCache.get(documentTypeKey);
      return cached !== undefined ? structuredClone(cached) : undefined;
    }

    const rawDocsByKey = await this.getRawDocsByKey();
    if (this.uiSchemaCache.has(documentTypeKey)) {
      const cached = this.uiSchemaCache.get(documentTypeKey);
      return cached !== undefined ? structuredClone(cached) : undefined;
    }

    const rawDoc = rawDocsByKey.get(documentTypeKey);
    let uiSchema = this.cleanAndCheck(rawDoc?.documentUiSchema, UiSchema);
    if (!uiSchema) {
      this.uiSchemaCache.set(documentTypeKey, undefined);
      return undefined;
    }
    if (this.evaluationOrderEnsurer) {
      const docSchema = this.resolveDocumentSchema(documentTypeKey, rawDoc);
      uiSchema = this.evaluationOrderEnsurer(uiSchema, docSchema);
    }
    this.uiSchemaCache.set(documentTypeKey, uiSchema);
    return structuredClone(uiSchema);
  }

  async getDocumentSchema(documentTypeKey: string): Promise<AbstractDataSchema | undefined> {
    if (this.docSchemaCache.has(documentTypeKey)) {
      const cached = this.docSchemaCache.get(documentTypeKey);
      return cached !== undefined ? structuredClone(cached) : undefined;
    }

    const rawDocsByKey = await this.getRawDocsByKey();
    return this.resolveDocumentSchema(documentTypeKey, rawDocsByKey.get(documentTypeKey));
  }

  async getDisplayName(documentTypeKey: string): Promise<string | undefined> {
    if (this.displayNameCache.has(documentTypeKey)) {
      return this.displayNameCache.get(documentTypeKey);
    }

    const rawDocsByKey = await this.getRawDocsByKey();
    if (this.displayNameCache.has(documentTypeKey)) {
      return this.displayNameCache.get(documentTypeKey);
    }

    const rawDoc = rawDocsByKey.get(documentTypeKey);
    const displayName = rawDoc ? (rawDoc.name ?? rawDoc.displayName ?? rawDoc.key) : undefined;
    this.displayNameCache.set(documentTypeKey, displayName);
    return displayName;
  }
}

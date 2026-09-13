import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  DocumentSpaceManifestRegistryPort,
  DocumentSpaceStoragePort,
} from './ports';

export const StorageContextConfigSchema = Type.Record(Type.String(), Type.Unknown());

export type StorageContextConfig = Static<typeof StorageContextConfigSchema>;

export const DocumentSpaceTypeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  allowedDocumentTypes: Type.Array(Type.String()),
  storageConfig: StorageContextConfigSchema,
  spaceUiSchema: Type.Optional(Type.Unknown()),
});

export type DocumentSpaceType = Static<typeof DocumentSpaceTypeSchema>;

export const DocumentSpaceSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  typeId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  abstractStorageId: Type.String({ minLength: 1 }),
});

export type DocumentSpace = Static<typeof DocumentSpaceSchema>;

export const DocumentSpaceCollectionSchema = Type.Object({
  type: DocumentSpaceTypeSchema,
  spaces: Type.Array(DocumentSpaceSchema),
});

export type DocumentSpaceCollection = Static<typeof DocumentSpaceCollectionSchema>;

export const StorageLocationSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  abstractStorageId: Type.String({ minLength: 1 }),
});

export type StorageLocation = Static<typeof StorageLocationSchema>;

export function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

export class DocumentSpaceService {
  private spaceTypes = new Map<string, DocumentSpaceType>();

  constructor(
    private readonly manifestRegistry: DocumentSpaceManifestRegistryPort,
    private readonly storagePort: DocumentSpaceStoragePort
  ) {}

  async initialize(): Promise<void> {
    const rawTypes = await this.manifestRegistry.getDocumentSpaceTypes();

    this.spaceTypes.clear();

    for (const spaceType of rawTypes ?? []) {
      if (!Value.Check(DocumentSpaceTypeSchema, spaceType)) {
        const errors = formatValidationErrors(DocumentSpaceTypeSchema, spaceType);
        throw new Error(`Invalid DocumentSpaceType schema: ${errors.join(', ')}`);
      }
      this.spaceTypes.set(spaceType.id, spaceType);
    }
  }

  getType(typeId: string): DocumentSpaceType {
    const spaceType = this.spaceTypes.get(typeId);
    if (!spaceType) {
      throw new Error(`DocumentSpaceType "${typeId}" not found`);
    }
    return spaceType;
  }

  hasType(typeId: string): boolean {
    return this.spaceTypes.has(typeId);
  }

  getAllTypes(): DocumentSpaceType[] {
    return Array.from(this.spaceTypes.values());
  }

  async getCollection(typeId: string): Promise<DocumentSpaceCollection> {
    const spaceType = this.getType(typeId);
    const spaces = await this.storagePort.fetchSpaces(
      spaceType.storageConfig,
      spaceType.id
    );

    return {
      type: spaceType,
      spaces,
    };
  }

  async validateEndToEnd(): Promise<string[]> {
    const errors: string[] = [];
    const allTypes = this.getAllTypes();

    for (const spaceType of allTypes) {
      try {
        await this.getCollection(spaceType.id);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        errors.push(
          `DocumentSpaceType "${spaceType.id}" failed end-to-end validation: ${errorMessage}`
        );
      }
    }

    return errors;
  }
}

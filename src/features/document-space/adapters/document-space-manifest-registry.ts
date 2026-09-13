import { Value } from '@sinclair/typebox/value';
import { DocumentSpaceTypeSchema, type DocumentSpaceType } from '../domain';
import type {
  DocumentSpaceManifestRegistryPort,
  EvaluationOrderEnsurer,
  RawManifestProviderPort,
} from '../ports';
import { SpaceUiSchemaType, type SpaceUiSchema } from '../ports';

export class DocumentSpaceManifestRegistryAdapter
  implements DocumentSpaceManifestRegistryPort
{
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer
  ) {}

  async getDocumentSpaceTypes(): Promise<DocumentSpaceType[]> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as {
      DocumentSpaceTypes?: unknown[];
    };
    const rawSpaces = rawManifest?.DocumentSpaceTypes ?? [];
    const documentSpaceTypes: DocumentSpaceType[] = [];

    for (const rawSpace of rawSpaces) {
      const rawSpaceRecord = rawSpace as { id?: string; spaceUiSchema?: unknown };
      if (rawSpaceRecord?.spaceUiSchema) {
        const cleanedUi = Value.Clean(
          SpaceUiSchemaType,
          structuredClone(rawSpaceRecord.spaceUiSchema)
        );
        if (!Value.Check(SpaceUiSchemaType, cleanedUi)) {
          const errors = [...Value.Errors(SpaceUiSchemaType, cleanedUi)]
            .map((e) => `${e.path}: ${e.message}`)
            .join(', ');
          throw new Error(
            `Invalid DocumentSpaceType UI schema "${rawSpaceRecord.id ?? ''}": ${errors}`
          );
        }

        const spaceUi = cleanedUi as SpaceUiSchema;
        if (this.evaluationOrderEnsurer) {
          try {
            this.evaluationOrderEnsurer(spaceUi);
            (rawSpaceRecord.spaceUiSchema as Record<string, unknown>).evaluationOrder =
              spaceUi.evaluationOrder;
          } catch (error) {
            throw new Error(
              `Invalid DocumentSpaceType UI schema "${rawSpaceRecord.id ?? ''}": ${(error as Error).message}`,
              { cause: error }
            );
          }
        }
      }

      const cloned = structuredClone(rawSpace);
      const cleaned = Value.Clean(DocumentSpaceTypeSchema, cloned);
      if (!Value.Check(DocumentSpaceTypeSchema, cleaned)) {
        const errors = [...Value.Errors(DocumentSpaceTypeSchema, cleaned)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        throw new Error(`Invalid DocumentSpaceType schema: ${errors}`);
      }

      documentSpaceTypes.push(cleaned as DocumentSpaceType);
    }

    return documentSpaceTypes;
  }
}

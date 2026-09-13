import { Value } from '@sinclair/typebox/value';
import type {
  DocumentSpaceUiSchemaQueryPort,
  EvaluationOrderEnsurer,
  RawManifestProviderPort,
  SpaceUiSchema,
} from '../ports';
import { SpaceUiSchemaType } from '../ports';

interface ManifestWithDocumentSpaceTypes {
  DocumentSpaceTypes?: Array<Record<string, unknown>>;
}

export class DocumentSpaceUiSchemaQueryAdapter implements DocumentSpaceUiSchemaQueryPort {
  constructor(
    private readonly manifestProvider: RawManifestProviderPort,
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer
  ) {}

  async getSpaceUiSchema(spaceTypeKey: string): Promise<SpaceUiSchema | undefined> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as ManifestWithDocumentSpaceTypes | undefined;
    const spaceTypes = rawManifest?.DocumentSpaceTypes ?? [];

    for (const spaceType of spaceTypes) {
      const id = spaceType.id ?? spaceType.key;
      if (id === spaceTypeKey && spaceType.spaceUiSchema) {
        const cleaned = Value.Clean(
          SpaceUiSchemaType,
          structuredClone(spaceType.spaceUiSchema)
        );
        if (Value.Check(SpaceUiSchemaType, cleaned)) {
          const spaceUiSchema = cleaned as SpaceUiSchema;
          if (this.evaluationOrderEnsurer) {
            this.evaluationOrderEnsurer(spaceUiSchema);
          }
          return spaceUiSchema;
        }
      }
    }

    return undefined;
  }
}

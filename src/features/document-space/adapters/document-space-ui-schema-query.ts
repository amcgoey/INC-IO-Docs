import type {
  DocumentSpaceUiSchemaQueryPort,
  EvaluationOrderEnsurer,
  RawManifestProviderPort,
  SpaceUiSchema,
} from '../ports';
import { parseAndValidateSpaceUiSchema } from './space-ui-schema-parser';

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
        return parseAndValidateSpaceUiSchema(
          spaceType.spaceUiSchema,
          spaceTypeKey,
          this.evaluationOrderEnsurer
        );
      }
    }

    return undefined;
  }
}

import type {
  DocumentSpaceManifestRegistryPort,
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
    private readonly evaluationOrderEnsurer?: EvaluationOrderEnsurer,
    private readonly spaceManifestRegistry?: DocumentSpaceManifestRegistryPort
  ) {}

  async getSpaceUiSchema(spaceTypeKey: string): Promise<SpaceUiSchema | undefined> {
    if (this.spaceManifestRegistry) {
      const spaceTypes = await this.spaceManifestRegistry.getDocumentSpaceTypes();
      const space = spaceTypes.find(
        (s) => s.id === spaceTypeKey || (s as unknown as { key?: string }).key === spaceTypeKey
      );
      return space?.spaceUiSchema as SpaceUiSchema | undefined;
    }
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

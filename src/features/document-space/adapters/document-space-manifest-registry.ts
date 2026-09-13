import { Value } from '@sinclair/typebox/value';
import { DocumentSpaceTypeSchema, type DocumentSpaceType } from '../domain';
import type {
  DocumentSpaceManifestRegistryPort,
  EvaluationOrderEnsurer,
  RawManifestProviderPort,
} from '../ports';
import { parseAndValidateSpaceUiSchema } from './space-ui-schema-parser';

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
      const cloned = structuredClone(rawSpace) as Record<string, unknown>;
      if (cloned?.spaceUiSchema) {
        const spaceUi = parseAndValidateSpaceUiSchema(
          cloned.spaceUiSchema,
          (cloned.id as string) ?? '',
          this.evaluationOrderEnsurer
        );
        if (spaceUi) {
          cloned.spaceUiSchema = spaceUi;
        }
      }

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

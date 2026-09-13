import { Value } from '@sinclair/typebox/value';
import { DocumentSpaceTypeSchema, type DocumentSpaceType } from '../domain';
import type {
  DocumentSpaceManifestRegistryPort,
  RawManifestProviderPort,
} from '../ports';
import {
  ensureEvaluationOrder,
  type ContainerWithLayoutLike,
} from '../../../infrastructure/validation/json-logic-graph';

export class DocumentSpaceManifestRegistryAdapter
  implements DocumentSpaceManifestRegistryPort
{
  constructor(private readonly manifestProvider: RawManifestProviderPort) {}

  async getDocumentSpaceTypes(): Promise<DocumentSpaceType[]> {
    const rawManifest = (await this.manifestProvider.getRawManifest()) as {
      DocumentSpaceTypes?: unknown[];
    };
    const rawSpaces = rawManifest?.DocumentSpaceTypes ?? [];
    const documentSpaceTypes: DocumentSpaceType[] = [];

    for (const rawSpace of rawSpaces) {
      const rawSpaceRecord = rawSpace as { id?: string; spaceUiSchema?: unknown };
      if (rawSpaceRecord?.spaceUiSchema && typeof rawSpaceRecord.spaceUiSchema === 'object') {
        try {
          ensureEvaluationOrder(rawSpaceRecord.spaceUiSchema as ContainerWithLayoutLike);
        } catch (error) {
          throw new Error(
            `Invalid DocumentSpaceType UI schema "${rawSpaceRecord.id ?? ''}": ${(error as Error).message}`,
            { cause: error }
          );
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

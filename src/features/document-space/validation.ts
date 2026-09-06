import type { DocumentSpaceService } from './domain';

/**
 * Validates DocumentSpaceTypes end-to-end by attempting to fetch their spaces.
 * This can be used in tests and during application startup to verify storage configurations.
 */
export async function validateDocumentSpaceTypes(
  service: DocumentSpaceService
): Promise<string[]> {
  const errors: string[] = [];
  const allTypes = service.getAllTypes();

  for (const spaceType of allTypes) {
    try {
      await service.getCollection(spaceType.id);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      errors.push(
        `DocumentSpaceType "${spaceType.id}" failed end-to-end validation: ${errorMessage}`
      );
    }
  }

  return errors;
}

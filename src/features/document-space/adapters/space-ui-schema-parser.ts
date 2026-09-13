import { Value } from '@sinclair/typebox/value';
import { SpaceUiSchemaType, type SpaceUiSchema, type EvaluationOrderEnsurer } from '../ports';

export function parseAndValidateSpaceUiSchema(
  rawSpaceUiSchema: unknown,
  spaceTypeId: string = '',
  evaluationOrderEnsurer?: EvaluationOrderEnsurer
): SpaceUiSchema | undefined {
  if (!rawSpaceUiSchema || typeof rawSpaceUiSchema !== 'object') {
    return undefined;
  }

  const cleaned = Value.Clean(
    SpaceUiSchemaType,
    structuredClone(rawSpaceUiSchema)
  );

  if (!Value.Check(SpaceUiSchemaType, cleaned)) {
    const errors = [...Value.Errors(SpaceUiSchemaType, cleaned)]
      .map((e) => `${e.path}: ${e.message}`)
      .join(', ');
    throw new Error(
      `Invalid DocumentSpaceType UI schema "${spaceTypeId}": ${errors}`
    );
  }

  let spaceUi = cleaned as SpaceUiSchema;
  if (evaluationOrderEnsurer) {
    try {
      spaceUi = (evaluationOrderEnsurer(spaceUi) as SpaceUiSchema) ?? spaceUi;
    } catch (error) {
      throw new Error(
        `Invalid DocumentSpaceType UI schema "${spaceTypeId}": ${(error as Error).message}`,
        { cause: error }
      );
    }
  }

  return spaceUi;
}

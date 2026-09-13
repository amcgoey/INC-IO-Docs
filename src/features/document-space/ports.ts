import { Type, type Static, type TSchema, type TTuple } from '@sinclair/typebox';
import type {
  DocumentSpace,
  DocumentSpaceCollection,
  DocumentSpaceType,
  StorageContextConfig,
  StorageLocation,
} from './domain';

export type {
  DocumentSpace,
  DocumentSpaceCollection,
  DocumentSpaceType,
  StorageContextConfig,
  StorageLocation,
};

const DataVarString = Type.String({ pattern: '^data(\\..+)?$' });

const createBinaryOp = <K extends string, S extends TSchema>(op: K, schema: S) =>
  Type.Object({ [op]: Type.Tuple([schema, schema]) } as { [P in K]: TTuple<[S, S]> }, {
    additionalProperties: false,
  });

export const JSONLogicRuleType = Type.Recursive(
  (Self) => {
    const RuleOrPlainObject = Type.Union([
      Self,
      Type.Record(Type.String(), Type.Unknown()),
    ]);

    return Type.Union([
      // Primitives
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
      Type.Array(Self),
      // Comparison Operators
      createBinaryOp('==', Self),
      createBinaryOp('!=', Self),
      createBinaryOp('<', Self),
      createBinaryOp('>', Self),
      createBinaryOp('<=', Self),
      createBinaryOp('>=', Self),
      // Arithmetic Operators
      createBinaryOp('+', Self),
      Type.Object({ '+': Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      createBinaryOp('-', Self),
      Type.Object({ '-': Type.Union([Type.Tuple([Self]), Type.Tuple([Self, Self])]) }, { additionalProperties: false }),
      createBinaryOp('*', Self),
      Type.Object({ '*': Type.Array(Self, { minItems: 2 }) }, { additionalProperties: false }),
      createBinaryOp('/', Self),
      createBinaryOp('%', Self),
      // Logical Operators
      Type.Object({ and: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ or: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ '!': Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
      Type.Object({ '!!': Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
      // Data Access
      Type.Object(
        {
          var: Type.Union([
            DataVarString,
            Type.Tuple([DataVarString]),
            Type.Tuple([DataVarString, RuleOrPlainObject]),
          ]),
        },
        { additionalProperties: false }
      ),
      // Utility Operators
      Type.Object({ cat: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ in: Type.Tuple([Self, RuleOrPlainObject]) }, { additionalProperties: false }),
      Type.Object({ log: Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
    ]);
  },
  { $id: 'SpaceJSONLogicRule' }
);

export type JSONLogicRule = Static<typeof JSONLogicRuleType>;

export const SpaceUiFieldSchema = Type.Object({
  widget: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  showIf: Type.Optional(JSONLogicRuleType),
  disableIf: Type.Optional(JSONLogicRuleType),
  computeValue: Type.Optional(JSONLogicRuleType),
});

export type SpaceUiField = Static<typeof SpaceUiFieldSchema>;

export const SpaceUiSchemaType = Type.Object({
  layout: Type.Optional(Type.Array(Type.String())),
  fields: Type.Optional(Type.Record(Type.String(), SpaceUiFieldSchema)),
  evaluationOrder: Type.Optional(Type.Array(Type.String())),
});

export type SpaceUiSchema = Static<typeof SpaceUiSchemaType>;

export interface DocumentSpaceUiSchemaQueryPort {
  getSpaceUiSchema(spaceTypeKey: string): Promise<SpaceUiSchema | undefined>;
}

export interface DocumentSpaceManifestRegistryPort {
  getDocumentSpaceTypes(): Promise<DocumentSpaceType[]>;
}

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
}

export type SchemaOrKeys =
  | string[]
  | { fields?: Array<{ key: string }> | Record<string, unknown> }
  | Record<string, unknown>;

export type EvaluationOrderEnsurer = <
  T extends { layout?: string[]; fields?: Record<string, unknown>; evaluationOrder?: string[] }
>(
  container?: T,
  schemaOrKeys?: SchemaOrKeys
) => (T & { evaluationOrder?: string[] }) | undefined;

export interface DocumentSpaceStoragePort {
  fetchSpaces(config: StorageContextConfig, typeId: string): Promise<DocumentSpace[]>;
  resolveStorageLocation(abstractStorageId: string): Promise<StorageLocation>;
}



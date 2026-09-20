import { Type, type Static } from '@sinclair/typebox';

export const AbstractDataFieldSchema = Type.Object({
  key: Type.String(),
  type: Type.Optional(Type.String()),
  options: Type.Optional(Type.Unknown()),
  defaultValue: Type.Optional(Type.Unknown()),
});

export type AbstractDataField = Static<typeof AbstractDataFieldSchema>;

export const AbstractDataSchema = Type.Object({
  fields: Type.Array(AbstractDataFieldSchema),
});

export type AbstractDataSchema = Static<typeof AbstractDataSchema>;

import { Type, type Static } from '@sinclair/typebox';

export const LookupOptionStatusSchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('empty'),
  Type.Literal('missing_space'),
  Type.Literal('path_not_found'),
  Type.Literal('ambiguous_path'),
  Type.Literal('missing_log'),
  Type.Literal('ambiguous_log'),
  Type.Literal('config_error'),
  Type.Literal('timeout'),
  Type.Literal('error'),
]);
export type LookupOptionStatus = Static<typeof LookupOptionStatusSchema>;

export const LookupValidationStatusSchema = Type.Union([
  Type.Literal('valid'),
  Type.Literal('missing_space'),
  Type.Literal('path_not_found'),
  Type.Literal('ambiguous_path'),
  Type.Literal('missing_log'),
  Type.Literal('ambiguous_log'),
  Type.Literal('config_error'),
  Type.Literal('option_not_found'),
  Type.Literal('ambiguous_option'),
  Type.Literal('timeout'),
  Type.Literal('error'),
]);
export type LookupValidationStatus = Static<typeof LookupValidationStatusSchema>;

export const LookupOptionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
});
export type LookupOptionItem = Static<typeof LookupOptionItemSchema>;

export const LookupOptionTupleSchema = Type.Intersect([
  Type.Object({
    key: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    aliases: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);
export type LookupOptionTuple = Static<typeof LookupOptionTupleSchema>;

export const LookupFieldOptionsSchema = Type.Object({
  source: Type.String({ minLength: 1 }),
  key: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
  allowUserInput: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type LookupFieldOptions = Static<typeof LookupFieldOptionsSchema>;

export const LookupLinkedFieldSchema = Type.Object({
  sourceField: Type.String({ minLength: 1 }),
  sourceProperty: Type.String({ minLength: 1 }),
});
export type LookupLinkedField = Static<typeof LookupLinkedFieldSchema>;

export const LookupFieldSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Union([LookupFieldOptionsSchema, Type.Undefined()])),
  linkedField: Type.Optional(Type.Union([LookupLinkedFieldSchema, Type.Undefined()])),
});
export type LookupField = Static<typeof LookupFieldSchema>;

export const LookupDocumentLogOptionSourceSchema = Type.Object({
  provider: Type.Literal('document_log'),
  properties: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
export type LookupDocumentLogOptionSource = Static<typeof LookupDocumentLogOptionSourceSchema>;

export const LookupGoogleDriveOptionSourceSchema = Type.Object({
  provider: Type.Literal('google_drive'),
  method: Type.Optional(Type.Union([Type.Literal('list_folders'), Type.Undefined()])),
  relativePath: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
  properties: Type.Optional(
    Type.Union([Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), Type.Undefined()])
  ),
});
export type LookupGoogleDriveOptionSource = Static<typeof LookupGoogleDriveOptionSourceSchema>;

export const LookupOptionSourceSchema = Type.Union([
  LookupDocumentLogOptionSourceSchema,
  LookupGoogleDriveOptionSourceSchema,
]);
export type LookupOptionSource = Static<typeof LookupOptionSourceSchema>;

export const LookupDocumentSchemaSchema = Type.Object({
  fields: Type.Array(LookupFieldSchema),
  options: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Array(LookupOptionTupleSchema)), Type.Undefined()])
  ),
  optionSources: Type.Optional(
    Type.Union([Type.Record(Type.String({ minLength: 1 }), LookupOptionSourceSchema), Type.Undefined()])
  ),
});
export type LookupDocumentSchema = Static<typeof LookupDocumentSchemaSchema>;

export const LookupSpaceContextSchema = Type.Object({
  id: Type.String(),
  typeId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  abstractStorageId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type LookupSpaceContext = Static<typeof LookupSpaceContextSchema>;

export const LookupOptionsCallContextSchema = Type.Object({
  space: Type.Optional(Type.Union([LookupSpaceContextSchema, Type.Undefined()])),
  documentTypeKey: Type.String({ minLength: 1 }),
  selectedLogId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type LookupOptionsCallContext = Static<typeof LookupOptionsCallContextSchema>;

export const LookupSourceResolutionSchema = Type.Object({
  status: LookupOptionStatusSchema,
  tuples: Type.Array(LookupOptionTupleSchema),
  items: Type.Array(LookupOptionItemSchema),
  targetPath: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  errorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type LookupSourceResolution = Static<typeof LookupSourceResolutionSchema>;

export const LookupMatchResultSchema = Type.Object({
  matched: Type.Boolean(),
  key: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  tuple: Type.Optional(Type.Union([LookupOptionTupleSchema, Type.Undefined()])),
});
export type LookupMatchResult = Static<typeof LookupMatchResultSchema>;

export const LookupFieldValidationQuerySchema = Type.Object({
  queryId: Type.String(),
  fieldKey: Type.String(),
  sourceKey: Type.String(),
  value: Type.String(),
  allowUserInput: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type LookupFieldValidationQuery = Static<typeof LookupFieldValidationQuerySchema>;

export const LookupFieldValidationResultSchema = Type.Object({
  isValid: Type.Boolean(),
  status: LookupValidationStatusSchema,
  targetPath: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  matchedTuple: Type.Optional(Type.Union([LookupOptionTupleSchema, Type.Undefined()])),
  canonicalValue: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  errorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type LookupFieldValidationResult = Static<typeof LookupFieldValidationResultSchema>;

export const LookupInvalidationScopeSchema = Type.Object({
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectedLogId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type LookupInvalidationScope = Static<typeof LookupInvalidationScopeSchema>;

export const DriveOptionFolderResultSchema = Type.Union([
  Type.Object({
    status: Type.Literal('ready'),
    items: Type.Array(LookupOptionTupleSchema),
    targetPath: Type.String(),
    truncated: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  }),
  Type.Object({
    status: Type.Literal('empty'),
    items: Type.Tuple([]),
    targetPath: Type.String(),
    truncated: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  }),
  Type.Object({
    status: Type.Union([Type.Literal('path_not_found'), Type.Literal('ambiguous_path')]),
    items: Type.Tuple([]),
    targetPath: Type.String(),
  }),
]);
export type DriveOptionFolderResult = Static<typeof DriveOptionFolderResultSchema>;

export interface DriveOptionSourcePort {
  listFoldersAtPath(params: {
    spaceStorageId: string;
    relativePath?: string | undefined;
    maxItems?: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<DriveOptionFolderResult>;

  validateFolderExistence?(params: {
    spaceStorageId: string;
    relativePath?: string | undefined;
    value: string;
    allowUserInput?: boolean | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{
    isValid: boolean;
    status: LookupValidationStatus;
    targetPath: string;
    matchedTuple?: LookupOptionTuple | undefined;
  }>;
}

export const DocumentLogOptionTableEntrySchema = Type.Object({
  status: Type.Union([Type.Literal('ready'), Type.Literal('config_error')]),
  tuples: Type.Array(LookupOptionTupleSchema),
  errorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type DocumentLogOptionTableEntry = Static<typeof DocumentLogOptionTableEntrySchema>;

export const DocumentLogOptionTablesBatchResultSchema = Type.Union([
  Type.Object({
    status: Type.Literal('missing_space'),
    tables: Type.Record(Type.String(), DocumentLogOptionTableEntrySchema),
  }),
  Type.Object({
    status: Type.Literal('missing_log'),
    expectedFolderPath: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    tables: Type.Record(Type.String(), DocumentLogOptionTableEntrySchema),
  }),
  Type.Object({
    status: Type.Literal('ambiguous_log'),
    errorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    tables: Type.Record(Type.String(), DocumentLogOptionTableEntrySchema),
  }),
  Type.Object({
    status: Type.Literal('config_error'),
    errorMessage: Type.String(),
    tables: Type.Record(Type.String(), DocumentLogOptionTableEntrySchema),
  }),
  Type.Object({
    status: Type.Literal('ready'),
    spreadsheetId: Type.String(),
    tables: Type.Record(Type.String(), DocumentLogOptionTableEntrySchema),
  }),
]);
export type DocumentLogOptionTablesBatchResult = Static<typeof DocumentLogOptionTablesBatchResultSchema>;

export interface DocumentLogOptionSourcePort {
  readOptionTables(params: {
    documentTypeKey: string;
    space?: LookupSpaceContext | undefined;
    selectedLogId?: string | undefined;
    sourceKeys?: readonly string[] | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<DocumentLogOptionTablesBatchResult>;
}

export interface LookupManifestPort {
  getDocumentSchema(
    documentTypeKey: string
  ): Promise<LookupDocumentSchema | undefined> | LookupDocumentSchema | undefined;
}

export interface LookupOptionsPort {
  resolveOptions(
    context: LookupOptionsCallContext,
    sourceKeys?: readonly string[]
  ): Promise<Record<string, LookupSourceResolution>>;

  getCanonicalOptions(
    context: LookupOptionsCallContext,
    fieldKey: string
  ): Promise<LookupOptionTuple[]>;

  matchOption(
    context: LookupOptionsCallContext,
    fieldKey: string,
    candidate: string
  ): Promise<LookupMatchResult>;

  validateFields(
    context: LookupOptionsCallContext,
    queries: readonly LookupFieldValidationQuery[]
  ): Promise<Record<string, LookupFieldValidationResult>>;

  deriveLockedFields(
    context: LookupOptionsCallContext,
    formData: Readonly<Record<string, unknown>>
  ): Promise<Record<string, string>>;

  invalidate(scope?: LookupInvalidationScope): void;
}

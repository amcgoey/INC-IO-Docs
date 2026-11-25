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

export interface LookupSourceResolution {
  status: LookupOptionStatus;
  tuples: LookupOptionTuple[];
  items: LookupOptionItem[];
  targetPath?: string | undefined;
  errorMessage?: string | undefined;
}

export interface LookupMatchResult {
  matched: boolean;
  key?: string | undefined;
  tuple?: LookupOptionTuple | undefined;
}

export interface LookupFieldValidationQuery {
  queryId: string;
  fieldKey: string;
  sourceKey: string;
  value: string;
  allowUserInput?: boolean | undefined;
}

export interface LookupFieldValidationResult {
  isValid: boolean;
  status: LookupValidationStatus;
  targetPath?: string | undefined;
  matchedTuple?: LookupOptionTuple | undefined;
  canonicalValue?: string | undefined;
  errorMessage?: string | undefined;
}

export interface LookupInvalidationScope {
  spaceId?: string | undefined;
  documentTypeKey?: string | undefined;
  selectedLogId?: string | undefined;
}

export type DriveOptionFolderResult =
  | {
      status: 'ready';
      items: LookupOptionTuple[];
      targetPath: string;
      truncated?: boolean | undefined;
    }
  | {
      status: 'empty';
      items: [];
      targetPath: string;
      truncated?: boolean | undefined;
    }
  | {
      status: 'path_not_found' | 'ambiguous_path';
      items: [];
      targetPath: string;
    };

export interface DriveOptionSourcePort {
  listFoldersAtPath(params: {
    spaceStorageId: string;
    relativePath?: string | undefined;
    maxItems?: number | undefined;
  }): Promise<DriveOptionFolderResult>;

  validateFolderExistence?(params: {
    spaceStorageId: string;
    relativePath?: string | undefined;
    value: string;
    allowUserInput?: boolean | undefined;
  }): Promise<{
    isValid: boolean;
    status: LookupValidationStatus;
    targetPath: string;
    matchedTuple?: LookupOptionTuple | undefined;
  }>;
}

export interface DocumentLogOptionTableEntry {
  status: 'ready' | 'config_error';
  tuples: LookupOptionTuple[];
  errorMessage?: string | undefined;
}

export type DocumentLogOptionTablesBatchResult =
  | {
      status: 'missing_space';
      tables: Record<string, DocumentLogOptionTableEntry>;
    }
  | {
      status: 'missing_log';
      expectedFolderPath?: string | undefined;
      tables: Record<string, DocumentLogOptionTableEntry>;
    }
  | {
      status: 'config_error';
      errorMessage: string;
      tables: Record<string, DocumentLogOptionTableEntry>;
    }
  | {
      status: 'ready';
      spreadsheetId: string;
      tables: Record<string, DocumentLogOptionTableEntry>;
    };

export interface DocumentLogOptionSourcePort {
  readOptionTables(params: {
    documentTypeKey: string;
    space?: LookupSpaceContext | undefined;
    selectedLogId?: string | undefined;
    sourceKeys?: readonly string[] | undefined;
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

  invalidate(scope?: LookupInvalidationScope): void;
}

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { TypeCheck } from '@sinclair/typebox/compiler';
import {
  UiEventType,
  UiEventRuleType,
  DocumentUiEventsSchema,
  SourceFileSchema,
  SourceFileType,
  OPTION_NOT_FOUND_MSG,
  VALIDATION_TIMEOUT_MSG,
  LinkedFieldSchema,
  OptionSourceSchema,
  DocumentLogOptionSourceSchema,
  GoogleDriveOptionSourceSchema,
  CalculatedFieldTransformSchema,
  CalculatedFieldLookupSchema,
  type Activity,
  type ActivityExecutionContext,
  type ActivityOutput,
  type FileLocator,
  type SourceFile,
  type ProcessDocumentResult,
  type DocumentType,
  type UiEvent,
  type UiEventRule,
  type Document,
  type DocumentModel,
  type LinkedField,
  type OptionSource,
  type DocumentLogOptionSource,
  type GoogleDriveOptionSource,
} from './domain';

export {
  UiEventType,
  type UiEvent,
  UiEventRuleType,
  type UiEventRule,
  SourceFileSchema,
  SourceFileType,
  type SourceFile,
  OPTION_NOT_FOUND_MSG,
  VALIDATION_TIMEOUT_MSG,
  LinkedFieldSchema,
  type LinkedField,
  OptionSourceSchema,
  type OptionSource,
  DocumentLogOptionSourceSchema,
  type DocumentLogOptionSource,
  GoogleDriveOptionSourceSchema,
  type GoogleDriveOptionSource,
};

export type SchemaOrKeys =
  | string[]
  | { fields?: Array<{ key: string }> | Record<string, unknown> }
  | Record<string, unknown>;

export type EvaluationOrderCalculator = (
  schemaOrKeys?: SchemaOrKeys,
  uiSchema?: { layout?: string[]; fields?: Record<string, { computeValue?: unknown }> }
) => string[];

export type EvaluationOrderEnsurer = <
  T extends { layout?: string[]; fields?: Record<string, unknown>; evaluationOrder?: string[] }
>(
  container?: T,
  schemaOrKeys?: SchemaOrKeys
) => (T & { evaluationOrder?: string[] }) | undefined;

export const FormDocumentFieldOptionType = Type.Object({
  source: Type.String(),
  key: Type.String(),
  name: Type.Optional(Type.String()),
  allowUserInput: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export type FormDocumentFieldOption = Static<typeof FormDocumentFieldOptionType>;

export const FormDocumentFieldType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  type: Type.String(),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  defaultValue: Type.Optional(Type.String()),
  format: Type.Optional(Type.String()),
  options: Type.Optional(FormDocumentFieldOptionType),
  linkedField: Type.Optional(LinkedFieldSchema),
}, { additionalProperties: true });

export type FormDocumentField = Static<typeof FormDocumentFieldType>;

export const FormDocumentCalculatedFieldType = Type.Object({
  key: Type.String(),
  name: Type.Optional(Type.String()),
  template: Type.String(),
  description: Type.Optional(Type.String()),
  transforms: Type.Optional(
    Type.Union([Type.Array(CalculatedFieldTransformSchema, { minItems: 1 }), Type.Undefined()])
  ),
  lookup: Type.Optional(
    Type.Union([CalculatedFieldLookupSchema, Type.Undefined()])
  ),
  required: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
}, { additionalProperties: true });

export type FormDocumentCalculatedField = Static<typeof FormDocumentCalculatedFieldType>;

export const FormDocumentSchemaType = Type.Object({
  fields: Type.Array(FormDocumentFieldType),
  calculatedFields: Type.Optional(Type.Array(FormDocumentCalculatedFieldType)),
  identity: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  options: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.Unknown())))),
  optionSources: Type.Optional(
    Type.Union([Type.Record(Type.String({ minLength: 1 }), OptionSourceSchema), Type.Undefined()])
  ),
}, { additionalProperties: true });

export type FormDocumentSchema = Static<typeof FormDocumentSchemaType>;

export const FormSchemaType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  documentSchema: FormDocumentSchemaType,
  documentUiSchema: Type.Optional(DocumentUiEventsSchema),
  allowEmptySourceFiles: Type.Optional(Type.Boolean()),
  maxSourceFiles: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type FormSchema = Static<typeof FormSchemaType>;

export type {
  ActivityExecutionContext,
  FileLocator,
  ActivityOutput,
  ProcessDocumentResult,
  DocumentType,
  Document,
  DocumentModel,
};

export interface ActivityHandler {
  canHandle(activity: Activity): boolean;
  handle(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput | void> | ActivityOutput | void;
}

export interface SourceFileHydratorPort {
  hydrate(sourceFiles: SourceFile[]): Promise<SourceFile[]>;
}

export interface ActivityDispatcherPort {
  dispatch(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput | void> | ActivityOutput | void;
}

export interface DocumentServicePort {
  validateDocument?(
    document: Document
  ): Promise<{ success: boolean; errors?: string[] }>;
  processDocument(
    payload?: unknown,
    eventName?: string
  ): Promise<ProcessDocumentResult>;
}

export const DynamicValidationQuerySchema = Type.Object({
  sourceKey: Type.String(),
  fieldKey: Type.Optional(Type.String()),
  valueToValidate: Type.String(),
  queryId: Type.String(),
  allowUserInput: Type.Optional(Type.Boolean()),
});

export type DynamicValidationQuery = Static<typeof DynamicValidationQuerySchema>;

export const DynamicValidationStatusSchema = Type.Union([
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

export type DynamicValidationStatus = Static<typeof DynamicValidationStatusSchema>;

export const DynamicValidationResultSchema = Type.Object({
  isValid: Type.Boolean(),
  status: Type.Optional(DynamicValidationStatusSchema),
  targetPath: Type.Optional(Type.String()),
  matchedTuple: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  errorMessage: Type.Optional(Type.String()),
});

export type DynamicValidationResult = Static<typeof DynamicValidationResultSchema>;

export type DynamicValidationMessageFormatter = (
  status: DynamicValidationStatus,
  targetPath?: string
) => string;

export const DynamicValidationSpaceSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  typeId: Type.String(),
  abstractStorageId: Type.String(),
});

export const DynamicValidationContextSchema = Type.Object({
  spaceId: Type.Optional(Type.String()),
  space: Type.Optional(DynamicValidationSpaceSchema),
  documentTypeKey: Type.Optional(Type.String()),
  selectedLogId: Type.Optional(Type.String()),
  formData: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type DynamicValidationContext = Static<typeof DynamicValidationContextSchema>;

export interface DocumentDynamicValidationPort {
  validateExistence(
    queries: DynamicValidationQuery[],
    context: DynamicValidationContext
  ): Promise<Record<string, DynamicValidationResult>>;
}

export const DocumentOptionTableStatusSchema = Type.Union([
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

export type DocumentOptionTableStatus = Static<typeof DocumentOptionTableStatusSchema>;

export const DocumentOptionTableResolutionSchema = Type.Object({
  status: DocumentOptionTableStatusSchema,
  tuples: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  targetPath: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  errorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export type DocumentOptionTableResolution = Static<typeof DocumentOptionTableResolutionSchema>;

export const DocumentOptionTableContextSchema = Type.Object({
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  space: Type.Optional(Type.Union([DynamicValidationSpaceSchema, Type.Undefined()])),
  documentTypeKey: Type.String({ minLength: 1 }),
  selectedLogId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export type DocumentOptionTableContext = Static<typeof DocumentOptionTableContextSchema>;

export interface DocumentOptionTablePort {
  resolveOptionTables(
    sourceKeys: readonly string[],
    context: DocumentOptionTableContext
  ): Promise<Record<string, DocumentOptionTableResolution>>;
}


export interface DocumentSchemaRegistryPort {
  loadAll(): Promise<DocumentType[]>;
}

export interface CompiledSchemaRegistryPort {
  initialize(): Promise<void>;
  get(key: string): TypeCheck<TSchema> | undefined;
}

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema(relPath: string): Promise<unknown>;
}

export type TemplateEvaluationContext = { [key: string]: unknown };

export interface TemplateEvaluatorPort {
  validate(template: string, allowedVariables: string[]): boolean;
  evaluate(template: string, context: TemplateEvaluationContext): string;
}

export class DriveServiceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DriveServiceError';
  }
}

export class AmbiguousPathSpecError extends DriveServiceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AmbiguousPathSpecError';
  }
}

export class AmbiguousFileError extends DriveServiceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AmbiguousFileError';
  }
}

export class FileNotFoundError extends DriveServiceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FileNotFoundError';
  }
}

export class DriveFileTooLargeError extends DriveServiceError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DriveFileTooLargeError';
  }
}

export interface DriveSearchQuery {
  targetName: string;
  exactMatch?: boolean | undefined;
  sharedDriveId?: string | undefined;
  mimeTypes?: string[] | undefined;
  expectedParentPathNames?: string[] | undefined;
}

export interface DriveShortcutDetails {
  targetId?: string | undefined;
  targetMimeType?: string | undefined;
}

export interface DriveFileResult {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
  size?: number | undefined;
  webViewLink?: string | undefined;
  modifiedTime?: string | undefined;
  shortcutDetails?: DriveShortcutDetails | undefined;
}

export type DriveFile = DriveFileResult;

export interface DriveConfiguration {
  defaultFolderName?: string | undefined;
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  backoffFactor?: number | undefined;
}

export interface AppConfigurationProviderPort {
  getDriveConfig(): Promise<DriveConfiguration | undefined>;
  getMaxInMemoryFileBytes?(): Promise<number | undefined>;
}

export interface DriveDuplicateOptions {
  newName?: string | undefined;
  targetFolderId?: string | undefined;
}

/** Options for atomic Drive move and optional rename operations. */
export interface DriveMoveOptions {
  newName?: string | undefined;
}

export interface DriveContentCreateOptions {
  action: 'create';
  targetFolderId: string;
  name: string;
  mimeType?: string | undefined;
}

export interface DriveContentUpdateOptions {
  action: 'update';
  fileId: string;
  mimeType?: string | undefined;
}

export type DriveContentSaveOptions = DriveContentCreateOptions | DriveContentUpdateOptions;

export interface DriveServicePort {
  getFile(fileId: string): Promise<DriveFileResult>;
  findOrCreateFolder(parentId: string, folderName: string): Promise<DriveFileResult>;
  resolveFolderPath(rootFolderId: string, pathSegments: string[]): Promise<DriveFileResult>;
  move(
    fileId: string,
    targetFolderId: string,
    moveOptions?: DriveMoveOptions
  ): Promise<DriveFileResult>;
  rename(fileId: string, newName: string): Promise<DriveFileResult>;
  duplicate(
    fileId: string,
    duplicateOptions?: DriveDuplicateOptions
  ): Promise<DriveFileResult>;
  searchFiles(query: DriveSearchQuery): Promise<DriveFileResult[]>;
  downloadAsBuffer(fileId: string): Promise<Uint8Array>;
  saveBuffer(
    content: Uint8Array,
    saveOptions: DriveContentSaveOptions
  ): Promise<DriveFileResult>;
  uploadStream(
    stream: ReadableStream<Uint8Array>,
    saveOptions: DriveContentSaveOptions
  ): Promise<DriveFileResult>;
}

export const PrimaryTargetIdSchema = Type.String({
  minLength: 1,
  pattern: '^.*\\S+.*$',
});

export function validatePrimaryTargetId(
  targetId: unknown,
  callerName: string
): string | undefined {
  if (targetId === undefined) {
    return undefined;
  }
  if (!Value.Check(PrimaryTargetIdSchema, targetId)) {
    throw new Error(`${callerName}: primaryTargetId must be a non-empty string`);
  }
  return targetId as string;
}

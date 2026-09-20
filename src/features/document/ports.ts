import { Type, type Static } from '@sinclair/typebox';
import {
  UiEventType,
  UiEventRuleType,
  DocumentUiEventsSchema,
  type Activity,
  type ActivityOutput,
  type FileLocator,
  type ProcessDocumentResult,
  type DocumentType,
  type UiEvent,
  type UiEventRule,
} from './domain';

export {
  UiEventType,
  type UiEvent,
  UiEventRuleType,
  type UiEventRule,
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
  name: Type.String(),
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
}, { additionalProperties: true });

export type FormDocumentField = Static<typeof FormDocumentFieldType>;

export const FormDocumentCalculatedFieldType = Type.Object({
  key: Type.String(),
  template: Type.String(),
  description: Type.Optional(Type.String()),
}, { additionalProperties: true });

export type FormDocumentCalculatedField = Static<typeof FormDocumentCalculatedFieldType>;

export const FormDocumentSchemaType = Type.Object({
  fields: Type.Array(FormDocumentFieldType),
  calculatedFields: Type.Optional(Type.Array(FormDocumentCalculatedFieldType)),
  identity: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  options: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.Unknown())))),
}, { additionalProperties: true });

export type FormDocumentSchema = Static<typeof FormDocumentSchemaType>;

export const FormSchemaType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  documentSchema: FormDocumentSchemaType,
  documentUiSchema: Type.Optional(DocumentUiEventsSchema),
});

export type FormSchema = Static<typeof FormSchemaType>;

export const ExecutionContextSchema = Type.Object({
  credentials: Type.Optional(
    Type.Object({
      oauthToken: Type.Optional(Type.String()),
    })
  ),
  resources: Type.Optional(
    Type.Object({
      primaryTargetId: Type.Optional(Type.String()),
    })
  ),
});

export type ExecutionContext = Static<typeof ExecutionContextSchema>;

export type {
  FileLocator,
  ActivityOutput,
  ProcessDocumentResult,
  DocumentType,
};

export interface ActivityHandler {
  canHandle(activity: Activity): boolean;
  handle(
    activity: Activity,
    context?: ExecutionContext
  ): Promise<ActivityOutput | void> | ActivityOutput | void;
}

export interface ActivityDispatcherPort {
  dispatch(
    activity: Activity,
    context?: ExecutionContext
  ): Promise<ActivityOutput | void> | ActivityOutput | void;
}

export interface DocumentServicePort {
  processDocument(
    payload?: unknown,
    eventName?: string,
    context?: ExecutionContext
  ): Promise<ProcessDocumentResult>;
}


export interface DocumentSchemaRegistryPort {
  loadAll(): Promise<DocumentType[]>;
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

export interface DriveSearchQuery {
  targetName: string;
  exactMatch?: boolean | undefined;
  sharedDriveId?: string | undefined;
  mimeTypes?: string[] | undefined;
  expectedParentPathNames?: string[] | undefined;
}

export interface DriveFileResult {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
  webViewLink?: string | undefined;
}

export interface DriveConfiguration {
  defaultFolderName?: string | undefined;
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  backoffFactor?: number | undefined;
}

export interface AppConfigurationProviderPort {
  getDriveConfig(): Promise<DriveConfiguration | undefined>;
}

export interface DriveDuplicateOptions {
  newName?: string | undefined;
  targetFolderId?: string | undefined;
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

export interface DriveServiceOptions {
  auth?: string | undefined;
}

export interface DriveServicePort {
  getFile(fileId: string, options?: DriveServiceOptions): Promise<DriveFileResult>;
  findOrCreateFolder(parentId: string, folderName: string, options?: DriveServiceOptions): Promise<DriveFileResult>;
  move(
    fileId: string,
    targetFolderId: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult>;
  rename(
    fileId: string,
    newName: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult>;
  duplicate(
    fileId: string,
    duplicateOptions?: DriveDuplicateOptions,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult>;
  searchFiles(
    query: DriveSearchQuery,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult[]>;
  downloadAsBuffer(
    fileId: string,
    options?: DriveServiceOptions
  ): Promise<Uint8Array>;
  saveBuffer(
    content: Uint8Array,
    saveOptions: DriveContentSaveOptions,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult>;
  uploadStream(
    stream: ReadableStream<Uint8Array>,
    saveOptions: DriveContentSaveOptions,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult>;
}




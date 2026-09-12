import { Type, type Static } from '@sinclair/typebox';
import type {
  Activity,
  ActivityOutput,
  ExecutionContext,
  FileLocator,
  ProcessDocumentResult,
  DocumentType,
} from './domain';

export const UiEventRuleType = Type.Object({
  matchFields: Type.Optional(Type.Record(Type.String(), Type.String())),
  workflow: Type.String(),
});

export type UiEventRule = Static<typeof UiEventRuleType>;

export const UiEventType = Type.Object({
  rules: Type.Optional(Type.Array(UiEventRuleType)),
  catchAllWorkflow: Type.Optional(Type.String()),
});

export type UiEvent = Static<typeof UiEventType>;

export const DocumentUiSchemaType = Type.Object({
  events: Type.Optional(Type.Record(Type.String(), UiEventType)),
});

export type DocumentUiSchema = Static<typeof DocumentUiSchemaType>;

export const FormFieldOptionType = Type.Object({
  source: Type.String(),
  key: Type.String(),
  name: Type.String(),
  allowUserInput: Type.Optional(Type.Boolean()),
});

export type FormFieldOption = Static<typeof FormFieldOptionType>;

export const FormFieldType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  type: Type.String(),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  defaultValue: Type.Optional(Type.String()),
  format: Type.Optional(Type.String()),
  options: Type.Optional(FormFieldOptionType),
});

export type FormField = Static<typeof FormFieldType>;

export const FormCalculatedFieldType = Type.Object({
  key: Type.String(),
  template: Type.String(),
  description: Type.Optional(Type.String()),
});

export type FormCalculatedField = Static<typeof FormCalculatedFieldType>;

export const FormIdentitySchemaType = Type.Object(
  {
    id: Type.Optional(Type.String()),
    idDocument: Type.Optional(Type.String()),
    idGroup: Type.Optional(Type.String()),
  },
  { additionalProperties: Type.String() }
);

export type FormIdentitySchema = Static<typeof FormIdentitySchemaType>;

export const FormDocumentSchemaType = Type.Object({
  fields: Type.Array(FormFieldType),
  calculatedFields: Type.Optional(Type.Array(FormCalculatedFieldType)),
  identity: Type.Optional(FormIdentitySchemaType),
  options: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Record(Type.String(), Type.Unknown())))),
});

export type FormDocumentSchema = Static<typeof FormDocumentSchemaType>;

export const FormSchemaType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  documentSchema: FormDocumentSchemaType,
  documentUiSchema: Type.Optional(DocumentUiSchemaType),
});

export type FormSchema = Static<typeof FormSchemaType>;

export type {
  FileLocator,
  ActivityOutput,
  ExecutionContext,
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

export interface SchemaQueryPort {
  getForms(): Promise<FormSchema[]> | FormSchema[];
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




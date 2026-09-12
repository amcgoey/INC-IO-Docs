import { Type, type Static } from '@sinclair/typebox';
import {
  DocumentSchemaType,
  UiEventType,
  UiEventRuleType,
  type Activity,
  type ActivityOutput,
  type ExecutionContext,
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

const DataVarString = Type.String({ pattern: '^data\\.' });

export const JSONLogicRuleType = Type.Recursive(
  (Self) =>
    Type.Union([
      // Primitives
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
      Type.Array(Self),
      // Operators
      Type.Object({ '==': Type.Tuple([Self, Self]) }, { additionalProperties: false }),
      Type.Object({ '!=': Type.Tuple([Self, Self]) }, { additionalProperties: false }),
      Type.Object({ '<': Type.Tuple([Self, Self]) }, { additionalProperties: false }),
      Type.Object({ '>': Type.Tuple([Self, Self]) }, { additionalProperties: false }),
      Type.Object({ '<=': Type.Tuple([Self, Self]) }, { additionalProperties: false }),
      Type.Object({ '>=': Type.Tuple([Self, Self]) }, { additionalProperties: false }),
      Type.Object({ and: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ or: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ '!': Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
      Type.Object({ '!!': Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
      Type.Object(
        {
          var: Type.Union([
            DataVarString,
            Type.Tuple([DataVarString]),
            Type.Tuple([DataVarString, Self]),
          ]),
        },
        { additionalProperties: false }
      ),
      Type.Object({ cat: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ in: Type.Tuple([Self, Self]) }, { additionalProperties: false }),
      Type.Object({ log: Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
    ]),
  { $id: 'JSONLogicRule' }
);

export type JSONLogicRule = Static<typeof JSONLogicRuleType>;

export const UiFieldSchema = Type.Object({
  widget: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  showIf: Type.Optional(JSONLogicRuleType),
  disableIf: Type.Optional(JSONLogicRuleType),
});

export type UiField = Static<typeof UiFieldSchema>;

export const DocumentUiSchemaType = Type.Object({
  layout: Type.Optional(Type.Array(Type.String())),
  fields: Type.Optional(Type.Record(Type.String(), UiFieldSchema)),
  events: Type.Optional(Type.Record(Type.String(), UiEventType)),
});

export type DocumentUiSchema = Static<typeof DocumentUiSchemaType>;

export const SpaceUiSchemaType = Type.Object({
  layout: Type.Optional(Type.Array(Type.String())),
  fields: Type.Optional(Type.Record(Type.String(), UiFieldSchema)),
});

export type SpaceUiSchema = Static<typeof SpaceUiSchemaType>;

export interface DocumentUiSchemaQueryPort {
  getDocumentUiSchema(documentTypeKey: string): Promise<DocumentUiSchema | undefined>;
  getSpaceUiSchema(spaceTypeKey: string): Promise<SpaceUiSchema | undefined>;
}

export const FormSchemaType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  documentSchema: DocumentSchemaType,
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




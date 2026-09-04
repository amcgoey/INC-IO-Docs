import type {
  Activity,
  ActivityOutput,
  ExecutionContext,
  FileLocator,
  FormSchema,
  ProcessDocumentResult,
  DocumentType,
} from './domain';

export type {
  FileLocator,
  ActivityOutput,
  ExecutionContext,
  FormSchema,
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
  getManifestDir(): string;
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




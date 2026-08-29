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

export interface ManifestRegistryPort {
  loadAll(): Promise<DocumentType[]>;
}

export type TemplateEvaluationContext = { [key: string]: unknown };

export interface TemplateEvaluatorPort {
  validate(template: string, allowedVariables: string[]): boolean;
  evaluate(template: string, context: TemplateEvaluationContext): string;
}

export interface DriveFileResult {
  id: string;
  name: string;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
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

export interface DriveServiceOptions {
  auth?: string | undefined;
}

export interface DriveServicePort {
  getFile(fileId: string, options?: DriveServiceOptions): Promise<DriveFileResult>;
  findOrCreateFolder(parentId: string, folderName: string, options?: DriveServiceOptions): Promise<DriveFileResult>;
  moveFile(
    fileId: string,
    currentParentId: string,
    targetFolderId: string,
    options?: DriveServiceOptions
  ): Promise<DriveFileResult>;
}



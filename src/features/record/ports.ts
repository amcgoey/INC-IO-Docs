import type { Activity, ActivityOutput, FileLocator, FormSchema, ProcessRecordResult, RecordType } from './domain';

export type { FileLocator, ActivityOutput, FormSchema, ProcessRecordResult, RecordType };


export interface ActivityHandler {
  canHandle(activity: Activity): boolean;
  handle<TContext = unknown>(
    activity: Activity,
    context?: TContext
  ): Promise<ActivityOutput | void> | ActivityOutput | void;
}

export interface ActivityDispatcherPort {
  dispatch<TContext = unknown>(
    activity: Activity,
    context?: TContext
  ): Promise<ActivityOutput | void> | ActivityOutput | void;
}

export interface RecordServicePort {
  processRecord<TContext = unknown>(
    payload?: unknown,
    eventName?: string,
    context?: TContext
  ): Promise<ProcessRecordResult>;
}

export interface SchemaQueryPort {
  getForms(): Promise<FormSchema[]> | FormSchema[];
}

export interface ManifestRegistryPort {
  loadAll(): Promise<RecordType[]>;
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



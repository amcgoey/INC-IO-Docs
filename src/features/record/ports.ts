import type { Activity, FormSchema, ProcessRecordResult, RecordType } from './domain';


export interface ActivityHandler {
  canHandle(activity: Activity): boolean;
  handle<TContext = unknown>(activity: Activity, context?: TContext): Promise<void> | void;
}

export interface ActivityDispatcherPort {
  dispatch<TContext = unknown>(activity: Activity, context?: TContext): Promise<void> | void;
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

export interface DriveServicePort {
  getFile(fileId: string, auth?: string): Promise<DriveFileResult>;
  findOrCreateFolder(parentId: string, folderName: string, auth?: string): Promise<DriveFileResult>;
  moveFile(fileId: string, currentParentId: string, targetFolderId: string, auth?: string): Promise<DriveFileResult>;
}


export interface AuthVerificationResult {
  isValid: boolean;
  payload?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface AuthVerifierPort {
  verifyToken(authHeader?: string): Promise<AuthVerificationResult>;
}

export interface WorkspaceConfiguration {
  appTitle?: string | undefined;
  actionButtonText?: string | undefined;
  defaultRecordType?: string | undefined;
  defaultEventName?: string | undefined;
}

export interface WorkspaceConfigProviderPort {
  getWorkspaceConfig(): Promise<WorkspaceConfiguration | undefined>;
}

export interface WorkspaceFileLocator {
  id: string;
  name: string;
  parentName?: string | undefined;
  mimeType?: string | undefined;
  uri?: string | undefined;
}

export interface WorkspaceActivityResult {
  success?: boolean | undefined;
  error?: string | undefined;
  files?: WorkspaceFileLocator[] | undefined;
  contextVariables?: Record<string, unknown> | undefined;
  recordDataPatch?: Record<string, unknown> | undefined;
}

export interface WorkspaceRecordProcessResult {
  success: boolean;
  errors?: string[] | undefined;
  outputs?: WorkspaceActivityResult[] | undefined;
}

import type { WorkspaceRecordExecutionContext } from './domain';

export type { WorkspaceRecordExecutionContext };

export interface WorkspaceRecordRunnerPort {
  processRecord(
    payload?: unknown,
    eventName?: string,
    context?: WorkspaceRecordExecutionContext
  ): Promise<WorkspaceRecordProcessResult>;
}


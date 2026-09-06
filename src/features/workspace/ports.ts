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
  defaultDocumentType?: string | undefined;
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
  documentDataPatch?: Record<string, unknown> | undefined;
}

export interface WorkspaceDocumentProcessResult {
  success: boolean;
  errors?: string[] | undefined;
  outputs?: WorkspaceActivityResult[] | undefined;
}

import type { WorkspaceDocumentExecutionContext } from './domain';

export type { WorkspaceDocumentExecutionContext };

export interface WorkspaceDocumentRunnerPort {
  processDocument(
    payload?: unknown,
    eventName?: string,
    context?: WorkspaceDocumentExecutionContext
  ): Promise<WorkspaceDocumentProcessResult>;
}

export interface WorkspaceUiBuilderPort {
  buildCard(header: Record<string, unknown>, sections: (Record<string, unknown> | null)[]): Record<string, unknown>;
  buildTitleBlock(options: { title: string; subtitle?: string; imageUrl?: string; imageType?: 'SQUARE' | 'CIRCLE' }): Record<string, unknown>;
  buildStatusMessageBlock(message?: string, isOnlySection?: boolean): Record<string, unknown> | null;
  buildNavigationAction(card: Record<string, unknown>): Record<string, unknown>;
  buildErrorCard(errorMessage: string, title?: string): Record<string, unknown>;
  buildAuthorizationAction(authorizationUrl?: string): Record<string, unknown>;
}


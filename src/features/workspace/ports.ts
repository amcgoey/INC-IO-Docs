import { Type, type Static } from '@sinclair/typebox';
import type { WorkspaceDocumentExecutionContext } from './domain';

export const AuthVerificationResultSchema = Type.Object({
  isValid: Type.Boolean(),
  payload: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])
  ),
  error: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export type AuthVerificationResult = Static<typeof AuthVerificationResultSchema>;

export interface AuthVerifierPort {
  verifyToken(authHeader?: string): Promise<AuthVerificationResult>;
}

export const WorkspaceConfigurationSchema = Type.Object({
  appTitle: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  actionButtonText: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  defaultDocumentType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  defaultDocumentSpaceType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  defaultEventName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export type WorkspaceConfiguration = Static<typeof WorkspaceConfigurationSchema>;

export interface WorkspaceConfigProviderPort {
  getWorkspaceConfig(): Promise<WorkspaceConfiguration | undefined>;
}

export const WorkspaceFileLocatorSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  parentName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  uri: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export type WorkspaceFileLocator = Static<typeof WorkspaceFileLocatorSchema>;

export const WorkspaceActivityResultSchema = Type.Object({
  success: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  files: Type.Optional(Type.Union([Type.Array(WorkspaceFileLocatorSchema), Type.Undefined()])),
  contextVariables: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])
  ),
  documentDataPatch: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])
  ),
});

export type WorkspaceActivityResult = Static<typeof WorkspaceActivityResultSchema>;

export const WorkspaceDocumentProcessResultSchema = Type.Object({
  success: Type.Boolean(),
  errors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  outputs: Type.Optional(Type.Union([Type.Array(WorkspaceActivityResultSchema), Type.Undefined()])),
});

export type WorkspaceDocumentProcessResult = Static<
  typeof WorkspaceDocumentProcessResultSchema
>;

export type { WorkspaceDocumentExecutionContext };

export interface WorkspaceDocumentRunnerPort {
  processDocument(
    payload?: unknown,
    eventName?: string,
    context?: WorkspaceDocumentExecutionContext
  ): Promise<WorkspaceDocumentProcessResult>;
  getForms?(): Promise<{ key: string; name: string }[]>;
}

export interface WorkspaceDocumentSpaceProviderPort {
  getAllTypes(): { id: string; displayName: string; allowedDocumentTypes?: string[] }[];
  getCollection(typeId: string): Promise<{
    type?: { id: string; displayName: string; allowedDocumentTypes?: string[] };
    spaces: { id: string; name: string }[];
  }>;
}

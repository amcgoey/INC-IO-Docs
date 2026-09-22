import { Type, type Static } from '@sinclair/typebox';
import {
  UiSelectionItemSchema,
  type UiSelectionItem,
  UiSelectionStateSchema,
  type UiSelectionState,
  type UiProcessSpaceType,
  ProcessUiStateConfigSchema,
  type ProcessUiStateConfig,
} from './domain';

export {
  UiSelectionItemSchema,
  type UiSelectionItem,
  UiSelectionStateSchema,
  type UiSelectionState,
  type UiProcessSpaceType,
  ProcessUiStateConfigSchema,
  type ProcessUiStateConfig,
};

export const UiProcessEventContextSchema = Type.Object({
  actionName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  parameters: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  userOAuthToken: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectedItems: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          id: Type.Optional(Type.String()),
          title: Type.Optional(Type.String()),
        })
      ),
      Type.Undefined(),
    ])
  ),
});
export type UiProcessEventContext = Static<typeof UiProcessEventContextSchema>;

export const UiProcessCardRequestSchema = Type.Object({
  viewId: Type.String({ minLength: 1 }),
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectionState: Type.Optional(Type.Union([UiSelectionStateSchema, Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  hiddenFields: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type UiProcessCardRequest = Static<typeof UiProcessCardRequestSchema>;

// --- Driven Ports ---

export interface UiProcessConfigProviderPort {
  getWorkspaceConfig(): Promise<ProcessUiStateConfig | undefined>;
}

export interface UiProcessAuthOptions {
  auth?: string | undefined;
}

export interface UiProcessSpaceCollection {
  type?: UiProcessSpaceType | undefined;
  spaces: Array<{ id: string; name: string }>;
}

export interface UiProcessSpaceProviderPort {
  getAllTypes(): UiProcessSpaceType[];
  getCollection(typeId: string, options?: UiProcessAuthOptions): Promise<UiProcessSpaceCollection>;
}

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema(relPath: string): Promise<unknown>;
}

export interface UiProcessManifestPort {
  resolveDocumentTypeKey(nameOrKey: string): Promise<string | undefined>;
  getAllDocumentTypes(): Promise<Array<{ key: string; name?: string | undefined; displayName?: string | undefined }>>;
  getDocumentTypeSchemas(key: string): Promise<{ docSchema?: unknown; uiSchema?: unknown }>;
}

export interface UiProcessViewGeneratorPort {
  generateCard(request: UiProcessCardRequest): Promise<unknown>;
}

export interface UiProcessDocumentExecutionResult {
  success: boolean;
  errors?: string[] | undefined;
  error?: string | undefined;
}

export interface UiProcessDocumentRunnerPort {
  processDocument(
    payload: { type: string; data: Record<string, unknown>; space?: string },
    eventName: string,
    context?: { credentials?: { oauthToken?: string }; resources?: { primaryTargetId?: string } }
  ): Promise<UiProcessDocumentExecutionResult>;
}

export interface UiProcessFormEvaluationResult {
  computedData: Record<string, unknown>;
  hiddenFields: string[];
  disabledFields: string[];
}

export interface UiProcessFormEvaluatorPort {
  evaluate(
    formData: Record<string, unknown>,
    documentTypeKey?: string
  ): Promise<UiProcessFormEvaluationResult>;
}

// --- Driving Port ---

export interface UiProcessOrchestratorPort {
  processUiEvent(context: UiProcessEventContext): Promise<unknown>;
}


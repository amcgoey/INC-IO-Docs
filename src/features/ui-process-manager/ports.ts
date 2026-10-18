import { Type, type Static } from '@sinclair/typebox';
import {
  UiSelectionItemSchema,
  type UiSelectionItem,
  UiSelectionStateSchema,
  type UiSelectionState,
  UiProcessSpaceTypeSchema,
  type UiProcessSpaceType,
  UiProcessSpaceItemSchema,
  type UiProcessSpaceItem,
  ProcessUiStateConfigSchema,
  type ProcessUiStateConfig,
  ProcessUiStateInputSchema,
  type ProcessUiStateInput,
  ProcessUiStateOutputSchema,
  type ProcessUiStateOutput,
  ResolveSpaceResultSchema,
  type ResolveSpaceResult,
} from './domain';

export {
  UiSelectionItemSchema,
  type UiSelectionItem,
  UiSelectionStateSchema,
  type UiSelectionState,
  UiProcessSpaceTypeSchema,
  type UiProcessSpaceType,
  UiProcessSpaceItemSchema,
  type UiProcessSpaceItem,
  ProcessUiStateConfigSchema,
  type ProcessUiStateConfig,
  ProcessUiStateInputSchema,
  type ProcessUiStateInput,
  ProcessUiStateOutputSchema,
  type ProcessUiStateOutput,
  ResolveSpaceResultSchema,
  type ResolveSpaceResult,
};

export const UiProcessEventContextSchema = Type.Object({
  actionName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  parameters: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  selectedItems: Type.Optional(
    Type.Union([
      Type.Array(
        Type.Object({
          id: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
          title: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
        })
      ),
      Type.Undefined(),
    ])
  ),
});
export type UiProcessEventContext = Static<typeof UiProcessEventContextSchema>;

export const UiProcessRenderResultSchema = Type.Object({
  type: Type.Literal('render'),
  viewId: Type.String({ minLength: 1 }),
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectionState: Type.Optional(Type.Union([UiSelectionStateSchema, Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  hiddenFields: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type UiProcessRenderResult = Static<typeof UiProcessRenderResultSchema>;

export const UiProcessNotificationResultSchema = Type.Object({
  type: Type.Literal('notification'),
  text: Type.String({ minLength: 1 }),
});
export type UiProcessNotificationResult = Static<typeof UiProcessNotificationResultSchema>;

export const UiProcessResultSchema = Type.Union([
  UiProcessRenderResultSchema,
  UiProcessNotificationResultSchema,
]);
export type UiProcessResult = Static<typeof UiProcessResultSchema>;

// --- Driven Ports ---

export interface UiProcessConfigProviderPort {
  getWorkspaceConfig(): Promise<ProcessUiStateConfig | undefined>;
}

export interface UiProcessSpaceCollection {
  type?: UiProcessSpaceType | undefined;
  spaces: UiProcessSpaceItem[];
}

export interface UiProcessSpaceProviderPort {
  getAllTypes(): UiProcessSpaceType[];
  getCollection(typeId: string): Promise<UiProcessSpaceCollection>;
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

export interface UiProcessDocumentExecutionResult {
  success: boolean;
  errors?: string[] | undefined;
  error?: string | undefined;
}

export interface UiProcessDocumentRunnerPort {
  processDocument(
    payload: {
      type: string;
      data: Record<string, unknown>;
      space?:
        | UiProcessSpaceItem
        | string
        | { id: string; typeId: string; name: string; abstractStorageId: string }
        | undefined;
    },
    eventName: string
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
  processUiEvent(context: UiProcessEventContext): Promise<UiProcessResult>;
}


import { Type, type Static } from '@sinclair/typebox';

// --- Selection & Context DTOs ---

export const UiSelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type UiSelectionItem = Static<typeof UiSelectionItemSchema>;

export const UiSelectionStateSchema = Type.Object({
  spaceTypes: Type.Array(UiSelectionItemSchema),
  spaces: Type.Array(Type.String()),
  documentTypes: Type.Array(UiSelectionItemSchema),
});
export type UiSelectionState = Static<typeof UiSelectionStateSchema>;

export const UiProcessEventContextSchema = Type.Object({
  actionName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  parameters: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
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
  getWorkspaceConfig(): Promise<{
    defaultDocumentType?: string | undefined;
    defaultDocumentSpaceType?: string | undefined;
  } | undefined>;
}

export interface UiProcessSpaceType {
  id: string;
  displayName: string;
  spaceSchema: { allowedDocumentTypes: string[] };
}

export interface UiProcessSpaceCollection {
  type?: UiProcessSpaceType | undefined;
  spaces: Array<{ id: string; name: string }>;
}

export interface UiProcessSpaceProviderPort {
  getAllTypes(): UiProcessSpaceType[];
  getCollection(typeId: string): Promise<UiProcessSpaceCollection>;
}

export interface UiProcessManifestPort {
  resolveDocumentTypeKey(nameOrKey: string): Promise<string | undefined>;
  getAllDocumentTypes(): Promise<Array<{ key: string; name?: string | undefined; displayName?: string | undefined }>>;
}

export interface UiProcessViewGeneratorPort {
  generateCard(request: UiProcessCardRequest): Promise<unknown>;
}

// --- Driving Port ---

export interface UiProcessOrchestratorPort {
  processUiEvent(context: UiProcessEventContext): Promise<unknown>;
}

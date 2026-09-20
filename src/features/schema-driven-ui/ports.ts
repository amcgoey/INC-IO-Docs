import { Type, type Static } from '@sinclair/typebox';
import type { UiSchema, UiView } from './domain';

// --- Selection & Request DTO Schemas ---

export const SelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Boolean()),
});

export type SelectionItem = Static<typeof SelectionItemSchema>;

export const SelectionStateSchema = Type.Object({
  spaceTypes: Type.Array(SelectionItemSchema),
  spaces: Type.Array(Type.String()),
  documentTypes: Type.Array(SelectionItemSchema),
});

export type SelectionState = Static<typeof SelectionStateSchema>;

export const GenerateViewRequestSchema = Type.Object({
  viewId: Type.String({ minLength: 1 }),
  documentTypeKey: Type.Optional(Type.String({ minLength: 1 })),
  selectionState: Type.Optional(SelectionStateSchema),
  validationErrors: Type.Optional(Type.Array(Type.String())),
});

export type GenerateViewRequest = Static<typeof GenerateViewRequestSchema>;

// --- Data & Presentation DTO Schemas ---

export const AbstractDataFieldSchema = Type.Object({
  key: Type.String(),
  type: Type.Optional(Type.String()),
  options: Type.Optional(Type.Unknown()),
  defaultValue: Type.Optional(Type.Unknown()),
});
export type AbstractDataField = Static<typeof AbstractDataFieldSchema>;

export const AbstractDataSchema = Type.Object({
  fields: Type.Array(AbstractDataFieldSchema),
});
export type AbstractDataSchema = Static<typeof AbstractDataSchema>;

export const StandardWidgetCustomPropsSchema = Type.Object({
  type: Type.Optional(Type.String()),
  placeholder: Type.Optional(Type.String()),
  hintText: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  items: Type.Optional(Type.Array(SelectionItemSchema)),
});
export type StandardWidgetCustomProps = Static<typeof StandardWidgetCustomPropsSchema>;

// --- Port Interfaces ---

export interface UiManifestPort {
  getUiSchema(documentTypeKey: string): Promise<UiSchema | undefined>;
  getDocumentSchema(documentTypeKey: string): Promise<AbstractDataSchema | undefined>;
}

export interface UiViewAdapterContext extends GenerateViewRequest {
  uiSchema?: UiSchema | undefined;
  documentSchema?: AbstractDataSchema | undefined;
}

export interface UiViewSchemaAdapterPort {
  readonly viewId: string;
  composeView(context: UiViewAdapterContext): Promise<UiView> | UiView;
}

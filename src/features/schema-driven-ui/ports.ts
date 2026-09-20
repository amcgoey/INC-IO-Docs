import { Type, type Static } from '@sinclair/typebox';
import {
  SelectionItemSchema,
  type UiSchema,
  type UiView,
  type GenerateViewRequest,
} from './domain';

export {
  SelectionItemSchema,
  type SelectionItem,
  SelectionStateSchema,
  type SelectionState,
  GenerateViewRequestSchema,
  type GenerateViewRequest,
} from './domain';

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

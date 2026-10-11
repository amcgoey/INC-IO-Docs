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
  spaceId: Type.Optional(Type.String()),
  selectionState: Type.Optional(SelectionStateSchema),
  validationErrors: Type.Optional(Type.Array(Type.String())),
  formData: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  hiddenFields: Type.Optional(Type.Array(Type.String())),
});

export type GenerateViewRequest = Static<typeof GenerateViewRequestSchema>;

// --- Dynamic Option DTO Schemas & Port ---

export const DynamicOptionQuerySchema = Type.Object({
  sourceKey: Type.String(),
  config: Type.Record(Type.String(), Type.Unknown()),
});

export type DynamicOptionQuery = Static<typeof DynamicOptionQuerySchema>;

export const DynamicOptionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
});

export type DynamicOptionItem = Static<typeof DynamicOptionItemSchema>;

export const OptionsFetcherContextSchema = Type.Object({
  spaceId: Type.Optional(Type.String()),
  formData: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type OptionsFetcherContext = Static<typeof OptionsFetcherContextSchema>;

export interface OptionsFetcherPort {
  fetchOptions(
    queries: DynamicOptionQuery[],
    context: OptionsFetcherContext
  ): Promise<Record<string, DynamicOptionItem[]>>;
}

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
  options: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Unknown()))),
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

export interface DocumentTypeDisplayNameResolverPort {
  getDisplayName(documentTypeKey: string): Promise<string | undefined>;
}

export interface UiViewAdapterContext extends GenerateViewRequest {
  uiSchema?: UiSchema | undefined;
  documentSchema?: AbstractDataSchema | undefined;
  dynamicOptions?: Record<string, DynamicOptionItem[]> | undefined;
}

export interface UiViewSchemaAdapterPort {
  readonly viewId: string;
  composeView(context: UiViewAdapterContext): Promise<UiView> | UiView;
}

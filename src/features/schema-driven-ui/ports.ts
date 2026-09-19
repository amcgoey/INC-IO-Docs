import type {
  UiSchema,
  UiView,
  GenerateViewRequest,
} from './domain';

export {
  SelectionItemSchema,
  type SelectionItem,
  SelectionStateSchema,
  type SelectionState,
  GenerateViewRequestSchema,
  type GenerateViewRequest,
} from './domain';

// --- Port Interfaces ---

export interface UiManifestPort {
  getUiSchema(documentTypeKey: string): Promise<UiSchema | undefined>;
  getDocumentSchema(documentTypeKey: string): Promise<unknown | undefined>;
}

export interface UiViewAdapterContext extends GenerateViewRequest {
  uiSchema?: UiSchema | undefined;
  documentSchema?: unknown | undefined;
}

export interface UiViewSchemaAdapterPort {
  readonly viewId: string;
  composeView(context: UiViewAdapterContext): Promise<UiView> | UiView;
}

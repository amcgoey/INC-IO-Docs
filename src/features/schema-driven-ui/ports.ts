import { Type, type Static } from '@sinclair/typebox';
import type { UiSchema, UiView } from './domain';

// --- Selection & Request DTO Schemas ---

export const SelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});

export type SelectionItem = Static<typeof SelectionItemSchema>;

export const SelectionStateSchema = Type.Object({
  spaceTypes: Type.Array(SelectionItemSchema),
  spaces: Type.Array(Type.String()),
  documentTypes: Type.Array(SelectionItemSchema),
  files: Type.Optional(Type.Union([Type.Array(SelectionItemSchema), Type.Undefined()])),
  fileSources: Type.Optional(Type.Union([Type.Array(SelectionItemSchema), Type.Undefined()])),
  threadMessages: Type.Optional(Type.Union([Type.Array(SelectionItemSchema), Type.Undefined()])),
});

export type SelectionState = Static<typeof SelectionStateSchema>;

export const GenerateViewRequestSchema = Type.Object({
  viewId: Type.String({ minLength: 1 }),
  documentTypeKey: Type.Optional(Type.String({ minLength: 1 })),
  spaceId: Type.Optional(Type.String()),
  selectionState: Type.Optional(SelectionStateSchema),
  validationErrors: Type.Optional(Type.Array(Type.String())),
  statusMessages: Type.Optional(Type.Array(Type.String())),
  formData: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  hiddenFields: Type.Optional(Type.Array(Type.String())),
});

export type GenerateViewRequest = Static<typeof GenerateViewRequestSchema>;

// --- Dynamic Option DTO Schemas & Port ---

export const AbstractOptionSourceSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal('document_log'), Type.Literal('google_drive')]),
    method: Type.Optional(Type.Union([Type.Literal('list_folders'), Type.Undefined()])),
    relativePath: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    properties: Type.Optional(
      Type.Union([Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), Type.Undefined()])
    ),
  },
  { additionalProperties: true }
);
export type AbstractOptionSource = Static<typeof AbstractOptionSourceSchema>;

export const DynamicOptionQuerySchema = Type.Object({
  sourceKey: Type.String(),
  optionSource: Type.Optional(AbstractOptionSourceSchema),
});

export type DynamicOptionQuery = Static<typeof DynamicOptionQuerySchema>;

export const DynamicOptionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
});

export type DynamicOptionItem = Static<typeof DynamicOptionItemSchema>;

export const DynamicOptionStatusSchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('empty'),
  Type.Literal('missing_space'),
  Type.Literal('path_not_found'),
  Type.Literal('ambiguous_path'),
  Type.Literal('missing_log'),
  Type.Literal('ambiguous_log'),
  Type.Literal('config_error'),
  Type.Literal('timeout'),
  Type.Literal('error'),
]);

export type DynamicOptionStatus = Static<typeof DynamicOptionStatusSchema>;

export const DynamicOptionResolutionSchema = Type.Object({
  status: DynamicOptionStatusSchema,
  items: Type.Array(DynamicOptionItemSchema),
  targetPath: Type.Optional(Type.String()),
});

export type DynamicOptionResolution = Static<typeof DynamicOptionResolutionSchema>;

export const OptionsFetcherContextSchema = Type.Object({
  spaceId: Type.Optional(Type.String()),
  documentTypeKey: Type.Optional(Type.String()),
  selectedLogId: Type.Optional(Type.String()),
  formData: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type OptionsFetcherContext = Static<typeof OptionsFetcherContextSchema>;

export interface OptionsFetcherPort {
  fetchOptions(
    queries: DynamicOptionQuery[],
    context: OptionsFetcherContext
  ): Promise<Record<string, DynamicOptionResolution>>;
}

// --- Pre-Submit UI Context Query Port & Storage-Agnostic Panel DTOs ---

export const DOCUMENT_LOG_CONTEXT_KEY = 'document-log';

export const UiContextQueryRequestSchema = Type.Object({
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  formData: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])
  ),
});

export type UiContextQueryRequest = Static<typeof UiContextQueryRequestSchema>;

export interface UiContextQueryPort {
  queryContext(
    keys: readonly string[],
    context: UiContextQueryRequest
  ): Promise<Record<string, unknown>>;
}

export const DocumentLogPanelStatusSchema = Type.Union([
  Type.Literal('missing_space'),
  Type.Literal('missing'),
  Type.Literal('resolved'),
  Type.Literal('ambiguous'),
  Type.Literal('discovery_error'),
]);

export type DocumentLogPanelStatus = Static<typeof DocumentLogPanelStatusSchema>;

export const DocumentLogPanelCandidateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    url: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type DocumentLogPanelCandidate = Static<typeof DocumentLogPanelCandidateSchema>;

export const DocumentLogPanelReadStatusSchema = Type.Union([
  Type.Literal('ready'),
  Type.Literal('idle_incomplete_id'),
  Type.Literal('read_error'),
  Type.Literal('partial_hydration'),
]);

export type DocumentLogPanelReadStatus = Static<typeof DocumentLogPanelReadStatusSchema>;

export const DocumentLogPanelEntrySchema = Type.Object(
  {
    topLabel: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    text: Type.String(),
    bottomLabel: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    fileUri: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    valid: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type DocumentLogPanelEntry = Static<typeof DocumentLogPanelEntrySchema>;

export const DocumentLogPanelContextSchema = Type.Object(
  {
    status: DocumentLogPanelStatusSchema,
    spaceName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    targetFolderPath: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    targetFileName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    discoveryErrorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    candidateOptions: Type.Optional(
      Type.Union([Type.Array(SelectionItemSchema), Type.Undefined()])
    ),
    activeCandidate: Type.Optional(
      Type.Union([DocumentLogPanelCandidateSchema, Type.Undefined()])
    ),
    readStatus: Type.Optional(
      Type.Union([DocumentLogPanelReadStatusSchema, Type.Undefined()])
    ),
    idGroup: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    missingIdFields: Type.Optional(
      Type.Union([Type.Array(Type.String()), Type.Undefined()])
    ),
    readErrorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    warningMessages: Type.Optional(
      Type.Union([Type.Array(Type.String()), Type.Undefined()])
    ),
    entries: Type.Optional(
      Type.Union([Type.Array(DocumentLogPanelEntrySchema), Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);

export type DocumentLogPanelContext = Static<typeof DocumentLogPanelContextSchema>;

// --- Data & Presentation DTO Schemas ---

export const LinkedFieldSchema = Type.Object({
  sourceField: Type.String({ minLength: 1 }),
  sourceProperty: Type.String({ minLength: 1 }),
});
export type LinkedField = Static<typeof LinkedFieldSchema>;

export const AbstractDataFieldSchema = Type.Object({
  key: Type.String(),
  type: Type.Optional(Type.String()),
  options: Type.Optional(Type.Unknown()),
  defaultValue: Type.Optional(Type.Unknown()),
  linkedField: Type.Optional(LinkedFieldSchema),
});
export type AbstractDataField = Static<typeof AbstractDataFieldSchema>;

export const AbstractDataSchema = Type.Object({
  fields: Type.Array(AbstractDataFieldSchema),
  options: Type.Optional(Type.Record(Type.String(), Type.Array(Type.Unknown()))),
  optionSources: Type.Optional(
    Type.Union([
      Type.Record(Type.String({ minLength: 1 }), AbstractOptionSourceSchema),
      Type.Undefined(),
    ])
  ),
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
  dynamicOptions?: Record<string, DynamicOptionResolution | DynamicOptionItem[]> | undefined;
  uiContext?: Record<string, unknown> | undefined;
}

export interface UiViewSchemaAdapterPort {
  readonly viewId: string;
  readonly contextKeys?: readonly string[] | undefined;
  composeView(context: UiViewAdapterContext): Promise<UiView> | UiView;
}

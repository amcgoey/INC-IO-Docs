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
  ProcessUiStateEventSchema,
  type ProcessUiStateEvent,
  SELECT_FILES_KEY,
  SELECT_FILE_SOURCE_KEY,
  SELECT_ATTACHMENTS_KEY,
  INPUT_DRIVE_URL_KEY,
  SAVE_EMAIL_TO_PDF_KEY,
  SELECT_EMAIL_MESSAGE_KEY,
  SELECT_DOCUMENT_LOG_KEY,
  EPHEMERAL_UI_SELECTION_KEYS,
  isSelectionKey,
  parseGoogleDriveUrl,
  extractSelectFilesSet,
  resolveAttachmentId,
  formatThreadEmailOptionLabel,
  IN_CARD_ACTIONS,
  isInCardAction,
  isResetOrInitialLoad,
  DRIVE_WORKSPACE_ADDON_VIEW_ID,
  GMAIL_WORKSPACE_ADDON_VIEW_ID,
  DOCUMENT_SUCCESS_CARD_VIEW_ID,
  UiProcessGmailEventContextSchema,
  type UiProcessGmailEventContext,
  UiProcessGmailAttachmentDescriptorSchema,
  type UiProcessGmailAttachmentDescriptor,
  UiProcessGmailMessageDescriptorSchema,
  type UiProcessGmailMessageDescriptor,
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
  ProcessUiStateEventSchema,
  type ProcessUiStateEvent,
  SELECT_FILES_KEY,
  SELECT_FILE_SOURCE_KEY,
  SELECT_ATTACHMENTS_KEY,
  INPUT_DRIVE_URL_KEY,
  SAVE_EMAIL_TO_PDF_KEY,
  SELECT_EMAIL_MESSAGE_KEY,
  SELECT_DOCUMENT_LOG_KEY,
  EPHEMERAL_UI_SELECTION_KEYS,
  isSelectionKey,
  parseGoogleDriveUrl,
  extractSelectFilesSet,
  resolveAttachmentId,
  formatThreadEmailOptionLabel,
  IN_CARD_ACTIONS,
  isInCardAction,
  isResetOrInitialLoad,
  DRIVE_WORKSPACE_ADDON_VIEW_ID,
  GMAIL_WORKSPACE_ADDON_VIEW_ID,
  DOCUMENT_SUCCESS_CARD_VIEW_ID,
  UiProcessGmailEventContextSchema,
  type UiProcessGmailEventContext,
  UiProcessGmailAttachmentDescriptorSchema,
  type UiProcessGmailAttachmentDescriptor,
  UiProcessGmailMessageDescriptorSchema,
  type UiProcessGmailMessageDescriptor,
};

export const UiProcessEventContextSchema = ProcessUiStateEventSchema;
export type UiProcessEventContext = ProcessUiStateEvent;

export const UiProcessExecutionFileLocatorSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    parentId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    parentName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    parentUri: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    uri: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type UiProcessExecutionFileLocator = Static<typeof UiProcessExecutionFileLocatorSchema>;

export const UiProcessExecutionStepResultSchema = Type.Object(
  {
    stepId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    activityType: Type.String(),
    files: Type.Array(UiProcessExecutionFileLocatorSchema),
    notices: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type UiProcessExecutionStepResult = Static<typeof UiProcessExecutionStepResultSchema>;

export const UiProcessExecutionLogWriteSchema = Type.Object(
  {
    sheetName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    sheetId: Type.Optional(Type.Union([Type.Number(), Type.Undefined()])),
    rowNumber: Type.Optional(Type.Union([Type.Number(), Type.Undefined()])),
    action: Type.Optional(
      Type.Union([Type.Literal('inserted'), Type.Literal('updated'), Type.Undefined()])
    ),
    uri: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type UiProcessExecutionLogWrite = Static<typeof UiProcessExecutionLogWriteSchema>;

export const UiProcessDocumentExecutionOutcomeSchema = Type.Object(
  {
    success: Type.Boolean(),
    workflowName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    completedStepCount: Type.Integer({ minimum: 0 }),
    failedStepId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    spaceName: Type.String(),
    documentData: Type.Record(Type.String(), Type.Unknown()),
    stepResults: Type.Array(UiProcessExecutionStepResultSchema),
    notices: Type.Array(Type.String()),
    logWrite: Type.Optional(Type.Union([UiProcessExecutionLogWriteSchema, Type.Undefined()])),
    errors: Type.Array(Type.String()),
  },
  { additionalProperties: false }
);
export type UiProcessDocumentExecutionOutcome = Static<
  typeof UiProcessDocumentExecutionOutcomeSchema
>;
export type DocumentExecutionOutcome = UiProcessDocumentExecutionOutcome;

export const UiProcessRenderResultSchema = Type.Object({
  type: Type.Literal('render'),
  viewId: Type.String({ minLength: 1 }),
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectionState: Type.Optional(Type.Union([UiSelectionStateSchema, Type.Undefined()])),
  formData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  hiddenFields: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  lockedFields: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  isUpdateCard: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  popToRoot: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  notification: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  executionOutcome: Type.Optional(
    Type.Union([UiProcessDocumentExecutionOutcomeSchema, Type.Undefined()])
  ),
});
export type UiProcessRenderResult = Static<typeof UiProcessRenderResultSchema>;

export const UiProcessResultSchema = UiProcessRenderResultSchema;
export type UiProcessResult = UiProcessRenderResult;

export const UiProcessDocumentSpaceDtoSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  typeId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  abstractStorageId: Type.String({ minLength: 1 }),
});
export type UiProcessDocumentSpaceDto = Static<typeof UiProcessDocumentSpaceDtoSchema>;

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
  getDocumentTypeSchemas(key: string): Promise<{
    docSchema?: unknown;
    uiSchema?: unknown;
    allowEmptySourceFiles?: boolean | undefined;
    maxSourceFiles?: number | undefined;
  }>;
}

export const UiProcessSourceFileDtoSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  content: Type.Optional(Type.Union([Type.Uint8Array(), Type.Undefined()])),
});
export type UiProcessSourceFileDto = Static<typeof UiProcessSourceFileDtoSchema>;

export interface UiProcessDocumentExecutionResult {
  success: boolean;
  errors?: string[] | undefined;
  error?: string | undefined;
  contextVariables?: Record<string, unknown> | undefined;
  executionOutcome?: UiProcessDocumentExecutionOutcome | undefined;
}

export const UiProcessLogCandidateSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
});
export type UiProcessLogCandidate = Static<typeof UiProcessLogCandidateSchema>;

export type UiProcessLogResolutionResult =
  | {
      status: 'missing';
      expectedFolderPath: string;
    }
  | {
      status: 'resolved';
      candidate: UiProcessLogCandidate;
    }
  | {
      status: 'ambiguous';
      candidates: UiProcessLogCandidate[];
    };

export const UiProcessCopyDocumentLogResultSchema = Type.Object(
  {
    created: Type.Boolean(),
    candidate: UiProcessLogCandidateSchema,
    folderPath: Type.String(),
  },
  { additionalProperties: false }
);
export type UiProcessCopyDocumentLogResult = Static<typeof UiProcessCopyDocumentLogResultSchema>;

export interface UiProcessDocumentLogPort {
  requiresDocumentLog(documentTypeKey: string): Promise<boolean> | boolean;
  resolveLog(space: UiProcessDocumentSpaceDto): Promise<UiProcessLogResolutionResult>;
  copyLog(space: UiProcessDocumentSpaceDto): Promise<UiProcessCopyDocumentLogResult>;
}

export interface UiProcessDocumentRunnerPort {
  processDocument(
    payload: {
      type: string;
      data: Record<string, unknown>;
      space?: UiProcessDocumentSpaceDto | undefined;
      sourceFiles?: UiProcessSourceFileDto[] | undefined;
      targetMessageId?: string | undefined;
      selectedLogId?: string | undefined;
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

export interface UiProcessGmailPort {
  getMessageAttachments(
    messageId: string,
    accessToken?: string
  ): Promise<UiProcessGmailAttachmentDescriptor[]>;

  getThreadMessages?(
    threadId: string,
    options?: { skipCache?: boolean }
  ): Promise<UiProcessGmailMessageDescriptor[]>;

  getMessageDetails?(
    messageId: string,
    options?: { skipCache?: boolean }
  ): Promise<UiProcessGmailMessageDescriptor>;
}

export const UiProcessInferredRoutingResultSchema = Type.Object({
  spaceTypeId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  spaceIdOrName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
});
export type UiProcessInferredRoutingResult = Static<typeof UiProcessInferredRoutingResultSchema>;

export const UiProcessSourceContextItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type UiProcessSourceContextItem = Static<typeof UiProcessSourceContextItemSchema>;

export const UiProcessSourceEmailAttachmentDescriptorSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type UiProcessSourceEmailAttachmentDescriptor = Static<typeof UiProcessSourceEmailAttachmentDescriptorSchema>;

export const UiProcessSourceEmailDescriptorSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  threadId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  subject: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  from: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  to: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  cc: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  date: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  plainTextBody: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  htmlBody: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  labels: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  attachments: Type.Optional(Type.Union([Type.Array(UiProcessSourceEmailAttachmentDescriptorSchema), Type.Undefined()])),
});
export type UiProcessSourceEmailDescriptor = Static<typeof UiProcessSourceEmailDescriptorSchema>;

export const UiProcessCandidateSpaceDescriptorSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  typeId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type UiProcessCandidateSpaceDescriptor = Static<typeof UiProcessCandidateSpaceDescriptorSchema>;

export const UiProcessSourceContextSchema = Type.Object({
  items: Type.Optional(Type.Union([Type.Array(UiProcessSourceContextItemSchema), Type.Undefined()])),
  candidateSpaces: Type.Optional(Type.Union([Type.Array(UiProcessCandidateSpaceDescriptorSchema), Type.Undefined()])),
  email: Type.Optional(Type.Union([UiProcessSourceEmailDescriptorSchema, Type.Undefined()])),
  isDriveUrl: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type UiProcessSourceContext = Static<typeof UiProcessSourceContextSchema>;

export const UiProcessExtractFieldsRequestSchema = Type.Object({
  documentTypeKey: Type.String({ minLength: 1 }),
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectedLogId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  context: UiProcessSourceContextSchema,
  existingData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
});
export type UiProcessExtractFieldsRequest = Static<typeof UiProcessExtractFieldsRequestSchema>;

export const UiProcessExtractedFieldsResultSchema = Type.Object({
  fields: Type.Record(Type.String(), Type.Unknown()),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
});
export type UiProcessExtractedFieldsResult = Static<typeof UiProcessExtractedFieldsResultSchema>;

export interface UiProcessSourceParserPort {
  inferRouting(context: UiProcessSourceContext): Promise<UiProcessInferredRoutingResult>;
  extractFields?(request: UiProcessExtractFieldsRequest): Promise<UiProcessExtractedFieldsResult>;
}

export interface UiProcessLockedFieldsPort {
  deriveLockedFields(params: {
    documentTypeKey: string;
    space?: UiProcessDocumentSpaceDto | undefined;
    selectedLogId?: string | undefined;
    formData: Readonly<Record<string, unknown>>;
  }): Promise<Record<string, string>>;
}

// --- Driving Port ---

export interface UiProcessOrchestratorPort {
  processUiEvent(context: UiProcessEventContext): Promise<UiProcessResult>;
}


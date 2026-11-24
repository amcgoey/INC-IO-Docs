import { Type, type Static } from '@sinclair/typebox';

export const DocumentLogDiscoveryConfigSchema = Type.Object(
  {
    preferredFolderPath: Type.String({ minLength: 1 }),
    fileNameContains: Type.String({ minLength: 1 }),
    excludePrefixes: Type.Array(Type.String({ minLength: 1 })),
    excludeSubstrings: Type.Array(Type.String({ minLength: 1 })),
    templateSpreadsheetId: Type.String({ minLength: 1 }),
    copyNameTemplate: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type DocumentLogDiscoveryConfig = Static<typeof DocumentLogDiscoveryConfigSchema>;

export const DocumentLogDiscoveryConfigOverrideSchema = Type.Object(
  {
    preferredFolderPath: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    fileNameContains: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    excludePrefixes: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Undefined()])),
    excludeSubstrings: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Undefined()])),
    templateSpreadsheetId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    copyNameTemplate: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type DocumentLogDiscoveryConfigOverride = Static<typeof DocumentLogDiscoveryConfigOverrideSchema>;

export const DocumentSpaceFetchMethodSchema = Type.Union([
  Type.Literal('shared_drives'),
  Type.Literal('folders'),
]);
export type DocumentSpaceFetchMethod = Static<typeof DocumentSpaceFetchMethodSchema>;

export const DocumentLogTargetSchema = Type.Object(
  {
    sheetName: Type.String({ minLength: 1 }),
    rangeName: Type.String({ minLength: 1 }),
    extentMarker: Type.String({ minLength: 1 }),
    groupDividerMarker: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type DocumentLogTarget = Static<typeof DocumentLogTargetSchema>;

export const DocumentLogSortOrderSchema = Type.Union([
  Type.Literal('asc'),
  Type.Literal('desc'),
]);
export type DocumentLogSortOrder = Static<typeof DocumentLogSortOrderSchema>;

export const DocumentLogDuplicatePolicySchema = Type.Union([
  Type.Literal('insert'),
  Type.Literal('upsert'),
  Type.Literal('reject'),
]);
export type DocumentLogDuplicatePolicy = Static<typeof DocumentLogDuplicatePolicySchema>;

export const DocumentLogGroupingSchema = Type.Object(
  {
    groupBy: Type.String({ minLength: 1 }),
    sortBy: Type.String({ minLength: 1 }),
    groupSortOrder: DocumentLogSortOrderSchema,
    rowSortOrder: DocumentLogSortOrderSchema,
    duplicatePolicy: DocumentLogDuplicatePolicySchema,
  },
  { additionalProperties: false }
);
export type DocumentLogGrouping = Static<typeof DocumentLogGroupingSchema>;

export const DocumentLogTemplateColumnBindingSchema = Type.Object(
  {
    template: Type.String({ minLength: 1 }),
    readOnly: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type DocumentLogTemplateColumnBinding = Static<typeof DocumentLogTemplateColumnBindingSchema>;

export const DocumentLogFileLinkColumnBindingSchema = Type.Object(
  {
    source: Type.Literal('fileLink'),
    label: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type DocumentLogFileLinkColumnBinding = Static<typeof DocumentLogFileLinkColumnBindingSchema>;

export const DocumentLogColumnBindingSchema = Type.Union([
  DocumentLogTemplateColumnBindingSchema,
  DocumentLogFileLinkColumnBindingSchema,
]);
export type DocumentLogColumnBinding = Static<typeof DocumentLogColumnBindingSchema>;

export const DocumentLogSchemaSchema = Type.Object(
  {
    provider: Type.Literal('google_sheets'),
    target: DocumentLogTargetSchema,
    grouping: DocumentLogGroupingSchema,
    columns: Type.Record(Type.String({ minLength: 1 }), DocumentLogColumnBindingSchema, {
      minProperties: 1,
    }),
  },
  { additionalProperties: false }
);
export type DocumentLogSchema = Static<typeof DocumentLogSchemaSchema>;

export const DocumentLogSpaceSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  typeId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  abstractStorageId: Type.String({ minLength: 1 }),
});
export type DocumentLogSpace = Static<typeof DocumentLogSpaceSchema>;

export const DocumentLogDocumentSchema = Type.Object({
  id: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  idDocument: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  idGroup: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  type: Type.String({ minLength: 1 }),
  data: Type.Record(Type.String(), Type.Unknown()),
  calculated: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  space: Type.Optional(Type.Union([DocumentLogSpaceSchema, Type.Undefined()])),
});
export type DocumentLogDocument = Static<typeof DocumentLogDocumentSchema>;

export const LogResolutionCandidateSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  parents: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  webViewLink: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  modifiedTime: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type LogResolutionCandidate = Static<typeof LogResolutionCandidateSchema>;

export type LogResolutionResult =
  | {
      status: 'missing';
      candidates: [];
      expectedFolderPath: string;
    }
  | {
      status: 'resolved';
      candidate: LogResolutionCandidate;
      candidates: [LogResolutionCandidate];
    }
  | {
      status: 'ambiguous';
      candidates: LogResolutionCandidate[];
    };

export const LogCellPrimitiveSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);
export type LogCellPrimitive = Static<typeof LogCellPrimitiveSchema>;

export const LogFormulaCellSchema = Type.Object({
  formula: Type.String(),
});
export type LogFormulaCell = Static<typeof LogFormulaCellSchema>;

export const LogCellInputSchema = Type.Union([
  LogCellPrimitiveSchema,
  LogFormulaCellSchema,
]);
export type LogCellInput = Static<typeof LogCellInputSchema>;

export const LogRowValuesSchema = Type.Record(Type.String(), LogCellPrimitiveSchema);
export type LogRowValues = Static<typeof LogRowValuesSchema>;

export const WriteDocumentLogRequestSchema = Type.Object({
  document: DocumentLogDocumentSchema,
  fileUri: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  selectedLogId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type WriteDocumentLogRequest = Static<typeof WriteDocumentLogRequestSchema>;

export const WriteDocumentLogResultSchema = Type.Object({
  spreadsheetId: Type.String({ minLength: 1 }),
  sheetName: Type.String({ minLength: 1 }),
  rowNumber: Type.Number(),
  action: Type.Union([Type.Literal('inserted'), Type.Literal('updated')]),
});
export type WriteDocumentLogResult = Static<typeof WriteDocumentLogResultSchema>;

export const LogFilterBySchema = Type.Union([
  Type.Literal('idGroup'),
  Type.Literal('idDocument'),
  Type.Literal('id'),
]);
export type LogFilterBy = Static<typeof LogFilterBySchema>;

export const ReadDocumentLogRequestSchema = Type.Object({
  documentTypeKey: Type.String({ minLength: 1 }),
  space: Type.Optional(Type.Union([DocumentLogSpaceSchema, Type.Undefined()])),
  selectedLogId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  filterBy: Type.Optional(Type.Union([LogFilterBySchema, Type.Undefined()])),
  values: Type.Optional(
    Type.Union([Type.String(), Type.Array(Type.String()), Type.Undefined()])
  ),
});
export type ReadDocumentLogRequest = Static<typeof ReadDocumentLogRequestSchema>;

export const DocumentLogEntrySchema = Type.Object({
  document: DocumentLogDocumentSchema,
  valid: Type.Boolean(),
  fileUri: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  rowNumber: Type.Number(),
  validationErrors: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
});
export type DocumentLogEntry = Static<typeof DocumentLogEntrySchema>;

export const RowHydrationWarningSchema = Type.Object({
  rowNumber: Type.Number(),
  field: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  message: Type.String(),
});
export type RowHydrationWarning = Static<typeof RowHydrationWarningSchema>;

export const ReadDocumentLogResultSchema = Type.Object({
  spreadsheetId: Type.String(),
  sheetName: Type.String({ minLength: 1 }),
  entries: Type.Array(DocumentLogEntrySchema),
  warnings: Type.Array(RowHydrationWarningSchema),
});
export type ReadDocumentLogResult = Static<typeof ReadDocumentLogResultSchema>;

export const LogTargetDocumentFieldOptionsSchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    key: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    allowUserInput: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
    dynamicConfig: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type LogTargetDocumentFieldOptions = Static<typeof LogTargetDocumentFieldOptionsSchema>;

export const LogTargetLinkedFieldSchema = Type.Object(
  {
    sourceField: Type.String({ minLength: 1 }),
    sourceProperty: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type LogTargetLinkedField = Static<typeof LogTargetLinkedFieldSchema>;

export const LogTargetDocumentFieldSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    type: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    required: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
    minLength: Type.Optional(Type.Union([Type.Number(), Type.Undefined()])),
    pattern: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    options: Type.Optional(Type.Union([LogTargetDocumentFieldOptionsSchema, Type.Undefined()])),
    linkedField: Type.Optional(Type.Union([LogTargetLinkedFieldSchema, Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type LogTargetDocumentField = Static<typeof LogTargetDocumentFieldSchema>;

export const LogTargetCalculatedFieldSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type LogTargetCalculatedField = Static<typeof LogTargetCalculatedFieldSchema>;

export const LogTargetDocumentOptionTupleSchema = Type.Intersect([
  Type.Object({
    key: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);
export type LogTargetDocumentOptionTuple = Static<typeof LogTargetDocumentOptionTupleSchema>;

export const LogTargetDocumentSchemaSchema = Type.Object(
  {
    fields: Type.Array(LogTargetDocumentFieldSchema),
    calculatedFields: Type.Optional(
      Type.Union([Type.Array(LogTargetCalculatedFieldSchema), Type.Undefined()])
    ),
    identity: Type.Optional(
      Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])
    ),
    options: Type.Optional(
      Type.Union([
        Type.Record(Type.String(), Type.Array(LogTargetDocumentOptionTupleSchema)),
        Type.Undefined(),
      ])
    ),
  },
  { additionalProperties: false }
);
export type LogTargetDocumentSchema = Static<typeof LogTargetDocumentSchemaSchema>;

export interface LogMustacheTemplateToken {
  original: string;
  parts: string[];
}

export interface LogParsedMustacheTemplate {
  tokens: LogMustacheTemplateToken[];
  literals: string[];
}

// --- Domain Errors ---

export class DocumentLogError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentLogError';
  }
}

export class DocumentLogConfigurationError extends DocumentLogError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DocumentLogConfigurationError';
  }
}

export class DocumentLogMissingError extends DocumentLogError {
  readonly spaceName: string;
  readonly expectedFolderPath: string;

  constructor(spaceName: string, expectedFolderPath: string, options?: ErrorOptions) {
    super(
      `No DocumentLog spreadsheet found for space "${spaceName}". Expected a DocumentLog spreadsheet in "${expectedFolderPath}".`,
      options
    );
    this.name = 'DocumentLogMissingError';
    this.spaceName = spaceName;
    this.expectedFolderPath = expectedFolderPath;
  }
}

export class DocumentLogAmbiguousError extends DocumentLogError {
  readonly spaceName: string;
  readonly candidates: readonly LogResolutionCandidate[];

  constructor(
    spaceName: string,
    candidates: readonly LogResolutionCandidate[],
    options?: ErrorOptions
  ) {
    const candidateSummary = candidates.map((c) => `"${c.name}" (${c.id})`).join(', ');
    super(
      `Multiple DocumentLog spreadsheets found for space "${spaceName}": ${candidateSummary}.`,
      options
    );
    this.name = 'DocumentLogAmbiguousError';
    this.spaceName = spaceName;
    this.candidates = candidates;
  }
}

// --- Driven Ports ---

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema(relPath: string): Promise<unknown>;
}

export interface LogTemplateParserPort {
  parseMustacheTemplate(template: string): LogParsedMustacheTemplate;
}

export interface LogTemplateEvaluatorPort {
  evaluate(template: string, context: Record<string, unknown>): string;
}

export interface LogSchemaRegistryPort {
  initialize(): Promise<void>;
  getDiscoveryConfig(spaceTypeId?: string): DocumentLogDiscoveryConfig | undefined;
  getSpaceFetchMethod?(spaceTypeId: string): DocumentSpaceFetchMethod | undefined;
  getDocumentLogSchema(documentTypeKey: string): DocumentLogSchema | undefined;
  getTargetSchema(documentTypeKey: string): LogTargetDocumentSchema | undefined;
}

export interface LogDiscoveryQuery {
  targetName: string;
  exactMatch?: boolean | undefined;
  sharedDriveId?: string | undefined;
  mimeTypes?: string[] | undefined;
}

export interface LogDiscoveryFileMetadata {
  id: string;
  name: string;
  parents?: string[] | undefined;
  driveId?: string | undefined;
  mimeType?: string | undefined;
  webViewLink?: string | undefined;
  modifiedTime?: string | undefined;
}

export interface LogDiscoveryFolderMetadata {
  id: string;
  name: string;
}

export interface LogDiscoveryCopyFileOptions {
  targetFolderId: string;
  newName: string;
}

export interface LogDiscoveryPort {
  searchSpreadsheets(query: LogDiscoveryQuery): Promise<LogResolutionCandidate[]>;
  getFile?(fileId: string): Promise<LogDiscoveryFileMetadata>;
  resolveFolderPath?(rootFolderId: string, pathSegments: string[]): Promise<LogDiscoveryFolderMetadata>;
  ensureFolderPath?(
    rootFolderId: string,
    pathSegments: string[]
  ): Promise<LogDiscoveryFolderMetadata>;
  copyFile?(
    templateFileId: string,
    options: LogDiscoveryCopyFileOptions
  ): Promise<LogResolutionCandidate>;
}

export interface LogStorageTarget {
  spreadsheetId: string;
  sheetName: string;
  rangeName: string;
  extentMarker: string;
  groupDividerMarker: string;
}

export interface LogRowKey {
  groupKey: string;
  sortKey: string;
}

export interface InsertLogRowRequest {
  target: LogStorageTarget;
  rowData: Record<string, LogCellInput>;
  rowKeyExtractor?: ((row: LogRowValues) => LogRowKey | null) | undefined;
  targetKeys?: LogRowKey | undefined;
  groupSortOrder?: DocumentLogSortOrder | undefined;
  rowSortOrder?: DocumentLogSortOrder | undefined;
  duplicatePolicy?: DocumentLogDuplicatePolicy | undefined;
  readOnlyColumns?: string[] | undefined;
}

export interface InsertLogRowResult {
  rowNumber: number;
  action: 'inserted' | 'updated';
}

export interface ReadLogRowsRequest {
  target: LogStorageTarget;
  linkColumns?: string[] | undefined;
}

export interface ReadLogRow {
  rowNumber: number;
  values: LogRowValues;
  links?: Record<string, string | null> | undefined;
}

export interface ReadLogRowsResult {
  headers: string[];
  formulaColumns: string[];
  rows: ReadLogRow[];
}

export interface LogStoragePort {
  insertRow(request: InsertLogRowRequest): Promise<InsertLogRowResult>;
  readRows(request: ReadLogRowsRequest): Promise<ReadLogRowsResult>;
}

// --- Pre-Submit UI Context DTOs ---

export const QueryDocumentLogUiContextRequestSchema = Type.Object({
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  space: Type.Optional(Type.Union([DocumentLogSpaceSchema, Type.Undefined()])),
  selectedLogId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  formData: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])
  ),
});
export type QueryDocumentLogUiContextRequest = Static<typeof QueryDocumentLogUiContextRequestSchema>;

export const DocumentLogUiStatusSchema = Type.Union([
  Type.Literal('missing_space'),
  Type.Literal('missing'),
  Type.Literal('resolved'),
  Type.Literal('ambiguous'),
  Type.Literal('discovery_error'),
]);
export type DocumentLogUiStatus = Static<typeof DocumentLogUiStatusSchema>;

export const DocumentLogUiCandidateSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    url: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type DocumentLogUiCandidate = Static<typeof DocumentLogUiCandidateSchema>;

export const DocumentLogUiCandidateOptionSchema = Type.Object(
  {
    text: Type.String(),
    value: Type.String(),
    selected: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type DocumentLogUiCandidateOption = Static<typeof DocumentLogUiCandidateOptionSchema>;

export const DocumentLogUiContextResultSchema = Type.Object(
  {
    status: DocumentLogUiStatusSchema,
    spaceName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    targetFolderPath: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    targetFileName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    discoveryErrorMessage: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    candidateOptions: Type.Optional(
      Type.Union([Type.Array(DocumentLogUiCandidateOptionSchema), Type.Undefined()])
    ),
    activeCandidate: Type.Optional(
      Type.Union([DocumentLogUiCandidateSchema, Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);
export type DocumentLogUiContextResult = Static<typeof DocumentLogUiContextResultSchema>;

export const CopyDocumentLogResultSchema = Type.Object(
  {
    created: Type.Boolean(),
    candidate: LogResolutionCandidateSchema,
    folderPath: Type.String(),
  },
  { additionalProperties: false }
);
export type CopyDocumentLogResult = Static<typeof CopyDocumentLogResultSchema>;

// --- Driving Port ---

export interface DocumentLogPort {
  requiresDocumentLog(documentTypeKey: string): boolean;
  resolveLog(space: DocumentLogSpace): Promise<LogResolutionResult>;
  copyLog(space: DocumentLogSpace): Promise<CopyDocumentLogResult>;
  queryUiContext(
    request: QueryDocumentLogUiContextRequest
  ): Promise<DocumentLogUiContextResult | undefined>;
  readLog(request: ReadDocumentLogRequest): Promise<ReadDocumentLogResult>;
  writeLog(request: WriteDocumentLogRequest): Promise<WriteDocumentLogResult>;
}

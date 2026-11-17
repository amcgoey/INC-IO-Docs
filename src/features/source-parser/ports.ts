import { Type, type Static } from '@sinclair/typebox';

export const DriveHierarchyNodeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type DriveHierarchyNode = Static<typeof DriveHierarchyNodeSchema>;

export const DriveItemHierarchySchema = Type.Object({
  item: DriveHierarchyNodeSchema,
  driveId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  driveName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  ancestors: Type.Array(DriveHierarchyNodeSchema),
});
export type DriveItemHierarchy = Static<typeof DriveItemHierarchySchema>;

export const SourceItemDescriptorSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type SourceItemDescriptor = Static<typeof SourceItemDescriptorSchema>;

export const CandidateSpaceDescriptorSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  typeId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type CandidateSpaceDescriptor = Static<typeof CandidateSpaceDescriptorSchema>;

export const SourceEmailAttachmentDescriptorSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});
export type SourceEmailAttachmentDescriptor = Static<typeof SourceEmailAttachmentDescriptorSchema>;

export const SourceEmailDescriptorSchema = Type.Object({
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
  attachments: Type.Optional(Type.Union([Type.Array(SourceEmailAttachmentDescriptorSchema), Type.Undefined()])),
});
export type SourceEmailDescriptor = Static<typeof SourceEmailDescriptorSchema>;

export const SourceContextSchema = Type.Object({
  items: Type.Optional(Type.Union([Type.Array(SourceItemDescriptorSchema), Type.Undefined()])),
  candidateSpaces: Type.Optional(Type.Union([Type.Array(CandidateSpaceDescriptorSchema), Type.Undefined()])),
  email: Type.Optional(Type.Union([SourceEmailDescriptorSchema, Type.Undefined()])),
  isDriveUrl: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});
export type SourceContext = Static<typeof SourceContextSchema>;

export const InferredRoutingResultSchema = Type.Object({
  spaceTypeId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  spaceIdOrName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  documentTypeKey: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
});
export type InferredRoutingResult = Static<typeof InferredRoutingResultSchema>;

export const ExtractFieldsRequestSchema = Type.Object({
  documentTypeKey: Type.String({ minLength: 1 }),
  spaceId: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  context: SourceContextSchema,
  existingData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
});
export type ExtractFieldsRequest = Static<typeof ExtractFieldsRequestSchema>;

export const ExtractedFieldsResultSchema = Type.Object({
  fields: Type.Record(Type.String(), Type.Unknown()),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
});
export type ExtractedFieldsResult = Static<typeof ExtractedFieldsResultSchema>;

export const ParseJsonLogicRuleSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Boolean(),
    Type.String(),
    Type.Number(),
    Type.Null(),
    Type.Array(Self),
    Type.Record(Type.String(), Type.Unknown()),
  ])
);
export type ParseJsonLogicRule = Static<typeof ParseJsonLogicRuleSchema>;

export const GmailExtractSourceSchema = Type.Union([
  Type.Literal('email.date'),
  Type.Literal('email.subjectClean'),
  Type.Literal('email.subject'),
  Type.Literal('email.body'),
  Type.Literal('email.plainTextBody'),
  Type.Literal('email.htmlBody'),
  Type.Literal('email.from'),
  Type.Literal('email.to'),
  Type.Literal('email.cc'),
  Type.Literal('email.labels'),
]);
export type GmailExtractSource = Static<typeof GmailExtractSourceSchema>;

export const GmailSetFieldRuleSchema = Type.Object(
  {
    when: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
    set: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);
export type GmailSetFieldRule = Static<typeof GmailSetFieldRuleSchema>;

export const GmailExtractFieldRuleSchema = Type.Object(
  {
    when: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
    from: GmailExtractSourceSchema,
    pattern: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    flags: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    group: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type GmailExtractFieldRule = Static<typeof GmailExtractFieldRuleSchema>;

export const GmailFieldRuleSchema = Type.Union([
  GmailSetFieldRuleSchema,
  GmailExtractFieldRuleSchema,
]);
export type GmailFieldRule = Static<typeof GmailFieldRuleSchema>;

export const GmailExtractorRuleSchema = Type.Object(
  {
    source: Type.Literal('gmail'),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    match: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
    fields: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Union([GmailFieldRuleSchema, Type.Array(GmailFieldRuleSchema)])
    ),
  },
  { additionalProperties: false }
);
export type GmailExtractorRule = Static<typeof GmailExtractorRuleSchema>;

export const StructuralExtractorRuleSchema = Type.Object(
  {
    source: Type.Union([
      Type.Literal('drive'),
      Type.Literal('pdfForm'),
      Type.Literal('googleDoc'),
    ]),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    match: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
    fields: Type.Record(Type.String({ minLength: 1 }), Type.Unknown()),
  },
  { additionalProperties: false }
);
export type StructuralExtractorRule = Static<typeof StructuralExtractorRuleSchema>;

export const SourceExtractorRuleSchema = Type.Union([
  GmailExtractorRuleSchema,
  StructuralExtractorRuleSchema,
]);
export type SourceExtractorRule = Static<typeof SourceExtractorRuleSchema>;

export const FallbackExtractorRuleSchema = Type.Object(
  {
    strategy: Type.Literal('ai'),
    fields: Type.Optional(Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type FallbackExtractorRule = Static<typeof FallbackExtractorRuleSchema>;

export const DocumentParseSchemaSchema = Type.Object(
  {
    extractors: Type.Array(SourceExtractorRuleSchema),
    fallback: Type.Optional(Type.Union([FallbackExtractorRuleSchema, Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type DocumentParseSchema = Static<typeof DocumentParseSchemaSchema>;

export interface ParseTargetDocumentField {
  key: string;
  name?: string | undefined;
  type?: string | undefined;
  minLength?: number | undefined;
  pattern?: string | undefined;
  options?: {
    source: string;
    key: string;
    name?: string | undefined;
    allowUserInput?: boolean | undefined;
  } | undefined;
  linkedField?: {
    sourceField: string;
    sourceProperty: string;
  } | undefined;
}

export interface ParseTargetDocumentOptionTuple {
  key: string;
  name?: string | undefined;
  aliases?: string[] | undefined;
  [k: string]: unknown;
}

export interface ParseTargetDocumentSchema {
  fields: ParseTargetDocumentField[];
  calculatedFields?: Array<{ key: string; name?: string }> | undefined;
  options?: Record<string, ParseTargetDocumentOptionTuple[]> | undefined;
}

export const SourceParserSpaceTypeConfigSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  displayName: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  spaceSchema: Type.Object({
    allowedDocumentTypes: Type.Array(Type.String()),
    defaultDocumentType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  }),
  storageConfig: Type.Record(Type.String(), Type.Unknown()),
});
export type SourceParserSpaceTypeConfig = Static<typeof SourceParserSpaceTypeConfigSchema>;

// Driven Ports
export interface DriveSourceContextPort {
  getItemHierarchy(itemId: string): Promise<DriveItemHierarchy>;
}

export interface SourceParserSpaceConfigPort {
  getDocumentSpaceTypes(): Promise<SourceParserSpaceTypeConfig[]> | SourceParserSpaceTypeConfig[];
}

export interface ParseSchemaRegistryPort {
  initialize(): Promise<void>;
  getParseSchema(documentTypeKey: string): Promise<DocumentParseSchema | undefined> | DocumentParseSchema | undefined;
  getTargetSchema(documentTypeKey: string): Promise<ParseTargetDocumentSchema | undefined> | ParseTargetDocumentSchema | undefined;
}

export interface PredicateEvaluatorPort {
  evaluate(rule: unknown, data: Record<string, unknown>): boolean;
}

export interface FallbackFieldExtractorPort {
  extractFields(request: ExtractFieldsRequest): Promise<Record<string, unknown>>;
}

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema(relPath: string): Promise<unknown>;
}

// Driving Port
export interface SourceParserPort {
  inferRouting(context: SourceContext): Promise<InferredRoutingResult>;
  extractFields(request: ExtractFieldsRequest): Promise<ExtractedFieldsResult>;
}

import { Type, type Static, type TSchema } from '@sinclair/typebox';

export const DriveHierarchyNodeSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  mimeType: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  createdTime: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  modifiedTime: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
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
  Type.Literal('attachmentName'),
]);
export type GmailExtractSource = Static<typeof GmailExtractSourceSchema>;

export const DriveExtractSourceSchema = Type.Union([
  Type.Literal('drive.fileName'),
  Type.Literal('drive.fileNameStem'),
  Type.Literal('drive.modifiedTime'),
  Type.Literal('drive.createdTime'),
]);
export type DriveExtractSource = Static<typeof DriveExtractSourceSchema>;

export const FieldCandidateNormalizeSchema = Type.Union([
  Type.Literal('digits6'),
  Type.Literal('pad3'),
  Type.Literal('revision'),
  Type.Literal('yymmdd'),
  Type.Literal('cleanFilenameText'),
]);
export type FieldCandidateNormalize = Static<typeof FieldCandidateNormalizeSchema>;

function createFieldRuleSchemas<T extends TSchema>(sourceSchema: T) {
  const SetFieldRuleSchema = Type.Object(
    {
      when: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
      set: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  );

  const ExtractFieldRuleSchema = Type.Object(
    {
      when: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
      from: sourceSchema,
      pattern: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
      flags: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
      group: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Undefined()])),
      normalize: Type.Optional(Type.Union([FieldCandidateNormalizeSchema, Type.Undefined()])),
    },
    { additionalProperties: false }
  );

  const LookupFieldRuleSchema = Type.Object(
    {
      when: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
      from: sourceSchema,
      pattern: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
      flags: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
      group: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Undefined()])),
      normalize: Type.Optional(Type.Union([FieldCandidateNormalizeSchema, Type.Undefined()])),
      excludePattern: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
      lookup: Type.Literal(true),
    },
    { additionalProperties: false }
  );

  const FieldRuleSchema = Type.Union([
    SetFieldRuleSchema,
    ExtractFieldRuleSchema,
    LookupFieldRuleSchema,
  ]);

  const FieldRuleOrListSchema = Type.Union([
    FieldRuleSchema,
    Type.Array(FieldRuleSchema, { minItems: 1 }),
  ]);

  return {
    SetFieldRuleSchema,
    ExtractFieldRuleSchema,
    LookupFieldRuleSchema,
    FieldRuleSchema,
    FieldRuleOrListSchema,
  };
}

const gmailRuleSchemas = createFieldRuleSchemas(GmailExtractSourceSchema);
export const GmailSetFieldRuleSchema = gmailRuleSchemas.SetFieldRuleSchema;
export type GmailSetFieldRule = Static<typeof GmailSetFieldRuleSchema>;
export const GmailExtractFieldRuleSchema = gmailRuleSchemas.ExtractFieldRuleSchema;
export type GmailExtractFieldRule = Static<typeof GmailExtractFieldRuleSchema>;
export const GmailLookupFieldRuleSchema = gmailRuleSchemas.LookupFieldRuleSchema;
export type GmailLookupFieldRule = Static<typeof GmailLookupFieldRuleSchema>;
export const GmailFieldRuleSchema = gmailRuleSchemas.FieldRuleSchema;
export type GmailFieldRule = Static<typeof GmailFieldRuleSchema>;
export const GmailFieldRuleOrListSchema = gmailRuleSchemas.FieldRuleOrListSchema;
export type GmailFieldRuleOrList = Static<typeof GmailFieldRuleOrListSchema>;

const driveRuleSchemas = createFieldRuleSchemas(DriveExtractSourceSchema);
export const DriveSetFieldRuleSchema = driveRuleSchemas.SetFieldRuleSchema;
export type DriveSetFieldRule = Static<typeof DriveSetFieldRuleSchema>;
export const DriveExtractFieldRuleSchema = driveRuleSchemas.ExtractFieldRuleSchema;
export type DriveExtractFieldRule = Static<typeof DriveExtractFieldRuleSchema>;
export const DriveLookupFieldRuleSchema = driveRuleSchemas.LookupFieldRuleSchema;
export type DriveLookupFieldRule = Static<typeof DriveLookupFieldRuleSchema>;
export const DriveFieldRuleSchema = driveRuleSchemas.FieldRuleSchema;
export type DriveFieldRule = Static<typeof DriveFieldRuleSchema>;
export const DriveFieldRuleOrListSchema = driveRuleSchemas.FieldRuleOrListSchema;
export type DriveFieldRuleOrList = Static<typeof DriveFieldRuleOrListSchema>;

export const AliasDictionarySchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    mappings: Type.Record(Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false }
);
export type AliasDictionary = Static<typeof AliasDictionarySchema>;

export const GmailExtractorRuleSchema = Type.Object(
  {
    source: Type.Literal('gmail'),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    match: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
    fields: Type.Record(
      Type.String({ minLength: 1 }),
      GmailFieldRuleOrListSchema
    ),
  },
  { additionalProperties: false }
);
export type GmailExtractorRule = Static<typeof GmailExtractorRuleSchema>;

export const DriveExtractorRuleSchema = Type.Object(
  {
    source: Type.Literal('drive'),
    name: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    match: Type.Optional(Type.Union([ParseJsonLogicRuleSchema, Type.Undefined()])),
    fields: Type.Record(
      Type.String({ minLength: 1 }),
      DriveFieldRuleOrListSchema
    ),
  },
  { additionalProperties: false }
);
export type DriveExtractorRule = Static<typeof DriveExtractorRuleSchema>;

export const StructuralExtractorRuleSchema = Type.Object(
  {
    source: Type.Union([
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
  DriveExtractorRuleSchema,
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

export const ParseTargetDocumentFieldOptionsSchema = Type.Object(
  {
    source: Type.String(),
    key: Type.String(),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    allowUserInput: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
    dynamicConfig: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type ParseTargetDocumentFieldOptions = Static<typeof ParseTargetDocumentFieldOptionsSchema>;

export const ParseTargetLinkedFieldSchema = Type.Object(
  {
    sourceField: Type.String(),
    sourceProperty: Type.String(),
  },
  { additionalProperties: false }
);
export type ParseTargetLinkedField = Static<typeof ParseTargetLinkedFieldSchema>;

export const ParseTargetDocumentFieldSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    type: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    minLength: Type.Optional(Type.Union([Type.Number(), Type.Undefined()])),
    pattern: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    options: Type.Optional(Type.Union([ParseTargetDocumentFieldOptionsSchema, Type.Undefined()])),
    linkedField: Type.Optional(Type.Union([ParseTargetLinkedFieldSchema, Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type ParseTargetDocumentField = Static<typeof ParseTargetDocumentFieldSchema>;

export const ParseTargetCalculatedFieldSchema = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  },
  { additionalProperties: false }
);
export type ParseTargetCalculatedField = Static<typeof ParseTargetCalculatedFieldSchema>;

export const ParseTargetDocumentOptionTupleSchema = Type.Intersect([
  Type.Object({
    key: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    name: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    aliases: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
  }),
  Type.Record(Type.String(), Type.Unknown()),
]);
export type ParseTargetDocumentOptionTuple = Static<typeof ParseTargetDocumentOptionTupleSchema>;

export const ParseTargetDocumentSchemaSchema = Type.Object(
  {
    fields: Type.Array(ParseTargetDocumentFieldSchema),
    calculatedFields: Type.Optional(Type.Union([Type.Array(ParseTargetCalculatedFieldSchema), Type.Undefined()])),
    options: Type.Optional(
      Type.Union([
        Type.Record(Type.String(), Type.Array(ParseTargetDocumentOptionTupleSchema)),
        Type.Undefined(),
      ])
    ),
  },
  { additionalProperties: false }
);
export type ParseTargetDocumentSchema = Static<typeof ParseTargetDocumentSchemaSchema>;

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

export interface SourceParserConfigPort {
  getWorkspaceTimeZone(): Promise<string | undefined> | string | undefined;
}

export interface ParseSchemaRegistryPort {
  initialize(): Promise<void>;
  getParseSchema(documentTypeKey: string): Promise<DocumentParseSchema | undefined> | DocumentParseSchema | undefined;
  getTargetSchema(documentTypeKey: string): Promise<ParseTargetDocumentSchema | undefined> | ParseTargetDocumentSchema | undefined;
  getAliasDictionary?(sourceKey: string): AliasDictionary | undefined;
}

export interface CanonicalOptionsProviderPort {
  getCanonicalOptions(
    spaceId: string | undefined,
    field: ParseTargetDocumentField
  ): Promise<ParseTargetDocumentOptionTuple[]>;
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

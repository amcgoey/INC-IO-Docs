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

export const SourceContextSchema = Type.Object({
  items: Type.Optional(Type.Union([Type.Array(SourceItemDescriptorSchema), Type.Undefined()])),
  candidateSpaces: Type.Optional(Type.Union([Type.Array(CandidateSpaceDescriptorSchema), Type.Undefined()])),
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
  context: SourceContextSchema,
  existingData: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()])),
});
export type ExtractFieldsRequest = Static<typeof ExtractFieldsRequestSchema>;

export const ExtractedFieldsResultSchema = Type.Object({
  fields: Type.Record(Type.String(), Type.Unknown()),
  statusMessages: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Undefined()])),
});
export type ExtractedFieldsResult = Static<typeof ExtractedFieldsResultSchema>;

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

// Driving Port
export interface SourceParserPort {
  inferRouting(context: SourceContext): Promise<InferredRoutingResult>;
  extractFields(request: ExtractFieldsRequest): Promise<ExtractedFieldsResult>;
}

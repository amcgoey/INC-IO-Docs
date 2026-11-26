import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  ActivityDispatcherPort,
  DocumentSchemaRegistryPort,
  DocumentServicePort,
  DriveFileResult,
  DriveServicePort,
  TemplateEvaluationContext,
  TemplateEvaluatorPort,
  CompiledSchemaRegistryPort,
  DocumentDynamicValidationPort,
  DynamicValidationQuery,
  DynamicValidationMessageFormatter,
  DocumentOptionTablePort,
  DocumentOptionTableResolution,
} from './ports';

const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
const GOOGLE_SHORTCUT_MIME_TYPE = 'application/vnd.google-apps.shortcut';
const MAX_SHORTCUT_HOPS = 5;

export const OPTION_NOT_FOUND_MSG = 'Option not found.';
export const VALIDATION_TIMEOUT_MSG = 'Validation timed out.';

export function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

export const DocumentSpaceModel = Type.Object({
  id: Type.String({ minLength: 1 }),
  typeId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  abstractStorageId: Type.String({ minLength: 1 }),
});

export const DocumentSpaceSchema = DocumentSpaceModel;
export type DocumentSpace = Static<typeof DocumentSpaceModel>;

export const SourceFileSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  content: Type.Optional(Type.Uint8Array()),
});

export const SourceFileType = SourceFileSchema;

export type SourceFile = Static<typeof SourceFileSchema>;

export const DocumentModel = Type.Object({
  // STUB: Pending Chunk 3
  id: Type.Optional(Type.String()),
  // STUB: Pending Chunk 3
  idDocument: Type.Optional(Type.String()),
  // STUB: Pending Chunk 3
  idGroup: Type.Optional(Type.String()),
  type: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
  calculated: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  space: Type.Optional(DocumentSpaceModel),
  sourceFiles: Type.Optional(Type.Array(SourceFileSchema)),
});

export type Document = Static<typeof DocumentModel>;
export type DocumentModel = Document;

const ACTIVITY_ID_PATTERN = '^[A-Za-z_][A-Za-z0-9_-]*$';
const ACTIVITY_ID_REGEX = new RegExp(ACTIVITY_ID_PATTERN);

export const ActivityType = Type.Object({
  id: Type.Optional(Type.String({ pattern: ACTIVITY_ID_PATTERN })),
  type: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type Activity = Static<typeof ActivityType>;

export const FileLocatorType = Type.Object({
  id: Type.String(),
  name: Type.String(),
  parentId: Type.Optional(Type.String()),
  parentName: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  uri: Type.Optional(Type.String()),
});

export type FileLocator = Static<typeof FileLocatorType>;

export const ActivityOutputType = Type.Object({
  success: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  documentDataPatch: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  contextVariables: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  files: Type.Optional(Type.Array(FileLocatorType)),
});

export type ActivityOutput = Static<typeof ActivityOutputType>;

export interface ActivityExecutionContext {
  readonly document: Document;
  readonly files: readonly FileLocator[];
  readonly stepOutputs: Readonly<Record<string, ActivityOutput>>;
  readonly contextVariables: Readonly<Record<string, unknown>>;
}


export const DocumentFieldOptionType = Type.Object(
  {
    source: Type.String(),
    key: Type.String(),
    name: Type.Optional(Type.String()),
    allowUserInput: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false }
);

export type DocumentFieldOption = Static<typeof DocumentFieldOptionType>;

export const LinkedFieldSchema = Type.Object({
  sourceField: Type.String({ minLength: 1 }),
  sourceProperty: Type.String({ minLength: 1 }),
});

export type LinkedField = Static<typeof LinkedFieldSchema>;

export const DocumentFieldType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  type: Type.String(),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  defaultValue: Type.Optional(Type.String()),
  format: Type.Optional(Type.String()),
  minLength: Type.Optional(Type.Number()),
  pattern: Type.Optional(Type.String()),
  options: Type.Optional(DocumentFieldOptionType),
  linkedField: Type.Optional(LinkedFieldSchema),
});

export type DocumentField = Static<typeof DocumentFieldType>;

export const DocumentSchemaOptionTupleType = Type.Record(Type.String(), Type.Unknown());

export type DocumentSchemaOptionTuple = Static<typeof DocumentSchemaOptionTupleType>;

export const DocumentLogOptionSourceSchema = Type.Object(
  {
    provider: Type.Literal('document_log'),
    properties: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false }
);

export type DocumentLogOptionSource = Static<typeof DocumentLogOptionSourceSchema>;

export const GoogleDriveOptionSourceSchema = Type.Object(
  {
    provider: Type.Literal('google_drive'),
    method: Type.Optional(Type.Union([Type.Literal('list_folders'), Type.Undefined()])),
    relativePath: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])),
    properties: Type.Optional(
      Type.Union([Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }), Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);

export type GoogleDriveOptionSource = Static<typeof GoogleDriveOptionSourceSchema>;

export const OptionSourceSchema = Type.Union([
  DocumentLogOptionSourceSchema,
  GoogleDriveOptionSourceSchema,
]);

export type OptionSource = Static<typeof OptionSourceSchema>;

export const DocumentIdentitySchemaType = Type.Object(
  {
    id: Type.Optional(Type.String()),
    idDocument: Type.Optional(Type.String()),
    idGroup: Type.Optional(Type.String()),
  },
  { additionalProperties: Type.String() }
);

export type DocumentIdentitySchema = Static<typeof DocumentIdentitySchemaType>;

export const CalculatedFieldPrefixTransformSchema = Type.Object(
  {
    type: Type.Literal('prefix'),
    length: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false }
);

export type CalculatedFieldPrefixTransform = Static<typeof CalculatedFieldPrefixTransformSchema>;

export const CalculatedFieldUppercaseTransformSchema = Type.Object(
  {
    type: Type.Literal('uppercase'),
  },
  { additionalProperties: false }
);

export type CalculatedFieldUppercaseTransform = Static<typeof CalculatedFieldUppercaseTransformSchema>;

export const CalculatedFieldTransformSchema = Type.Union([
  CalculatedFieldPrefixTransformSchema,
  CalculatedFieldUppercaseTransformSchema,
]);

export type CalculatedFieldTransform = Static<typeof CalculatedFieldTransformSchema>;

export const CalculatedFieldLookupSchema = Type.Object(
  {
    source: Type.String({ minLength: 1 }),
    matchProperty: Type.String({ minLength: 1 }),
    resultProperty: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type CalculatedFieldLookup = Static<typeof CalculatedFieldLookupSchema>;

export const CalculatedFieldType = Type.Object({
  key: Type.String(),
  name: Type.Optional(Type.String()),
  template: Type.String(),
  description: Type.Optional(Type.String()),
  transforms: Type.Optional(
    Type.Union([Type.Array(CalculatedFieldTransformSchema, { minItems: 1 }), Type.Undefined()])
  ),
  lookup: Type.Optional(
    Type.Union([CalculatedFieldLookupSchema, Type.Undefined()])
  ),
  required: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
});

export type CalculatedField = Static<typeof CalculatedFieldType>;

export const SystemContextSchema = Type.Object({
  // STUB: Reserved for future system context expansion
});

export type SystemContext = Static<typeof SystemContextSchema>;

export const DocumentSchemaType = Type.Object({
  fields: Type.Array(DocumentFieldType),
  calculatedFields: Type.Optional(Type.Array(CalculatedFieldType)),
  identity: Type.Optional(DocumentIdentitySchemaType),
  options: Type.Optional(Type.Record(Type.String(), Type.Array(DocumentSchemaOptionTupleType))),
  optionSources: Type.Optional(
    Type.Union([Type.Record(Type.String({ minLength: 1 }), OptionSourceSchema), Type.Undefined()])
  ),
});

export type DocumentSchema = Static<typeof DocumentSchemaType>;

export const UiEventRuleType = Type.Object({
  matchFields: Type.Optional(Type.Record(Type.String(), Type.String())),
  workflow: Type.String(),
});

export type UiEventRule = Static<typeof UiEventRuleType>;

export const UiEventType = Type.Object({
  rules: Type.Optional(Type.Array(UiEventRuleType)),
  catchAllWorkflow: Type.Optional(Type.String()),
});

export type UiEvent = Static<typeof UiEventType>;

export const WorkflowType = Type.Object({
  name: Type.String(),
  activitySequence: Type.Optional(Type.Array(ActivityType)),
});

export type Workflow = Static<typeof WorkflowType>;

export const DocumentWorkflowConfigType = Type.Object({
  workflows: Type.Array(WorkflowType),
});

export type DocumentWorkflowConfig = Static<typeof DocumentWorkflowConfigType>;

export const StorageContextConfigType = Type.Record(Type.String(), Type.Unknown());

export type StorageContextConfig = Static<typeof StorageContextConfigType>;

export const DocumentUiEventsSchema = Type.Object(
  {
    events: Type.Optional(Type.Record(Type.String(), UiEventType)),
  },
  { additionalProperties: true }
);

export type DocumentUiEvents = Static<typeof DocumentUiEventsSchema>;

export const DocumentTypeSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  documentSchema: DocumentSchemaType,
  documentUiSchema: Type.Optional(DocumentUiEventsSchema),
  documentWorkflowConfig: Type.Optional(DocumentWorkflowConfigType),
  storageContextConfig: Type.Optional(StorageContextConfigType),
  allowEmptySourceFiles: Type.Optional(Type.Boolean()),
  maxSourceFiles: Type.Optional(Type.Integer({ minimum: 1 })),
});

export type DocumentType = Static<typeof DocumentTypeSchema>;

export type ProcessDocumentResult =
  | {
      success: true;
      data: Document;
      activities: Activity[];
      outputs: ActivityOutput[];
      stepOutputs?: Record<string, ActivityOutput> | undefined;
      files?: FileLocator[] | undefined;
      contextVariables?: { [key: string]: unknown } | undefined;
    }
  | {
      success: false;
      errors: string[];
      failedStepId?: string | undefined;
      workflowName?: string | undefined;
      stepOutputs?: Record<string, ActivityOutput> | undefined;
      files?: FileLocator[] | undefined;
      contextVariables?: { [key: string]: unknown } | undefined;
    };

/**
 * Maps property names in DocumentIdentitySchema to property names in the Document entity model.
 * DocumentIdentitySchema defines 'id', 'idDocument', and 'idGroup' which map directly to 'id', 'idDocument', and 'idGroup' on the Document entity.
 */
const IDENTITY_SCHEMA_TO_DOCUMENT_FIELD_MAPPING = {
  id: 'id',
  idDocument: 'idDocument',
  idGroup: 'idGroup',
} as const;

function matchFieldValue(value: unknown, expected: string): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === 'string') {
    return value === expected;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      obj.key === expected ||
      obj.id === expected ||
      obj.code === expected ||
      Object.values(obj).some((v) => String(v) === expected)
    );
  }
  return String(value) === expected;
}

export function sanitizeFilePath(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^\s+/, '')
    .replace(/[\s.]+$/, '');
}

const FILE_PATH_PAYLOAD_KEYS = new Set([
  'parentPath',
  'folderName',
  'targetPath',
  'filePath',
  'fileName',
  'targetName',
  'path',
]);

function sanitizeStringsDeepForPath(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeFilePath(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStringsDeepForPath(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeStringsDeepForPath(v);
    }
    return out;
  }
  return value;
}

function resolveCalculatedFieldLookup(params: {
  calcFieldKey: string;
  lookupKey: string;
  lookup: CalculatedFieldLookup;
  documentSchema: DocumentSchema;
  dynamicTables: Readonly<Record<string, DocumentOptionTableResolution>>;
}): { ok: true; value: string } | { ok: false; error: string } {
  const { calcFieldKey, lookupKey, lookup, documentSchema, dynamicTables } = params;
  const trimmedKey = lookupKey.trim();
  if (trimmedKey.length === 0) {
    return {
      ok: false,
      error: `CalculatedField "${calcFieldKey}" could not resolve lookup in "${lookup.source}": lookup key is blank.`,
    };
  }

  let tuples: readonly Record<string, unknown>[];
  const staticOptions = documentSchema.options?.[lookup.source];
  if (staticOptions !== undefined) {
    tuples = staticOptions;
  } else {
    const resolution = dynamicTables[lookup.source];
    if (!resolution) {
      return {
        ok: false,
        error: `CalculatedField "${calcFieldKey}" could not resolve option table "${lookup.source}".`,
      };
    }
    if (resolution.status !== 'ready') {
      return {
        ok: false,
        error:
          resolution.errorMessage ??
          `CalculatedField "${calcFieldKey}" failed to load option table "${lookup.source}" (${resolution.status}).`,
      };
    }
    const { tuples: resolvedTuples } = resolution;
    tuples = resolvedTuples;
  }

  const normalizedKey = trimmedKey.toLowerCase();
  const matches = tuples.filter((tuple) => {
    const rawMatch = tuple[lookup.matchProperty];
    if (rawMatch === undefined || rawMatch === null) {
      return false;
    }
    return String(rawMatch).trim().toLowerCase() === normalizedKey;
  });

  if (matches.length === 0) {
    return {
      ok: false,
      error: `CalculatedField "${calcFieldKey}" could not find matching "${lookup.matchProperty}" = "${trimmedKey}" in option source "${lookup.source}".`,
    };
  }

  const distinctResults = new Set<string>();
  let firstRawResult: unknown;
  for (const match of matches) {
    const val = match[lookup.resultProperty];
    if (firstRawResult === undefined && val !== undefined && val !== null) {
      firstRawResult = val;
    }
    if (val !== undefined && val !== null) {
      const s = String(val).trim();
      if (s.length > 0) {
        distinctResults.add(s);
      }
    }
  }

  if (distinctResults.size > 1) {
    return {
      ok: false,
      error: `CalculatedField "${calcFieldKey}" found ambiguous "${lookup.matchProperty}" = "${trimmedKey}" in option source "${lookup.source}".`,
    };
  }

  if (distinctResults.size === 0 || firstRawResult === undefined || firstRawResult === null) {
    return {
      ok: false,
      error: `CalculatedField "${calcFieldKey}" matched "${trimmedKey}" in "${lookup.source}", but "${lookup.resultProperty}" is blank.`,
    };
  }

  return {
    ok: true,
    value: String(firstRawResult),
  };
}

function applyCalculatedFieldTransforms(
  initialValue: string,
  transforms: readonly CalculatedFieldTransform[] | undefined
): string {
  let result = initialValue;
  if (!transforms) {
    return result;
  }
  for (const transform of transforms) {
    if (transform.type === 'prefix') {
      result = result.slice(0, transform.length);
    } else if (transform.type === 'uppercase') {
      result = result.toUpperCase();
    }
  }
  return result;
}

function createPathSafeDocument(
  document: Document,
  documentType: DocumentType,
  evaluator: TemplateEvaluatorPort
): Document {
  const sanitizedData = sanitizeStringsDeepForPath(document.data) as Record<string, unknown>;
  let sanitizedCalculated: Record<string, unknown> | undefined;

  if (documentType.documentSchema.calculatedFields) {
    const pathBasePayload: Record<string, unknown> = {
      ...sanitizedData,
      ...(document.space !== undefined ? { space: document.space } : {}),
      Document: {
        ...document,
        data: sanitizedData,
        ...(document.space !== undefined ? { space: document.space } : {}),
      },
    };
    sanitizedCalculated = {};
    for (const calcField of documentType.documentSchema.calculatedFields) {
      const hasPostProcessing =
        (calcField.transforms !== undefined && calcField.transforms.length > 0) ||
        calcField.lookup !== undefined;
      if (hasPostProcessing && document.calculated?.[calcField.key] !== undefined) {
        sanitizedCalculated[calcField.key] = sanitizeStringsDeepForPath(
          document.calculated[calcField.key]
        );
      } else {
        const rawEvaluated = evaluator.evaluate(calcField.template, pathBasePayload);
        const transformed = applyCalculatedFieldTransforms(rawEvaluated, calcField.transforms);
        sanitizedCalculated[calcField.key] = sanitizeFilePath(transformed);
      }
    }
  } else if (document.calculated !== undefined) {
    sanitizedCalculated = sanitizeStringsDeepForPath(document.calculated) as Record<string, unknown>;
  }

  return {
    ...document,
    data: sanitizedData,
    ...(sanitizedCalculated !== undefined ? { calculated: sanitizedCalculated } : {}),
  };
}

function matchesRule(matchFields: { [key: string]: string } | undefined, document: Document): boolean {
  if (!matchFields || Object.keys(matchFields).length === 0) {
    return true;
  }
  const documentData = document.data as Record<string, unknown>;
  const documentObj = document as unknown as Record<string, unknown>;

  return Object.entries(matchFields).every(([key, expectedValue]) => {
    const rawValue = documentData[key] !== undefined ? documentData[key] : documentObj[key];
    return matchFieldValue(rawValue, expectedValue);
  });
}

function resolvePayloadTemplates(
  value: unknown,
  evaluator: TemplateEvaluatorPort,
  context: TemplateEvaluationContext,
  pathContext?: TemplateEvaluationContext
): unknown {
  if (typeof value === 'string') {
    return evaluator.evaluate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePayloadTemplates(item, evaluator, context, pathContext));
  }
  if (value !== null && typeof value === 'object') {
    const result: { [key: string]: unknown } = {};
    for (const [k, v] of Object.entries(value as { [key: string]: unknown })) {
      const targetContext =
        pathContext !== undefined && FILE_PATH_PAYLOAD_KEYS.has(k) ? pathContext : context;
      result[k] = resolvePayloadTemplates(v, evaluator, targetContext, pathContext);
    }
    return result;
  }
  return value;
}

function isDynamicOptionField(
  field: DocumentField,
  documentSchema: DocumentSchema
): field is DocumentField & {
  options: DocumentFieldOption;
} {
  return (
    field.options !== undefined &&
    documentSchema.optionSources?.[field.options.source] !== undefined
  );
}

function getSpaceStorageId(space?: DocumentSpace): string | undefined {
  return space?.abstractStorageId ?? space?.id;
}

export function buildFieldSchema(
  field: DocumentField,
  documentSchema: DocumentSchema,
  documentTypeKey: string
): TSchema {
  let fieldSchema: TSchema;
  if (field.type === 'string') {
    const isDynamicSource = isDynamicOptionField(field, documentSchema);
    if (field.options && !field.options.allowUserInput && !isDynamicSource) {
      // nosemgrep: domain-pass-through-read
      const keyProp = field.options.key;
      const nameProp = field.options.name ?? keyProp;
      const optionTuples = documentSchema.options?.[field.options.source] ?? [];
      const uniqueAllowed = Array.from(
        new Set(
          optionTuples
            .flatMap((tuple) => [tuple[keyProp], tuple[nameProp]])
            .filter((val): val is string => typeof val === 'string' && val.length > 0)
        )
      );
      const literals = uniqueAllowed.map((val) => Type.Literal(val));
      if (literals.length === 0) {
        fieldSchema = Type.Never();
      } else if (literals.length === 1) {
        fieldSchema = literals[0];
      } else {
        fieldSchema = Type.Union(literals);
      }
    } else {
      // nosemgrep: domain-pass-through-read
      const { minLength, pattern } = field;
      const stringOptions: { minLength?: number; pattern?: string } = {};
      if (minLength !== undefined) {
        stringOptions.minLength = minLength;
      }
      if (pattern !== undefined) {
        stringOptions.pattern = pattern;
      }
      fieldSchema = Type.String(stringOptions);
    }
  } else {
    throw new Error(`Unsupported field type '${field.type}' in DocumentType '${documentTypeKey}'`);
  }

  if (!field.required) {
    fieldSchema = Type.Optional(fieldSchema);
  }

  return fieldSchema;
}

export function buildDocumentTypeSchema(documentType: DocumentType): TSchema {
  const properties: Record<string, TSchema> = {};
  for (const field of documentType.documentSchema.fields) {
    properties[field.key] = buildFieldSchema(
      field,
      documentType.documentSchema,
      documentType.key
    );
  }
  return Type.Object(properties);
}

const validatedDataObjects = new WeakSet<object>();
const validatedDynamicMatchedTuples = new WeakMap<object, Map<string, Record<string, unknown>>>();
const validatedDerivedLinkedFields = new WeakMap<object, Map<string, string>>();

function matchStaticOptionTuple(
  optionTuples: readonly Record<string, unknown>[],
  candidates: readonly string[],
  keyProp: string,
  nameProp: string | undefined
): Record<string, unknown> | undefined {
  const normalizedCandidates = candidates
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  if (normalizedCandidates.length === 0) {
    return undefined;
  }

  for (const tuple of optionTuples) {
    const rawKey = tuple[keyProp];
    if (rawKey === undefined || rawKey === null) {
      continue;
    }
    const normKey = String(rawKey).trim().toLowerCase();
    if (normKey.length > 0 && normalizedCandidates.includes(normKey)) {
      return tuple;
    }
  }

  if (nameProp !== undefined) {
    for (const tuple of optionTuples) {
      const rawName = tuple[nameProp];
      if (rawName === undefined || rawName === null) {
        continue;
      }
      const normName = String(rawName).trim().toLowerCase();
      if (normName.length > 0 && normalizedCandidates.includes(normName)) {
        return tuple;
      }
    }
  }

  return undefined;
}

function cloneAndFreezePlainValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneAndFreezePlainValue(item))) as unknown as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return value;
  }
  const cloned: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    cloned[key] = cloneAndFreezePlainValue(entryValue);
  }
  return Object.freeze(cloned) as T;
}

function mergeContextVariables(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  const existingNotices = Array.isArray(target.notices) ? target.notices : undefined;
  const hasPatchNotices = Object.prototype.hasOwnProperty.call(patch, 'notices');
  const { notices: patchNoticesRaw } = patch;

  Object.assign(target, patch);

  if (hasPatchNotices) {
    if (patchNoticesRaw === undefined) {
      if (existingNotices !== undefined) {
        target.notices = [...existingNotices];
      } else {
        delete target.notices;
      }
    } else {
      const appended = Array.isArray(patchNoticesRaw) ? patchNoticesRaw : [patchNoticesRaw];
      target.notices = [...(existingNotices ?? []), ...appended];
    }
  }
}

function createActivityExecutionContext(
  document: Document,
  files: readonly FileLocator[],
  stepOutputs: Record<string, ActivityOutput>,
  contextVariables: Record<string, unknown>
): ActivityExecutionContext {
  return Object.freeze({
    document: cloneAndFreezePlainValue(document),
    files,
    stepOutputs: Object.freeze({ ...stepOutputs }),
    contextVariables: Object.freeze({ ...contextVariables }),
  });
}

export class DocumentService implements DocumentServicePort {
  private documentTypes: DocumentType[] = [];

  constructor(
    private readonly dispatcher: ActivityDispatcherPort,
    private readonly documentSchemaRegistry: DocumentSchemaRegistryPort,
    private readonly templateEvaluator: TemplateEvaluatorPort,
    private readonly compiledSchemaRegistry: CompiledSchemaRegistryPort,
    private readonly dynamicValidator?: DocumentDynamicValidationPort,
    private readonly validationMessageFormatter?: DynamicValidationMessageFormatter,
    private readonly selectedLogId?: string,
    private readonly driveService?: DriveServicePort,
    private readonly isEmailAttachmentSource?: boolean,
    private readonly optionTablePort?: DocumentOptionTablePort
  ) {}

  async initialize(): Promise<void> {
    await this.compiledSchemaRegistry.initialize();
    this.documentTypes = await this.documentSchemaRegistry.loadAll();
  }

  private formatDynamicFailure(
    result: { errorMessage?: string | undefined; status?: string | undefined; targetPath?: string | undefined } | undefined
  ): string {
    if (result?.errorMessage !== undefined) {
      return result.errorMessage;
    }
    if (result?.status !== undefined && this.validationMessageFormatter) {
      return this.validationMessageFormatter(
        result.status as Parameters<DynamicValidationMessageFormatter>[0],
        result.targetPath
      );
    }
    if (result?.status === 'timeout') {
      return VALIDATION_TIMEOUT_MSG;
    }
    return OPTION_NOT_FOUND_MSG;
  }

  private collectDynamicQueries(
    fields: readonly DocumentField[],
    documentSchema: DocumentSchema,
    rawData: Record<string, unknown>,
    skipFieldKeys?: ReadonlySet<string>
  ): { queries: DynamicValidationQuery[]; queryFieldKeys: Map<string, string> } {
    const queries: DynamicValidationQuery[] = [];
    const queryFieldKeys = new Map<string, string>();

    for (const field of fields) {
      if (skipFieldKeys?.has(field.key) || !isDynamicOptionField(field, documentSchema)) {
        continue;
      }
      const rawValue = rawData[field.key];
      const valuesToValidate: string[] = [];
      const normalizedValues = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const item of normalizedValues) {
        if (typeof item === 'string') {
          if (!field.required && item.trim() === '') {
            continue;
          }
          valuesToValidate.push(item);
        }
      }

      valuesToValidate.forEach((val, index) => {
        const queryId =
          valuesToValidate.length > 1
            ? `${field.key}_${index}`
            : field.key;
        queryFieldKeys.set(queryId, field.key);
        queries.push({
          sourceKey: field.options.source,
          fieldKey: field.key,
          valueToValidate: val,
          queryId,
          ...(field.options.allowUserInput !== undefined
            ? { allowUserInput: field.options.allowUserInput }
            : {}),
        });
      });
    }

    return { queries, queryFieldKeys };
  }

  public async validateDocument(
    document: DocumentModel
  ): Promise<{ success: boolean; errors?: string[] }> {
    if (
      document.data &&
      typeof document.data === 'object' &&
      validatedDataObjects.has(document.data)
    ) {
      return { success: true };
    }

    const documentType = this.documentTypes.find((rt) => rt.key === document.type);
    const compiled = this.compiledSchemaRegistry.get(document.type);
    if (!compiled || !documentType) {
      return {
        success: false,
        errors: [`Unknown document type: ${document.type}`],
      };
    }

    if (typeof document.data !== 'object' || document.data === null || Array.isArray(document.data)) {
      const errors = formatValidationErrors(compiled.Schema(), document.data);
      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Invalid document data payload'],
      };
    }

    const rawData = document.data as { [key: string]: unknown };
    const candidateData: { [key: string]: unknown } = { ...rawData };
    const matchedDynamicTuples = new Map<string, Record<string, unknown>>();
    const preMatchedStaticTuples = new Map<string, Record<string, unknown>>();
    const preQueriedFieldKeys = new Set<string>();
    const derivedLinkedFields = new Map<string, string>();
    const spaceId = getSpaceStorageId(document.space);

    const linkedFields = documentType.documentSchema.fields.filter(
      (f): f is DocumentField & { linkedField: LinkedField } => f.linkedField !== undefined
    );

    if (linkedFields.length > 0) {
      const sourceFieldKeys = new Set(linkedFields.map((f) => f.linkedField.sourceField));
      const preCandidateFields: DocumentField[] = [];

      for (const sourceKey of sourceFieldKeys) {
        const sourceField = documentType.documentSchema.fields.find((f) => f.key === sourceKey);
        if (!sourceField?.options) {
          continue;
        }
        const rawSourceVal = rawData[sourceField.key];
        if (typeof rawSourceVal !== 'string' || rawSourceVal.trim().length === 0) {
          continue;
        }
        if (isDynamicOptionField(sourceField, documentType.documentSchema)) {
          if (
            this.dynamicValidator &&
            Value.Check(
              buildFieldSchema(sourceField, documentType.documentSchema, documentType.key),
              rawSourceVal
            )
          ) {
            preCandidateFields.push(sourceField);
          }
        } else {
          const optionTuples =
            documentType.documentSchema.options?.[sourceField.options.source] ?? [];
          const staticMatch = matchStaticOptionTuple(
            optionTuples,
            [rawSourceVal, rawSourceVal.trim()],
            sourceField.options.key,
            sourceField.options.name
          );
          if (staticMatch) {
            preMatchedStaticTuples.set(sourceField.key, staticMatch);
          }
        }
      }

      if (preCandidateFields.length > 0 && this.dynamicValidator) {
        const { queries: preQueries, queryFieldKeys: preQueryFieldKeys } =
          this.collectDynamicQueries(preCandidateFields, documentType.documentSchema, rawData);

        if (preQueries.length > 0) {
          const preResults = await this.dynamicValidator.validateExistence(preQueries, {
            ...(spaceId !== undefined ? { spaceId } : {}),
            ...(document.space !== undefined ? { space: document.space } : {}),
            documentTypeKey: document.type,
            ...(this.selectedLogId !== undefined ? { selectedLogId: this.selectedLogId } : {}),
            formData: rawData,
          });

          const preErrors: string[] = [];
          for (const query of preQueries) {
            const fieldKey = preQueryFieldKeys.get(query.queryId);
            if (fieldKey) {
              preQueriedFieldKeys.add(fieldKey);
            }
            const result = preResults[query.queryId] ?? preResults[query.sourceKey];
            if (!result || !result.isValid) {
              preErrors.push(this.formatDynamicFailure(result));
            } else if (result.matchedTuple && query.queryId === fieldKey) {
              matchedDynamicTuples.set(fieldKey, result.matchedTuple);
            }
          }

          if (preErrors.length > 0) {
            return {
              success: false,
              errors: preErrors,
            };
          }
        }
      }

      for (const field of linkedFields) {
        const tuple =
          matchedDynamicTuples.get(field.linkedField.sourceField) ??
          preMatchedStaticTuples.get(field.linkedField.sourceField);
        if (!tuple) {
          continue;
        }
        const rawProp = tuple[field.linkedField.sourceProperty];
        if (rawProp !== undefined && rawProp !== null) {
          const trimmedProp = String(rawProp).trim();
          if (trimmedProp.length > 0) {
            candidateData[field.key] = trimmedProp;
            derivedLinkedFields.set(field.key, trimmedProp);
          }
        }
      }
    }

    if (!compiled.Check(candidateData)) {
      const errors = formatValidationErrors(compiled.Schema(), candidateData);
      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Invalid document data payload'],
      };
    }

    if (this.dynamicValidator) {
      const { queries: dynamicQueries, queryFieldKeys } = this.collectDynamicQueries(
        documentType.documentSchema.fields,
        documentType.documentSchema,
        rawData,
        preQueriedFieldKeys
      );

      if (dynamicQueries.length > 0) {
        const validationResults = await this.dynamicValidator.validateExistence(
          dynamicQueries,
          {
            ...(spaceId !== undefined ? { spaceId } : {}),
            ...(document.space !== undefined ? { space: document.space } : {}),
            documentTypeKey: document.type,
            ...(this.selectedLogId !== undefined ? { selectedLogId: this.selectedLogId } : {}),
            formData: rawData,
          }
        );

        const dynamicErrors: string[] = [];
        for (const query of dynamicQueries) {
          const result = validationResults[query.queryId] ?? validationResults[query.sourceKey];
          if (!result || !result.isValid) {
            dynamicErrors.push(this.formatDynamicFailure(result));
          } else if (result.matchedTuple && query.queryId === queryFieldKeys.get(query.queryId)) {
            matchedDynamicTuples.set(queryFieldKeys.get(query.queryId)!, result.matchedTuple);
          }
        }

        if (dynamicErrors.length > 0) {
          return {
            success: false,
            errors: dynamicErrors,
          };
        }
      }
    }

    if (matchedDynamicTuples.size > 0) {
      validatedDynamicMatchedTuples.set(document.data, matchedDynamicTuples);
    }
    if (derivedLinkedFields.size > 0) {
      validatedDerivedLinkedFields.set(document.data, derivedLinkedFields);
    }

    validatedDataObjects.add(document.data);

    return { success: true };
  }

  private async resolveDriveSourceFile(
    documentType: DocumentType,
    file: SourceFile
  ): Promise<{ ok: true; file: SourceFile } | { ok: false; error: string }> {
    const isDriveItem =
      !(file.content instanceof Uint8Array) &&
      !file.id.startsWith('email-pdf-') &&
      !this.isEmailAttachmentSource;

    if (!isDriveItem || !this.driveService) {
      return { ok: true, file: { ...file } };
    }

    const visited = new Set<string>();
    const { id: initialFileId } = file;
    let currentId = initialFileId;
    let resolvedMeta: DriveFileResult;

    for (let hop = 0; hop <= MAX_SHORTCUT_HOPS; hop++) {
      if (visited.has(currentId)) {
        return { ok: false, error: `Drive shortcut cycle detected for "${initialFileId}".` };
      }
      visited.add(currentId);

      try {
        resolvedMeta = await this.driveService.getFile(currentId);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (resolvedMeta.mimeType !== GOOGLE_SHORTCUT_MIME_TYPE) {
        if (resolvedMeta.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
          return {
            ok: false,
            error: `DocumentType "${documentType.key}" does not accept folders ("${resolvedMeta.name || currentId}"). Please select a single file instead.`,
          };
        }
        return {
          ok: true,
          file: {
            id: resolvedMeta.id,
            ...(resolvedMeta.name
              ? { name: resolvedMeta.name }
              : file.name !== undefined
                ? { name: file.name }
                : {}),
            ...(resolvedMeta.mimeType !== undefined
              ? { mimeType: resolvedMeta.mimeType }
              : file.mimeType !== undefined
                ? { mimeType: file.mimeType }
                : {}),
          },
        };
      }

      const { targetId, targetMimeType } = resolvedMeta.shortcutDetails ?? {};
      if (!targetId) {
        return {
          ok: false,
          error: `Drive shortcut "${resolvedMeta.name || currentId}" has no targetId and cannot be resolved.`,
        };
      }
      if (targetMimeType === GOOGLE_FOLDER_MIME_TYPE) {
        return {
          ok: false,
          error: `DocumentType "${documentType.key}" does not accept folders ("${resolvedMeta.name || currentId}"). Please select a single file instead.`,
        };
      }
      currentId = targetId;
    }

    return {
      ok: false,
      error: `Drive shortcut resolution exceeded ${MAX_SHORTCUT_HOPS} hops for "${initialFileId}".`,
    };
  }

  private async validateAndResolveSourceFiles(
    documentType: DocumentType,
    sourceFiles: readonly SourceFile[] | undefined
  ): Promise<{ ok: true; sourceFiles?: SourceFile[] } | { ok: false; errors: string[] }> {
    if (sourceFiles === undefined) {
      return { ok: true };
    }

    if (documentType.maxSourceFiles === undefined) {
      return { ok: true, sourceFiles: [...sourceFiles] };
    }

    if (sourceFiles.length > documentType.maxSourceFiles) {
      return {
        ok: false,
        errors: [
          `DocumentType "${documentType.key}" allows at most ${documentType.maxSourceFiles} source file(s), but ${sourceFiles.length} were provided.`,
        ],
      };
    }

    const resolvedFiles: SourceFile[] = [];
    for (const file of sourceFiles) {
      if (file.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
        return {
          ok: false,
          errors: [
            `DocumentType "${documentType.key}" does not accept folders ("${file.name ?? file.id}"). Please select a single file instead.`,
          ],
        };
      }
      const resolved = await this.resolveDriveSourceFile(documentType, file);
      if (!resolved.ok) {
        return { ok: false, errors: [resolved.error] };
      }
      resolvedFiles.push(resolved.file);
    }

    return { ok: true, sourceFiles: resolvedFiles };
  }

  async processDocument(
    payload?: unknown,
    eventName?: string
  ): Promise<ProcessDocumentResult> {
    if (!Value.Check(DocumentModel, payload)) {
      const errors = formatValidationErrors(DocumentModel, payload);
      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Invalid document payload'],
      };
    }

    const document = payload;
    const validationResult = await this.validateDocument(document);
    if (!validationResult.success) {
      return {
        success: false,
        errors: validationResult.errors ?? ['Invalid document data payload'],
      };
    }

    const documentType = this.documentTypes.find((rt) => rt.key === document.type)!;
    const sourceFileValidation = await this.validateAndResolveSourceFiles(
      documentType,
      document.sourceFiles
    );
    if (!sourceFileValidation.ok) {
      return {
        success: false,
        errors: sourceFileValidation.errors,
      };
    }
    const { sourceFiles: resolvedSourceFiles } = sourceFileValidation;
    const rawData = document.data as { [key: string]: unknown };

    // Anti-Corruption Layer: Context Enrichment & Fallback Tuple Synthesis
    const schemaFieldKeys = new Set(documentType.documentSchema.fields.map((f) => f.key));
    const enrichedData: { [key: string]: unknown } = {};
    for (const [key, value] of Object.entries(rawData)) {
      if (schemaFieldKeys.has(key)) {
        enrichedData[key] = value;
      }
    }

    const dynamicMatchedTuples =
      document.data && typeof document.data === 'object'
        ? validatedDynamicMatchedTuples.get(document.data)
        : undefined;
    const derivedLinkedFields =
      document.data && typeof document.data === 'object'
        ? validatedDerivedLinkedFields.get(document.data)
        : undefined;

    for (const field of documentType.documentSchema.fields) {
      if (field.options) {
        const rawValue = rawData[field.key];
        // nosemgrep: domain-pass-through-read
        const { key: keyProp, name: nameProp } = field.options;
        if (typeof rawValue === 'string') {
          const trimmedVal = rawValue.trim();
          if (!field.required && trimmedVal === '') {
            delete enrichedData[field.key];
            continue;
          }
          const optionTuples = documentType.documentSchema.options?.[field.options.source] ?? [];
          const matchedTuple =
            dynamicMatchedTuples?.get(field.key) ??
            matchStaticOptionTuple(optionTuples, [rawValue, trimmedVal], keyProp, nameProp);
          if (matchedTuple) {
            enrichedData[field.key] = { ...matchedTuple };
          } else if (field.options.allowUserInput) {
            const fallback: Record<string, unknown> = {
              [keyProp]: trimmedVal,
            };
            if (field.options.name) {
              fallback[field.options.name] = trimmedVal;
            }
            enrichedData[field.key] = fallback;
          }
        } else if (rawValue !== null && typeof rawValue === 'object') {
          const tupleObj = rawValue as Record<string, unknown>;
          if (field.options.allowUserInput) {
            enrichedData[field.key] = { ...tupleObj };
          }
        }
      }
    }

    // Authoritatively re-derive non-blank LinkedField values from matched option tuples
    for (const field of documentType.documentSchema.fields) {
      if (!field.linkedField) {
        continue;
      }
      const preDerived = derivedLinkedFields?.get(field.key);
      if (preDerived !== undefined) {
        enrichedData[field.key] = preDerived;
        continue;
      }
      const sourceTuple = enrichedData[field.linkedField.sourceField];
      if (sourceTuple && typeof sourceTuple === 'object') {
        const rawProp = (sourceTuple as Record<string, unknown>)[field.linkedField.sourceProperty];
        if (rawProp !== undefined && rawProp !== null) {
          const trimmedProp = String(rawProp).trim();
          if (trimmedProp.length > 0) {
            enrichedData[field.key] = trimmedProp;
          }
        }
      }
    }

    // STUB: SystemContext incorporates global system runtime variables
    const systemContext: SystemContext = {};
    const basePayload: { [key: string]: unknown } = {
      ...systemContext,
      ...enrichedData,
      ...(document.space !== undefined ? { space: document.space } : {}),
      Document: {
        ...document,
        data: enrichedData,
        ...(document.space !== undefined ? { space: document.space } : {}),
      },
    };

    const calculatedValues: { [key: string]: unknown } = {};
    const calculatedErrors: string[] = [];
    if (documentType.documentSchema.calculatedFields) {
      const dynamicLookupSources = Array.from(
        new Set(
          documentType.documentSchema.calculatedFields
            .map((cf) => cf.lookup?.source)
            .filter(
              (src): src is string =>
                typeof src === 'string' &&
                src.length > 0 &&
                documentType.documentSchema.options?.[src] === undefined
            )
        )
      );

      let dynamicTables: Record<string, DocumentOptionTableResolution> = {};
      if (dynamicLookupSources.length > 0) {
        if (!this.optionTablePort) {
          return {
            success: false,
            errors: [
              `CalculatedField lookup source "${dynamicLookupSources[0]}" requires DocumentOptionTablePort to be configured.`,
            ],
          };
        }
        const spaceId = getSpaceStorageId(document.space);
        dynamicTables = await this.optionTablePort.resolveOptionTables(dynamicLookupSources, {
          ...(spaceId !== undefined ? { spaceId } : {}),
          ...(document.space !== undefined ? { space: document.space } : {}),
          documentTypeKey: document.type,
          ...(this.selectedLogId !== undefined ? { selectedLogId: this.selectedLogId } : {}),
        });
      }

      for (const calculatedField of documentType.documentSchema.calculatedFields) {
        const templated = this.templateEvaluator.evaluate(
          calculatedField.template,
          basePayload
        );
        let finalValue = applyCalculatedFieldTransforms(templated, calculatedField.transforms);
        if (calculatedField.lookup) {
          const lookupResult = resolveCalculatedFieldLookup({
            calcFieldKey: calculatedField.key,
            lookupKey: finalValue,
            lookup: calculatedField.lookup,
            documentSchema: documentType.documentSchema,
            dynamicTables,
          });
          if (!lookupResult.ok) {
            calculatedErrors.push(lookupResult.error);
            continue;
          }
          finalValue = String(lookupResult.value);
        }
        if (calculatedField.required && finalValue.trim().length === 0) {
          calculatedErrors.push(
            `CalculatedField "${calculatedField.key}" evaluated to a blank value.`
          );
          continue;
        }
        calculatedValues[calculatedField.key] = finalValue;
      }
    }
    if (calculatedErrors.length > 0) {
      return {
        success: false,
        errors: calculatedErrors,
      };
    }

    const identityUpdates: Partial<Document> = {};
    if (documentType.documentSchema.identity) {
      for (const [schemaKey, targetKey] of Object.entries(IDENTITY_SCHEMA_TO_DOCUMENT_FIELD_MAPPING)) {
        const template = documentType.documentSchema.identity[schemaKey as keyof typeof IDENTITY_SCHEMA_TO_DOCUMENT_FIELD_MAPPING];
        if (typeof template === 'string') {
          identityUpdates[targetKey] = this.templateEvaluator.evaluate(
            template,
            basePayload
          );
        }
      }
    }

    let enrichedDocument: Document = {
      ...document,
      ...identityUpdates,
      data: enrichedData,
      ...(Object.keys(calculatedValues).length > 0 ? { calculated: calculatedValues } : {}),
      ...(resolvedSourceFiles !== undefined ? { sourceFiles: resolvedSourceFiles } : {}),
    };

    let selectedWorkflowName: string | undefined;

    if (eventName && documentType.documentUiSchema?.events?.[eventName]) {
      const uiEvent = documentType.documentUiSchema.events[eventName];
      if (uiEvent.rules && uiEvent.rules.length > 0) {
        for (const rule of uiEvent.rules) {
          if (matchesRule(rule.matchFields, enrichedDocument)) {
            // nosemgrep: domain-pass-through-read
            selectedWorkflowName = rule.workflow;
            break;
          }
        }
      }

      if (!selectedWorkflowName && uiEvent.catchAllWorkflow) {
        // nosemgrep: domain-pass-through-read
        selectedWorkflowName = uiEvent.catchAllWorkflow;
      }
    }

    if (!selectedWorkflowName) {
      return {
        success: true,
        data: enrichedDocument,
        activities: [],
        outputs: [],
      };
    }

    const workflow = documentType.documentWorkflowConfig?.workflows.find(
      (w) => w.name === selectedWorkflowName
    );

    if (!workflow) {
      throw new Error(
        `Workflow '${selectedWorkflowName}' not found in configuration for DocumentType '${documentType.key}'`
      );
    }

    const activities = workflow.activitySequence ?? [];
    let storageContext: unknown;
    if (documentType.storageContextConfig !== undefined) {
      storageContext = resolvePayloadTemplates(
        documentType.storageContextConfig,
        this.templateEvaluator,
        { Document: createPathSafeDocument(enrichedDocument, documentType, this.templateEvaluator) }
      );
    }

    const evaluationContext: TemplateEvaluationContext = {
      Document: enrichedDocument,
      documentSchema: documentType.documentSchema,
      Context: {},
      ...(storageContext !== undefined ? { StorageContext: storageContext } : {}),
    };
    const pathEvaluationContext: TemplateEvaluationContext = {
      ...evaluationContext,
      Document: createPathSafeDocument(enrichedDocument, documentType, this.templateEvaluator),
    };

    let currentFiles: readonly FileLocator[] = Object.freeze([]);
    const stepOutputs: Record<string, ActivityOutput> = {};
    const accumulatedContextVariables: { [key: string]: unknown } = {};
    let currentContext: ActivityExecutionContext = createActivityExecutionContext(
      enrichedDocument,
      currentFiles,
      stepOutputs,
      accumulatedContextVariables
    );

    const buildWorkflowFailureResult = (
      errors: string[],
      failedStepId: string | undefined
    ): ProcessDocumentResult => ({
      success: false,
      errors,
      workflowName: workflow.name,
      ...(failedStepId !== undefined ? { failedStepId } : {}),
      stepOutputs: { ...stepOutputs },
      files: [...currentFiles],
      ...(Object.keys(accumulatedContextVariables).length > 0
        ? { contextVariables: { ...accumulatedContextVariables } }
        : {}),
    });

    const resolvedActivities: Activity[] = [];
    const collectedOutputs: ActivityOutput[] = [];
    for (const activity of activities) {
      let resolvedActivity: Activity;
      let output: ActivityOutput | void;
      try {
        const resolvedPayload = (resolvePayloadTemplates(
          activity.payload,
          this.templateEvaluator,
          evaluationContext,
          pathEvaluationContext
        ) ?? {}) as { [key: string]: unknown };

        resolvedActivity = {
          ...(activity.id !== undefined ? { id: activity.id } : {}),
          type: activity.type,
          payload: resolvedPayload,
        };

        output = (await this.dispatcher.dispatch(
          resolvedActivity,
          currentContext
        )) as ActivityOutput | void;
      } catch (error) {
        const message =
          error instanceof Error && error.message.length > 0
            ? error.message
            : typeof error === 'string' && error.length > 0
              ? error
              : `Activity execution failed for ${activity.type}`;
        return buildWorkflowFailureResult([message], activity.id);
      }

      resolvedActivities.push(resolvedActivity);

      if (output !== undefined) {
        collectedOutputs.push(output);
        if (output.success === false) {
          if (output.contextVariables) {
            mergeContextVariables(accumulatedContextVariables, output.contextVariables);
          }
          return buildWorkflowFailureResult(
            [output.error ?? `Activity execution failed for ${activity.type}`],
            activity.id
          );
        }
        if (output.documentDataPatch) {
          enrichedDocument = {
            ...enrichedDocument,
            data: {
              ...enrichedDocument.data,
              ...output.documentDataPatch,
            },
          };
        }
        if (output.files !== undefined) {
          currentFiles = Object.freeze([...output.files]);
        }
        if (activity.id !== undefined) {
          stepOutputs[activity.id] = cloneAndFreezePlainValue(output);
        }
        if (output.contextVariables) {
          mergeContextVariables(evaluationContext, output.contextVariables);
          mergeContextVariables(accumulatedContextVariables, output.contextVariables);
        }
        evaluationContext.Document = enrichedDocument;
        evaluationContext.Context = {
          ...accumulatedContextVariables,
          ...stepOutputs,
        };
        pathEvaluationContext.Document = createPathSafeDocument(
          enrichedDocument,
          documentType,
          this.templateEvaluator
        );
        const { Context: nextContext } = evaluationContext;
        pathEvaluationContext.Context = nextContext;
        currentContext = createActivityExecutionContext(
          enrichedDocument,
          currentFiles,
          stepOutputs,
          accumulatedContextVariables
        );
      }
    }

    const finalResult: ProcessDocumentResult = {
      success: true,
      data: enrichedDocument,
      activities: resolvedActivities,
      outputs: collectedOutputs,
    };
    if (Object.keys(stepOutputs).length > 0) {
      finalResult.stepOutputs = { ...stepOutputs };
    }
    if (currentFiles.length > 0) {
      finalResult.files = [...currentFiles];
    }
    if (Object.keys(accumulatedContextVariables).length > 0) {
      finalResult.contextVariables = accumulatedContextVariables;
    }

    return finalResult;
  }
}

/**
 * Recursively flattens an object into dot-notation paths.
 */
function flattenObjectPaths(obj: unknown, prefix = ''): string[] {
  const paths: string[] = [];
  if (obj === null || obj === undefined) {
    return paths;
  }
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      if (prefix) paths.push(prefix);
      obj.forEach((item, index) => {
        const itemPrefix = prefix ? `${prefix}.${index}` : `${index}`;
        paths.push(itemPrefix);
        paths.push(...flattenObjectPaths(item, itemPrefix));
      });
    } else {
      if (prefix) paths.push(prefix);
      for (const [key, value] of Object.entries(obj as { [key: string]: unknown })) {
        const keyPrefix = prefix ? `${prefix}.${key}` : key;
        paths.push(keyPrefix);
        paths.push(...flattenObjectPaths(value, keyPrefix));
      }
    }
  }
  return paths;
}

/**
 * Traverses an arbitrary JSON structure and invokes a callback for every string template encountered.
 */
export function walkTemplates(
  obj: unknown,
  currentPath: string,
  callback: (path: string, template: string) => void
): void {
  if (obj === null || obj === undefined) {
    return;
  }
  if (typeof obj === 'string') {
    callback(currentPath, obj);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      walkTemplates(item, `${currentPath}[${index}]`, callback);
    });
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as { [key: string]: unknown })) {
      const propPath = currentPath ? `${currentPath}.${key}` : key;
      walkTemplates(value, propPath, callback);
    }
  }
}

const DOCUMENT_SPACE_PROPERTIES = [
  'id',
  'typeId',
  'name',
  'abstractStorageId',
] as const;

const DOCUMENT_SPACE_EXECUTION_VARIABLES = [
  'Document.space',
  ...DOCUMENT_SPACE_PROPERTIES.map((prop) => `Document.space.${prop}`),
];

const DOCUMENT_SPACE_BASE_VARIABLES = [
  'space',
  ...DOCUMENT_SPACE_PROPERTIES.map((prop) => `space.${prop}`),
  ...DOCUMENT_SPACE_EXECUTION_VARIABLES,
];

/**
 * Compiles the list of base variables available during document hydration and identity/calculatedField resolution.
 */
function getBaseVariables(manifest: DocumentType): string[] {
  const vars: string[] = [
    ...Object.keys(SystemContextSchema.properties),
    ...DOCUMENT_SPACE_BASE_VARIABLES,
  ];

  for (const field of manifest.documentSchema.fields) {
    vars.push(field.key);
    if (field.options) {
      const optionSource = manifest.documentSchema.optionSources?.[field.options.source];
      if (optionSource?.properties) {
        for (const prop of optionSource.properties) {
          vars.push(`${field.key}.${prop}`);
        }
      } else {
        if (field.options.key) {
          vars.push(`${field.key}.${field.options.key}`);
        }
        if (field.options.name) {
          vars.push(`${field.key}.${field.options.name}`);
        }
        const optionTuples = manifest.documentSchema.options?.[field.options.source] ?? [];
        for (const tuple of optionTuples) {
          vars.push(...flattenObjectPaths(tuple, field.key));
        }
      }
    }
  }

  return Array.from(new Set(vars));
}

/**
 * Compiles the list of execution variables available during storage context and workflow activity evaluation.
 */
function getExecutionVariables(manifest: DocumentType, baseVariables: string[]): string[] {
  const vars: string[] = [
    'Document.id',
    'Document.idDocument',
    'Document.idGroup',
    'Document.type',
    ...DOCUMENT_SPACE_EXECUTION_VARIABLES,
  ];

  for (const baseVar of baseVariables) {
    vars.push(`Document.data.${baseVar}`);
  }

  if (manifest.documentSchema.calculatedFields) {
    vars.push('Document.calculated');
    for (const calcField of manifest.documentSchema.calculatedFields) {
      vars.push(`Document.calculated.${calcField.key}`);
    }
  }

  const documentSchemaPaths = flattenObjectPaths(manifest.documentSchema, 'documentSchema');
  vars.push(...documentSchemaPaths);

  if (manifest.storageContextConfig) {
    vars.push('StorageContext');
    const storagePaths = flattenObjectPaths(manifest.storageContextConfig, 'StorageContext');
    vars.push(...storagePaths);
  }

  vars.push('Context.*');

  return Array.from(new Set(vars));
}

function validateWorkflowSteps(workflows: Workflow[], errors: string[]): void {
  workflows.forEach((workflow, workflowIndex) => {
    const seenStepIds = new Set<string>();
    const activitySequence = workflow.activitySequence ?? [];
    activitySequence.forEach((activity, activityIndex) => {
      const activityPath = `documentWorkflowConfig.workflows[${workflowIndex}].activitySequence[${activityIndex}]`;
      const hasValidId =
        activity.id !== undefined &&
        typeof activity.id === 'string' &&
        ACTIVITY_ID_REGEX.test(activity.id);

      if (activity.id !== undefined) {
        if (!hasValidId) {
          errors.push(
            `Invalid Activity id "${String(activity.id)}" at "${activityPath}.id": must match ${ACTIVITY_ID_PATTERN}.`
          );
        } else if (seenStepIds.has(activity.id)) {
          errors.push(
            `Duplicate Activity id "${activity.id}" at "${activityPath}.id" within workflow "${workflow.name}".`
          );
        }
      }

      if (
        activity.payload &&
        typeof activity.payload === 'object' &&
        !Array.isArray(activity.payload) &&
        activity.payload['fileSourceStepId'] !== undefined
      ) {
        const fileSourceStepId = activity.payload['fileSourceStepId'];
        if (typeof fileSourceStepId !== 'string') {
          errors.push(
            `Invalid fileSourceStepId at "${activityPath}.payload.fileSourceStepId": must be a string referencing an earlier Activity.id.`
          );
        } else if (!seenStepIds.has(fileSourceStepId)) {
          errors.push(
            `Invalid fileSourceStepId "${fileSourceStepId}" at "${activityPath}.payload.fileSourceStepId": must match an earlier Activity.id in workflow "${workflow.name}".`
          );
        }
      }

      if (
        activity.type === 'DUPLICATE_FILE' &&
        activity.payload &&
        typeof activity.payload === 'object' &&
        !Array.isArray(activity.payload) &&
        activity.payload['fileNamePrefix'] !== undefined
      ) {
        const prefix = activity.payload['fileNamePrefix'];
        if (typeof prefix !== 'string' || prefix.trim().length === 0) {
          errors.push(
            `Invalid fileNamePrefix at "${activityPath}.payload.fileNamePrefix": must be a non-empty string.`
          );
        }
      }

      if (hasValidId && activity.id !== undefined) {
        seenStepIds.add(activity.id);
      }
    });
  });
}

function validateOptionSourcesAndFields(
  documentSchema: DocumentSchema | undefined,
  errors: string[]
): void {
  if (!documentSchema) {
    return;
  }

  if (documentSchema.optionSources) {
    for (const [sourceKey, sourceDef] of Object.entries(documentSchema.optionSources)) {
      if (sourceKey.trim().length === 0) {
        errors.push('OptionSource key in documentSchema.optionSources must be a non-empty string.');
      }
      if (documentSchema.options?.[sourceKey] !== undefined) {
        errors.push(
          `Option source "${sourceKey}" cannot be declared in both documentSchema.options and documentSchema.optionSources.`
        );
      }
      if (sourceDef.properties !== undefined) {
        for (const prop of sourceDef.properties) {
          if (prop.trim().length === 0) {
            errors.push(
              `OptionSource "${sourceKey}" contains an empty or whitespace-only property name.`
            );
          }
        }
      }
      if (
        sourceDef.provider === 'google_drive' &&
        sourceDef.relativePath !== undefined &&
        sourceDef.relativePath.trim().length === 0
      ) {
        errors.push(
          `OptionSource "${sourceKey}" relativePath must be a non-empty string.`
        );
      }
    }
  }

  if (!documentSchema.fields) {
    return;
  }

  for (const field of documentSchema.fields) {
    if (field.options) {
      // nosemgrep: domain-pass-through-read
      const sourceKey = field.options.source;
      const hasStaticOptions = documentSchema.options?.[sourceKey] !== undefined;
      const optionSource = documentSchema.optionSources?.[sourceKey];

      if (!hasStaticOptions && optionSource === undefined) {
        errors.push(`Field "${field.key}" references unknown OptionSource "${sourceKey}".`);
      } else if (optionSource?.properties !== undefined) {
        if (!optionSource.properties.includes(field.options.key)) {
          errors.push(
            `Field "${field.key}" options.key "${field.options.key}" is not declared in OptionSource "${sourceKey}" properties.`
          );
        }
        if (
          field.options.name !== undefined &&
          !optionSource.properties.includes(field.options.name)
        ) {
          errors.push(
            `Field "${field.key}" options.name "${field.options.name}" is not declared in OptionSource "${sourceKey}" properties.`
          );
        }
      }
    }

    if (field.linkedField) {
      // nosemgrep: domain-pass-through-read
      const { sourceField, sourceProperty } = field.linkedField;
      if (sourceField === field.key) {
        errors.push(`Field "${field.key}" has invalid linkedField: cannot reference itself.`);
        continue;
      }
      const targetField = documentSchema.fields.find((f) => f.key === sourceField);
      if (!targetField) {
        errors.push(
          `Field "${field.key}" has invalid linkedField: sourceField "${sourceField}" does not exist.`
        );
        continue;
      }
      if (!targetField.options) {
        errors.push(
          `Field "${field.key}" has invalid linkedField: sourceField "${sourceField}" does not define options.`
        );
        continue;
      }
      // nosemgrep: domain-pass-through-read
      const optionSourceKey = targetField.options.source;
      const declaredOptionSource = documentSchema.optionSources?.[optionSourceKey];
      // nosemgrep: domain-pass-through-read
      const keyProp = targetField.options.key;
      const nameProp = targetField.options.name ?? keyProp;
      if (declaredOptionSource !== undefined) {
        const propertyExists =
          declaredOptionSource.properties !== undefined
            ? declaredOptionSource.properties.includes(sourceProperty)
            : sourceProperty === keyProp || sourceProperty === nameProp;
        if (!propertyExists) {
          errors.push(
            `Field "${field.key}" has invalid linkedField: sourceProperty "${sourceProperty}" does not exist on sourceField "${sourceField}" options.`
          );
        }
      } else {
        const tuples = documentSchema.options?.[optionSourceKey];
        if (tuples && tuples.length > 0) {
          const propertyExists =
            sourceProperty === keyProp ||
            sourceProperty === nameProp ||
            tuples.some((t) => typeof t === 'object' && t !== null && sourceProperty in t);
          if (!propertyExists) {
            errors.push(
              `Field "${field.key}" has invalid linkedField: sourceProperty "${sourceProperty}" does not exist on sourceField "${sourceField}" options.`
            );
          }
        }
      }
    }
  }
}

function validateCalculatedFields(
  documentSchema: DocumentSchema,
  evaluator: TemplateEvaluatorPort,
  baseVariables: string[],
  errors: string[]
): void {
  const { calculatedFields: calcFields } = documentSchema;
  if (!calcFields) {
    return;
  }

  const seenKeys = new Set<string>();
  calcFields.forEach((calcField, index) => {
    const basePath = `documentSchema.calculatedFields[${index}]`;
    const templatePath = `${basePath}.template`;

    if (calcField.key.trim().length === 0) {
      errors.push(`Invalid key at "${basePath}.key": must be a non-empty string.`);
    } else if (seenKeys.has(calcField.key)) {
      errors.push(`Duplicate CalculatedField key "${calcField.key}" at "${basePath}.key".`);
    } else {
      seenKeys.add(calcField.key);
    }

    if (!evaluator.validate(calcField.template, baseVariables)) {
      errors.push(`Invalid template at "${templatePath}": references unknown fields or is malformed.`);
    }

    const requiresNonBlankTemplate =
      calcField.required === true ||
      calcField.lookup !== undefined ||
      calcField.transforms !== undefined;
    if (requiresNonBlankTemplate && calcField.template.trim().length === 0) {
      errors.push(`Invalid template at "${templatePath}": must not be blank.`);
    }

    if (calcField.transforms !== undefined) {
      if (!Array.isArray(calcField.transforms) || calcField.transforms.length === 0) {
        errors.push(`Invalid transforms at "${basePath}.transforms": must be a non-empty array.`);
      } else {
        calcField.transforms.forEach((transform, tIndex) => {
          const tPath = `${basePath}.transforms[${tIndex}]`;
          if (transform.type === 'prefix') {
            if (
              typeof transform.length !== 'number' ||
              !Number.isInteger(transform.length) ||
              transform.length < 1
            ) {
              errors.push(
                `Invalid prefix transform at "${tPath}": length must be an integer >= 1.`
              );
            }
          } else if (transform.type !== 'uppercase') {
            errors.push(`Unsupported transform type at "${tPath}".`);
          }
        });
      }
    }

    if (calcField.lookup !== undefined) {
      const { lookup } = calcField;
      const { source, matchProperty, resultProperty } = lookup;
      const optionSource = documentSchema.optionSources?.[source];
      const staticOptions = documentSchema.options?.[source];
      if (source.trim().length === 0 || (optionSource === undefined && staticOptions === undefined)) {
        errors.push(
          `Invalid lookup at "${basePath}.lookup.source": unknown option source "${source}".`
        );
      } else {
        const checkProperty = (propName: string, propLabel: 'matchProperty' | 'resultProperty') => {
          const propPath = `${basePath}.lookup.${propLabel}`;
          if (propName.trim().length === 0) {
            errors.push(`Invalid lookup at "${propPath}": must be a non-empty string.`);
            return;
          }
          if (optionSource?.properties !== undefined) {
            if (!optionSource.properties.includes(propName)) {
              errors.push(
                `Invalid lookup at "${propPath}": property "${propName}" is not declared in OptionSource "${source}".`
              );
            }
          } else if (staticOptions && staticOptions.length > 0) {
            const existsInTuples = staticOptions.some(
              (tuple) => typeof tuple === 'object' && tuple !== null && propName in tuple
            );
            if (!existsInTuples) {
              errors.push(
                `Invalid lookup at "${propPath}": property "${propName}" does not exist in options "${source}".`
              );
            }
          }
        };
        checkProperty(matchProperty, 'matchProperty');
        checkProperty(resultProperty, 'resultProperty');
      }
    }
  });
}

function validateWorkflowPathPayloads(
  manifest: DocumentType,
  errors: string[]
): void {
  const { workflows } = manifest.documentWorkflowConfig ?? {};
  if (!workflows) {
    return;
  }

  const blankTemplateCalcKeys = new Set(
    (manifest.documentSchema.calculatedFields ?? [])
      .filter((cf) => cf.template.trim().length === 0)
      .map((cf) => cf.key)
  );

  workflows.forEach((workflow, workflowIndex) => {
    const activitySequence = workflow.activitySequence ?? [];
    activitySequence.forEach((activity, activityIndex) => {
      if (!activity.payload || typeof activity.payload !== 'object' || Array.isArray(activity.payload)) {
        return;
      }
      for (const [key, val] of Object.entries(activity.payload)) {
        if (!FILE_PATH_PAYLOAD_KEYS.has(key) || typeof val !== 'string') {
          continue;
        }
        const payloadPath = `documentWorkflowConfig.workflows[${workflowIndex}].activitySequence[${activityIndex}].payload.${key}`;
        if (val.trim().length === 0) {
          errors.push(`Blank folder-routing path at "${payloadPath}": must not be empty or whitespace-only.`);
          continue;
        }
        for (const blankKey of blankTemplateCalcKeys) {
          if (val.includes(`Document.calculated.${blankKey}`)) {
            errors.push(
              `Folder-routing path at "${payloadPath}" references CalculatedField "${blankKey}" with a blank template.`
            );
          }
        }
      }
    });
  });
}

/**
 * Pure domain function to statically validate all Handlebars templates within a DocumentType manifest.
 * Returns an array of formatted error strings using exact dot-notation paths.
 */
export function validateManifestTemplates(
  manifest: DocumentType,
  evaluator: TemplateEvaluatorPort
): string[] {
  const errors: string[] = [];

  const baseVariables = getBaseVariables(manifest);
  const executionVariables = getExecutionVariables(manifest, baseVariables);

  validateOptionSourcesAndFields(manifest.documentSchema, errors);
  validateCalculatedFields(manifest.documentSchema, evaluator, baseVariables, errors);

  if (manifest.documentSchema.identity) {
    for (const [propKey, template] of Object.entries(manifest.documentSchema.identity)) {
      if (typeof template === 'string') {
        const path = `documentSchema.identity.${propKey}`;
        if (!evaluator.validate(template, baseVariables)) {
          errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
        }
      }
    }
  }

  if (manifest.storageContextConfig) {
    walkTemplates(manifest.storageContextConfig, 'storageContextConfig', (path, template) => {
      if (!evaluator.validate(template, executionVariables)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  if (manifest.documentWorkflowConfig) {
    validateWorkflowSteps(manifest.documentWorkflowConfig.workflows, errors);
    validateWorkflowPathPayloads(manifest, errors);

    walkTemplates(manifest.documentWorkflowConfig, 'documentWorkflowConfig', (path, template) => {
      if (!evaluator.validate(template, executionVariables)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  return errors;
}

/**
 * Pure domain helper to format an email PDF filename following a deterministic, filesystem-safe convention:
 * "Email - <Sanitized Subject>.pdf", falling back to "Email - <sanitizedId>.pdf".
 */
export function formatEmailPdfFileName(subject: string | undefined, messageId: string): string {
  const trimmedSubject = subject?.trim();
  const sanitizedSubject = trimmedSubject ? sanitizeFilePath(trimmedSubject).slice(0, 120).trim() : '';

  if (sanitizedSubject.length > 0) {
    return `Email - ${sanitizedSubject}.pdf`;
  }

  const cleanId = sanitizeFilePath(messageId.replace(/[<>]/g, '')).trim();
  return `Email - ${cleanId}.pdf`;
}




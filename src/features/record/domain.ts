import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  ActivityDispatcherPort,
  ManifestRegistryPort,
  RecordServicePort,
  SchemaQueryPort,
  TemplateEvaluationContext,
  TemplateEvaluatorPort,
} from './ports';

export function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

export const RecordModel = Type.Object({
  // STUB: Pending Chunk 3
  id: Type.Optional(Type.String()),
  // STUB: Pending Chunk 3
  idRecord: Type.Optional(Type.String()),
  // STUB: Pending Chunk 3
  idGroup: Type.Optional(Type.String()),
  type: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
});

export type Record = Static<typeof RecordModel>;

export const ActivityType = Type.Object({
  type: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type Activity = Static<typeof ActivityType>;

export const FileLocatorType = Type.Object({
  id: Type.String(),
  name: Type.String(),
  parentName: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  uri: Type.Optional(Type.String()),
});

export type FileLocator = Static<typeof FileLocatorType>;

export const ActivityOutputType = Type.Object({
  success: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  recordDataPatch: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  contextVariables: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  files: Type.Optional(Type.Array(FileLocatorType)),
});

export type ActivityOutput = Static<typeof ActivityOutputType>;

export const ExecutionContextSchema = Type.Object({
  credentials: Type.Optional(
    Type.Object({
      oauthToken: Type.Optional(Type.String()),
    })
  ),
  resources: Type.Optional(
    Type.Object({
      primaryTargetId: Type.Optional(Type.String()),
    })
  ),
});

export type ExecutionContext = Static<typeof ExecutionContextSchema>;

export const RecordFieldOptionType = Type.Object({
  source: Type.String(),
  key: Type.String(),
  name: Type.String(),
  allowUserInput: Type.Optional(Type.Boolean()),
});

export type RecordFieldOption = Static<typeof RecordFieldOptionType>;

export const RecordFieldType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  type: Type.String(),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  defaultValue: Type.Optional(Type.String()),
  format: Type.Optional(Type.String()),
  options: Type.Optional(RecordFieldOptionType),
});

export type RecordField = Static<typeof RecordFieldType>;

export const RecordSchemaOptionTupleType = Type.Record(Type.String(), Type.Unknown());

export type RecordSchemaOptionTuple = Static<typeof RecordSchemaOptionTupleType>;

export const RecordIdentitySchemaType = Type.Object(
  {
    id: Type.Optional(Type.String()),
    idRecord: Type.Optional(Type.String()),
    idGroup: Type.Optional(Type.String()),
  },
  { additionalProperties: Type.String() }
);

export type RecordIdentitySchema = Static<typeof RecordIdentitySchemaType>;

export const CalculatedFieldType = Type.Object({
  key: Type.String(),
  template: Type.String(),
  description: Type.Optional(Type.String()),
});

export type CalculatedField = Static<typeof CalculatedFieldType>;

export const SystemContextSchema = Type.Object({
  // STUB: Reserved for future system context expansion
});

export type SystemContext = Static<typeof SystemContextSchema>;

export const RecordSchemaType = Type.Object({
  fields: Type.Array(RecordFieldType),
  calculatedFields: Type.Optional(Type.Array(CalculatedFieldType)),
  identity: Type.Optional(RecordIdentitySchemaType),
  options: Type.Optional(Type.Record(Type.String(), Type.Array(RecordSchemaOptionTupleType))),
});

export type RecordSchema = Static<typeof RecordSchemaType>;

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

export const RecordUiConfigType = Type.Object({
  events: Type.Optional(Type.Record(Type.String(), UiEventType)),
});

export type RecordUiConfig = Static<typeof RecordUiConfigType>;

export const WorkflowType = Type.Object({
  name: Type.String(),
  activitySequence: Type.Optional(Type.Array(ActivityType)),
});

export type Workflow = Static<typeof WorkflowType>;

export const RecordWorkflowConfigType = Type.Object({
  workflows: Type.Array(WorkflowType),
});

export type RecordWorkflowConfig = Static<typeof RecordWorkflowConfigType>;

export const StorageContextConfigType = Type.Record(Type.String(), Type.Unknown());

export type StorageContextConfig = Static<typeof StorageContextConfigType>;

export const RecordTypeSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  recordSchema: RecordSchemaType,
  recordUiConfig: Type.Optional(RecordUiConfigType),
  recordWorkflowConfig: Type.Optional(RecordWorkflowConfigType),
  storageContextConfig: Type.Optional(StorageContextConfigType),
});

export type RecordType = Static<typeof RecordTypeSchema>;

export const FormSchemaType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  recordSchema: RecordSchemaType,
  recordUiConfig: Type.Optional(RecordUiConfigType),
});

export type FormSchema = Static<typeof FormSchemaType>;

export type ProcessRecordResult =
  | {
      success: true;
      data: Record;
      activities: Activity[];
      outputs: ActivityOutput[];
      contextVariables?: { [key: string]: unknown } | undefined;
    }
  | { success: false; errors: string[] };

/**
 * Maps property names in RecordIdentitySchema to property names in the Record entity model.
 * RecordIdentitySchema defines 'id', 'idRecord', and 'idGroup' which map directly to 'id', 'idRecord', and 'idGroup' on the Record entity.
 */
const IDENTITY_SCHEMA_TO_RECORD_FIELD_MAPPING = {
  id: 'id',
  idRecord: 'idRecord',
  idGroup: 'idGroup',
} as const;

function compileFieldSchema(field: RecordField, recordSchema: RecordSchema, recordTypeKey: string): TSchema {
  let fieldSchema: TSchema;
  if (field.type === 'string') {
    if (field.options && !field.options.allowUserInput) {
      const { source, key } = field.options;
      const optionTuples = recordSchema.options?.[source] ?? [];
      const uniqueKeys = Array.from(
        new Set(
          optionTuples
            .map((tuple) => tuple[key])
            .filter((val): val is string => typeof val === 'string')
        )
      );
      const literals = uniqueKeys.map((val) => Type.Literal(val));
      if (literals.length === 0) {
        fieldSchema = Type.Never();
      } else if (literals.length === 1) {
        fieldSchema = literals[0];
      } else {
        fieldSchema = Type.Union(literals);
      }
    } else {
      fieldSchema = Type.String();
    }
  } else {
    throw new Error(`Unsupported field type '${field.type}' in RecordType '${recordTypeKey}'`);
  }

  if (!field.required) {
    fieldSchema = Type.Optional(fieldSchema);
  }

  return fieldSchema;
}

function matchesRule(matchFields: { [key: string]: string } | undefined, record: Record): boolean {
  if (!matchFields || Object.keys(matchFields).length === 0) {
    return true;
  }
  const recordData = record.data as { [key: string]: unknown };
  const recordObj = record as unknown as { [key: string]: unknown };

  for (const [key, expectedValue] of Object.entries(matchFields)) {
    const rawValue = recordData[key] !== undefined ? recordData[key] : recordObj[key];
    if (rawValue === undefined || rawValue === null) {
      return false;
    }
    if (typeof rawValue === 'string') {
      if (rawValue !== expectedValue) {
        return false;
      }
    } else if (typeof rawValue === 'object') {
      const obj = rawValue as { [key: string]: unknown };
      const match =
        obj.key === expectedValue ||
        obj.id === expectedValue ||
        obj.code === expectedValue ||
        Object.values(obj).some((v) => String(v) === expectedValue);
      if (!match) {
        return false;
      }
    } else if (String(rawValue) !== expectedValue) {
      return false;
    }
  }
  return true;
}

function resolvePayloadTemplates(
  value: unknown,
  evaluator: TemplateEvaluatorPort,
  context: TemplateEvaluationContext
): unknown {
  if (typeof value === 'string') {
    return evaluator.evaluate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePayloadTemplates(item, evaluator, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: { [key: string]: unknown } = {};
    for (const [k, v] of Object.entries(value as { [key: string]: unknown })) {
      result[k] = resolvePayloadTemplates(v, evaluator, context);
    }
    return result;
  }
  return value;
}

export class RecordService implements RecordServicePort, SchemaQueryPort {
  private recordTypes: RecordType[] = [];
  private compiledSchemas = new Map<string, TSchema>();

  constructor(
    private readonly dispatcher: ActivityDispatcherPort,
    private readonly manifestRegistry: ManifestRegistryPort,
    private readonly templateEvaluator: TemplateEvaluatorPort,
  ) {}

  async initialize(): Promise<void> {
    this.recordTypes = await this.manifestRegistry.loadAll();
    this.compiledSchemas.clear();

    for (const recordType of this.recordTypes) {
      const properties: { [key: string]: TSchema } = {};
      for (const field of recordType.recordSchema.fields) {
        properties[field.key] = compileFieldSchema(field, recordType.recordSchema, recordType.key);
      }
      this.compiledSchemas.set(recordType.key, Type.Object(properties));
    }
  }

  async getForms(): Promise<FormSchema[]> {
    return this.recordTypes.map((recordType) => {
      const formSchema: FormSchema = {
        key: recordType.key,
        name: recordType.name,
        recordSchema: recordType.recordSchema,
      };

      if (recordType.recordUiConfig !== undefined) {
        formSchema.recordUiConfig = recordType.recordUiConfig;
      }

      return formSchema;
    });
  }

  async processRecord(
    payload?: unknown,
    eventName?: string,
    context?: ExecutionContext
  ): Promise<ProcessRecordResult> {
    if (!Value.Check(RecordModel, payload)) {
      const errors = formatValidationErrors(RecordModel, payload);
      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Invalid record payload'],
      };
    }

    const record = payload;
    const recordType = this.recordTypes.find((rt) => rt.key === record.type);
    const schema = this.compiledSchemas.get(record.type);
    if (!schema || !recordType) {
      return {
        success: false,
        errors: [`Unknown record type: ${record.type}`],
      };
    }

    if (!Value.Check(schema, record.data)) {
      const errors = formatValidationErrors(schema, record.data);
      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Invalid record data payload'],
      };
    }

    // Anti-Corruption Layer: Context Enrichment & Fallback Tuple Synthesis
    const rawData = record.data as { [key: string]: unknown };
    const enrichedData: { [key: string]: unknown } = { ...rawData };

    for (const field of recordType.recordSchema.fields) {
      if (field.options) {
        const rawValue = rawData[field.key];
        if (typeof rawValue === 'string') {
          const optionTuples = recordType.recordSchema.options?.[field.options.source] ?? [];
          const matchedTuple = optionTuples.find((tuple) => tuple[field.options!.key] === rawValue);
          if (matchedTuple) {
            enrichedData[field.key] = { ...matchedTuple };
          } else if (field.options.allowUserInput) {
            enrichedData[field.key] = {
              [field.options.key]: rawValue,
              [field.options.name]: rawValue,
            };
          }
        }
      }
    }

    // STUB: SystemContext incorporates global system runtime variables
    const systemContext: SystemContext = {};
    const basePayload: { [key: string]: unknown } = {
      ...systemContext,
      ...enrichedData,
    };

    let resolvedData: { [key: string]: unknown } = { ...enrichedData };
    if (recordType.recordSchema.calculatedFields) {
      const calculatedValues: { [key: string]: unknown } = {};
      for (const calculatedField of recordType.recordSchema.calculatedFields) {
        calculatedValues[calculatedField.key] = this.templateEvaluator.evaluate(
          calculatedField.template,
          basePayload
        );
      }
      resolvedData = {
        ...resolvedData,
        ...calculatedValues,
      };
    }

    const identityUpdates: Partial<Record> = {};
    if (recordType.recordSchema.identity) {
      for (const [schemaKey, targetKey] of Object.entries(IDENTITY_SCHEMA_TO_RECORD_FIELD_MAPPING)) {
        const template = recordType.recordSchema.identity[schemaKey as keyof typeof IDENTITY_SCHEMA_TO_RECORD_FIELD_MAPPING];
        if (typeof template === 'string') {
          identityUpdates[targetKey] = this.templateEvaluator.evaluate(
            template,
            basePayload
          );
        }
      }
    }

    let enrichedRecord: Record = {
      ...record,
      ...identityUpdates,
      data: resolvedData,
    };

    let selectedWorkflowName: string | undefined;

    if (eventName && recordType.recordUiConfig?.events?.[eventName]) {
      const uiEvent = recordType.recordUiConfig.events[eventName];
      if (uiEvent.rules && uiEvent.rules.length > 0) {
        for (const rule of uiEvent.rules) {
          if (matchesRule(rule.matchFields, enrichedRecord)) {
            selectedWorkflowName = rule.workflow;
            break;
          }
        }
      }

      if (!selectedWorkflowName && uiEvent.catchAllWorkflow) {
        selectedWorkflowName = uiEvent.catchAllWorkflow;
      }
    }

    if (!selectedWorkflowName) {
      return {
        success: true,
        data: enrichedRecord,
        activities: [],
        outputs: [],
      };
    }

    const workflow = recordType.recordWorkflowConfig?.workflows.find(
      (w) => w.name === selectedWorkflowName
    );

    if (!workflow) {
      throw new Error(
        `Workflow '${selectedWorkflowName}' not found in configuration for RecordType '${recordType.key}'`
      );
    }

    const activities = workflow.activitySequence ?? [];
    let storageContext: unknown;
    if (recordType.storageContextConfig !== undefined) {
      storageContext = resolvePayloadTemplates(
        recordType.storageContextConfig,
        this.templateEvaluator,
        { Record: enrichedRecord }
      );
    }

    const evaluationContext: TemplateEvaluationContext = {
      Record: enrichedRecord,
      RecordSchema: recordType.recordSchema,
      ...(storageContext !== undefined ? { StorageContext: storageContext } : {}),
    };

    const accumulatedContextVariables: { [key: string]: unknown } = {};
    const resolvedActivities: Activity[] = [];
    const collectedOutputs: ActivityOutput[] = [];
    for (const activity of activities) {
      const resolvedPayload = (resolvePayloadTemplates(
        activity.payload,
        this.templateEvaluator,
        evaluationContext
      ) ?? {}) as { [key: string]: unknown };

      const resolvedActivity: Activity = {
        type: activity.type,
        payload: resolvedPayload,
      };

      const output = (context !== undefined
        ? await this.dispatcher.dispatch(resolvedActivity, context)
        : await this.dispatcher.dispatch(resolvedActivity)) as ActivityOutput | void;

      resolvedActivities.push(resolvedActivity);

      if (output) {
        collectedOutputs.push(output);
        if (output.success === false) {
          return {
            success: false,
            errors: [output.error ?? `Activity execution failed for ${activity.type}`],
          };
        }
        if (output.recordDataPatch) {
          enrichedRecord = {
            ...enrichedRecord,
            data: {
              ...enrichedRecord.data,
              ...output.recordDataPatch,
            },
          };
          evaluationContext.Record = enrichedRecord;
        }
        if (output.contextVariables) {
          Object.assign(evaluationContext, output.contextVariables);
          Object.assign(accumulatedContextVariables, output.contextVariables);
        }
      }
    }

    const finalResult: ProcessRecordResult = {
      success: true,
      data: enrichedRecord,
      activities: resolvedActivities,
      outputs: collectedOutputs,
    };
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
 * Extracts any variables referencing the dynamic `Context` namespace from a template string.
 */
function extractContextVariables(template: string): string[] {
  const matches = template.matchAll(/\{\{\{?\s*([a-zA-Z0-9_$.-]+)\s*\}?\}\}/g);
  const vars: string[] = [];
  for (const match of matches) {
    const varName = match[1];
    if (varName === 'Context' || varName.startsWith('Context.')) {
      vars.push(varName);
    }
  }
  return vars;
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

/**
 * Compiles the list of base variables available during record hydration and identity/calculatedField resolution.
 */
function getBaseVariables(manifest: RecordType): string[] {
  const vars: string[] = [
    ...Object.keys(SystemContextSchema.properties),
  ];

  for (const field of manifest.recordSchema.fields) {
    vars.push(field.key);
    if (field.options) {
      vars.push(`${field.key}.${field.options.key}`);
      vars.push(`${field.key}.${field.options.name}`);
      const optionTuples = manifest.recordSchema.options?.[field.options.source] ?? [];
      for (const tuple of optionTuples) {
        for (const tupleKey of Object.keys(tuple)) {
          vars.push(`${field.key}.${tupleKey}`);
        }
      }
    }
  }

  return Array.from(new Set(vars));
}

/**
 * Compiles the list of execution variables available during storage context and workflow activity evaluation.
 */
function getExecutionVariables(manifest: RecordType, baseVariables: string[]): string[] {
  const vars: string[] = [
    'Record.id',
    'Record.idRecord',
    'Record.idGroup',
    'Record.type',
  ];

  if (manifest.recordSchema.identity) {
    for (const propKey of Object.keys(manifest.recordSchema.identity)) {
      vars.push(`Record.${propKey}`);
    }
  }

  for (const baseVar of baseVariables) {
    vars.push(`Record.data.${baseVar}`);
  }

  if (manifest.recordSchema.calculatedFields) {
    for (const calcField of manifest.recordSchema.calculatedFields) {
      vars.push(`Record.data.${calcField.key}`);
    }
  }

  const recordSchemaPaths = flattenObjectPaths(manifest.recordSchema, 'RecordSchema');
  vars.push(...recordSchemaPaths);

  if (manifest.storageContextConfig) {
    vars.push('StorageContext');
    const storagePaths = flattenObjectPaths(manifest.storageContextConfig, 'StorageContext');
    vars.push(...storagePaths);
  }

  vars.push('Context');

  return Array.from(new Set(vars));
}

/**
 * Pure domain function to statically validate all Handlebars templates within a RecordType manifest.
 * Returns an array of formatted error strings using exact dot-notation paths.
 */
export function validateManifestTemplates(
  manifest: RecordType,
  evaluator: TemplateEvaluatorPort
): string[] {
  const errors: string[] = [];

  const baseVariables = getBaseVariables(manifest);
  const executionVariables = getExecutionVariables(manifest, baseVariables);

  if (manifest.recordSchema.calculatedFields) {
    manifest.recordSchema.calculatedFields.forEach((calcField, index) => {
      const path = `recordSchema.calculatedFields[${index}].template`;
      if (!evaluator.validate(calcField.template, baseVariables)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  if (manifest.recordSchema.identity) {
    for (const [propKey, template] of Object.entries(manifest.recordSchema.identity)) {
      if (typeof template === 'string') {
        const path = `recordSchema.identity.${propKey}`;
        if (!evaluator.validate(template, baseVariables)) {
          errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
        }
      }
    }
  }

  if (manifest.storageContextConfig) {
    walkTemplates(manifest.storageContextConfig, 'storageContextConfig', (path, template) => {
      const dynamicVars = extractContextVariables(template);
      const allowed = dynamicVars.length > 0 ? [...executionVariables, ...dynamicVars] : executionVariables;
      if (!evaluator.validate(template, allowed)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  if (manifest.recordWorkflowConfig) {
    walkTemplates(manifest.recordWorkflowConfig, 'recordWorkflowConfig', (path, template) => {
      const dynamicVars = extractContextVariables(template);
      const allowed = dynamicVars.length > 0 ? [...executionVariables, ...dynamicVars] : executionVariables;
      if (!evaluator.validate(template, allowed)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  return errors;
}




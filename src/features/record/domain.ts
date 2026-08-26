import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ActivityDispatcherPort, ManifestRegistryPort, RecordServicePort, SchemaQueryPort, TemplateEvaluatorPort } from './ports';

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

export const RecordTypeSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  recordSchema: RecordSchemaType,
  recordUiConfig: Type.Optional(RecordUiConfigType),
  recordWorkflowConfig: Type.Optional(Type.Unknown()),
  storageContextConfig: Type.Optional(Type.Unknown()),
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
  | { success: true; data: Record; activity: Activity }
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

  async processRecord(payload?: unknown): Promise<ProcessRecordResult> {
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

    const enrichedRecord: Record = {
      ...record,
      ...identityUpdates,
      data: resolvedData,
    };

    // STUB: Raw payload dispatch is an interim solution pending Chunk 3
    const activity: Activity = {
      type: 'LOG_RECORD',
      payload: { record: enrichedRecord },
    };

    await this.dispatcher.dispatch(activity);

    return {
      success: true,
      data: enrichedRecord,
      activity,
    };
  }
}



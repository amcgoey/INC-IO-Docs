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
  IdRecord: Type.Optional(Type.String()),
  // STUB: Pending Chunk 3
  IdGroup: Type.Optional(Type.String()),
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
    Id: Type.Optional(Type.String()),
    IdRecord: Type.Optional(Type.String()),
    IdGroup: Type.Optional(Type.String()),
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

const IDENTITY_FIELD_MAPPING = {
  Id: 'id',
  IdRecord: 'IdRecord',
  IdGroup: 'IdGroup',
} as const;

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
        let fieldSchema: TSchema;
        if (field.type === 'string') {
          fieldSchema = Type.String();
        } else {
          throw new Error(`Unsupported field type '${field.type}' in RecordType '${recordType.key}'`);
        }

        if (!field.required) {
          fieldSchema = Type.Optional(fieldSchema);
        }

        properties[field.key] = fieldSchema;
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

    // STUB: SystemContext incorporates global system runtime variables
    const systemContext: SystemContext = {};
    const basePayload: { [key: string]: unknown } = {
      ...systemContext,
      ...(record.data as { [key: string]: unknown }),
    };

    let resolvedData: { [key: string]: unknown } = { ...(record.data as { [key: string]: unknown }) };
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
      for (const [schemaKey, targetKey] of Object.entries(IDENTITY_FIELD_MAPPING)) {
        const template = recordType.recordSchema.identity[schemaKey as keyof typeof IDENTITY_FIELD_MAPPING];
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



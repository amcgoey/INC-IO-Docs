import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ActivityDispatcherPort, ManifestRegistryPort, RecordServicePort, SchemaQueryPort } from './ports';

export function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

export const RecordModel = Type.Object({
  id: Type.String(),
  type: Type.String(),
  title: Type.String(),
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

export const RecordSchemaType = Type.Object({
  fields: Type.Array(RecordFieldType),
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

export class RecordService implements RecordServicePort, SchemaQueryPort {
  private recordTypes: RecordType[] = [];

  constructor(
    private readonly dispatcher: ActivityDispatcherPort,
    private readonly manifestRegistry: ManifestRegistryPort,
  ) {}

  async initialize(): Promise<void> {
    this.recordTypes = await this.manifestRegistry.loadAll();
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
    if (Value.Check(RecordModel, payload)) {
      const activity: Activity = {
        type: 'LOG_RECORD',
        payload: { record: payload },
      };

      await this.dispatcher.dispatch(activity);

      return {
        success: true,
        data: payload,
        activity,
      };
    }

    const errors = formatValidationErrors(RecordModel, payload);

    return {
      success: false,
      errors: errors.length > 0 ? errors : ['Invalid record payload'],
    };
  }
}



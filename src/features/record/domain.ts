import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ActivityDispatcherPort, ManifestRegistryPort, RecordServicePort, SchemaQueryPort } from './ports';

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
  source: Type.Optional(Type.String()),
  key: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});

export type RecordFieldOption = Static<typeof RecordFieldOptionType>;

export const RecordFieldType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  type: Type.String(),
  description: Type.Optional(Type.String()),
  required: Type.Boolean(),
  defaultValue: Type.Optional(Type.Unknown()),
  format: Type.Optional(Type.String()),
  options: Type.Optional(RecordFieldOptionType),
});

export type RecordField = Static<typeof RecordFieldType>;

export const RecordSchemaType = Type.Object({
  fields: Type.Array(RecordFieldType),
  identity: Type.Optional(Type.Record(Type.String(), Type.String())),
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type RecordSchema = Static<typeof RecordSchemaType>;

export const UiEventRuleType = Type.Object({
  matchFields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
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
});

export type RecordType = Static<typeof RecordTypeSchema>;

export const FormSchemaType = RecordTypeSchema;
export type FormSchema = RecordType;

export type ProcessRecordResult =
  | { success: true; data: Record; activity: Activity }
  | { success: false; errors: string[] };

export class RecordService implements RecordServicePort, SchemaQueryPort {
  private formSchemas: FormSchema[] = [];

  constructor(
    private readonly dispatcher: ActivityDispatcherPort,
    private readonly manifestRegistry?: ManifestRegistryPort,
  ) {}

  async initialize(): Promise<void> {
    if (this.manifestRegistry) {
      const recordTypes = await this.manifestRegistry.loadAll();
      this.formSchemas = recordTypes;
    }
  }


  async getForms(): Promise<FormSchema[]> {
    return this.formSchemas;
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

    const errors = [...Value.Errors(RecordModel, payload)].map(
      (err) => `${err.path}: ${err.message}`
    );

    return {
      success: false,
      errors: errors.length > 0 ? errors : ['Invalid record payload'],
    };
  }
}



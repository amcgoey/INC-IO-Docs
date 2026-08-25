import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ActivityDispatcherPort, RecordServicePort, SchemaQueryPort } from './ports';

export const RecordType = Type.Object({
  id: Type.String(),
  type: Type.String(),
  title: Type.String(),
});

export type Record = Static<typeof RecordType>;

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

export const FormSchemaType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  recordSchema: RecordSchemaType,
  recordUiConfig: Type.Optional(RecordUiConfigType),
});

export type FormSchema = Static<typeof FormSchemaType>;

export const STUB_FORM_SCHEMA: FormSchema = {
  key: 'communication-project',
  name: 'Communication Project',
  recordSchema: {
    fields: [
      {
        key: 'Contact',
        name: 'Contact',
        type: 'string',
        description: 'Contact folder name',
        required: true,
      },
      {
        key: 'Date',
        name: 'Date',
        type: 'string',
        description: 'Date in yyMMdd format',
        required: true,
      },
      {
        key: 'Direction',
        name: 'Direction',
        type: 'string',
        description: 'Communication direction',
        required: true,
        options: {
          source: 'Direction',
          key: 'Key',
          name: 'Name',
        },
      },
      {
        key: 'Description',
        name: 'Description',
        type: 'string',
        description: 'Description of communication',
        required: true,
      },
    ],
    options: {
      Direction: [
        ['IN', 'Incoming'],
        ['OT', 'Outgoing'],
      ],
    },
  },
  recordUiConfig: {
    events: {
      onSubmit: {
        catchAllWorkflow: 'FileCommProject',
      },
    },
  },
};

export type ProcessRecordResult =
  | { success: true; data: Record; activity: Activity }
  | { success: false; errors: string[] };

export class RecordService implements RecordServicePort, SchemaQueryPort {
  constructor(private readonly dispatcher: ActivityDispatcherPort) {}

  async getForms(): Promise<FormSchema[]> {
    return [STUB_FORM_SCHEMA];
  }

  async processRecord(payload?: unknown): Promise<ProcessRecordResult> {
    if (Value.Check(RecordType, payload)) {
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

    const errors = [...Value.Errors(RecordType, payload)].map(
      (err) => `${err.path}: ${err.message}`
    );

    return {
      success: false,
      errors: errors.length > 0 ? errors : ['Invalid record payload'],
    };
  }
}


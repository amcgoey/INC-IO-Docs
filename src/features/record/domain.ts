import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { ActivityDispatcherPort, RecordServicePort } from './ports';

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

export type ProcessRecordResult =
  | { success: true; data: Record; activity: Activity }
  | { success: false; errors: string[] };

export class RecordService implements RecordServicePort {
  constructor(private readonly dispatcher: ActivityDispatcherPort) {}

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


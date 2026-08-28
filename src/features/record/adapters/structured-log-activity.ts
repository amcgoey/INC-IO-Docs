import type { Activity, ActivityOutput } from '../domain';
import type { ActivityDispatcherPort, ActivityHandler } from '../ports';

export class StructuredLogActivity implements ActivityDispatcherPort, ActivityHandler {
  canHandle(activity: Activity): boolean {
    return activity.type === 'LOG_RECORD' || activity.type === 'STRUCTURED_LOG';
  }

  async handle<TContext = unknown>(
    activity: Activity,
    context?: TContext
  ): Promise<ActivityOutput | void> {
    return this.dispatch(activity, context);
  }

  async dispatch<TContext = unknown>(
    activity: Activity,
    context?: TContext
  ): Promise<ActivityOutput | void> {
    void context;
    console.log(JSON.stringify(activity.payload));

    const payload = activity.payload as Record<string, unknown> | undefined;
    if (payload && (payload.recordDataPatch !== undefined || payload.contextVariables !== undefined)) {
      const output: ActivityOutput = {
        success: true,
      };
      if (payload.recordDataPatch !== undefined) {
        output.recordDataPatch = payload.recordDataPatch as Record<string, unknown>;
      }
      if (payload.contextVariables !== undefined) {
        output.contextVariables = payload.contextVariables as Record<string, unknown>;
      }
      return output;
    }
  }
}

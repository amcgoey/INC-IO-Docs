import type { Activity, ActivityExecutionContext, ActivityOutput } from '../domain';
import type { ActivityDispatcherPort, ActivityHandler } from '../ports';

export class ActivityEngine implements ActivityDispatcherPort {
  constructor(private readonly handlers: ActivityHandler[] = []) {}

  async dispatch(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput | void> {
    const handler = this.handlers.find((h) => h.canHandle(activity));
    if (handler) {
      return context !== undefined
        ? handler.handle(activity, context)
        : handler.handle(activity);
    }

    console.log(`Executing activity: ${activity.type}`, activity.payload);
  }
}

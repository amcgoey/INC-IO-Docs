import type { Activity, ActivityOutput } from '../domain';
import type { ActivityDispatcherPort, ActivityHandler, ExecutionContext } from '../ports';

export class ActivityEngine implements ActivityDispatcherPort {
  constructor(private readonly handlers: ActivityHandler[] = []) {}

  async dispatch(
    activity: Activity,
    context?: ExecutionContext
  ): Promise<ActivityOutput | void> {
    const handler = this.handlers.find((h) => h.canHandle(activity));
    if (handler) {
      return handler.handle(activity, context);
    }

    console.log(`Executing activity: ${activity.type}`, activity.payload);
  }
}

import type { Activity } from '../domain';
import type { ActivityDispatcherPort, ActivityHandler } from '../ports';

export class ActivityEngine implements ActivityDispatcherPort {
  constructor(private readonly handlers: ActivityHandler[] = []) {}

  async dispatch<TContext = unknown>(activity: Activity, context?: TContext): Promise<void> {
    const handler = this.handlers.find((h) => h.canHandle(activity));
    if (handler) {
      await handler.handle(activity, context);
      return;
    }

    console.log(`Executing activity: ${activity.type}`, activity.payload);
  }
}

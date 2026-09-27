import type { Activity, ActivityOutput } from '../domain';
import {
  validatePrimaryTargetId,
  type ActivityDispatcherPort,
  type ActivityHandler,
} from '../ports';

export interface ActivityEngineOptions {
  primaryTargetId?: string | undefined;
}

export class ActivityEngine implements ActivityDispatcherPort {
  private readonly primaryTargetId?: string | undefined;

  constructor(
    private readonly handlers: ActivityHandler[] = [],
    options?: ActivityEngineOptions
  ) {
    this.primaryTargetId = validatePrimaryTargetId(options?.primaryTargetId, 'ActivityEngine');
  }

  async dispatch(
    activity: Activity
  ): Promise<ActivityOutput | void> {
    const handler = this.handlers.find((h) => h.canHandle(activity));
    if (handler) {
      return handler.handle(activity);
    }

    console.log(`Executing activity: ${activity.type}`, activity.payload);
  }
}

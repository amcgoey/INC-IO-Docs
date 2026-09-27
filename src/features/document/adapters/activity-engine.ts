import type { Activity, ActivityOutput } from '../domain';
import {
  validatePrimaryTargetId,
  type ActivityDispatcherPort,
  type ActivityHandler,
  type ExecutionContext,
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
    activity: Activity,
    context?: ExecutionContext
  ): Promise<ActivityOutput | void> {
    const handler = this.handlers.find((h) => h.canHandle(activity));
    if (handler) {
      const effectiveContext: ExecutionContext | undefined = this.primaryTargetId
        ? {
            ...context,
            resources: {
              ...context?.resources,
              primaryTargetId: context?.resources?.primaryTargetId ?? this.primaryTargetId,
            },
          }
        : context;
      return handler.handle(activity, effectiveContext);
    }

    console.log(`Executing activity: ${activity.type}`, activity.payload);
  }
}

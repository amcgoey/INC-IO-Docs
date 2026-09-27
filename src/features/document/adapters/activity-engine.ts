import type { Activity, ActivityOutput } from '../domain';
import type { ActivityDispatcherPort, ActivityHandler, ExecutionContext } from '../ports';

export interface ActivityEngineOptions {
  primaryTargetId?: string | undefined;
}

export class ActivityEngine implements ActivityDispatcherPort {
  private readonly primaryTargetId?: string | undefined;

  constructor(
    private readonly handlers: ActivityHandler[] = [],
    options?: ActivityEngineOptions
  ) {
    if (options?.primaryTargetId !== undefined) {
      if (typeof options.primaryTargetId !== 'string' || options.primaryTargetId.trim() === '') {
        throw new Error('ActivityEngine: primaryTargetId must be a non-empty string');
      }
      this.primaryTargetId = options.primaryTargetId;
    }
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

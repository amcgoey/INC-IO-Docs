import type { Activity } from '../domain';
import type { ActivityHandler, ExecutionContext } from '../ports';

export class StructuredLogActivity implements ActivityHandler {
  canHandle(activity: Activity): boolean {
    return activity.type === 'LOG_DOCUMENT' || activity.type === 'STRUCTURED_LOG';
  }

  handle(
    activity: Activity,
    context?: ExecutionContext
  ): void {
    void context;
    console.log(JSON.stringify(activity.payload));
  }
}

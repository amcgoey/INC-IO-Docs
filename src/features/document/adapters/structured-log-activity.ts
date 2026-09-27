import type { Activity } from '../domain';
import type { ActivityHandler } from '../ports';

export class StructuredLogActivity implements ActivityHandler {
  canHandle(activity: Activity): boolean {
    return activity.type === 'LOG_DOCUMENT' || activity.type === 'STRUCTURED_LOG';
  }

  handle(activity: Activity): void {
    console.log(JSON.stringify(activity.payload));
  }
}

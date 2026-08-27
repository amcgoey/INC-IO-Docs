import type { Activity } from '../domain';
import type { ActivityDispatcherPort } from '../ports';

export class StructuredLogActivity implements ActivityDispatcherPort {
  async dispatch<TContext = unknown>(activity: Activity, _context?: TContext): Promise<void> {
    console.log(JSON.stringify(activity.payload));
  }
}

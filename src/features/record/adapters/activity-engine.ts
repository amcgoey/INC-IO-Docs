import type { Activity } from '../domain';
import type { ActivityDispatcherPort } from '../ports';

export class ActivityEngine implements ActivityDispatcherPort {
  async dispatch<TContext = unknown>(activity: Activity, _context?: TContext): Promise<void> {
    console.log(`Executing activity: ${activity.type}`, activity.payload);
  }
}

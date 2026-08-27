import type { Activity } from '../domain';
import type { ActivityDispatcherPort } from '../ports';

export class StructuredLogActivity implements ActivityDispatcherPort {
  async dispatch<TContext = unknown>(activity: Activity, context?: TContext): Promise<void> {
    void context;
    console.log(JSON.stringify(activity.payload));
  }
}

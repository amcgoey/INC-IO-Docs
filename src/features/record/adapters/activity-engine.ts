import type { Activity } from '../domain';
import type { ActivityDispatcherPort } from '../ports';

export class ActivityEngine implements ActivityDispatcherPort {
  async dispatch(activity: Activity): Promise<void> {
    console.log(`Executing activity: ${activity.type}`, activity.payload);
  }
}

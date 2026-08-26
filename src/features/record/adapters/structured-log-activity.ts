import type { Activity } from '../domain';
import type { ActivityDispatcherPort } from '../ports';

export class StructuredLogActivity implements ActivityDispatcherPort {
  async dispatch(activity: Activity): Promise<void> {
    console.log(JSON.stringify(activity.payload));
  }
}

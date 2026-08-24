import { describe, it, expect, vi } from 'vitest';
import { ActivityEngine } from './activity-engine';
import type { Activity } from '../domain';

describe('ActivityEngine driven adapter', () => {
  it('logs activity to console', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const engine = new ActivityEngine();
    const activity: Activity = {
      type: 'LOG_RECORD',
      payload: { record: { id: 'rec-1', type: 'submittal', title: 'Test' } },
    };

    await engine.dispatch(activity);

    expect(consoleSpy).toHaveBeenCalledWith('Executing activity: LOG_RECORD', activity.payload);
    consoleSpy.mockRestore();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { StructuredLogActivity } from './structured-log-activity';
import type { Activity } from '../domain';

describe('StructuredLogActivity driven adapter', () => {
  it('logs dispatched activity payload as JSON string to stdout via console.log', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = new StructuredLogActivity();
    const activity: Activity = {
      type: 'LOG_RECORD',
      payload: {
        targetPath: '1Admin\\Communication\\_Client - AAA\\260826 OT - ASR 06 Design Changes',
        archivePath: 'Archive\\OT\\260826',
      },
    };

    await adapter.dispatch(activity);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(activity.payload));
    consoleSpy.mockRestore();
  });

  it('accepts generic context parameter during dispatch', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = new StructuredLogActivity();
    const activity: Activity = {
      type: 'LOG_RECORD',
      payload: { test: 123 },
    };
    const context = { userToken: 'sample-oauth-token' };

    await adapter.dispatch(activity, context);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(activity.payload));
    consoleSpy.mockRestore();
  });
});

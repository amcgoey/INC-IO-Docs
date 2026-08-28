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

  it('accepts execution context parameter during dispatch', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = new StructuredLogActivity();
    const activity: Activity = {
      type: 'LOG_RECORD',
      payload: { test: 123 },
    };
    const context = { credentials: { oauthToken: 'sample-oauth-token' } };

    await adapter.dispatch(activity, context);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(activity.payload));
    consoleSpy.mockRestore();
  });

  it('canHandle returns true for LOG_RECORD and STRUCTURED_LOG, false for others', () => {
    const adapter = new StructuredLogActivity();
    expect(adapter.canHandle({ type: 'LOG_RECORD', payload: {} })).toBe(true);
    expect(adapter.canHandle({ type: 'STRUCTURED_LOG', payload: {} })).toBe(true);
    expect(adapter.canHandle({ type: 'OTHER_TYPE', payload: {} })).toBe(false);
  });

  it('emits ActivityOutput when recordDataPatch or contextVariables are present in payload', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = new StructuredLogActivity();
    const activity: Activity = {
      type: 'STRUCTURED_LOG',
      payload: {
        message: 'Patching state',
        recordDataPatch: { patchedField: 'patched-value' },
        contextVariables: { customVar: 'custom-val' },
      },
    };

    const output = await adapter.handle(activity);

    expect(output).toEqual({
      success: true,
      recordDataPatch: { patchedField: 'patched-value' },
      contextVariables: { customVar: 'custom-val' },
    });
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(activity.payload));
    consoleSpy.mockRestore();
  });
});

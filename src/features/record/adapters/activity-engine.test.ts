import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivityEngine } from './activity-engine';
import type { Activity } from '../domain';
import type { ActivityHandler } from '../ports';

describe('ActivityEngine driven adapter', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('logs activity to console when no handlers are configured', async () => {
    const engine = new ActivityEngine();
    const activity: Activity = {
      type: 'LOG_RECORD',
      payload: { record: { id: 'rec-1', type: 'submittal', title: 'Test' } },
    };

    await engine.dispatch(activity);

    expect(consoleSpy).toHaveBeenCalledWith('Executing activity: LOG_RECORD', activity.payload);
  });

  it('accepts execution context parameter during dispatch and logs to console when no handlers match', async () => {
    const engine = new ActivityEngine();
    const activity: Activity = {
      type: 'LOG_RECORD',
      payload: { record: { id: 'rec-1' } },
    };
    const context = { credentials: { oauthToken: 'secret-token-xyz' } };

    await engine.dispatch(activity, context);

    expect(consoleSpy).toHaveBeenCalledWith('Executing activity: LOG_RECORD', activity.payload);
  });

  it('delegates activity dispatch to matching ActivityHandler', async () => {
    const mockHandler: ActivityHandler = {
      canHandle: vi.fn((act: Activity) => act.type === 'DRIVE_MOVE_FILE'),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const engine = new ActivityEngine([mockHandler]);
    const activity: Activity = {
      type: 'DRIVE_MOVE_FILE',
      payload: { fileId: 'file-123', destinationFolderId: 'folder-456' },
    };
    const context = { credentials: { oauthToken: 'auth-token-123' } };

    await engine.dispatch(activity, context);

    expect(mockHandler.canHandle).toHaveBeenCalledWith(activity);
    expect(mockHandler.handle).toHaveBeenCalledWith(activity, context);
  });

  it('routes to the first matching handler in priority order when multiple handlers exist', async () => {
    const firstHandler: ActivityHandler = {
      canHandle: vi.fn((act: Activity) => act.type === 'DRIVE_MOVE_FILE'),
      handle: vi.fn().mockResolvedValue(undefined),
    };
    const secondHandler: ActivityHandler = {
      canHandle: vi.fn(() => true),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const engine = new ActivityEngine([firstHandler, secondHandler]);
    const activity: Activity = {
      type: 'DRIVE_MOVE_FILE',
      payload: { fileId: 'file-123' },
    };

    await engine.dispatch(activity);

    expect(firstHandler.canHandle).toHaveBeenCalledWith(activity);
    expect(firstHandler.handle).toHaveBeenCalledWith(activity, undefined);
    expect(secondHandler.canHandle).not.toHaveBeenCalled();
    expect(secondHandler.handle).not.toHaveBeenCalled();
  });

  it('falls back to second handler when first handler cannot handle the activity', async () => {
    const firstHandler: ActivityHandler = {
      canHandle: vi.fn(() => false),
      handle: vi.fn().mockResolvedValue(undefined),
    };
    const secondHandler: ActivityHandler = {
      canHandle: vi.fn((act: Activity) => act.type === 'NOTIFY_USER'),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const engine = new ActivityEngine([firstHandler, secondHandler]);
    const activity: Activity = {
      type: 'NOTIFY_USER',
      payload: { message: 'Hello' },
    };

    await engine.dispatch(activity);

    expect(firstHandler.canHandle).toHaveBeenCalledWith(activity);
    expect(firstHandler.handle).not.toHaveBeenCalled();
    expect(secondHandler.canHandle).toHaveBeenCalledWith(activity);
    expect(secondHandler.handle).toHaveBeenCalledWith(activity, undefined);
  });

  it('falls back to console.log when configured handlers cannot handle the activity', async () => {
    const handler: ActivityHandler = {
      canHandle: vi.fn(() => false),
      handle: vi.fn().mockResolvedValue(undefined),
    };

    const engine = new ActivityEngine([handler]);
    const activity: Activity = {
      type: 'UNHANDLED_TYPE',
      payload: { key: 'val' },
    };

    await engine.dispatch(activity);

    expect(handler.canHandle).toHaveBeenCalledWith(activity);
    expect(handler.handle).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith('Executing activity: UNHANDLED_TYPE', activity.payload);
  });

  it('returns ActivityOutput emitted by matching handler', async () => {
    const expectedOutput = {
      success: true,
      recordDataPatch: { updatedKey: 'new-val' },
      contextVariables: { step1: 'done' },
    };
    const handler: ActivityHandler = {
      canHandle: vi.fn(() => true),
      handle: vi.fn().mockResolvedValue(expectedOutput),
    };

    const engine = new ActivityEngine([handler]);
    const activity: Activity = {
      type: 'CUSTOM_ACTIVITY',
      payload: {},
    };

    const result = await engine.dispatch(activity);
    expect(result).toEqual(expectedOutput);
  });
});

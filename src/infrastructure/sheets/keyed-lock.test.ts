import { describe, it, expect } from 'vitest';
import { KeyedAsyncLock } from './keyed-lock';

describe('KeyedAsyncLock', () => {
  it('serializes tasks sharing the same key sequentially', async () => {
    const lock = new KeyedAsyncLock();
    const order: string[] = [];

    const task1 = lock.acquire('sheet-1', async () => {
      order.push('task1:start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('task1:end');
      return 1;
    });

    const task2 = lock.acquire('sheet-1', async () => {
      order.push('task2:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('task2:end');
      return 2;
    });

    const [res1, res2] = await Promise.all([task1, task2]);

    expect(res1).toBe(1);
    expect(res2).toBe(2);
    expect(order).toEqual([
      'task1:start',
      'task1:end',
      'task2:start',
      'task2:end',
    ]);
  });

  it('runs tasks with different keys concurrently', async () => {
    const lock = new KeyedAsyncLock();
    const order: string[] = [];

    const task1 = lock.acquire('sheet-A', async () => {
      order.push('task1:start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('task1:end');
    });

    const task2 = lock.acquire('sheet-B', async () => {
      order.push('task2:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('task2:end');
    });

    await Promise.all([task1, task2]);

    // task2 finishes before task1 because they run concurrently
    expect(order).toEqual([
      'task1:start',
      'task2:start',
      'task2:end',
      'task1:end',
    ]);
  });

  it('does not deadlock or poison the queue when a prior task throws', async () => {
    const lock = new KeyedAsyncLock();

    const failingTask = lock.acquire('sheet-1', async () => {
      throw new Error('Task failure');
    });

    const succeedingTask = lock.acquire('sheet-1', async () => {
      return 'recovered';
    });

    await expect(failingTask).rejects.toThrow('Task failure');
    await expect(succeedingTask).resolves.toBe('recovered');
  });

  it('cleans up queue entries from the map once finished', async () => {
    const lock = new KeyedAsyncLock();

    await lock.acquire('sheet-1', async () => {
      return 'done';
    });

    // Verify internal map size is 0
    expect(lock.activeKeyCount).toBe(0);
  });
});

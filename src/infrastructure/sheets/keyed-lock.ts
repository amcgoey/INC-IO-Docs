/**
 * In-memory keyed asynchronous lock that serializes promises for a given key.
 * Used to prevent race conditions during read-calculate-write cycles (e.g. Google Sheets row insertion).
 */
export class KeyedAsyncLock {
  private queues = new Map<string, Promise<unknown>>();

  /**
   * Acquires the lock for a given key, runs the task when previous tasks for this key have settled,
   * and returns the result of the task.
   */
  async acquire<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prevTask = this.queues.get(key) ?? Promise.resolve();

    const currentTask = (async () => {
      try {
        await prevTask;
      } catch {
        // Suppress failure from previous task so the queue is not permanently blocked
      }
      return await task();
    })();

    this.queues.set(key, currentTask);

    try {
      return await currentTask;
    } finally {
      if (this.queues.get(key) === currentTask) {
        this.queues.delete(key);
      }
    }
  }

  /**
   * Returns the number of active lock keys currently in the map.
   */
  get activeKeyCount(): number {
    return this.queues.size;
  }
}

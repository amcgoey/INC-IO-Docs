import { describe, it, expect } from 'vitest';
import { processRecord } from './domain';

describe('Record domain', () => {
  it('processRecord returns hardcoded success', () => {
    const result = processRecord({ sample: 'payload' });
    expect(result).toEqual({ success: true });
  });
});

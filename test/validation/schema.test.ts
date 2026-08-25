import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ManifestRegistryAdapter } from '../../src/features/record/adapters/manifest-registry';
import { RecordTypeSchema } from '../../src/features/record/domain';
import { Value } from '@sinclair/typebox/value';

describe('RecordType JSON files schema validation', () => {
  it('should validate all RecordType JSON files referenced by manifest.json against Typebox schemas', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const adapter = new ManifestRegistryAdapter({ manifestPath });
    const recordTypes = await adapter.loadAll();

    expect(recordTypes.length).toBeGreaterThan(0);
    for (const recordType of recordTypes) {
      expect(Value.Check(RecordTypeSchema, recordType)).toBe(true);
    }
  });
});


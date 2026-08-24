import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

describe('DocumentType Schema Validation', () => {
  it('should validate DocumentType schema definition against Typebox', () => {
    const DocumentTypeSchema = Type.Object({
      id: Type.String(),
      name: Type.String(),
      version: Type.Number(),
    });

    const sampleDoc = {
      id: 'doc-template-01',
      name: 'Standard Invoice',
      version: 1,
    };

    expect(Value.Check(DocumentTypeSchema, sampleDoc)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import {
  parseJson,
  formatValidationErrors,
  validateAndCleanSchema,
} from './json-schema';

describe('json-schema utilities', () => {
  describe('parseJson', () => {
    it('parses valid JSON string', () => {
      const result = parseJson('{"name": "test", "count": 42}', 'test payload');
      expect(result).toEqual({ name: 'test', count: 42 });
    });

    it('throws error with context description on invalid JSON', () => {
      expect(() => parseJson('{ invalid json }', 'test config')).toThrow(
        /Invalid JSON in test config:/i
      );
    });
  });

  describe('formatValidationErrors', () => {
    const TestSchema = Type.Object({
      name: Type.String(),
      age: Type.Number(),
    });

    it('returns empty array when there are no validation errors', () => {
      const errors = formatValidationErrors(TestSchema, { name: 'Alice', age: 30 });
      expect(errors).toEqual([]);
    });

    it('returns formatted path and message for validation errors', () => {
      const errors = formatValidationErrors(TestSchema, { name: 123 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.includes('/name'))).toBe(true);
      expect(errors.some((e) => e.includes('/age'))).toBe(true);
    });
  });

  describe('validateAndCleanSchema', () => {
    const SimpleSchema = Type.Object({
      title: Type.String(),
      score: Type.Optional(Type.Number()),
    });

    it('strips extraneous properties and returns typed object', () => {
      const input = {
        title: 'Hello',
        score: 10,
        extraProp: 'to be removed',
      };
      const cleaned = validateAndCleanSchema(SimpleSchema, input, 'Validation error');
      expect(cleaned).toEqual({ title: 'Hello', score: 10 });
      expect(cleaned).not.toHaveProperty('extraProp');
    });

    it('throws descriptive error on schema validation failure', () => {
      const input = {
        title: 123,
      };
      expect(() =>
        validateAndCleanSchema(SimpleSchema, input, 'Invalid schema structure')
      ).toThrow(/Invalid schema structure: \/title:/i);
    });
  });
});

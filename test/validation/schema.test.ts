import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ManifestRegistryAdapter } from '../../src/features/record/adapters/manifest-registry';
import { HandlebarsAdapter } from '../../src/infrastructure/template-engine/handlebars-adapter';
import {
  RecordTypeSchema,
  FormSchemaType,
  formatValidationErrors,
} from '../../src/features/record/domain';
import { Value } from '@sinclair/typebox/value';

describe('RecordType JSON files schema validation', () => {
  it('should validate all RecordType JSON files referenced by manifest.json against Typebox schemas', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const adapter = new ManifestRegistryAdapter({
      manifestPath,
      templateEvaluator: new HandlebarsAdapter(),
    });
    const recordTypes = await adapter.loadAll();

    expect(recordTypes.length).toBeGreaterThan(0);
    for (const recordType of recordTypes) {
      const errors = formatValidationErrors(RecordTypeSchema, recordType);
      expect(errors).toEqual([]);
      expect(Value.Check(RecordTypeSchema, recordType)).toBe(true);

      // Verify essential properties
      expect(typeof recordType.key).toBe('string');
      expect(recordType.key.length).toBeGreaterThan(0);
      expect(typeof recordType.name).toBe('string');
      expect(recordType.name.length).toBeGreaterThan(0);

      // Verify fields
      expect(Array.isArray(recordType.recordSchema.fields)).toBe(true);
      expect(recordType.recordSchema.fields.length).toBeGreaterThan(0);
      for (const field of recordType.recordSchema.fields) {
        expect(typeof field.key).toBe('string');
        expect(typeof field.name).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(typeof field.required).toBe('boolean');
      }

      // Verify calculatedFields if present
      if (recordType.recordSchema.calculatedFields) {
        expect(Array.isArray(recordType.recordSchema.calculatedFields)).toBe(true);
        for (const calcField of recordType.recordSchema.calculatedFields) {
          expect(typeof calcField.key).toBe('string');
          expect(calcField.key.length).toBeGreaterThan(0);
          expect(typeof calcField.template).toBe('string');
          expect(calcField.template.length).toBeGreaterThan(0);
        }
      }

      // Verify identity if present
      if (recordType.recordSchema.identity) {
        expect(typeof recordType.recordSchema.identity).toBe('object');
        if (recordType.recordSchema.identity.id) {
          expect(typeof recordType.recordSchema.identity.id).toBe('string');
          expect(recordType.recordSchema.identity.id.length).toBeGreaterThan(0);
        }
        if (recordType.recordSchema.identity.idRecord) {
          expect(typeof recordType.recordSchema.identity.idRecord).toBe('string');
          expect(recordType.recordSchema.identity.idRecord.length).toBeGreaterThan(0);
        }
        if (recordType.recordSchema.identity.idGroup) {
          expect(typeof recordType.recordSchema.identity.idGroup).toBe('string');
          expect(recordType.recordSchema.identity.idGroup.length).toBeGreaterThan(0);
        }
      }

      // Verify FormSchema projection matches tightened FormSchemaType
      const formSchema = {
        key: recordType.key,
        name: recordType.name,
        recordSchema: recordType.recordSchema,
        ...(recordType.recordUiConfig !== undefined && {
          recordUiConfig: recordType.recordUiConfig,
        }),
      };
      expect(Value.Check(FormSchemaType, formSchema)).toBe(true);
      expect(formSchema).not.toHaveProperty('recordWorkflowConfig');
      expect(formSchema).not.toHaveProperty('storageContextConfig');
    }
  });
});



import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ManifestRegistryAdapter } from '../../src/features/document/adapters/manifest-registry';
import { HandlebarsAdapter } from '../../src/infrastructure/template-engine/handlebars-adapter';
import {
  DocumentTypeSchema,
  FormSchemaType,
  formatValidationErrors,
} from '../../src/features/document/domain';
import { Value } from '@sinclair/typebox/value';

describe('DocumentType JSON files schema validation', () => {
  it('should validate all DocumentType JSON files referenced by manifest.json against Typebox schemas', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const adapter = new ManifestRegistryAdapter({
      manifestPath,
      templateEvaluator: new HandlebarsAdapter(),
    });
    const documentTypes = await adapter.loadAll();

    expect(documentTypes.length).toBeGreaterThan(0);
    for (const documentType of documentTypes) {
      const errors = formatValidationErrors(DocumentTypeSchema, documentType);
      expect(errors).toEqual([]);
      expect(Value.Check(DocumentTypeSchema, documentType)).toBe(true);

      // Verify essential properties
      expect(typeof documentType.key).toBe('string');
      expect(documentType.key.length).toBeGreaterThan(0);
      expect(typeof documentType.name).toBe('string');
      expect(documentType.name.length).toBeGreaterThan(0);

      // Verify fields
      expect(Array.isArray(documentType.documentSchema.fields)).toBe(true);
      expect(documentType.documentSchema.fields.length).toBeGreaterThan(0);
      for (const field of documentType.documentSchema.fields) {
        expect(typeof field.key).toBe('string');
        expect(typeof field.name).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(typeof field.required).toBe('boolean');
      }

      // Verify calculatedFields if present
      if (documentType.documentSchema.calculatedFields) {
        expect(Array.isArray(documentType.documentSchema.calculatedFields)).toBe(true);
        for (const calcField of documentType.documentSchema.calculatedFields) {
          expect(typeof calcField.key).toBe('string');
          expect(calcField.key.length).toBeGreaterThan(0);
          expect(typeof calcField.template).toBe('string');
          expect(calcField.template.length).toBeGreaterThan(0);
        }
      }

      // Verify identity if present
      if (documentType.documentSchema.identity) {
        expect(typeof documentType.documentSchema.identity).toBe('object');
        if (documentType.documentSchema.identity.id) {
          expect(typeof documentType.documentSchema.identity.id).toBe('string');
          expect(documentType.documentSchema.identity.id.length).toBeGreaterThan(0);
        }
        if (documentType.documentSchema.identity.idDocument) {
          expect(typeof documentType.documentSchema.identity.idDocument).toBe('string');
          expect(documentType.documentSchema.identity.idDocument.length).toBeGreaterThan(0);
        }
        if (documentType.documentSchema.identity.idGroup) {
          expect(typeof documentType.documentSchema.identity.idGroup).toBe('string');
          expect(documentType.documentSchema.identity.idGroup.length).toBeGreaterThan(0);
        }
      }

      // Verify FormSchema projection matches tightened FormSchemaType
      const formSchema = {
        key: documentType.key,
        name: documentType.name,
        documentSchema: documentType.documentSchema,
        ...(documentType.documentUiConfig !== undefined && {
          documentUiConfig: documentType.documentUiConfig,
        }),
      };
      expect(Value.Check(FormSchemaType, formSchema)).toBe(true);
      expect(formSchema).not.toHaveProperty('documentWorkflowConfig');
      expect(formSchema).not.toHaveProperty('storageContextConfig');
    }
  });
});



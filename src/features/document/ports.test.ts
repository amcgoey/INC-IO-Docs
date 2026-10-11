import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  FormSchemaType,
  DynamicValidationQuerySchema,
  DynamicValidationResultSchema,
  DynamicValidationContextSchema,
  type FormSchema,
} from './ports';

describe('Document Ports & DTOs', () => {
  it('FormSchemaType validates FormSchema definitions', () => {
    expect(FormSchemaType).toBeDefined();
    const validFormSchema: FormSchema = {
      key: 'submittal',
      name: 'Submittal Document',
      documentSchema: {
        fields: [
          {
            key: 'title',
            name: 'Title',
            type: 'string',
            required: true,
          },
        ],
      },
      documentUiSchema: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitSubmittal',
          },
        },
      },
    };
    expect(Value.Check(FormSchemaType, validFormSchema)).toBe(true);
  });

  it('FormSchemaType validates FormSchema definitions without optional documentUiSchema', () => {
    const validFormSchema: FormSchema = {
      key: 'rfi',
      name: 'RFI Document',
      documentSchema: {
        fields: [
          {
            key: 'subject',
            name: 'Subject',
            type: 'string',
            required: true,
          },
        ],
      },
    };
    expect(Value.Check(FormSchemaType, validFormSchema)).toBe(true);
  });

  it('DynamicValidationQuerySchema validates dynamic validation queries', () => {
    const validQuery = {
      sourceKey: 'contactFolders',
      config: {
        provider: 'google_drive',
        method: 'list_folders',
        relativePath: '1 Admin/Communication',
      },
      valueToValidate: 'Acme Corp',
    };
    expect(Value.Check(DynamicValidationQuerySchema, validQuery)).toBe(true);
    expect(Value.Check(DynamicValidationQuerySchema, { sourceKey: 'a', config: {} })).toBe(false);
  });

  it('DynamicValidationResultSchema validates dynamic validation results', () => {
    expect(Value.Check(DynamicValidationResultSchema, { isValid: true })).toBe(true);
    expect(
      Value.Check(DynamicValidationResultSchema, {
        isValid: false,
        errorMessage: 'Option not found.',
      })
    ).toBe(true);
    expect(Value.Check(DynamicValidationResultSchema, { isValid: 'yes' })).toBe(false);
  });

  it('DynamicValidationContextSchema validates dynamic validation context', () => {
    expect(Value.Check(DynamicValidationContextSchema, {})).toBe(true);
    expect(
      Value.Check(DynamicValidationContextSchema, {
        spaceId: 'space-123',
        formData: { field1: 'val' },
      })
    ).toBe(true);
  });
});


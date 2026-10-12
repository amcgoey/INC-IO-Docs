import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  FormSchemaType,
  type FormSchema,
  DynamicValidationQuerySchema,
  DynamicValidationResultSchema,
  DynamicValidationContextSchema,
  OPTION_NOT_FOUND_MSG,
  VALIDATION_TIMEOUT_MSG,
  resolveQueryKey,
  type DocumentDynamicValidationPort,
  type DynamicValidationQuery,
  type DynamicValidationResult,
  type DynamicValidationContext,
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

  it('DocumentDynamicValidationPort satisfies interface contract', async () => {
    const port: DocumentDynamicValidationPort = {
      validateExistence: async (
        queries: DynamicValidationQuery[],
        context: DynamicValidationContext
      ): Promise<Record<string, DynamicValidationResult>> => {
        const results: Record<string, DynamicValidationResult> = {};
        for (const q of queries) {
          results[q.sourceKey] = { isValid: Boolean(context.spaceId) };
        }
        return results;
      },
    };

    const res = await port.validateExistence(
      [
        {
          sourceKey: 'contactFolders',
          config: { provider: 'google_drive', method: 'list_folders' },
          valueToValidate: 'Acme',
        },
      ],
      { spaceId: 'space-123' }
    );

    expect(res.contactFolders.isValid).toBe(true);
  });

  it('validates DynamicValidationQuerySchema with Value.Check', () => {
    const validQuery: DynamicValidationQuery = {
      sourceKey: 'contactFolders',
      config: { provider: 'google_drive', method: 'list_folders' },
      valueToValidate: 'Acme',
      queryId: 'field_1',
    };
    expect(Value.Check(DynamicValidationQuerySchema, validQuery)).toBe(true);

    const invalidQuery = {
      sourceKey: 123,
      config: 'not-an-object',
      valueToValidate: true,
    };
    expect(Value.Check(DynamicValidationQuerySchema, invalidQuery)).toBe(false);
  });

  it('validates DynamicValidationResultSchema with Value.Check', () => {
    const validResult: DynamicValidationResult = {
      isValid: false,
      errorMessage: 'Option not found.',
    };
    expect(Value.Check(DynamicValidationResultSchema, validResult)).toBe(true);

    const invalidResult = {
      isValid: 'not-a-boolean',
    };
    expect(Value.Check(DynamicValidationResultSchema, invalidResult)).toBe(false);
  });

  it('validates DynamicValidationContextSchema with Value.Check', () => {
    const validContext: DynamicValidationContext = {
      spaceId: 'sp-1',
      formData: { name: 'Test' },
    };
    expect(Value.Check(DynamicValidationContextSchema, validContext)).toBe(true);

    const emptyContext: DynamicValidationContext = {};
    expect(Value.Check(DynamicValidationContextSchema, emptyContext)).toBe(true);
  });

  it('resolves query key using queryId if present, otherwise falling back to sourceKey', () => {
    expect(resolveQueryKey({ sourceKey: 'folders' })).toBe('folders');
    expect(resolveQueryKey({ queryId: 'contact_0', sourceKey: 'folders' })).toBe('contact_0');
  });

  it('exports standard validation messages', () => {
    expect(OPTION_NOT_FOUND_MSG).toBe('Option not found.');
    expect(VALIDATION_TIMEOUT_MSG).toBe('Validation timed out.');
  });
});


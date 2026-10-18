import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  FormSchemaType,
  type FormSchema,
  DynamicValidationQuerySchema,
  DynamicValidationStatusSchema,
  DynamicValidationResultSchema,
  DynamicValidationContextSchema,
  SourceFileSchema,
  type SourceFile,
  OPTION_NOT_FOUND_MSG,
  VALIDATION_TIMEOUT_MSG,
  type DocumentDynamicValidationPort,
  type DynamicValidationQuery,
  type DynamicValidationStatus,
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
          queryId: 'contactFolders',
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

    const missingQueryId = {
      sourceKey: 'contactFolders',
      config: { provider: 'google_drive', method: 'list_folders' },
      valueToValidate: 'Acme',
    };
    expect(Value.Check(DynamicValidationQuerySchema, missingQueryId)).toBe(false);

    const invalidQuery = {
      sourceKey: 123,
      config: 'not-an-object',
      valueToValidate: true,
      queryId: 456,
    };
    expect(Value.Check(DynamicValidationQuerySchema, invalidQuery)).toBe(false);
  });

  it('validates DynamicValidationStatusSchema with Value.Check', () => {
    const statuses: DynamicValidationStatus[] = [
      'valid',
      'missing_space',
      'path_not_found',
      'ambiguous_path',
      'option_not_found',
      'ambiguous_option',
      'timeout',
      'error',
    ];
    for (const status of statuses) {
      expect(Value.Check(DynamicValidationStatusSchema, status)).toBe(true);
    }
    expect(Value.Check(DynamicValidationStatusSchema, 'invalid_status')).toBe(false);
  });

  it('validates DynamicValidationResultSchema with Value.Check', () => {
    const validResult: DynamicValidationResult = {
      isValid: false,
      errorMessage: 'Option not found.',
    };
    expect(Value.Check(DynamicValidationResultSchema, validResult)).toBe(true);

    const structuredResult: DynamicValidationResult = {
      isValid: false,
      status: 'path_not_found',
      targetPath: '1 Admin/Communication',
    };
    expect(Value.Check(DynamicValidationResultSchema, structuredResult)).toBe(true);

    const invalidResult = {
      isValid: 'not-a-boolean',
    };
    expect(Value.Check(DynamicValidationResultSchema, invalidResult)).toBe(false);

    const invalidStatusResult = {
      isValid: false,
      status: 'non_existent_status',
    };
    expect(Value.Check(DynamicValidationResultSchema, invalidStatusResult)).toBe(false);
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

  it('exports standard validation messages', () => {
    expect(OPTION_NOT_FOUND_MSG).toBe('Option not found.');
    expect(VALIDATION_TIMEOUT_MSG).toBe('Validation timed out.');
  });

  it('re-exports SourceFileSchema and validates SourceFile shape', () => {
    expect(SourceFileSchema).toBeDefined();

    const validSourceFile: SourceFile = {
      id: 'file-xyz-99',
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
    };
    expect(Value.Check(SourceFileSchema, validSourceFile)).toBe(true);

    const invalidSourceFile = {
      name: 'invoice.pdf',
    };
    expect(Value.Check(SourceFileSchema, invalidSourceFile)).toBe(false);
  });
});


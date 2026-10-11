import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  FormSchemaType,
  type FormSchema,
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
});


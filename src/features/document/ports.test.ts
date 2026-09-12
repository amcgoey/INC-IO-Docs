import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  FormSchemaType,
  type FormSchema,
  DocumentUiSchemaType,
  type DocumentUiSchema,
  SpaceUiSchemaType,
  type SpaceUiSchema,
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

  it('DocumentUiSchemaType validates events structure', () => {
    expect(DocumentUiSchemaType).toBeDefined();
    const validUiSchema: DocumentUiSchema = {
      events: {
        onSubmit: {
          rules: [
            {
              matchFields: { category: 'urgent' },
              workflow: 'ExpeditedWorkflow',
            },
          ],
          catchAllWorkflow: 'StandardWorkflow',
        },
      },
    };
    expect(Value.Check(DocumentUiSchemaType, validUiSchema)).toBe(true);

    const invalidUiSchema = {
      events: 'not-an-object',
    };
    expect(Value.Check(DocumentUiSchemaType, invalidUiSchema)).toBe(false);
  });

  it('DocumentUiSchemaType validates layout and fields structure', () => {
    const fullUiSchema: DocumentUiSchema = {
      layout: ['firstName', 'lastName'],
      fields: {
        firstName: {
          widget: 'textInput',
          label: 'First Name',
          props: { placeholder: 'Enter first name' },
        },
        lastName: {
          label: 'Last Name',
        },
      },
      events: {
        onSubmit: {
          catchAllWorkflow: 'StandardWorkflow',
        },
      },
    };
    expect(Value.Check(DocumentUiSchemaType, fullUiSchema)).toBe(true);
  });

  it('SpaceUiSchemaType validates layout and fields structure', () => {
    expect(SpaceUiSchemaType).toBeDefined();
    const validSpaceUiSchema: SpaceUiSchema = {
      layout: ['spaceName', 'region'],
      fields: {
        spaceName: {
          widget: 'textInput',
          label: 'Space Name',
        },
        region: {
          widget: 'selectionInput',
          label: 'Region',
          props: { items: ['US', 'EU'] },
        },
      },
    };
    expect(Value.Check(SpaceUiSchemaType, validSpaceUiSchema)).toBe(true);
  });
});

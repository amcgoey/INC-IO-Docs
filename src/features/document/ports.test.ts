import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  FormSchemaType,
  type FormSchema,
  DocumentUiSchemaType,
  type DocumentUiSchema,
  JSONLogicRuleType,
  type JSONLogicRule,
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
          showIf: { '==': [{ var: 'data.includeFirstName' }, true] },
          disableIf: { '!': { var: 'data.isEditable' } },
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

  describe('JSONLogicRuleType Validation', () => {
    it('validates allowed operators', () => {
      const validRules: JSONLogicRule[] = [
        { '==': [{ var: 'data.status' }, 'active'] },
        { '!=': [{ var: 'data.count' }, 5] },
        { '<': [1, 2] },
        { '>': [2, 1] },
        { '<=': [1, 1] },
        { '>=': [2, 2] },
        { and: [{ '==': [{ var: 'data.ready' }, true] }] },
        {
          or: [
            { '==': [{ var: 'data.flag' }, true] },
            { '!=': [{ var: 'data.role' }, 'guest'] },
          ],
        },
        { '!': { var: 'data.isHidden' } },
        { '!': [{ var: 'data.isHidden' }] },
        { '!!': { var: 'data.isVisible' } },
        { '!!': [{ var: 'data.isVisible' }] },
        { cat: ['Hello ', { var: 'data.name' }] },
        { in: ['apple', ['apple', 'banana']] },
        { log: 'Evaluating rule...' },
        { log: ['Evaluating rule...'] },
        { var: 'data' },
        { var: ['data'] },
        { var: 'data.firstName' },
        { var: ['data.lastName'] },
        { var: ['data.middleName', 'N/A'] },
        { var: ['data.user', { name: 'Guest' }] },
        { var: ['data', { defaultTheme: 'light' }] },
        { in: ['role', { role: 'admin' }] },
        { '+': [1, 2] },
        { '+': [1, 2, 3] },
        { '-': [5, 2] },
        { '-': [5] },
        { '*': [3, 4] },
        { '/': [10, 2] },
        { '%': [10, 3] },
      ];

      for (const rule of validRules) {
        const isValid = Value.Check(JSONLogicRuleType, rule);
        if (!isValid) {
          const error = Value.Errors(JSONLogicRuleType, rule).First();
          expect.fail(
            `Rule failed validation: ${JSON.stringify(rule)}, error: ${JSON.stringify(error)}`
          );
        }
        expect(isValid).toBe(true);
      }
    });

    it('validates literal values and arrays', () => {
      expect(Value.Check(JSONLogicRuleType, 'hello')).toBe(true);
      expect(Value.Check(JSONLogicRuleType, 42)).toBe(true);
      expect(Value.Check(JSONLogicRuleType, true)).toBe(true);
      expect(Value.Check(JSONLogicRuleType, false)).toBe(true);
      expect(Value.Check(JSONLogicRuleType, null)).toBe(true);
      expect(Value.Check(JSONLogicRuleType, ['apple', 'banana'])).toBe(true);
    });

    it('validates deeply nested rules', () => {
      const nestedRule: JSONLogicRule = {
        and: [
          { '==': [{ var: 'data.status' }, 'active'] },
          {
            or: [
              { '>': [{ var: 'data.age' }, 18] },
              { '!': { var: 'data.requiresParentalConsent' } },
            ],
          },
        ],
      };

      expect(Value.Check(JSONLogicRuleType, nestedRule)).toBe(true);
    });

    it('rejects forbidden operators and invalid structures', () => {
      const invalidRules = [
        { map: [{ var: 'data.items' }, { var: '' }] }, // Array operator not in allow-list
        { filter: [{ var: 'data.items' }, { var: '' }] }, // Array operator not in allow-list
        { reduce: [{ var: 'data.items' }, { var: '' }, 0] }, // Array operator not in allow-list
        { '==': [{ var: 'data.status' }] }, // '==' requires exactly 2 arguments
        { and: [] }, // 'and' requires at least 1 argument
        { or: [] }, // 'or' requires at least 1 argument
        { arbitraryKey: 'value' }, // Arbitrary keys not allowed
        { var: 123 }, // 'var' requires a string or tuple
        {}, // Empty object is not a valid JSONLogic expression
      ];

      for (const rule of invalidRules) {
        expect(Value.Check(JSONLogicRuleType, rule)).toBe(false);
      }
    });

    it('rejects var without data namespace context', () => {
      const invalidVarRules = [
        { var: 'firstName' },
        { var: 'root.firstName' },
        { var: 'database' },
        { var: ['firstName'] },
        { var: ['lastName', 'Smith'] },
      ];

      for (const rule of invalidVarRules) {
        expect(Value.Check(JSONLogicRuleType, rule)).toBe(false);
      }
    });

    it('rejects forbidden operators in showIf, disableIf, and computeValue', () => {
      const invalidDocSchema = {
        fields: {
          firstName: {
            showIf: { map: [{ var: 'data.items' }, { var: '' }] },
          },
        },
      };
      expect(Value.Check(DocumentUiSchemaType, invalidDocSchema)).toBe(false);

      const invalidComputeSchema = {
        fields: {
          total: {
            computeValue: { reduce: [{ var: 'data.items' }, { var: '' }, 0] },
          },
        },
      };
      expect(Value.Check(DocumentUiSchemaType, invalidComputeSchema)).toBe(false);
    });

    it('validates computeValue and evaluationOrder on DocumentUiSchema', () => {
      const validDocSchema: DocumentUiSchema = {
        layout: ['first', 'last', 'full'],
        fields: {
          first: { label: 'First' },
          last: { label: 'Last' },
          full: {
            label: 'Full',
            computeValue: { cat: [{ var: 'data.first' }, ' ', { var: 'data.last' }] },
          },
        },
        evaluationOrder: ['first', 'last', 'full'],
      };
      expect(Value.Check(DocumentUiSchemaType, validDocSchema)).toBe(true);
    });
  });
});

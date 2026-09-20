import { describe, it, expect } from 'vitest';
import { evaluateFormChange } from './json-logic-evaluator';

describe('json-logic-evaluator', () => {
  it('evaluates cascaded calculated fields using computeValue and Kahn topological order', () => {
    const rawFormData = {
      baseValue: 'HELLO',
    };

    const dataSchema = {
      fields: [
        { key: 'baseValue' },
        { key: 'step1' },
        { key: 'step2' },
      ],
    };

    const uiSchema = {
      layout: ['baseValue', 'step1', 'step2'],
      fields: {
        step1: {
          computeValue: {
            cat: [{ var: 'data.baseValue' }, ' WORLD'],
          },
        },
        step2: {
          computeValue: {
            cat: [{ var: 'data.step1' }, '!'],
          },
        },
      },
    };

    const result = evaluateFormChange(rawFormData, dataSchema, uiSchema);

    expect(result.computedData).toEqual({
      baseValue: 'HELLO',
      step1: 'HELLO WORLD',
      step2: 'HELLO WORLD!',
    });
    expect(result.hiddenFields).toEqual([]);
    expect(result.disabledFields).toEqual([]);
  });

  it('evaluates showIf condition to populate hiddenFields when falsy', () => {
    const rawFormData = {
      documentType: 'INVOICE',
      contractNumber: 'CNT-123',
    };

    const dataSchema = {
      fields: [
        { key: 'documentType' },
        { key: 'contractNumber' },
        { key: 'invoiceNumber' },
      ],
    };

    const uiSchema = {
      layout: ['documentType', 'contractNumber', 'invoiceNumber'],
      fields: {
        contractNumber: {
          showIf: { '==': [{ var: 'data.documentType' }, 'CONTRACT'] },
        },
        invoiceNumber: {
          showIf: { '==': [{ var: 'data.documentType' }, 'INVOICE'] },
        },
      },
    };

    const result = evaluateFormChange(rawFormData, dataSchema, uiSchema);

    expect(result.hiddenFields).toContain('contractNumber');
    expect(result.hiddenFields).not.toContain('invoiceNumber');
  });

  it('evaluates disableIf condition to populate disabledFields when truthy', () => {
    const rawFormData = {
      status: 'LOCKED',
      notes: 'Some notes',
    };

    const dataSchema = {
      fields: [{ key: 'status' }, { key: 'notes' }],
    };

    const uiSchema = {
      layout: ['status', 'notes'],
      fields: {
        notes: {
          disableIf: { '==': [{ var: 'data.status' }, 'LOCKED'] },
        },
      },
    };

    const result = evaluateFormChange(rawFormData, dataSchema, uiSchema);

    expect(result.disabledFields).toContain('notes');
  });

  it('incorporates default values from dataSchema if not provided in rawFormData', () => {
    const rawFormData = {};

    const dataSchema = {
      fields: [
        { key: 'amount', defaultValue: 100 },
        { key: 'tax' },
      ],
    };

    const uiSchema = {
      layout: ['amount', 'tax'],
      fields: {
        tax: {
          computeValue: {
            '*': [{ var: 'data.amount' }, 0.2],
          },
        },
      },
    };

    const result = evaluateFormChange(rawFormData, dataSchema, uiSchema);

    expect(result.computedData.amount).toBe(100);
    expect(result.computedData.tax).toBe(20);
  });
});

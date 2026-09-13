import { describe, it, expect } from 'vitest';
import {
  extractJsonLogicDependencies,
  computeEvaluationOrder,
} from './dependency-graph';
import type { DocumentUiSchema } from '../ports';

describe('Dependency Graph & Kahn\'s Algorithm', () => {
  describe('extractJsonLogicDependencies', () => {
    it('extracts var dependencies pointing to data namespace', () => {
      const rule = {
        cat: [
          { var: 'data.firstName' },
          ' ',
          { var: ['data.lastName'] },
        ],
      };
      const deps = extractJsonLogicDependencies(rule);
      expect(deps).toEqual(['firstName', 'lastName']);
    });

    it('extracts nested dependencies inside fallback arguments and objects', () => {
      const rule = {
        var: ['data.primaryContact', { var: 'data.backupContact' }],
      };
      const deps = extractJsonLogicDependencies(rule);
      expect(deps).toContain('primaryContact');
      expect(deps).toContain('backupContact');
    });

    it('extracts dependencies from complex nested conditional rules', () => {
      const rule = {
        and: [
          { '==': [{ var: 'data.type' }, 'standard'] },
          {
            or: [
              { '>': [{ var: 'data.amount' }, 1000] },
              { '!': { var: 'data.isExempt' } },
            ],
          },
        ],
      };
      const deps = extractJsonLogicDependencies(rule);
      expect(deps).toEqual(['type', 'amount', 'isExempt']);
    });

    it('ignores vars that do not target data namespace', () => {
      const rule = {
        and: [
          { var: 'system.currentUser' },
          { var: 'context.orgId' },
          { var: 'data' },
        ],
      };
      const deps = extractJsonLogicDependencies(rule);
      expect(deps).toEqual([]);
    });

    it('returns empty array for primitive rules and empty inputs', () => {
      expect(extractJsonLogicDependencies(null)).toEqual([]);
      expect(extractJsonLogicDependencies('hello')).toEqual([]);
      expect(extractJsonLogicDependencies(42)).toEqual([]);
      expect(extractJsonLogicDependencies(true)).toEqual([]);
      expect(extractJsonLogicDependencies({})).toEqual([]);
    });
  });

  describe('computeEvaluationOrder', () => {
    it('evaluates fields without computeValue first, followed by computed fields', () => {
      const docSchema = {
        fields: [
          { key: 'firstName', name: 'First Name', type: 'string' },
          { key: 'lastName', name: 'Last Name', type: 'string' },
          { key: 'fullName', name: 'Full Name', type: 'string' },
        ],
      };

      const uiSchema: DocumentUiSchema = {
        layout: ['firstName', 'lastName', 'fullName'],
        fields: {
          firstName: { label: 'First Name' },
          lastName: { label: 'Last Name' },
          fullName: {
            label: 'Full Name',
            computeValue: {
              cat: [{ var: 'data.firstName' }, ' ', { var: 'data.lastName' }],
            },
          },
        },
      };

      const order = computeEvaluationOrder(docSchema, uiSchema);
      expect(order).toEqual(['firstName', 'lastName', 'fullName']);
      expect(order.indexOf('firstName')).toBeLessThan(order.indexOf('fullName'));
      expect(order.indexOf('lastName')).toBeLessThan(order.indexOf('fullName'));
    });

    it('handles multiple levels of computed dependencies (chain)', () => {
      const docSchema = {
        fields: [
          { key: 'unitPrice', name: 'Unit Price', type: 'number' },
          { key: 'quantity', name: 'Quantity', type: 'number' },
          { key: 'subtotal', name: 'Subtotal', type: 'number' },
          { key: 'tax', name: 'Tax', type: 'number' },
          { key: 'total', name: 'Total', type: 'number' },
        ],
      };

      const uiSchema: DocumentUiSchema = {
        fields: {
          unitPrice: {},
          quantity: {},
          subtotal: {
            computeValue: {
              and: [{ var: 'data.unitPrice' }, { var: 'data.quantity' }],
            },
          },
          tax: {
            computeValue: {
              and: [{ var: 'data.subtotal' }],
            },
          },
          total: {
            computeValue: {
              cat: [{ var: 'data.subtotal' }, { var: 'data.tax' }],
            },
          },
        },
      };

      const order = computeEvaluationOrder(docSchema, uiSchema);
      expect(order.indexOf('unitPrice')).toBeLessThan(order.indexOf('subtotal'));
      expect(order.indexOf('quantity')).toBeLessThan(order.indexOf('subtotal'));
      expect(order.indexOf('subtotal')).toBeLessThan(order.indexOf('tax'));
      expect(order.indexOf('subtotal')).toBeLessThan(order.indexOf('total'));
      expect(order.indexOf('tax')).toBeLessThan(order.indexOf('total'));
    });

    it('handles diamond dependencies correctly', () => {
      const docSchema = {
        fields: [
          { key: 'base', name: 'Base', type: 'string' },
          { key: 'left', name: 'Left', type: 'string' },
          { key: 'right', name: 'Right', type: 'string' },
          { key: 'combined', name: 'Combined', type: 'string' },
        ],
      };

      const uiSchema: DocumentUiSchema = {
        fields: {
          base: {},
          left: {
            computeValue: { cat: [{ var: 'data.base' }, 'L'] },
          },
          right: {
            computeValue: { cat: [{ var: 'data.base' }, 'R'] },
          },
          combined: {
            computeValue: {
              cat: [{ var: 'data.left' }, { var: 'data.right' }],
            },
          },
        },
      };

      const order = computeEvaluationOrder(docSchema, uiSchema);
      expect(order[0]).toBe('base');
      expect(order.indexOf('left')).toBeLessThan(order.indexOf('combined'));
      expect(order.indexOf('right')).toBeLessThan(order.indexOf('combined'));
      expect(order[3]).toBe('combined');
    });

    it('fails loudly when an immediate self-dependency cycle is detected', () => {
      const docSchema = {
        fields: [{ key: 'counter', name: 'Counter', type: 'number' }],
      };

      const uiSchema: DocumentUiSchema = {
        fields: {
          counter: {
            computeValue: { var: 'data.counter' },
          },
        },
      };

      expect(() => computeEvaluationOrder(docSchema, uiSchema)).toThrow(
        /Circular dependency detected in computeValue rules: counter/
      );
    });

    it('fails loudly when a 2-node circular dependency is detected', () => {
      const docSchema = {
        fields: [
          { key: 'fieldA', name: 'Field A', type: 'string' },
          { key: 'fieldB', name: 'Field B', type: 'string' },
        ],
      };

      const uiSchema: DocumentUiSchema = {
        fields: {
          fieldA: {
            computeValue: { var: 'data.fieldB' },
          },
          fieldB: {
            computeValue: { var: 'data.fieldA' },
          },
        },
      };

      expect(() => computeEvaluationOrder(docSchema, uiSchema)).toThrow(
        /Circular dependency detected in computeValue rules/
      );
    });

    it('fails loudly when a multi-node circular dependency is detected', () => {
      const docSchema = {
        fields: [
          { key: 'x', name: 'X', type: 'string' },
          { key: 'y', name: 'Y', type: 'string' },
          { key: 'z', name: 'Z', type: 'string' },
        ],
      };

      const uiSchema: DocumentUiSchema = {
        fields: {
          x: { computeValue: { var: 'data.y' } },
          y: { computeValue: { var: 'data.z' } },
          z: { computeValue: { var: 'data.x' } },
        },
      };

      expect(() => computeEvaluationOrder(docSchema, uiSchema)).toThrow(
        /Circular dependency detected in computeValue rules/
      );
    });

    it('returns empty array when no fields exist', () => {
      expect(computeEvaluationOrder(undefined, undefined)).toEqual([]);
      expect(computeEvaluationOrder({ fields: [] }, { fields: {} })).toEqual([]);
    });
  });
});

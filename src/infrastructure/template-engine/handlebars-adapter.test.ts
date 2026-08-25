import { describe, it, expect } from 'vitest';
import { HandlebarsAdapter } from './handlebars-adapter';

describe('HandlebarsAdapter', () => {
  const adapter = new HandlebarsAdapter();

  describe('extractVariables', () => {
    it('extracts variable names from standard Handlebars template', () => {
      const template = '{{Date}}-{{Direction}}-{{Contact}}-{{Description}}';
      const variables = adapter.extractVariables(template);
      expect(variables).toEqual(['Date', 'Direction', 'Contact', 'Description']);
    });

    it('extracts variables and de-duplicates them', () => {
      const template = '{{Date}}-{{Date}}-{{Contact}}';
      const variables = adapter.extractVariables(template);
      expect(variables).toEqual(['Date', 'Contact']);
    });

    it('extracts variables from triple-stash unescaped expressions', () => {
      const template = '{{{RawField}}}-{{NormalField}}';
      const variables = adapter.extractVariables(template);
      expect(variables).toEqual(['RawField', 'NormalField']);
    });

    it('returns empty array when template has no variables', () => {
      expect(adapter.extractVariables('static-string-without-vars')).toEqual([]);
      expect(adapter.extractVariables('')).toEqual([]);
    });

    it('returns empty array when template syntax is malformed', () => {
      expect(adapter.extractVariables('{{unclosed')).toEqual([]);
    });
  });

  describe('validate', () => {
    it('returns true when all variables are present in allowedVariables list', () => {
      const template = '{{Date}}-{{Direction}}-{{Contact}}-{{Description}}';
      const allowed = ['Date', 'Direction', 'Contact', 'Description', 'ExtraField'];
      expect(adapter.validate(template, allowed)).toBe(true);
    });

    it('returns false when at least one variable is missing from allowedVariables list', () => {
      const template = '{{Date}}-{{DoesNotExist}}';
      const allowed = ['Date', 'Direction', 'Contact'];
      expect(adapter.validate(template, allowed)).toBe(false);
    });

    it('returns true for templates without any variables against empty allowed list', () => {
      expect(adapter.validate('static-text', [])).toBe(true);
      expect(adapter.validate('', [])).toBe(true);
    });

    it('returns false when template syntax is invalid', () => {
      expect(adapter.validate('{{bad syntax', ['bad'])).toBe(false);
    });
  });

  describe('evaluate', () => {
    it('interpolates payload variables into the template', () => {
      const template = '{{Date}}-{{Direction}}-{{Contact}}-{{Description}}';
      const context = {
        Date: '260825',
        Direction: 'IN',
        Contact: 'Jane Doe',
        Description: 'Project kick-off',
      };
      const result = adapter.evaluate(template, context);
      expect(result).toBe('260825-IN-Jane Doe-Project kick-off');
    });

    it('preserves special characters without HTML entity escaping (ADR 0003: noEscape)', () => {
      const template = '{{Description}}';
      const context = {
        Description: 'Smith & Jones <architects> "quotes" \'single\'',
      };
      const result = adapter.evaluate(template, context);
      expect(result).toBe('Smith & Jones <architects> "quotes" \'single\'');
    });

    it('renders missing context variables as empty strings without throwing', () => {
      const template = '{{Date}}-{{MissingField}}-{{Contact}}';
      const context = {
        Date: '260825',
        Contact: 'Jane Doe',
      };
      const result = adapter.evaluate(template, context);
      expect(result).toBe('260825--Jane Doe');
    });
  });
});

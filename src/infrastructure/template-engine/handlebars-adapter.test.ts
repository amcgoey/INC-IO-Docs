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

    it('returns false for templates containing BlockStatements (e.g. {{#if}}) per ADR 0003', () => {
      const template = '{{#if Date}}{{Date}}{{/if}}';
      expect(adapter.validate(template, ['Date'])).toBe(false);
    });

    it('returns false for templates containing {{#each}} loops per ADR 0003', () => {
      const template = '{{#each Items}}{{this}}{{/each}}';
      expect(adapter.validate(template, ['Items'])).toBe(false);
    });

    it('returns false for templates containing helper calls with parameters per ADR 0003', () => {
      const template = '{{uppercase Title}}';
      expect(adapter.validate(template, ['Title', 'uppercase'])).toBe(false);
    });

    it('natively supports namespace/root wildcarding with wildcard patterns (e.g. Context.*)', () => {
      const template = '{{Context.generatedFolderId}}-{{Context.stepResults.destinationPath}}-{{Context}}';
      expect(adapter.validate(template, ['Context.*'])).toBe(true);
    });

    it('supports arbitrary namespace wildcard patterns (e.g. DynamicData.*)', () => {
      const template = '{{DynamicData.user.id}}-{{DynamicData.meta}}';
      expect(adapter.validate(template, ['DynamicData.*'])).toBe(true);
    });

    it('supports global wildcard pattern (*)', () => {
      const template = '{{Anything.goes}}-{{RandomVar}}';
      expect(adapter.validate(template, ['*'])).toBe(true);
    });

    it('rejects variables when wildcard pattern does not match prefix boundary', () => {
      const template = '{{Contextual}}';
      expect(adapter.validate(template, ['Context.*'])).toBe(false);
    });

    it('rejects Context.* variables when Context.* is not in allowedVariables', () => {
      const template = '{{Context.generatedFolderId}}';
      expect(adapter.validate(template, ['Date', 'Direction'])).toBe(false);
    });

    it('does not wildcard other namespaces that are not authorized', () => {
      const template = '{{OtherNamespace.foo}}';
      expect(adapter.validate(template, ['Context.*'])).toBe(false);
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

  describe('parseFieldTemplate', () => {
    it('parses single-token and multi-token Stage-1 field templates with literal segments', () => {
      expect(adapter.parseFieldTemplate('{{action.name}}')).toEqual({
        tokens: [{ fieldKey: 'action', property: 'name' }],
        literals: ['', ''],
      });

      const dateParsed = adapter.parseFieldTemplate('{{date}}');
      expect(dateParsed).toEqual({
        tokens: [{ fieldKey: 'date' }],
        literals: ['', ''],
      });
      expect('property' in dateParsed.tokens[0]).toBe(false);

      expect(adapter.parseFieldTemplate('{{section}}-{{number}}-{{revision}}')).toEqual({
        tokens: [
          { fieldKey: 'section' },
          { fieldKey: 'number' },
          { fieldKey: 'revision' },
        ],
        literals: ['', '-', '-', ''],
      });

      expect(adapter.parseFieldTemplate('SUB-{{specTag.key}}-{{revision}}!')).toEqual({
        tokens: [
          { fieldKey: 'specTag', property: 'key' },
          { fieldKey: 'revision' },
        ],
        literals: ['SUB-', '-', '!'],
      });
    });

    it.each([
      ['malformed syntax', '{{unclosed'],
      ['empty template', ''],
      ['zero-token literal text', 'static text only'],
      ['BlockStatement #if', '{{#if action}}{{action.name}}{{/if}}'],
      ['BlockStatement #each', '{{#each items}}{{name}}{{/each}}'],
      ['helper parameters', '{{upper section}}'],
      ['hash arguments', '{{section foo="bar"}}'],
      ['SubExpression', '{{(helper section)}}'],
      ['triple-stache unescaped', '{{{action.name}}}'],
      ['comment statement', '{{! comment }}{{action.name}}'],
      ['partial statement', '{{> myPartial}}'],
      ['@root data variable', '{{@root.section}}'],
      ['@index data variable', '{{@index}}'],
      ['parent depth traversal', '{{../section}}'],
      ['this bare reference', '{{this}}'],
      ['this.property reference', '{{this.section}}'],
      ['dot bare reference', '{{.}}'],
      ['./property reference', '{{./section}}'],
      ['path deeper than fieldKey.property', '{{a.b.c}}'],
      ['CalculatedField namespace', '{{calculated.fileName}}'],
      ['Stage-2 Document namespace', '{{Document.data.section}}'],
      ['Stage-2 Document.id', '{{Document.id}}'],
    ])('rejects %s: %s', (_label, template) => {
      expect(() => adapter.parseFieldTemplate(template)).toThrow();
    });
  });
});

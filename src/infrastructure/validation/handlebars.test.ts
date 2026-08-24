import { describe, it, expect } from 'vitest';
import { validateHandlebarsTemplate } from './handlebars';

describe('Handlebars validation', () => {
  it('validates handlebars template stub', () => {
    expect(validateHandlebarsTemplate('{{test}}')).toBe(true);
  });

  it.todo('should assert all Handlebar template variables exist in the RecordType schema');
});

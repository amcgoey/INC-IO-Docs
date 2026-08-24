import { describe, it, expect } from 'vitest';
import { validateHandlebarsTemplate } from '../../src/infrastructure/validation/handlebars';

describe('Handlebars validation', () => {
  it('should invalidate empty template', () => {
    const result = validateHandlebarsTemplate('');
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Template cannot be empty');
  });

  it('should validate valid template string', () => {
    const result = validateHandlebarsTemplate('Hello {{name}}');
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema } from '../domain';
import { buildStatusMessageSection } from './status-message';

describe('Status Message Block', () => {
  it('returns undefined when no message or validation errors are provided', () => {
    expect(buildStatusMessageSection({})).toBeUndefined();
    expect(buildStatusMessageSection({ message: '' })).toBeUndefined();
    expect(buildStatusMessageSection({ message: '   ', validationErrors: [] })).toBeUndefined();
  });

  it('renders a textParagraph widget when a message is provided', () => {
    const section = buildStatusMessageSection({ message: 'Operation completed successfully' });
    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section!)).toBe(true);
    expect(section?.widgets).toHaveLength(1);
    expect(section?.widgets[0].textParagraph?.text).toBe('Operation completed successfully');
  });

  it('renders validation errors formatted with newlines when provided', () => {
    const errors = ['Document type is required', 'Field "title" cannot be empty'];
    const section = buildStatusMessageSection({ validationErrors: errors });
    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section!)).toBe(true);
    expect(section?.widgets).toHaveLength(1);
    expect(section?.widgets[0].textParagraph?.text).toBe(
      'Validation Errors:\nDocument type is required\nField "title" cannot be empty'
    );
  });

  it('renders both message and validation errors when both are present', () => {
    const section = buildStatusMessageSection({
      message: 'Validation failed',
      validationErrors: ['Invalid input'],
    });
    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section!)).toBe(true);
    expect(section?.widgets).toHaveLength(2);
    expect(section?.widgets[0].textParagraph?.text).toBe('Validation failed');
    expect(section?.widgets[1].textParagraph?.text).toBe('Validation Errors:\nInvalid input');
  });
});

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema, UiViewActionSchema } from '../domain';
import { buildDocumentAdminSection } from './document-admin';

describe('Document Admin Block', () => {
  it('creates an admin section with collapsible true and refresh/viewJson buttons', () => {
    const section = buildDocumentAdminSection();

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('Admin');
    expect(section.collapsible).toBe(true);
    expect(section.widgets).toHaveLength(1);

    const buttonList = section.widgets[0].buttonList;
    expect(buttonList).toBeDefined();
    expect(buttonList?.buttons).toEqual([
      { text: 'Refresh Document', onClick: { action: 'refresh' } },
      { text: 'View Raw JSON', onClick: { action: 'viewJson' } },
    ]);
  });

  it('allows customizing header option', () => {
    const section = buildDocumentAdminSection({
      header: 'Advanced Administration',
    });

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('Advanced Administration');
    expect(section.collapsible).toBe(true);
  });

  it('strictly asserts that button actions conform to closed UiViewAction schema', () => {
    const section = buildDocumentAdminSection();
    const buttons = section.widgets[0].buttonList?.buttons;
    expect(buttons).toBeDefined();
    expect(buttons).toHaveLength(2);

    for (const button of buttons!) {
      expect(button.onClick).toBeDefined();
      expect(Value.Check(UiViewActionSchema, button.onClick)).toBe(true);
    }
  });
});

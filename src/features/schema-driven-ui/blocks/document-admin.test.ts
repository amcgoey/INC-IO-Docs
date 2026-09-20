import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema } from '../domain';
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

  it('includes Process Document button when onProcessAction is provided', () => {
    const section = buildDocumentAdminSection({
      onProcessAction: { action: 'customProcess' },
    });

    expect(section.widgets[0].buttonList?.buttons).toEqual([
      { text: 'Process Document', onClick: { action: { action: 'customProcess' } } },
      { text: 'Refresh Document', onClick: { action: 'refresh' } },
      { text: 'View Raw JSON', onClick: { action: 'viewJson' } },
    ]);
  });
});

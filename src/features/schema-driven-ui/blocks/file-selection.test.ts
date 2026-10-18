import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema } from '../domain';
import { buildFileSelectionSection } from './file-selection';
import type { SelectionItem } from '../ports';

describe('File Selection Block', () => {
  const sampleFiles: SelectionItem[] = [
    { text: 'Proposal.pdf', value: 'file-1', selected: true },
    { text: 'Contract.pdf', value: 'file-2', selected: true },
  ];

  it('renders a collapsible section with CHECK_BOX selectionInput when files are provided', () => {
    const section = buildFileSelectionSection(sampleFiles);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('File Selection');
    expect(section.collapsible).toBe(true);
    expect(section.uncollapsibleWidgetsCount).toBeUndefined();
    expect(section.widgets).toHaveLength(1);

    const widget = section.widgets[0];
    expect(widget.selectionInput).toBeDefined();
    expect(widget.selectionInput?.name).toBe('SelectFiles');
    expect(widget.selectionInput?.type).toBe('CHECK_BOX');
    expect(widget.selectionInput?.items).toEqual(sampleFiles);
    expect(widget.selectionInput?.label).toBeUndefined();
    expect(widget.selectionInput?.onChangeAction).toBeUndefined();
  });

  it('renders a collapsible section with textParagraph when files array is empty', () => {
    const section = buildFileSelectionSection([]);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('File Selection');
    expect(section.collapsible).toBe(true);
    expect(section.widgets).toHaveLength(1);

    const widget = section.widgets[0];
    expect(widget.textParagraph).toBeDefined();
    expect(widget.textParagraph?.text).toBe('No files selected.');
    expect(widget.selectionInput).toBeUndefined();
  });

  it('renders textParagraph fallback when files argument is undefined', () => {
    const section = buildFileSelectionSection(undefined);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('File Selection');
    expect(section.collapsible).toBe(true);
    expect(section.widgets).toHaveLength(1);
    expect(section.widgets[0].textParagraph?.text).toBe('No files selected.');
  });

  it('respects custom options for sectionHeader, collapsible, inputName, and emptyText', () => {
    const customWithFiles = buildFileSelectionSection(sampleFiles, {
      sectionHeader: 'Attached Documents',
      collapsible: false,
      inputName: 'CustomFiles',
    });

    expect(Value.Check(UiViewSectionSchema, customWithFiles)).toBe(true);
    expect(customWithFiles.header).toBe('Attached Documents');
    expect(customWithFiles.collapsible).toBe(false);
    expect(customWithFiles.widgets[0].selectionInput?.name).toBe('CustomFiles');

    const customEmpty = buildFileSelectionSection([], {
      sectionHeader: 'Attached Documents',
      collapsible: false,
      emptyText: 'Nothing to see here.',
    });

    expect(Value.Check(UiViewSectionSchema, customEmpty)).toBe(true);
    expect(customEmpty.header).toBe('Attached Documents');
    expect(customEmpty.collapsible).toBe(false);
    expect(customEmpty.widgets[0].textParagraph?.text).toBe('Nothing to see here.');
  });
});

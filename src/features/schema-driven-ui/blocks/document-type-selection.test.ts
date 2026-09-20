import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema } from '../domain';
import type { SelectionState } from '../ports';
import { buildDocumentTypeSelectionSection } from './document-type-selection';

describe('Document Type Selection Block', () => {
  it('maps SelectionState with spaceTypes, spaces, and documentTypes into valid UiViewSection', () => {
    const selectionState: SelectionState = {
      spaceTypes: [
        { text: 'Project Space', value: 'projects', selected: true },
        { text: 'Proposal Space', value: 'proposals' },
      ],
      spaces: ['proj-alpha', 'proj-beta'],
      documentTypes: [
        { text: 'Communication Project', value: 'communication-project' },
      ],
    };

    const section = buildDocumentTypeSelectionSection(selectionState);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('Document Type');
    expect(section.widgets).toHaveLength(3);

    // Widget 1: SelectDocumentSpaceType (Dropdown)
    const spaceTypeWidget = section.widgets[0];
    expect(spaceTypeWidget.selectionInput).toBeDefined();
    expect(spaceTypeWidget.selectionInput?.name).toBe('SelectDocumentSpaceType');
    expect(spaceTypeWidget.selectionInput?.label).toBe('Document Space Type');
    expect(spaceTypeWidget.selectionInput?.type).toBe('DROPDOWN');
    expect(spaceTypeWidget.selectionInput?.items).toEqual(selectionState.spaceTypes);

    // Widget 2: SelectDocumentSpace (TextInput)
    const spaceWidget = section.widgets[1];
    expect(spaceWidget.textInput).toBeDefined();
    expect(spaceWidget.textInput?.name).toBe('SelectDocumentSpace');
    expect(spaceWidget.textInput?.label).toBe('Document Space');
    expect(spaceWidget.textInput?.value).toBe('proj-alpha');

    // Widget 3: SelectDocumentType (Dropdown)
    const docTypeWidget = section.widgets[2];
    expect(docTypeWidget.selectionInput).toBeDefined();
    expect(docTypeWidget.selectionInput?.name).toBe('SelectDocumentType');
    expect(docTypeWidget.selectionInput?.label).toBe('Document Type');
    expect(docTypeWidget.selectionInput?.type).toBe('DROPDOWN');
    expect(docTypeWidget.selectionInput?.items).toEqual(selectionState.documentTypes);
  });

  it('handles empty spaceTypes or documentTypes gracefully without synthetic items', () => {
    const selectionState: SelectionState = {
      spaceTypes: [],
      spaces: [],
      documentTypes: [],
    };

    const section = buildDocumentTypeSelectionSection(selectionState);

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.widgets[0].selectionInput?.items).toEqual([]);
    expect(section.widgets[1].textInput?.value).toBeUndefined();
    expect(section.widgets[2].selectionInput?.items).toEqual([]);
  });

  it('attaches onChangeAction and custom header when options are passed', () => {
    const selectionState: SelectionState = {
      spaceTypes: [{ text: 'Default', value: 'default' }],
      spaces: [],
      documentTypes: [{ text: 'Generic', value: 'generic' }],
    };

    const section = buildDocumentTypeSelectionSection(selectionState, {
      sectionHeader: 'Select Document Classification',
      onSpaceTypeChangeAction: { action: 'customSpaceTypeChange' },
      onDocumentTypeChangeAction: { action: 'customDocTypeChange' },
    });

    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.header).toBe('Select Document Classification');
    expect(section.widgets[0].selectionInput?.onChangeAction).toEqual({
      action: 'customSpaceTypeChange',
    });
    expect(section.widgets[2].selectionInput?.onChangeAction).toEqual({
      action: 'customDocTypeChange',
    });
  });
});

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema, UiViewActionSchema } from '../domain';
import type { SelectionState } from '../ports';
import {
  buildDocumentTypeSelectionSection,
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from './document-type-selection';

describe('Document Type Selection Block', () => {
  describe('getDocumentSpaceWidgetName', () => {
    it('generates dynamic widget name based on given space type', () => {
      expect(getDocumentSpaceWidgetName('projects')).toBe('SelectDocumentSpace_projects');
      expect(getDocumentSpaceWidgetName('proposals')).toBe('SelectDocumentSpace_proposals');
    });

    it('falls back to default when space type is omitted or undefined', () => {
      expect(getDocumentSpaceWidgetName()).toBe('SelectDocumentSpace_default');
    });
  });

  describe('getDocumentTypeWidgetName', () => {
    it('generates dynamic widget name based on given space type', () => {
      expect(getDocumentTypeWidgetName('projects')).toBe('SelectDocumentType_projects');
      expect(getDocumentTypeWidgetName('proposals')).toBe('SelectDocumentType_proposals');
    });

    it('falls back to default when space type is omitted or undefined', () => {
      expect(getDocumentTypeWidgetName()).toBe('SelectDocumentType_default');
    });
  });

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
    expect(spaceWidget.textInput?.name).toBe(getDocumentSpaceWidgetName('projects'));
    expect(spaceWidget.textInput?.label).toBe('Document Space');
    expect(spaceWidget.textInput?.value).toBe('proj-alpha');
    expect(spaceWidget.textInput?.autocomplete).toEqual([
      { text: 'proj-alpha', value: 'proj-alpha' },
      { text: 'proj-beta', value: 'proj-beta' },
    ]);

    // Widget 3: SelectDocumentType (Dropdown)
    const docTypeWidget = section.widgets[2];
    expect(docTypeWidget.selectionInput).toBeDefined();
    expect(docTypeWidget.selectionInput?.name).toBe(getDocumentTypeWidgetName('projects'));
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
    expect(section.widgets[1].textInput?.autocomplete).toBeUndefined();
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

  it('uses explicitly selected spaceType (even if not first) for dynamic widget names', () => {
    const selectionState: SelectionState = {
      spaceTypes: [
        { text: 'Projects', value: 'projects', selected: false },
        { text: 'Proposals', value: 'proposals', selected: true },
      ],
      spaces: ['prop-1'],
      documentTypes: [{ text: 'Proposal Doc', value: 'proposal-doc' }],
    };

    const section = buildDocumentTypeSelectionSection(selectionState);
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.widgets[1].textInput?.name).toBe('SelectDocumentSpace_proposals');
    expect(section.widgets[2].selectionInput?.name).toBe('SelectDocumentType_proposals');
  });

  it('falls back to default spaceType when no spaceType is marked selected', () => {
    const selectionState: SelectionState = {
      spaceTypes: [
        { text: 'Projects', value: 'projects' },
        { text: 'Proposals', value: 'proposals' },
      ],
      spaces: ['proj-1'],
      documentTypes: [{ text: 'Project Doc', value: 'project-doc' }],
    };

    const section = buildDocumentTypeSelectionSection(selectionState);
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section.widgets[1].textInput?.name).toBe('SelectDocumentSpace_default');
    expect(section.widgets[2].selectionInput?.name).toBe('SelectDocumentType_default');
  });

  it('supports options with only onSpaceTypeChangeAction or only onDocumentTypeChangeAction', () => {
    const selectionState: SelectionState = {
      spaceTypes: [{ text: 'Projects', value: 'projects' }],
      spaces: ['proj-1'],
      documentTypes: [{ text: 'Project Doc', value: 'project-doc' }],
    };

    // Only onSpaceTypeChangeAction
    const sectionSpaceOnly = buildDocumentTypeSelectionSection(selectionState, {
      onSpaceTypeChangeAction: { action: 'onSpaceChange' },
    });
    expect(sectionSpaceOnly.widgets[0].selectionInput?.onChangeAction).toEqual({
      action: 'onSpaceChange',
    });
    expect(sectionSpaceOnly.widgets[2].selectionInput?.onChangeAction).toBeUndefined();

    // Only onDocumentTypeChangeAction
    const sectionDocOnly = buildDocumentTypeSelectionSection(selectionState, {
      onDocumentTypeChangeAction: { action: 'onDocChange' },
    });
    expect(sectionDocOnly.widgets[0].selectionInput?.onChangeAction).toBeUndefined();
    expect(sectionDocOnly.widgets[2].selectionInput?.onChangeAction).toEqual({
      action: 'onDocChange',
    });
  });

  it('strictly verifies actions adhere to closed agnostic UiViewAction schema', () => {
    const selectionState: SelectionState = {
      spaceTypes: [{ text: 'Projects', value: 'projects' }],
      spaces: ['proj-1'],
      documentTypes: [{ text: 'Project Doc', value: 'project-doc' }],
    };

    const section = buildDocumentTypeSelectionSection(selectionState, {
      onSpaceTypeChangeAction: { action: 'onSpaceTypeChange' },
      onDocumentTypeChangeAction: { action: 'onDocumentTypeChange' },
    });

    const spaceTypeAction = section.widgets[0].selectionInput?.onChangeAction;
    expect(spaceTypeAction).toBeDefined();
    expect(Value.Check(UiViewActionSchema, spaceTypeAction)).toBe(true);
    expect(spaceTypeAction).toEqual({ action: 'onSpaceTypeChange' });

    const docTypeAction = section.widgets[2].selectionInput?.onChangeAction;
    expect(docTypeAction).toBeDefined();
    expect(Value.Check(UiViewActionSchema, docTypeAction)).toBe(true);
    expect(docTypeAction).toEqual({ action: 'onDocumentTypeChange' });
  });
});

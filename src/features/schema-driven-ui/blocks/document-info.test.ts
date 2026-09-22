import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema, UiViewActionSchema, type UiSchema } from '../domain';
import type { AbstractDataSchema, AbstractDataField, StandardWidgetCustomProps } from '../ports';
import {
  camelCaseToTitleCase,
  inferDefaultWidget,
  buildDocumentInfoSection,
  getDocumentInfoWidgetName,
  extractSelectionItems,
} from './document-info';

describe('Document Info Block', () => {
  describe('extractSelectionItems', () => {
    it('returns customProps.items when provided, overriding field.options', () => {
      const field: AbstractDataField = {
        key: 'status',
        type: 'string',
        options: ['Draft', 'Published'],
      };
      const customProps: StandardWidgetCustomProps = {
        items: [{ text: 'Custom Status', value: 'custom' }],
      };
      const result = extractSelectionItems(field, customProps);
      expect(result).toEqual([{ text: 'Custom Status', value: 'custom' }]);
    });

    it('maps string array field options to SelectionItems', () => {
      const field: AbstractDataField = {
        key: 'priority',
        type: 'string',
        options: ['Low', 'Medium', 'High'],
      };
      const result = extractSelectionItems(field, {});
      expect(result).toEqual([
        { text: 'Low', value: 'Low' },
        { text: 'Medium', value: 'Medium' },
        { text: 'High', value: 'High' },
      ]);
    });

    it('maps object array field options with text and value', () => {
      const field: AbstractDataField = {
        key: 'type',
        type: 'string',
        options: [
          { text: 'Option A', value: 'opt-a' },
          { text: 'Option B', value: 'opt-b' },
        ],
      };
      const result = extractSelectionItems(field, {});
      expect(result).toEqual([
        { text: 'Option A', value: 'opt-a' },
        { text: 'Option B', value: 'opt-b' },
      ]);
    });

    it('maps object array field options with only value, falling back text to String(value)', () => {
      const field: AbstractDataField = {
        key: 'code',
        type: 'string',
        options: [{ value: 101 }, { value: 'code-202' }],
      };
      const result = extractSelectionItems(field, {});
      expect(result).toEqual([
        { text: '101', value: '101' },
        { text: 'code-202', value: 'code-202' },
      ]);
    });

    it('maps primitive array options like numbers to SelectionItems', () => {
      const field: AbstractDataField = {
        key: 'rating',
        type: 'number',
        options: [1, 2, 3],
      };
      const result = extractSelectionItems(field, {});
      expect(result).toEqual([
        { text: '1', value: '1' },
        { text: '2', value: '2' },
        { text: '3', value: '3' },
      ]);
    });

    it('resolves options from dataSchema source lookup with name and key tuples', () => {
      const field: AbstractDataField = {
        key: 'dept',
        type: 'string',
        options: { source: 'departments' },
      };
      const dataSchema: AbstractDataSchema = {
        fields: [field],
        options: {
          departments: [
            { name: 'Engineering', key: 'eng' },
            { name: 'Human Resources', key: 'hr' },
          ],
        },
      };
      const result = extractSelectionItems(field, {}, dataSchema);
      expect(result).toEqual([
        { text: 'Engineering', value: 'eng' },
        { text: 'Human Resources', value: 'hr' },
      ]);
    });

    it('resolves options from dataSchema source lookup with text and value tuples', () => {
      const field: AbstractDataField = {
        key: 'role',
        type: 'string',
        options: { source: 'roles' },
      };
      const dataSchema: AbstractDataSchema = {
        fields: [field],
        options: {
          roles: [
            { text: 'Lead', value: 'role-lead' },
            { text: 'Contributor', value: 'role-contrib' },
          ],
        },
      };
      const result = extractSelectionItems(field, {}, dataSchema);
      expect(result).toEqual([
        { text: 'Lead', value: 'role-lead' },
        { text: 'Contributor', value: 'role-contrib' },
      ]);
    });

    it('resolves options from dataSchema source lookup with primitive tuples', () => {
      const field: AbstractDataField = {
        key: 'year',
        type: 'number',
        options: { source: 'years' },
      };
      const dataSchema: AbstractDataSchema = {
        fields: [field],
        options: {
          years: [2024, 2025, 2026],
        },
      };
      const result = extractSelectionItems(field, {}, dataSchema);
      expect(result).toEqual([
        { text: '2024', value: '2024' },
        { text: '2025', value: '2025' },
        { text: '2026', value: '2026' },
      ]);
    });

    it('returns empty array when dataSchema options does not have source key', () => {
      const field: AbstractDataField = {
        key: 'dept',
        type: 'string',
        options: { source: 'nonExistent' },
      };
      const dataSchema: AbstractDataSchema = {
        fields: [field],
        options: {},
      };
      const result = extractSelectionItems(field, {}, dataSchema);
      expect(result).toEqual([]);
    });

    it('returns empty array when field.options uses source lookup but dataSchema is undefined', () => {
      const field: AbstractDataField = {
        key: 'dept',
        type: 'string',
        options: { source: 'departments' },
      };
      const result = extractSelectionItems(field, {});
      expect(result).toEqual([]);
    });

    it('returns empty array when field has no options and customProps.items is undefined', () => {
      const field: AbstractDataField = {
        key: 'notes',
        type: 'string',
      };
      const result = extractSelectionItems(field, {});
      expect(result).toEqual([]);
    });
  });

  describe('camelCaseToTitleCase', () => {
    it('converts single word camelCase to Title Case', () => {
      expect(camelCaseToTitleCase('status')).toBe('Status');
      expect(camelCaseToTitleCase('title')).toBe('Title');
    });

    it('converts multi-word camelCase to Title Case', () => {
      expect(camelCaseToTitleCase('firstName')).toBe('First Name');
      expect(camelCaseToTitleCase('dateOfBirth')).toBe('Date Of Birth');
      expect(camelCaseToTitleCase('vendorTaxId')).toBe('Vendor Tax Id');
    });

    it('handles numbers and single letters', () => {
      expect(camelCaseToTitleCase('addressLine1')).toBe('Address Line 1');
      expect(camelCaseToTitleCase('id')).toBe('Id');
    });
  });

  describe('inferDefaultWidget', () => {
    it('infers selectionInput when field has options', () => {
      const field: AbstractDataField = {
        key: 'category',
        type: 'string',
        options: { source: 'list', key: 'cat', name: 'Category' },
      };
      expect(inferDefaultWidget(field)).toBe('selectionInput');
    });

    it('infers selectionInput when field is boolean', () => {
      const field: AbstractDataField = {
        key: 'isActive',
        type: 'boolean',
      };
      expect(inferDefaultWidget(field)).toBe('selectionInput');
    });

    it('infers textInput for string without options', () => {
      const field: AbstractDataField = {
        key: 'description',
        type: 'string',
      };
      expect(inferDefaultWidget(field)).toBe('textInput');
    });
  });

  describe('buildDocumentInfoSection', () => {
    const mockDataSchema: AbstractDataSchema = {
      fields: [
        {
          key: 'firstName',
          type: 'string',
          defaultValue: 'John',
        },
        {
          key: 'roleCategory',
          type: 'string',
          options: { source: 'inline', key: 'role', name: 'Role' },
        },
        {
          key: 'age',
          type: 'number',
        },
      ],
    };

    it('falls back to default inference when field is omitted from uiSchema.fields', () => {
      const uiSchema: UiSchema = {
        fields: {},
      };

      const section = buildDocumentInfoSection(mockDataSchema, uiSchema);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(3);

      // firstName: inferred textInput with Title Case label and default value
      expect(section.widgets[0].textInput).toBeDefined();
      expect(section.widgets[0].textInput?.name).toBe('firstName');
      expect(section.widgets[0].textInput?.label).toBe('First Name');
      expect(section.widgets[0].textInput?.value).toBe('John');

      // roleCategory: inferred selectionInput with Title Case label
      expect(section.widgets[1].selectionInput).toBeDefined();
      expect(section.widgets[1].selectionInput?.name).toBe('roleCategory');
      expect(section.widgets[1].selectionInput?.label).toBe('Role Category');
      expect(section.widgets[1].selectionInput?.type).toBe('DROPDOWN');

      // age: inferred textInput
      expect(section.widgets[2].textInput).toBeDefined();
      expect(section.widgets[2].textInput?.name).toBe('age');
      expect(section.widgets[2].textInput?.label).toBe('Age');
    });

    it('uses layout array to dictate rendering order and omissions', () => {
      const uiSchema: UiSchema = {
        layout: ['age', 'firstName'],
        fields: {
          firstName: {
            label: 'Custom First Name',
          },
        },
      };

      const section = buildDocumentInfoSection(mockDataSchema, uiSchema);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(2);
      expect(section.widgets[0].textInput?.name).toBe('age');
      expect(section.widgets[1].textInput?.name).toBe('firstName');
      expect(section.widgets[1].textInput?.label).toBe('Custom First Name');
    });

    it('applies widget overrides, custom props, and onChangeAction', () => {
      const uiSchema: UiSchema = {
        fields: {
          firstName: {
            widget: 'selectionInput',
            label: 'Preferred Name',
            props: {
              items: [{ text: 'Johnny', value: 'johnny' }],
            },
            onChange: true,
          },
          age: {
            props: {
              placeholder: 'Enter age in years',
            },
            onChange: 'customAgeChanged',
          },
        },
      };

      const section = buildDocumentInfoSection(mockDataSchema, uiSchema, {
        sectionHeader: 'Document Information',
      });

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.header).toBe('Document Information');

      // Widget 0: overridden widget to selectionInput with items and onChangeAction
      const w0 = section.widgets[0].selectionInput;
      expect(w0).toBeDefined();
      expect(w0?.label).toBe('Preferred Name');
      expect(w0?.items).toEqual([{ text: 'Johnny', value: 'johnny', selected: false }]);
      expect(w0?.onChangeAction).toEqual({ action: 'onFormChange' });

      // Widget 2: placeholder mapped to hintText and string onChange
      const w2 = section.widgets[2].textInput;
      expect(w2).toBeDefined();
      expect(w2?.hintText).toBe('Enter age in years');
      expect(w2?.onChangeAction).toEqual({ action: 'customAgeChanged' });
    });

    it('omits onChangeAction when onChange is explicitly false or undefined', () => {
      const uiSchema: UiSchema = {
        fields: {
          firstName: {
            onChange: false,
          },
          age: {
            // onChange is undefined
          },
        },
      };

      const section = buildDocumentInfoSection(mockDataSchema, uiSchema);
      expect(section.widgets[0].textInput?.onChangeAction).toBeUndefined();
      expect(section.widgets[2].textInput?.onChangeAction).toBeUndefined();
    });

    it('operates predictably with undefined uiSchema', () => {
      const section = buildDocumentInfoSection(mockDataSchema);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(3);
    });

    it('predictably maps mock schemas (e.g. documentUiSchema) without performing I/O', () => {
      const mockDocumentSchema: AbstractDataSchema = {
        fields: [
          { key: 'contact', type: 'string' },
          { key: 'date', type: 'string' },
          { key: 'direction', type: 'string', options: { source: 'direction' } },
          { key: 'description', type: 'string' },
        ],
      };

      const mockDocumentUiSchema: UiSchema = {
        layout: ['contact', 'date', 'direction', 'description'],
        fields: {
          contact: { widget: 'textInput', label: 'Contact' },
          date: { widget: 'textInput', label: 'Date' },
          direction: { widget: 'selectionInput', label: 'Direction', onChange: true },
          description: { widget: 'textInput', label: 'Description' },
        },
      };

      const section = buildDocumentInfoSection(mockDocumentSchema, mockDocumentUiSchema, {
        sectionHeader: 'Communication Details',
      });

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.header).toBe('Communication Details');
      // Layout has: ["contact", "date", "direction", "description"]
      expect(section.widgets).toHaveLength(4);

      // 1. contact: textInput
      expect(section.widgets[0].textInput).toBeDefined();
      expect(section.widgets[0].textInput?.name).toBe('contact');
      expect(section.widgets[0].textInput?.label).toBe('Contact');

      // 2. date: textInput
      expect(section.widgets[1].textInput).toBeDefined();
      expect(section.widgets[1].textInput?.name).toBe('date');
      expect(section.widgets[1].textInput?.label).toBe('Date');

      // 3. direction: selectionInput with onChangeAction
      expect(section.widgets[2].selectionInput).toBeDefined();
      expect(section.widgets[2].selectionInput?.name).toBe('direction');
      expect(section.widgets[2].selectionInput?.label).toBe('Direction');
      expect(section.widgets[2].selectionInput?.onChangeAction).toEqual({
        action: 'onFormChange',
      });

      // 4. description: textInput
      expect(section.widgets[3].textInput).toBeDefined();
      expect(section.widgets[3].textInput?.name).toBe('description');
      expect(section.widgets[3].textInput?.label).toBe('Description');
    });

    it('derives default dropdown items from field.options when customProps.items is omitted', () => {
      const schemaWithOptions: AbstractDataSchema = {
        fields: [
          {
            key: 'direction',
            type: 'string',
            options: ['Incoming', 'Outgoing'],
          },
          {
            key: 'priority',
            type: 'string',
            options: [
              { text: 'High Priority', value: 'high' },
              { text: 'Low Priority', value: 'low' },
            ],
          },
        ],
      };

      const section = buildDocumentInfoSection(schemaWithOptions);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(2);

      expect(section.widgets[0].selectionInput?.items).toEqual([
        { text: 'Incoming', value: 'Incoming' },
        { text: 'Outgoing', value: 'Outgoing' },
      ]);

      expect(section.widgets[1].selectionInput?.items).toEqual([
        { text: 'High Priority', value: 'high' },
        { text: 'Low Priority', value: 'low' },
      ]);
    });

    it('injects formData values into widgets and filters out hiddenFields', () => {
      const schema: AbstractDataSchema = {
        fields: [
          { key: 'title', type: 'string' },
          { key: 'status', type: 'string', options: ['OPEN', 'CLOSED'] },
          { key: 'internalNotes', type: 'string' },
        ],
      };

      const section = buildDocumentInfoSection(schema, undefined, {
        formData: {
          title: 'Existing Title',
          status: 'CLOSED',
          internalNotes: 'Secret',
        },
        hiddenFields: ['internalNotes'],
      });

      expect(section.widgets).toHaveLength(2);

      // 1. title has value from formData
      expect(section.widgets[0].textInput?.name).toBe('title');
      expect(section.widgets[0].textInput?.value).toBe('Existing Title');

      // 2. status has matching item selected
      expect(section.widgets[1].selectionInput?.name).toBe('status');
      const items = section.widgets[1].selectionInput?.items;
      expect(items?.find((i) => i.value === 'CLOSED')?.selected).toBe(true);
      expect(items?.find((i) => i.value === 'OPEN')?.selected).toBe(false);

      // 3. internalNotes is omitted because it is in hiddenFields
      const widgetNames = section.widgets.map(
        (w) => w.textInput?.name ?? w.selectionInput?.name
      );
      expect(widgetNames).not.toContain('internalNotes');
    });

    it('maps data schema options into textInput autocomplete property as SelectionItems', () => {
      const schemaWithOptions: AbstractDataSchema = {
        fields: [
          {
            key: 'category',
            type: 'string',
            options: ['Action', 'Comedy'],
          },
          {
            key: 'tag',
            type: 'string',
            options: { source: 'tagLookup' },
          },
          {
            key: 'plainField',
            type: 'string',
          },
        ],
        options: {
          tagLookup: [
            { name: 'Urgent', key: 'urgent' },
            { name: 'Routine', key: 'routine' },
          ],
        },
      };

      const uiSchema: UiSchema = {
        fields: {
          category: { widget: 'textInput' },
          tag: { widget: 'textInput' },
        },
      };

      const section = buildDocumentInfoSection(schemaWithOptions, uiSchema);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);

      // 1. category: textInput with autocomplete from string array
      expect(section.widgets[0].textInput?.name).toBe('category');
      expect(section.widgets[0].textInput?.autocomplete).toEqual([
        { text: 'Action', value: 'Action' },
        { text: 'Comedy', value: 'Comedy' },
      ]);

      // 2. tag: textInput with autocomplete from dataSchema.options
      expect(section.widgets[1].textInput?.name).toBe('tag');
      expect(section.widgets[1].textInput?.autocomplete).toEqual([
        { text: 'Urgent', value: 'urgent' },
        { text: 'Routine', value: 'routine' },
      ]);

      // 3. plainField: textInput without options has undefined autocomplete
      expect(section.widgets[2].textInput?.name).toBe('plainField');
      expect(section.widgets[2].textInput?.autocomplete).toBeUndefined();
    });

    it('appends Process Document button when onProcessAction is provided', () => {
      const schema: AbstractDataSchema = {
        fields: [{ key: 'title', type: 'string' }],
      };

      const sectionWithStringAction = buildDocumentInfoSection(schema, undefined, {
        onProcessAction: 'processDocument',
      });

      expect(Value.Check(UiViewSectionSchema, sectionWithStringAction)).toBe(true);
      expect(sectionWithStringAction.widgets).toHaveLength(2);
      expect(sectionWithStringAction.widgets[1].buttonList).toBeDefined();
      expect(sectionWithStringAction.widgets[1].buttonList?.buttons).toEqual([
        { text: 'Process Document', onClick: { action: 'processDocument' } },
      ]);

      const sectionWithObjectAction = buildDocumentInfoSection(schema, undefined, {
        onProcessAction: { action: 'customProcess', parameters: { docId: '123' } },
      });

      expect(Value.Check(UiViewSectionSchema, sectionWithObjectAction)).toBe(true);
      expect(sectionWithObjectAction.widgets).toHaveLength(2);
      expect(sectionWithObjectAction.widgets[1].buttonList?.buttons).toEqual([
        { text: 'Process Document', onClick: { action: 'customProcess', parameters: { docId: '123' } } },
      ]);
    });

    it('does not append Process Document button when onProcessAction is undefined', () => {
      const schema: AbstractDataSchema = {
        fields: [{ key: 'title', type: 'string' }],
      };

      const section = buildDocumentInfoSection(schema);
      expect(section.widgets).toHaveLength(1);
      expect(section.widgets[0].textInput).toBeDefined();
      expect(section.widgets.some((w) => w.buttonList !== undefined)).toBe(false);
    });

    it('suffixes widget input names with documentTypeKey when provided', () => {
      const schema: AbstractDataSchema = {
        fields: [
          { key: 'contact', type: 'string' },
          { key: 'status', type: 'string', options: ['Draft', 'Final'] },
        ],
      };

      const section = buildDocumentInfoSection(schema, undefined, {
        documentTypeKey: 'communication-project',
      });

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(2);
      expect(section.widgets[0].textInput?.name).toBe('contact_communication-project');
      expect(section.widgets[1].selectionInput?.name).toBe('status_communication-project');
    });

    it('retrieves formValue from formData using either unsuffixed key or suffixed key', () => {
      const schema: AbstractDataSchema = {
        fields: [
          { key: 'contact', type: 'string' },
          { key: 'amount', type: 'string' },
        ],
      };

      const section = buildDocumentInfoSection(schema, undefined, {
        documentTypeKey: 'communication-project',
        formData: {
          contact: 'Acme Corp',
          'amount_communication-project': '500',
        },
      });

      expect(section.widgets[0].textInput?.value).toBe('Acme Corp');
      expect(section.widgets[1].textInput?.value).toBe('500');
    });

    it('silently skips layout keys that do not exist in dataSchema.fields', () => {
      const schema: AbstractDataSchema = {
        fields: [{ key: 'presentField', type: 'string' }],
      };
      const uiSchema: UiSchema = {
        layout: ['ghostField1', 'presentField', 'ghostField2'],
      };

      const section = buildDocumentInfoSection(schema, uiSchema);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets).toHaveLength(1);
      expect(section.widgets[0].textInput?.name).toBe('presentField');
    });

    it('infers selectionInput for boolean fields and respects customProps.type', () => {
      const schema: AbstractDataSchema = {
        fields: [{ key: 'isUrgent', type: 'boolean' }],
      };
      const uiSchema: UiSchema = {
        fields: {
          isUrgent: {
            props: {
              type: 'RADIO_BUTTON',
              items: [
                { text: 'Yes', value: 'true' },
                { text: 'No', value: 'false' },
              ],
            },
          },
        },
      };

      const section = buildDocumentInfoSection(schema, uiSchema);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
      expect(section.widgets[0].selectionInput).toBeDefined();
      expect(section.widgets[0].selectionInput?.type).toBe('RADIO_BUTTON');
      expect(section.widgets[0].selectionInput?.items).toHaveLength(2);
    });

    it('uses customProps.value for textInput when neither formData nor defaultValue is defined', () => {
      const schema: AbstractDataSchema = {
        fields: [{ key: 'templateName', type: 'string' }],
      };
      const uiSchema: UiSchema = {
        fields: {
          templateName: {
            props: { value: 'Standard Template' },
          },
        },
      };

      const section = buildDocumentInfoSection(schema, uiSchema);
      expect(section.widgets[0].textInput?.value).toBe('Standard Template');
    });

    it('selects item matching defaultValue in selectionInput when formData is absent', () => {
      const schema: AbstractDataSchema = {
        fields: [
          {
            key: 'status',
            type: 'string',
            defaultValue: 'IN_PROGRESS',
            options: ['DRAFT', 'IN_PROGRESS', 'COMPLETE'],
          },
        ],
      };

      const section = buildDocumentInfoSection(schema);
      const items = section.widgets[0].selectionInput?.items;
      expect(items?.find((i) => i.value === 'IN_PROGRESS')?.selected).toBe(true);
      expect(items?.find((i) => i.value === 'DRAFT')?.selected).toBe(false);
    });

    it('strictly asserts that generated actions match closed agnostic UiViewAction schema', () => {
      const schema: AbstractDataSchema = {
        fields: [{ key: 'title', type: 'string' }],
      };
      const uiSchema: UiSchema = {
        fields: {
          title: { onChange: true },
        },
      };

      const section = buildDocumentInfoSection(schema, uiSchema, {
        onProcessAction: { action: 'processDocument', parameters: { mode: 'fast' } },
      });

      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);

      // 1. Check onChangeAction on textInput
      const inputAction = section.widgets[0].textInput?.onChangeAction;
      expect(inputAction).toBeDefined();
      expect(Value.Check(UiViewActionSchema, inputAction)).toBe(true);
      expect(inputAction).toEqual({ action: 'onFormChange' });

      // 2. Check onClick on Process Document button
      const buttonAction = section.widgets[1].buttonList?.buttons[0].onClick;
      expect(buttonAction).toBeDefined();
      expect(Value.Check(UiViewActionSchema, buttonAction)).toBe(true);
      expect(buttonAction).toEqual({ action: 'processDocument', parameters: { mode: 'fast' } });
    });
  });

  describe('getDocumentInfoWidgetName', () => {
    it('appends documentTypeKey suffix when provided', () => {
      expect(getDocumentInfoWidgetName('contact', 'communication-project')).toBe(
        'contact_communication-project'
      );
      expect(getDocumentInfoWidgetName('description', 'invoice-project')).toBe(
        'description_invoice-project'
      );
    });

    it('returns field key unchanged when documentTypeKey is not provided', () => {
      expect(getDocumentInfoWidgetName('contact')).toBe('contact');
      expect(getDocumentInfoWidgetName('contact', undefined)).toBe('contact');
      expect(getDocumentInfoWidgetName('contact', '')).toBe('contact');
    });
  });
});


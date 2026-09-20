import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewSectionSchema, type UiSchema } from '../domain';
import type { AbstractDataSchema, AbstractDataField } from '../ports';
import {
  camelCaseToTitleCase,
  inferDefaultWidget,
  buildDocumentInfoSection,
} from './document-info';

describe('Document Info Block', () => {
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
      expect(w0?.items).toEqual([{ text: 'Johnny', value: 'johnny' }]);
      expect(w0?.onChangeAction).toEqual({ action: 'firstNameChanged' });

      // Widget 2: placeholder mapped to hintText and string onChange
      const w2 = section.widgets[2].textInput;
      expect(w2).toBeDefined();
      expect(w2?.hintText).toBe('Enter age in years');
      expect(w2?.onChangeAction).toEqual({ action: 'customAgeChanged' });
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
        action: 'directionChanged',
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
              { label: 'High Priority', value: 'high' },
              { label: 'Low Priority', value: 'low' },
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
  });
});


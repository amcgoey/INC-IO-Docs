import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  camelCaseToTitleCase,
  inferDefaultWidget,
  buildDocumentFormWidgets,
  buildDocumentFormCard,
  DocumentUiBlockAdapter,
} from './ui-block';
import type { DocumentSchema, DocumentField } from '../domain';
import type { DocumentUiSchema, DocumentUiSchemaQueryPort } from '../ports';
import { CardSchema } from '../../../infrastructure/workspace-addon/ui-blocks';

describe('UiBlock Adapter', () => {
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
      const field: DocumentField = {
        key: 'category',
        name: 'category',
        type: 'string',
        options: {
          source: 'list',
          key: 'cat',
          name: 'Category',
        },
      };
      expect(inferDefaultWidget(field)).toBe('selectionInput');
    });

    it('infers selectionInput when field is boolean', () => {
      const field: DocumentField = {
        key: 'isActive',
        name: 'isActive',
        type: 'boolean',
      };
      expect(inferDefaultWidget(field)).toBe('selectionInput');
    });

    it('infers textInput for string without options', () => {
      const field: DocumentField = {
        key: 'description',
        name: 'description',
        type: 'string',
      };
      expect(inferDefaultWidget(field)).toBe('textInput');
    });
  });

  describe('buildDocumentFormWidgets', () => {
    const mockSchema: DocumentSchema = {
      fields: [
        {
          key: 'firstName',
          name: 'firstName',
          type: 'string',
          defaultValue: 'John',
        },
        {
          key: 'roleCategory',
          name: 'roleCategory',
          type: 'string',
          options: {
            source: 'inline',
            key: 'role',
            name: 'Role',
          },
        },
        {
          key: 'age',
          name: 'age',
          type: 'number',
        },
      ],
    };

    it('falls back to default inference when field is omitted from uiSchema.fields', () => {
      const uiSchema: DocumentUiSchema = {
        fields: {},
      };

      const widgets = buildDocumentFormWidgets(mockSchema, uiSchema);
      expect(widgets).toHaveLength(3);

      // firstName: omitted in uiSchema -> inferred textInput with Title Case label
      expect(widgets[0].textInput).toBeDefined();
      expect(widgets[0].textInput?.name).toBe('firstName');
      expect(widgets[0].textInput?.label).toBe('First Name');
      expect(widgets[0].textInput?.value).toBe('John');

      // roleCategory: omitted in uiSchema -> inferred selectionInput with Title Case label
      expect(widgets[1].selectionInput).toBeDefined();
      expect(widgets[1].selectionInput?.name).toBe('roleCategory');
      expect(widgets[1].selectionInput?.label).toBe('Role Category');

      // age: omitted in uiSchema -> inferred textInput with Title Case label
      expect(widgets[2].textInput).toBeDefined();
      expect(widgets[2].textInput?.name).toBe('age');
      expect(widgets[2].textInput?.label).toBe('Age');
    });

    it('uses layout array to dictate rendering order', () => {
      const uiSchema: DocumentUiSchema = {
        layout: ['age', 'firstName'],
        fields: {
          firstName: {
            label: 'Custom First Name',
          },
        },
      };

      const widgets = buildDocumentFormWidgets(mockSchema, uiSchema);
      expect(widgets).toHaveLength(2);
      expect(widgets[0].textInput?.name).toBe('age');
      expect(widgets[1].textInput?.name).toBe('firstName');
      expect(widgets[1].textInput?.label).toBe('Custom First Name');
    });

    it('applies widget overrides and custom props', () => {
      const uiSchema: DocumentUiSchema = {
        fields: {
          firstName: {
            widget: 'selectionInput',
            label: 'Preferred Name',
            props: {
              items: [{ text: 'Johnny', value: 'johnny' }],
            },
          },
        },
      };

      const widgets = buildDocumentFormWidgets(mockSchema, uiSchema);
      expect(widgets[0].selectionInput).toBeDefined();
      expect(widgets[0].selectionInput?.label).toBe('Preferred Name');
      expect(widgets[0].selectionInput?.items).toEqual([{ text: 'Johnny', value: 'johnny' }]);
    });
  });

  describe('DocumentUiBlockAdapter', () => {
    it('bypasses core domain to fetch UI config directly and generates valid UiCard', async () => {
      const mockQueryPort: DocumentUiSchemaQueryPort = {
        getDocumentUiSchema: vi.fn().mockResolvedValue({
          layout: ['contractTitle', 'approvalStatus'],
          fields: {
            contractTitle: {
              label: 'Title of Contract',
            },
            approvalStatus: {
              widget: 'selectionInput',
              props: {
                items: [
                  { text: 'Draft', value: 'draft' },
                  { text: 'Approved', value: 'approved' },
                ],
              },
            },
          },
        }),
      };

      const documentSchema: DocumentSchema = {
        fields: [
          {
            key: 'contractTitle',
            name: 'contractTitle',
            type: 'string',
          },
          {
            key: 'approvalStatus',
            name: 'approvalStatus',
            type: 'string',
          },
        ],
      };

      const adapter = new DocumentUiBlockAdapter(mockQueryPort);
      const card = await adapter.renderDocumentCard('contract-doc', documentSchema, {
        title: 'Contract Details',
        subtitle: 'Review schema',
      });

      expect(mockQueryPort.getDocumentUiSchema).toHaveBeenCalledWith('contract-doc');
      expect(card.header.title).toBe('Contract Details');
      expect(card.header.subtitle).toBe('Review schema');
      expect(card.sections).toHaveLength(1);
      expect(card.sections[0].widgets).toHaveLength(2);

      // Verify that card matches CardSchema (UiCard)
      expect(Value.Check(CardSchema, card)).toBe(true);

      // Verify fields
      const titleWidget = card.sections[0].widgets[0];
      expect(titleWidget.textInput?.label).toBe('Title of Contract');

      const statusWidget = card.sections[0].widgets[1];
      expect(statusWidget.selectionInput?.label).toBe('Approval Status'); // Default title case inference
      expect(statusWidget.selectionInput?.items).toHaveLength(2);
    });

    it('works when query port returns undefined UI schema using fallback defaults', async () => {
      const mockQueryPort: DocumentUiSchemaQueryPort = {
        getDocumentUiSchema: vi.fn().mockResolvedValue(undefined),
      };

      const documentSchema: DocumentSchema = {
        fields: [
          {
            key: 'notesField',
            name: 'notesField',
            type: 'string',
          },
        ],
      };

      const adapter = new DocumentUiBlockAdapter(mockQueryPort);
      const card = await adapter.renderDocumentCard('doc-type', documentSchema);

      expect(card.header.title).toBe('Document Form');
      expect(card.sections[0].widgets[0].textInput?.name).toBe('notesField');
      expect(card.sections[0].widgets[0].textInput?.label).toBe('Notes Field');
      expect(Value.Check(CardSchema, card)).toBe(true);
    });
  });

  describe('buildDocumentFormCard', () => {
    it('creates a valid UiCard directly from DocumentSchema and optional DocumentUiSchema', () => {
      const documentSchema: DocumentSchema = {
        fields: [{ key: 'itemName', name: 'itemName', type: 'string' }],
      };
      const mockCalculator = vi.fn().mockReturnValue(['itemName']);
      const card = buildDocumentFormCard(documentSchema, undefined, {
        title: 'Direct Card',
        sectionHeader: 'Item Section',
      }, mockCalculator);
      expect(card.header.title).toBe('Direct Card');
      expect(card.sections[0].header).toBe('Item Section');
      expect(card.sections[0].widgets[0].textInput?.label).toBe('Item Name');
      expect(Value.Check(CardSchema, card)).toBe(true);
      expect(card.evaluationOrder).toEqual(['itemName']);
    });

    it('emits safe evaluationOrder with uncomputed fields evaluated first', () => {
      const documentSchema: DocumentSchema = {
        fields: [
          { key: 'price', name: 'price', type: 'number' },
          { key: 'quantity', name: 'quantity', type: 'number' },
          { key: 'total', name: 'total', type: 'number' },
        ],
      };
      const uiSchema: DocumentUiSchema = {
        fields: {
          price: { label: 'Price' },
          quantity: { label: 'Quantity' },
          total: {
            label: 'Total',
            computeValue: {
              and: [{ var: 'data.price' }, { var: 'data.quantity' }],
            },
          },
        },
      };

      const mockCalculator = vi.fn().mockReturnValue(['price', 'quantity', 'total']);
      const card = buildDocumentFormCard(documentSchema, uiSchema, undefined, mockCalculator);
      expect(card.evaluationOrder).toEqual(['price', 'quantity', 'total']);
      expect(Value.Check(CardSchema, card)).toBe(true);
    });

    it('preserves precomputed evaluationOrder when provided in uiSchema', () => {
      const documentSchema: DocumentSchema = {
        fields: [{ key: 'a', name: 'a', type: 'string' }, { key: 'b', name: 'b', type: 'string' }],
      };
      const uiSchema: DocumentUiSchema = {
        fields: { a: {}, b: {} },
        evaluationOrder: ['b', 'a'],
      };

      const card = buildDocumentFormCard(documentSchema, uiSchema);
      expect(card.evaluationOrder).toEqual(['b', 'a']);
      expect(Value.Check(CardSchema, card)).toBe(true);
    });

    it('throws loudly when circular dependency is detected in buildDocumentFormCard', () => {
      const documentSchema: DocumentSchema = {
        fields: [{ key: 'field1', name: 'field1', type: 'string' }, { key: 'field2', name: 'field2', type: 'string' }],
      };
      const uiSchema: DocumentUiSchema = {
        fields: {
          field1: { computeValue: { var: 'data.field2' } },
          field2: { computeValue: { var: 'data.field1' } },
        },
      };

      const mockCalculator = vi.fn().mockImplementation(() => {
        throw new Error('Circular dependency detected in computeValue rules');
      });

      expect(() => buildDocumentFormCard(documentSchema, uiSchema, undefined, mockCalculator)).toThrow(
        /Circular dependency detected in computeValue rules/
      );
    });
  });
});

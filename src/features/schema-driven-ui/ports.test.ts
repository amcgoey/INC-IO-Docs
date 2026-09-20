import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  SelectionItemSchema,
  SelectionStateSchema,
  GenerateViewRequestSchema,
  AbstractDataSchema,
  StandardWidgetCustomPropsSchema,
  type SelectionState,
  type GenerateViewRequest,
} from './ports';

describe('schema-driven-ui ports', () => {
  describe('Selection state schemas', () => {
    it('validates SelectionItemSchema', () => {
      const item = { text: 'Item 1', value: 'item-1', selected: true };
      expect(Value.Check(SelectionItemSchema, item)).toBe(true);
    });

    it('validates SelectionStateSchema', () => {
      const state: SelectionState = {
        spaceTypes: [{ text: 'Projects', value: 'projects' }],
        spaces: ['space-1', 'space-2'],
        documentTypes: [{ text: 'Invoice', value: 'invoice', selected: true }],
      };
      expect(Value.Check(SelectionStateSchema, state)).toBe(true);
    });

    it('rejects SelectionStateSchema with invalid spaceTypes', () => {
      const invalidState = {
        spaceTypes: 'not-an-array',
        spaces: [],
        documentTypes: [],
      };
      expect(Value.Check(SelectionStateSchema, invalidState)).toBe(false);
    });
  });

  describe('GenerateViewRequestSchema', () => {
    it('validates a valid GenerateViewRequest', () => {
      const req: GenerateViewRequest = {
        viewId: 'drive-document-process-card',
        documentTypeKey: 'invoice',
        selectionState: {
          spaceTypes: [{ text: 'Projects', value: 'projects' }],
          spaces: ['p1'],
          documentTypes: [{ text: 'Invoice', value: 'inv' }],
        },
        validationErrors: ['Missing required field'],
      };
      expect(Value.Check(GenerateViewRequestSchema, req)).toBe(true);
    });

    it('rejects empty viewId in GenerateViewRequest', () => {
      const req = {
        viewId: '',
      };
      expect(Value.Check(GenerateViewRequestSchema, req)).toBe(false);
    });
  });

  describe('Data and Widget DTO schemas', () => {
    it('validates AbstractDataSchema', () => {
      const data = {
        fields: [
          { key: 'title', type: 'string', defaultValue: 'Default Title' },
          { key: 'status', type: 'string', options: ['Draft', 'Published'] },
        ],
      };
      expect(Value.Check(AbstractDataSchema, data)).toBe(true);
    });

    it('validates StandardWidgetCustomPropsSchema', () => {
      const props = {
        type: 'DROPDOWN',
        hintText: 'Select option',
        items: [{ text: 'Draft', value: 'draft' }],
      };
      expect(Value.Check(StandardWidgetCustomPropsSchema, props)).toBe(true);
    });
  });
});


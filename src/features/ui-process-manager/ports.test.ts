import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  UiProcessDocumentSpaceDtoSchema,
  type UiProcessDocumentSpaceDto,
  UiProcessResultSchema,
  UiSelectionStateSchema,
  ProcessUiStateEventSchema,
} from './ports';

describe('UI Process Manager Ports & DTOs', () => {
  describe('UiProcessDocumentSpaceDtoSchema', () => {
    it('validates a valid UiProcessDocumentSpaceDto', () => {
      const validDto: UiProcessDocumentSpaceDto = {
        id: 'space-123',
        typeId: 'projects',
        name: 'Project Alpha',
        abstractStorageId: 'storage-456',
      };
      expect(Value.Check(UiProcessDocumentSpaceDtoSchema, validDto)).toBe(true);
    });

    it('rejects DTO missing required fields', () => {
      const invalid = {
        id: 'space-123',
        name: 'Project Alpha',
      };
      expect(Value.Check(UiProcessDocumentSpaceDtoSchema, invalid)).toBe(false);
    });

    it('rejects empty strings for id, typeId, name, or abstractStorageId', () => {
      expect(
        Value.Check(UiProcessDocumentSpaceDtoSchema, {
          id: '',
          typeId: 'projects',
          name: 'Project Alpha',
          abstractStorageId: 'storage-456',
        })
      ).toBe(false);

      expect(
        Value.Check(UiProcessDocumentSpaceDtoSchema, {
          id: 'space-123',
          typeId: '',
          name: 'Project Alpha',
          abstractStorageId: 'storage-456',
        })
      ).toBe(false);

      expect(
        Value.Check(UiProcessDocumentSpaceDtoSchema, {
          id: 'space-123',
          typeId: 'projects',
          name: '',
          abstractStorageId: 'storage-456',
        })
      ).toBe(false);

      expect(
        Value.Check(UiProcessDocumentSpaceDtoSchema, {
          id: 'space-123',
          typeId: 'projects',
          name: 'Project Alpha',
          abstractStorageId: '',
        })
      ).toBe(false);
    });
  });

  describe('UiProcessResultSchema', () => {
    it('validates render result', () => {
      const render = {
        type: 'render',
        viewId: 'root-view',
      };
      expect(Value.Check(UiProcessResultSchema, render)).toBe(true);
    });

    it('validates notification result', () => {
      const notification = {
        type: 'notification',
        text: 'Document processed successfully',
      };
      expect(Value.Check(UiProcessResultSchema, notification)).toBe(true);
    });
  });

  describe('UiSelectionStateSchema', () => {
    it('validates selection state with optional files array', () => {
      const state = {
        spaceTypes: [{ text: 'Projects', value: 'projects' }],
        spaces: ['space-1'],
        documentTypes: [{ text: 'Invoice', value: 'invoice' }],
        files: [{ text: 'File A', value: 'file-1', selected: true }],
      };
      expect(Value.Check(UiSelectionStateSchema, state)).toBe(true);
    });

    it('rejects selection state with invalid files array', () => {
      const state = {
        spaceTypes: [],
        spaces: [],
        documentTypes: [],
        files: 'invalid',
      };
      expect(Value.Check(UiSelectionStateSchema, state)).toBe(false);
    });
  });

  describe('ProcessUiStateEventSchema', () => {
    it('validates selectedItems with id and title', () => {
      const event = {
        actionName: 'onFormChange',
        selectedItems: [
          { id: 'drive-item-1', title: 'Doc 1' },
          { id: 'drive-item-2' },
          { title: 'Doc 3' },
        ],
      };
      expect(Value.Check(ProcessUiStateEventSchema, event)).toBe(true);
    });

    it('rejects invalid selectedItems item', () => {
      const event = {
        selectedItems: [{ id: 123 }],
      };
      expect(Value.Check(ProcessUiStateEventSchema, event)).toBe(false);
    });
  });
});


import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  UiProcessDocumentSpaceDtoSchema,
  type UiProcessDocumentSpaceDto,
  UiProcessResultSchema,
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
});

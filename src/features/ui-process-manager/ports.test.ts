import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  UiProcessDocumentSpaceDtoSchema,
  type UiProcessDocumentSpaceDto,
  UiProcessResultSchema,
  UiSelectionStateSchema,
  ProcessUiStateEventSchema,
  UiProcessEventContextSchema,
  UiProcessSourceFileDtoSchema,
  SELECT_FILES_KEY,
  SELECT_FILE_SOURCE_KEY,
  SELECT_ATTACHMENTS_KEY,
  INPUT_DRIVE_URL_KEY,
  SAVE_EMAIL_TO_PDF_KEY,
  EPHEMERAL_UI_SELECTION_KEYS,
  isSelectionKey,
  parseGoogleDriveUrl,
  extractSelectFilesSet,
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

  describe('UiProcessSourceFileDtoSchema', () => {
    it('validates a complete UiProcessSourceFileDto', () => {
      const dto = {
        id: 'file-123',
        name: 'Report.pdf',
        mimeType: 'application/pdf',
      };
      expect(Value.Check(UiProcessSourceFileDtoSchema, dto)).toBe(true);
    });

    it('validates a minimal UiProcessSourceFileDto with only id', () => {
      const dto = { id: 'file-123' };
      expect(Value.Check(UiProcessSourceFileDtoSchema, dto)).toBe(true);
    });

    it('rejects invalid UiProcessSourceFileDto missing id or having invalid types', () => {
      expect(Value.Check(UiProcessSourceFileDtoSchema, { name: 'Report.pdf' })).toBe(false);
      expect(Value.Check(UiProcessSourceFileDtoSchema, { id: 123 })).toBe(false);
      expect(Value.Check(UiProcessSourceFileDtoSchema, { id: 'file-1', mimeType: 999 })).toBe(false);
    });
  });

  describe('ProcessUiStateEventSchema & UiProcessEventContextSchema mimeType support', () => {
    it('validates selectedItems with mimeType in ProcessUiStateEventSchema', () => {
      const event = {
        actionName: 'onFormChange',
        selectedItems: [
          { id: 'drive-item-1', title: 'Doc 1', mimeType: 'application/pdf' },
          { id: 'drive-item-2', mimeType: 'image/png' },
        ],
      };
      expect(Value.Check(ProcessUiStateEventSchema, event)).toBe(true);
    });

    it('validates selectedItems with mimeType in UiProcessEventContextSchema', () => {
      const context = {
        actionName: 'processDocument',
        selectedItems: [
          { id: 'drive-item-1', title: 'Doc 1', mimeType: 'application/pdf' },
        ],
      };
      expect(Value.Check(UiProcessEventContextSchema, context)).toBe(true);
    });

    it('validates userOAuthToken in ProcessUiStateEventSchema', () => {
      const event = {
        hostApp: 'GMAIL',
        userOAuthToken: 'ya29.user-token-123',
        gmail: {
          messageId: 'msg-123',
        },
      };
      expect(Value.Check(ProcessUiStateEventSchema, event)).toBe(true);
    });

    it('aliases ProcessUiStateEventSchema to adhere to Rule 2 schema deduplication', () => {
      expect(UiProcessEventContextSchema).toBe(ProcessUiStateEventSchema);
    });
  });

  describe('Re-exported Ephemeral Keys & Selection Utilities', () => {
    it('re-exports ephemeral selection keys and sets from domain', () => {
      expect(SELECT_FILES_KEY).toBe('SelectFiles');
      expect(SELECT_FILE_SOURCE_KEY).toBe('SelectFileSource');
      expect(SELECT_ATTACHMENTS_KEY).toBe('SelectAttachments');
      expect(INPUT_DRIVE_URL_KEY).toBe('InputDriveURL');
      expect(SAVE_EMAIL_TO_PDF_KEY).toBe('SaveEmailToPdf');
      expect(EPHEMERAL_UI_SELECTION_KEYS).toBeInstanceOf(Set);
      expect(EPHEMERAL_UI_SELECTION_KEYS.size).toBe(5);
      expect(typeof isSelectionKey).toBe('function');
      expect(typeof parseGoogleDriveUrl).toBe('function');
      expect(typeof extractSelectFilesSet).toBe('function');
    });
  });
});




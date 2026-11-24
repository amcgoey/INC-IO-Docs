import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import {
  UiProcessDocumentSpaceDtoSchema,
  type UiProcessDocumentSpaceDto,
  UiProcessRenderResultSchema,
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
  SELECT_EMAIL_MESSAGE_KEY,
  SELECT_DOCUMENT_LOG_KEY,
  EPHEMERAL_UI_SELECTION_KEYS,
  isSelectionKey,
  parseGoogleDriveUrl,
  extractSelectFilesSet,
  UiProcessGmailAttachmentDescriptorSchema,
  UiProcessGmailMessageDescriptorSchema,
  type UiProcessGmailAttachmentDescriptor,
  type UiProcessGmailMessageDescriptor,
  formatThreadEmailOptionLabel,
  ProcessUiStateInputSchema,
  type UiProcessDocumentRunnerPort,
  IN_CARD_ACTIONS,
  isInCardAction,
  UiProcessCopyDocumentLogResultSchema,
  type UiProcessCopyDocumentLogResult,
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

    it('validates render result with isUpdateCard: true and notification string', () => {
      const renderWithNotification = {
        type: 'render',
        viewId: 'root-view',
        isUpdateCard: true,
        notification: 'Created "Harborview Document Log" in "1 Admin".',
      };
      expect(Value.Check(UiProcessRenderResultSchema, renderWithNotification)).toBe(true);
      expect(Value.Check(UiProcessResultSchema, renderWithNotification)).toBe(true);
    });

    it('accepts notification: undefined on render result under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        const renderWithUndefinedNotification = {
          type: 'render',
          viewId: 'root-view',
          isUpdateCard: true,
          notification: undefined,
        };
        expect(Value.Check(UiProcessRenderResultSchema, renderWithUndefinedNotification)).toBe(true);
        expect(Value.Check(UiProcessResultSchema, renderWithUndefinedNotification)).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects non-string notification on render result', () => {
      for (const badNotification of [123, true, { text: 'Created' }]) {
        const invalidRender = {
          type: 'render',
          viewId: 'root-view',
          isUpdateCard: true,
          notification: badNotification,
        };
        expect(Value.Check(UiProcessRenderResultSchema, invalidRender)).toBe(false);
        expect(Value.Check(UiProcessResultSchema, invalidRender)).toBe(false);
      }
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

    it('validates selection state with optional threadMessages array', () => {
      const state = {
        spaceTypes: [{ text: 'Projects', value: 'projects' }],
        spaces: ['space-1'],
        documentTypes: [{ text: 'Invoice', value: 'invoice' }],
        threadMessages: [{ text: '(1) Alice | 261019', value: 'msg-1', selected: true }],
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

    it('validates a UiProcessSourceFileDto with binary content', () => {
      const dto = {
        id: 'att-1',
        name: 'receipt.pdf',
        mimeType: 'application/pdf',
        content: new Uint8Array([10, 20, 30]),
      };
      expect(Value.Check(UiProcessSourceFileDtoSchema, dto)).toBe(true);
    });

    it('rejects a UiProcessSourceFileDto with non-Uint8Array content', () => {
      const dto = {
        id: 'att-1',
        content: 'not-bytes',
      };
      expect(Value.Check(UiProcessSourceFileDtoSchema, dto)).toBe(false);
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
      expect(SELECT_EMAIL_MESSAGE_KEY).toBe('SelectEmailMessage');
      expect(SELECT_DOCUMENT_LOG_KEY).toBe('SelectDocumentLog');
      expect(EPHEMERAL_UI_SELECTION_KEYS).toBeInstanceOf(Set);
      expect(EPHEMERAL_UI_SELECTION_KEYS.size).toBe(7);
      expect(EPHEMERAL_UI_SELECTION_KEYS.has(SELECT_DOCUMENT_LOG_KEY)).toBe(true);
      expect(typeof isSelectionKey).toBe('function');
      expect(typeof parseGoogleDriveUrl).toBe('function');
      expect(typeof extractSelectFilesSet).toBe('function');
    });

    it('validates UiProcessGmailAttachmentDescriptorSchema and UiProcessGmailMessageDescriptorSchema with enriched metadata (Ticket #292)', () => {
      const validAttachment: UiProcessGmailAttachmentDescriptor = {
        id: 'att-1',
        title: 'Report.pdf',
        mimeType: 'application/pdf',
      };
      expect(Value.Check(UiProcessGmailAttachmentDescriptorSchema, validAttachment)).toBe(true);

      const validMessage: UiProcessGmailMessageDescriptor = {
        id: 'msg-1',
        threadId: 'th-1',
        subject: 'Project Kickoff - 071200-001 Waterproofing',
        from: 'Alice <alice@example.com>',
        to: 'Bob <bob@example.com>',
        cc: 'Charlie <charlie@example.com>',
        date: 'Mon, 19 Oct 2026 14:00:00 -0400',
        plainTextBody: 'Please find submittal attached.',
        htmlBody: '<p>Please find submittal attached.</p>',
        attachments: [validAttachment],
      };
      expect(Value.Check(UiProcessGmailMessageDescriptorSchema, validMessage)).toBe(true);
      expect(validMessage.subject).toBe('Project Kickoff - 071200-001 Waterproofing');
      expect(validMessage.plainTextBody).toBe('Please find submittal attached.');
      expect(validMessage.htmlBody).toBe('<p>Please find submittal attached.</p>');

      // Undefined optional properties pass ExactOptionalPropertyTypes check
      const minimalMessage: UiProcessGmailMessageDescriptor = {
        id: 'msg-2',
        threadId: undefined,
        subject: undefined,
        from: undefined,
        to: undefined,
        cc: undefined,
        date: undefined,
        plainTextBody: undefined,
        htmlBody: undefined,
        attachments: [],
      };
      expect(Value.Check(UiProcessGmailMessageDescriptorSchema, minimalMessage)).toBe(true);

      expect(typeof formatThreadEmailOptionLabel).toBe('function');
    });

    it('allows UiProcessDocumentRunnerPort to accept optional targetMessageId in payload', async () => {
      let capturedPayload: Parameters<UiProcessDocumentRunnerPort['processDocument']>[0] | undefined;
      const runner: UiProcessDocumentRunnerPort = {
        processDocument: async (payload) => {
          capturedPayload = payload;
          return { success: true };
        },
      };

      await runner.processDocument(
        {
          type: 'communication-project',
          data: { contact: 'Acme' },
          targetMessageId: 'msg-selected-456',
        },
        'onSubmit'
      );

      expect(capturedPayload!.targetMessageId).toBe('msg-selected-456');
    });
  });

  describe('ProcessUiStateInputSchema', () => {
    const baseInput = {
      context: {},
      spaceTypes: [],
      spaces: [],
    };

    it('accepts optional isResetOrInitial as true, false, undefined, or omitted', () => {
      expect(Value.Check(ProcessUiStateInputSchema, baseInput)).toBe(true);
      expect(
        Value.Check(ProcessUiStateInputSchema, { ...baseInput, isResetOrInitial: true })
      ).toBe(true);
      expect(
        Value.Check(ProcessUiStateInputSchema, { ...baseInput, isResetOrInitial: false })
      ).toBe(true);
      expect(
        Value.Check(ProcessUiStateInputSchema, { ...baseInput, isResetOrInitial: undefined })
      ).toBe(true);
    });

    it('rejects non-boolean values for isResetOrInitial', () => {
      expect(
        Value.Check(ProcessUiStateInputSchema, { ...baseInput, isResetOrInitial: 'true' })
      ).toBe(false);
    });
  });

  describe('IN_CARD_ACTIONS, isInCardAction, and UiProcessCopyDocumentLogResultSchema', () => {
    it('re-exports IN_CARD_ACTIONS and isInCardAction from domain', () => {
      expect(IN_CARD_ACTIONS).toBeInstanceOf(Set);
      expect(IN_CARD_ACTIONS.has('copyDocumentLog')).toBe(true);
      expect(isInCardAction('copyDocumentLog')).toBe(true);
      expect(isInCardAction('refresh')).toBe(false);
      expect(isInCardAction(undefined)).toBe(false);
    });

    it('validates valid UiProcessCopyDocumentLogResult payloads and rejects invalid ones', () => {
      const createdResult: UiProcessCopyDocumentLogResult = {
        created: true,
        candidate: { id: 'log-123', name: 'Project Main Document Log' },
        folderPath: '1 Admin',
      };
      expect(Value.Check(UiProcessCopyDocumentLogResultSchema, createdResult)).toBe(true);

      const existingResult: UiProcessCopyDocumentLogResult = {
        created: false,
        candidate: { id: 'log-123', name: 'Project Main Document Log' },
        folderPath: '1 Admin',
      };
      expect(Value.Check(UiProcessCopyDocumentLogResultSchema, existingResult)).toBe(true);

      // Rejects missing fields
      expect(
        Value.Check(UiProcessCopyDocumentLogResultSchema, {
          created: true,
          candidate: { id: 'log-123', name: 'Project Main Document Log' },
        })
      ).toBe(false);

      // Rejects additionalProperties
      expect(
        Value.Check(UiProcessCopyDocumentLogResultSchema, {
          ...createdResult,
          extra: 'nope',
        })
      ).toBe(false);

      // Rejects empty candidate id/name
      expect(
        Value.Check(UiProcessCopyDocumentLogResultSchema, {
          created: true,
          candidate: { id: '', name: 'Log' },
          folderPath: '1 Admin',
        })
      ).toBe(false);
    });
  });
});




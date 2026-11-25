import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  SelectionItemSchema,
  SelectionStateSchema,
  GenerateViewRequestSchema,
  AbstractDataFieldSchema,
  AbstractDataSchema,
  LinkedFieldSchema,
  StandardWidgetCustomPropsSchema,
  DynamicOptionQuerySchema,
  DynamicOptionStatusSchema,
  DynamicOptionResolutionSchema,
  type DynamicOptionResolution,
  OptionsFetcherContextSchema,
  DOCUMENT_LOG_CONTEXT_KEY,
  DocumentLogPanelContextSchema,
  DocumentLogPanelStatusSchema,
  UiContextQueryRequestSchema,
  type DocumentLogPanelContext,
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

    it('validates SelectionStateSchema with optional files array', () => {
      const stateWithFiles: SelectionState = {
        spaceTypes: [{ text: 'Projects', value: 'projects' }],
        spaces: ['space-1', 'space-2'],
        documentTypes: [{ text: 'Invoice', value: 'invoice', selected: true }],
        files: [
          { text: 'File A', value: 'file-1', selected: true },
          { text: 'File B', value: 'file-2', selected: false },
        ],
      };
      expect(Value.Check(SelectionStateSchema, stateWithFiles)).toBe(true);
    });

    it('rejects SelectionStateSchema with invalid files property', () => {
      const invalidFilesState = {
        spaceTypes: [],
        spaces: [],
        documentTypes: [],
        files: 'not-an-array',
      };
      expect(Value.Check(SelectionStateSchema, invalidFilesState)).toBe(false);
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
    it('validates LinkedFieldSchema with valid and invalid values', () => {
      expect(Value.Check(LinkedFieldSchema, { sourceField: 'specTag', sourceProperty: 'name' })).toBe(true);
      expect(Value.Check(LinkedFieldSchema, { sourceField: '', sourceProperty: 'name' })).toBe(false);
      expect(Value.Check(LinkedFieldSchema, { sourceField: 'specTag', sourceProperty: '' })).toBe(false);
      expect(Value.Check(LinkedFieldSchema, { sourceField: 'specTag' })).toBe(false);
    });

    it('validates AbstractDataFieldSchema with optional linkedField', () => {
      const fieldWithoutLinked = { key: 'title', type: 'string' };
      expect(Value.Check(AbstractDataFieldSchema, fieldWithoutLinked)).toBe(true);

      const fieldWithLinked = {
        key: 'specTitle',
        type: 'string',
        linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
      };
      expect(Value.Check(AbstractDataFieldSchema, fieldWithLinked)).toBe(true);

      const fieldWithInvalidLinked = {
        key: 'specTitle',
        type: 'string',
        linkedField: { sourceField: '', sourceProperty: 'name' },
      };
      expect(Value.Check(AbstractDataFieldSchema, fieldWithInvalidLinked)).toBe(false);
    });

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

  describe('Dynamic Options Schemas', () => {
    it('validates DynamicOptionQuerySchema', () => {
      const query = {
        sourceKey: 'contactFolders',
        optionSource: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '1 Admin/Communication',
        },
      };
      expect(Value.Check(DynamicOptionQuerySchema, query)).toBe(true);
    });

    it('validates OptionsFetcherContextSchema', () => {
      const context = {
        spaceId: 'folder-123',
        formData: { someKey: 'someVal' },
      };
      expect(Value.Check(OptionsFetcherContextSchema, context)).toBe(true);
    });

    it('validates GenerateViewRequest with optional spaceId and statusMessages', () => {
      const req: GenerateViewRequest = {
        viewId: 'drive-document-process-card',
        spaceId: 'space-folder-999',
        statusMessages: ['Status message 1', 'Status message 2'],
      };
      expect(Value.Check(GenerateViewRequestSchema, req)).toBe(true);
    });

    it('validates all 7 DynamicOptionStatusSchema literals', () => {
      const validStatuses = [
        'ready',
        'empty',
        'missing_space',
        'path_not_found',
        'ambiguous_path',
        'timeout',
        'error',
      ];
      for (const status of validStatuses) {
        expect(Value.Check(DynamicOptionStatusSchema, status)).toBe(true);
      }
      expect(Value.Check(DynamicOptionStatusSchema, 'invalid_status')).toBe(false);
    });

    it('validates DynamicOptionResolutionSchema with and without targetPath', () => {
      const resolutionWithPath: DynamicOptionResolution = {
        status: 'ready',
        items: [{ text: 'Alpha', value: 'alpha' }],
        targetPath: '1 Admin/Communications',
      };
      expect(Value.Check(DynamicOptionResolutionSchema, resolutionWithPath)).toBe(true);

      const resolutionWithoutPath: DynamicOptionResolution = {
        status: 'missing_space',
        items: [],
      };
      expect(Value.Check(DynamicOptionResolutionSchema, resolutionWithoutPath)).toBe(true);

      const invalidResolution = {
        status: 'unknown',
        items: [],
      };
      expect(Value.Check(DynamicOptionResolutionSchema, invalidResolution)).toBe(false);
    });
  });

  describe('UiContextQuery and DocumentLogPanelContext schemas', () => {
    it('exports DOCUMENT_LOG_CONTEXT_KEY and validates UiContextQueryRequestSchema', () => {
      expect(DOCUMENT_LOG_CONTEXT_KEY).toBe('document-log');
      expect(Value.Check(UiContextQueryRequestSchema, {})).toBe(true);
      expect(
        Value.Check(UiContextQueryRequestSchema, {
          spaceId: 'space-1',
          documentTypeKey: 'submittal-arch',
          formData: { section: '071200' },
        })
      ).toBe(true);
      expect(
        Value.Check(UiContextQueryRequestSchema, {
          spaceId: undefined,
          documentTypeKey: undefined,
          formData: undefined,
        })
      ).toBe(true);
    });

    it('validates all 5 DocumentLogPanelStatusSchema literals and rejects invalid status', () => {
      for (const status of [
        'missing_space',
        'missing',
        'resolved',
        'ambiguous',
        'discovery_error',
      ]) {
        expect(Value.Check(DocumentLogPanelStatusSchema, status)).toBe(true);
      }
      expect(Value.Check(DocumentLogPanelStatusSchema, 'unknown')).toBe(false);
    });

    it('validates DocumentLogPanelContextSchema with ExactOptionalPropertyTypes and rejects unknown or raw metadata fields', () => {
      const minimal: DocumentLogPanelContext = {
        status: 'missing_space',
      };
      expect(Value.Check(DocumentLogPanelContextSchema, minimal)).toBe(true);

      const resolvedWithExtensibleFields: DocumentLogPanelContext = {
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        targetFileName: 'Harborview Hotel Document Log',
        discoveryErrorMessage: undefined,
        candidateOptions: [{ text: 'Harborview Hotel Document Log', value: 'log-1', selected: true }],
        activeCandidate: {
          name: 'Harborview Hotel Document Log',
          url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
        },
        readStatus: 'ready',
        idGroup: '071200-001',
        missingIdFields: undefined,
        readErrorMessage: undefined,
        warningMessages: ['Row 7: invalid action'],
        entries: [
          {
            topLabel: 'Rev 0 • 071200-001 • Open',
            text: '<b>Received</b> 260204 (MB)',
            bottomLabel: 'Waterproofing',
            fileUri: 'https://drive.google.com/file/d/f1/view',
            valid: true,
          },
        ],
      };
      expect(Value.Check(DocumentLogPanelContextSchema, resolvedWithExtensibleFields)).toBe(true);

      // Must reject raw Drive/Sheets/domain metadata leakage
      expect(
        Value.Check(DocumentLogPanelContextSchema, {
          status: 'resolved',
          parents: ['folder-1'],
        })
      ).toBe(false);
      expect(
        Value.Check(DocumentLogPanelContextSchema, {
          status: 'resolved',
          activeCandidate: { name: '', url: 'https://docs.google.com/spreadsheets/d/log-1/edit' },
        })
      ).toBe(false);
    });
  });
});


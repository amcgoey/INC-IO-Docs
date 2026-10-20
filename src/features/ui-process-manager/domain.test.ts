import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  extractDocumentData,
  translateDocumentType,
  resolveSpaceType,
  resolveDocumentType,
  resolveSpace,
  resolveSpaceId,
  evaluateProcessUiState,
  isSelectionKey,
  parseGoogleDriveUrl,
  SELECT_FILES_KEY,
  SELECT_FILE_SOURCE_KEY,
  SELECT_ATTACHMENTS_KEY,
  INPUT_DRIVE_URL_KEY,
  SAVE_EMAIL_TO_PDF_KEY,
  EPHEMERAL_UI_SELECTION_KEYS,
  extractSelectFilesSet,
  ResolveSpaceResultSchema,
  UiProcessSpaceItemSchema,
  DRIVE_WORKSPACE_ADDON_VIEW_ID,
  GMAIL_WORKSPACE_ADDON_VIEW_ID,
  type ProcessUiStateInput,
} from './domain';
import {
  ResolveSpaceResultSchema as PortsResolveSpaceResultSchema,
  UiProcessSpaceItemSchema as PortsUiProcessSpaceItemSchema,
} from './ports';

describe('ui-process-manager domain', () => {

  describe('extractSelectFilesSet', () => {
    it('extracts set from scalar string trimming whitespace', () => {
      expect(extractSelectFilesSet({ SelectFiles: ' file-1 ' })).toEqual(new Set(['file-1']));
    });

    it('extracts set from array of strings trimming whitespace and ignoring blanks', () => {
      expect(
        extractSelectFilesSet({
          SelectFiles: [' file-1 ', 'file-2', '', '   ', 123 as unknown as string],
        })
      ).toEqual(new Set(['file-1', 'file-2']));
    });

    it('returns empty set when SelectFiles is absent, undefined, or empty', () => {
      expect(extractSelectFilesSet(undefined)).toEqual(new Set());
      expect(extractSelectFilesSet({})).toEqual(new Set());
      expect(extractSelectFilesSet({ SelectFiles: undefined })).toEqual(new Set());
      expect(extractSelectFilesSet({ SelectFiles: '' })).toEqual(new Set());
      expect(extractSelectFilesSet({ SelectFiles: [] })).toEqual(new Set());
    });

    it('parameterizes extraction using a custom keyName', () => {
      expect(
        extractSelectFilesSet(
          { [SELECT_ATTACHMENTS_KEY]: ' att-1 ' },
          SELECT_ATTACHMENTS_KEY
        )
      ).toEqual(new Set(['att-1']));

      expect(
        extractSelectFilesSet(
          { [SELECT_ATTACHMENTS_KEY]: [' att-1 ', 'att-2', '', '   '] },
          SELECT_ATTACHMENTS_KEY
        )
      ).toEqual(new Set(['att-1', 'att-2']));

      expect(
        extractSelectFilesSet(
          { SelectFiles: 'file-1' },
          SELECT_ATTACHMENTS_KEY
        )
      ).toEqual(new Set());
    });
  });

  describe('isSelectionKey and EPHEMERAL_UI_SELECTION_KEYS', () => {
    it('defines EPHEMERAL_UI_SELECTION_KEYS containing all five ephemeral selection keys', () => {
      expect(SELECT_FILES_KEY).toBe('SelectFiles');
      expect(SELECT_FILE_SOURCE_KEY).toBe('SelectFileSource');
      expect(SELECT_ATTACHMENTS_KEY).toBe('SelectAttachments');
      expect(INPUT_DRIVE_URL_KEY).toBe('InputDriveURL');
      expect(SAVE_EMAIL_TO_PDF_KEY).toBe('SaveEmailToPdf');

      expect(EPHEMERAL_UI_SELECTION_KEYS).toEqual(
        new Set([
          'SelectFiles',
          'SelectFileSource',
          'SelectAttachments',
          'InputDriveURL',
          'SaveEmailToPdf',
        ])
      );
    });

    it('returns true for all EPHEMERAL_UI_SELECTION_KEYS and any key starting with SELECTION_KEY_PREFIX', () => {
      expect(isSelectionKey('SelectFiles')).toBe(true);
      expect(isSelectionKey('SelectFileSource')).toBe(true);
      expect(isSelectionKey('SelectAttachments')).toBe(true);
      expect(isSelectionKey('InputDriveURL')).toBe(true);
      expect(isSelectionKey('SaveEmailToPdf')).toBe(true);

      expect(isSelectionKey('SelectDocumentSpaceType')).toBe(true);
      expect(isSelectionKey('SelectDocumentSpace')).toBe(true);
      expect(isSelectionKey('SelectDocumentType')).toBe(true);
      expect(isSelectionKey('SelectDocumentSpace_projects')).toBe(true);
      expect(isSelectionKey('SelectDocumentType_projects')).toBe(true);

      expect(isSelectionKey('contact')).toBe(false);
      expect(isSelectionKey('title')).toBe(false);
      expect(isSelectionKey('files')).toBe(false);
    });
  });

  describe('extractDocumentData', () => {
    it('extracts only non-SelectDocument keys from formData and strips all five ephemeral keys', () => {
      const formData = {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'communication-project',
        SelectFiles: ['file-1', 'file-2'],
        SelectFileSource: 'DRIVE',
        SelectAttachments: ['att-1', 'att-2'],
        InputDriveURL: 'https://drive.google.com/open?id=123',
        SaveEmailToPdf: true,
        contact: 'John Doe',
        date: '260920',
        direction: 'IN',
      };

      const result = extractDocumentData(formData);

      expect(result).toEqual({
        contact: 'John Doe',
        date: '260920',
        direction: 'IN',
      });
      expect(result).not.toHaveProperty('SelectDocumentSpaceType');
      expect(result).not.toHaveProperty('SelectDocumentSpace');
      expect(result).not.toHaveProperty('SelectDocumentType');
      expect(result).not.toHaveProperty('SelectFiles');
      expect(result).not.toHaveProperty('SelectFileSource');
      expect(result).not.toHaveProperty('SelectAttachments');
      expect(result).not.toHaveProperty('InputDriveURL');
      expect(result).not.toHaveProperty('SaveEmailToPdf');
    });

    it('returns empty object when formData is undefined or empty', () => {
      expect(extractDocumentData(undefined)).toEqual({});
      expect(extractDocumentData({})).toEqual({});
    });

    it('preserves inactive suffixed keys for core domain ACL to sanitize', () => {
      const formData = {
        SelectDocumentSpace: 'Alpha',
        contact: 'John Doe',
        date: '260920',
        'invoiceNumber_invoice-project': 'INV-999',
        'proposalTitle_communication-proposal': 'Proposal A',
      };

      const result = extractDocumentData(formData);

      expect(result).toEqual({
        contact: 'John Doe',
        date: '260920',
        'invoiceNumber_invoice-project': 'INV-999',
        'proposalTitle_communication-proposal': 'Proposal A',
      });
      expect(result).not.toHaveProperty('SelectDocumentSpace');
    });
  });

  describe('parseGoogleDriveUrl', () => {
    describe('standard Drive files', () => {
      it('parses standard https://drive.google.com/file/d/<id>/view URL', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/view?usp=sharing'
        );
        expect(result).toEqual({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          resourceType: 'file',
        });
      });

      it('parses standard https://drive.google.com/d/<id> URL', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
        );
        expect(result).toEqual({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          resourceType: 'file',
        });
      });

      it('parses standard https://drive.google.com/file/d/<id> without trailing subpath', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
        );
        expect(result).toEqual({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          resourceType: 'file',
        });
      });

      it('parses multi-account /file/u/1/d/<id> URLs', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/file/u/1/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/view'
        );
        expect(result).toEqual({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          resourceType: 'file',
        });
      });

      it('parses multi-account /u/2/file/d/<id> URLs', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/u/2/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/view'
        );
        expect(result).toEqual({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          resourceType: 'file',
        });
      });

      it('parses http: protocol URLs', () => {
        const result = parseGoogleDriveUrl(
          'http://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms'
        );
        expect(result).toEqual({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          resourceType: 'file',
        });
      });

      it('trims leading/trailing whitespace, tabs, and newlines', () => {
        const result = parseGoogleDriveUrl(
          '\n  \t https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/view?usp=sharing \r\n  '
        );
        expect(result).toEqual({
          id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
          resourceType: 'file',
        });
      });

      it('strips query parameters and hash fragments', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/file/d/file_123-abc/view?usp=drivesdk&authuser=0#heading=h.xyz'
        );
        expect(result).toEqual({
          id: 'file_123-abc',
          resourceType: 'file',
        });
      });
    });

    describe('standard Drive folders', () => {
      it('parses standard https://drive.google.com/drive/folders/<id>', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/drive/folders/1ABC_xyz-789'
        );
        expect(result).toEqual({
          id: '1ABC_xyz-789',
          resourceType: 'folder',
        });
      });

      it('parses multi-account /drive/u/0/folders/<id>', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/drive/u/0/folders/1ABC_xyz-789'
        );
        expect(result).toEqual({
          id: '1ABC_xyz-789',
          resourceType: 'folder',
        });
      });

      it('parses multi-account /u/1/folders/<id>', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/u/1/folders/1ABC_xyz-789'
        );
        expect(result).toEqual({
          id: '1ABC_xyz-789',
          resourceType: 'folder',
        });
      });

      it('parses bare /folders/<id>', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/folders/1ABC_xyz-789'
        );
        expect(result).toEqual({
          id: '1ABC_xyz-789',
          resourceType: 'folder',
        });
      });

      it('parses folder URL with query params and hash fragments', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/drive/u/1/folders/1ABC_xyz-789?usp=drive_link&resourcekey=0-xyz#my-anchor'
        );
        expect(result).toEqual({
          id: '1ABC_xyz-789',
          resourceType: 'folder',
        });
      });
    });

    describe('Drive open links', () => {
      it('parses https://drive.google.com/open?id=<id>', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/open?id=1open_file-ID'
        );
        expect(result).toEqual({
          id: '1open_file-ID',
          resourceType: 'file',
        });
      });

      it('parses open?id= with multiple query parameters in any order', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/open?usp=sharing&id=1open_file-ID&authuser=0'
        );
        expect(result).toEqual({
          id: '1open_file-ID',
          resourceType: 'file',
        });
      });

      it('parses open?id= with multi-account /u/1/open?id=<id>', () => {
        const result = parseGoogleDriveUrl(
          'https://drive.google.com/u/1/open?id=1open_file-ID'
        );
        expect(result).toEqual({
          id: '1open_file-ID',
          resourceType: 'file',
        });
      });
    });

    describe('Google Workspace Collaborative Docs', () => {
      it('parses Google Docs https://docs.google.com/document/d/<id>/edit', () => {
        const result = parseGoogleDriveUrl(
          'https://docs.google.com/document/d/1doc_ID-123/edit?tab=t.0#heading=h.1'
        );
        expect(result).toEqual({
          id: '1doc_ID-123',
          resourceType: 'file',
        });
      });

      it('parses Google Docs with multi-account /u/1/document/d/<id>/edit', () => {
        const result = parseGoogleDriveUrl(
          'https://docs.google.com/u/1/document/d/1doc_ID-123/edit'
        );
        expect(result).toEqual({
          id: '1doc_ID-123',
          resourceType: 'file',
        });
      });

      it('parses Google Docs with multi-account /document/u/1/d/<id>/edit', () => {
        const result = parseGoogleDriveUrl(
          'https://docs.google.com/document/u/1/d/1doc_ID-123/edit'
        );
        expect(result).toEqual({
          id: '1doc_ID-123',
          resourceType: 'file',
        });
      });

      it('parses Google Sheets https://docs.google.com/spreadsheets/d/<id>/edit#gid=0', () => {
        const result = parseGoogleDriveUrl(
          'https://docs.google.com/spreadsheets/d/1sheet_ID-456/edit#gid=0'
        );
        expect(result).toEqual({
          id: '1sheet_ID-456',
          resourceType: 'file',
        });
      });

      it('parses Google Slides https://docs.google.com/presentation/d/<id>/edit#slide=id.p', () => {
        const result = parseGoogleDriveUrl(
          'https://docs.google.com/presentation/d/1pres_ID-789/edit#slide=id.p'
        );
        expect(result).toEqual({
          id: '1pres_ID-789',
          resourceType: 'file',
        });
      });

      it('parses Google Forms https://docs.google.com/forms/d/1form_ID-000/viewform', () => {
        const result = parseGoogleDriveUrl(
          'https://docs.google.com/forms/d/1form_ID-000/viewform'
        );
        expect(result).toEqual({
          id: '1form_ID-000',
          resourceType: 'file',
        });
      });
    });

    describe('invalid URLs / rejection cases', () => {
      it('returns undefined for empty strings or blank whitespace', () => {
        expect(parseGoogleDriveUrl('')).toBeUndefined();
        expect(parseGoogleDriveUrl('   \t\n  ')).toBeUndefined();
      });

      it('returns undefined for non-URL strings or missing protocol', () => {
        expect(parseGoogleDriveUrl('not a url')).toBeUndefined();
        expect(parseGoogleDriveUrl('drive.google.com/file/d/123')).toBeUndefined();
      });

      it('returns undefined for unsupported protocols', () => {
        expect(parseGoogleDriveUrl('ftp://drive.google.com/file/d/123')).toBeUndefined();
        expect(parseGoogleDriveUrl('file:///drive.google.com/file/d/123')).toBeUndefined();
        expect(parseGoogleDriveUrl('javascript:alert(1)')).toBeUndefined();
      });

      it('returns undefined for external or lookalike hostnames', () => {
        expect(parseGoogleDriveUrl('https://dropbox.com/s/123/file.pdf')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://onedrive.live.com/?id=123')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://drive.google.com.attacker.com/file/d/123')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://notdrive.google.com/file/d/123')).toBeUndefined();
      });

      it('returns undefined for Google Drive home/navigation URLs without resource ID', () => {
        expect(parseGoogleDriveUrl('https://drive.google.com/')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://drive.google.com/drive/my-drive')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://drive.google.com/drive/starred')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://drive.google.com/drive/trash')).toBeUndefined();
      });

      it('returns undefined when ID segment is missing or empty', () => {
        expect(parseGoogleDriveUrl('https://drive.google.com/file/d/')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://drive.google.com/drive/folders/')).toBeUndefined();
        expect(parseGoogleDriveUrl('https://drive.google.com/open?id=')).toBeUndefined();
      });

      it('returns undefined when ID contains invalid characters', () => {
        expect(parseGoogleDriveUrl('https://drive.google.com/file/d/invalid!id@test')).toBeUndefined();
      });
    });
  });

  describe('translateDocumentType', () => {
    const mapping = {
      'Communication Project': 'communication-project',
      'Communication Proposal': 'communication-proposal',
    };

    it('translates human-readable names to backend keys', () => {
      expect(translateDocumentType('Communication Project', mapping)).toBe('communication-project');
      expect(translateDocumentType('Communication Proposal', mapping)).toBe('communication-proposal');
    });

    it('leaves backend keys intact', () => {
      expect(translateDocumentType('communication-project', mapping)).toBe('communication-project');
    });

    it('returns original input when no mapping exists', () => {
      expect(translateDocumentType('unknown-type', mapping)).toBe('unknown-type');
    });
  });

  describe('resolveSpaceType', () => {
    it('returns space type from formData when present', () => {
      const result = resolveSpaceType({
        formData: { SelectDocumentSpaceType: 'proposals' },
        config: { defaultDocumentSpaceType: 'projects' },
      });
      expect(result).toBe('proposals');
    });

    it('falls back to config defaultDocumentSpaceType when not in formData', () => {
      const result = resolveSpaceType({
        formData: {},
        config: { defaultDocumentSpaceType: 'invoices' },
      });
      expect(result).toBe('invoices');
    });

    it('falls back to projects when neither formData nor config provides it', () => {
      expect(resolveSpaceType()).toBe('projects');
      expect(resolveSpaceType({ formData: {}, config: {} })).toBe('projects');
    });
  });

  describe('resolveDocumentType', () => {
    it('returns document type from formData.SelectDocumentType when present', () => {
      const result = resolveDocumentType({
        formData: { SelectDocumentType: 'invoice-project' },
        config: { defaultDocumentType: 'communication-project' },
      });
      expect(result).toBe('invoice-project');
    });

    it('returns document type from suffixed SelectDocumentType_<spaceType> matching activeSpaceType', () => {
      const result = resolveDocumentType({
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType_projects: 'communication-project',
          SelectDocumentType_proposals: 'communication-proposal',
        },
        activeSpaceType: 'projects',
      });
      expect(result).toBe('communication-project');
    });

    it('prioritizes active space suffixed SelectDocumentType_<spaceType> over stale unsuffixed SelectDocumentType', () => {
      const result = resolveDocumentType({
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'stale-doc-type',
          SelectDocumentType_projects: 'active-space-doc-type',
        },
      });
      expect(result).toBe('active-space-doc-type');
    });

    it('respects empty string selection for active space without falling back to stale unsuffixed key or default config', () => {
      const result = resolveDocumentType({
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'stale-doc-type',
          SelectDocumentType_projects: '',
        },
        config: { defaultDocumentType: 'default-doc' },
      });
      expect(result).toBe('');
    });

    it('resolves activeSpaceType from formData when activeSpaceType is not passed', () => {
      const result = resolveDocumentType({
        formData: {
          SelectDocumentSpaceType: 'proposals',
          SelectDocumentType_projects: 'communication-project',
          SelectDocumentType_proposals: 'communication-proposal',
        },
      });
      expect(result).toBe('communication-proposal');
    });

    it('ignores SelectDocumentType_ keys from inactive spaces to prevent cross-pollination', () => {
      const result = resolveDocumentType({
        formData: {
          SelectDocumentType_custom: 'custom-doc-type',
        },
      });
      expect(result).toBeUndefined();
    });

    it('returns document type from parameters.documentTypeKey when not in formData', () => {
      const result = resolveDocumentType({
        formData: {},
        config: { defaultDocumentType: 'default-doc' },
        parameters: { documentTypeKey: 'param-doc-type' },
      });
      expect(result).toBe('param-doc-type');
    });

    it('falls back to config defaultDocumentType when not in formData or parameters', () => {
      const result = resolveDocumentType({
        formData: {},
        config: { defaultDocumentType: 'default-doc' },
      });
      expect(result).toBe('default-doc');
    });

    it('returns undefined when neither formData, parameters, nor config provides document type', () => {
      expect(resolveDocumentType()).toBeUndefined();
      expect(resolveDocumentType({ formData: {}, config: {} })).toBeUndefined();
    });
  });

  describe('resolveSpaceId', () => {
    it('returns spaceId directly from formData.spaceId when present', () => {
      const result = resolveSpaceId(
        {
          formData: { spaceId: 'direct-space-123' },
          spaces: [{ id: 'direct-space-123', name: 'Direct Space' }],
        }
      );
      expect(result).toBe('direct-space-123');
    });

    it('returns spaceId from formData.SelectDocumentSpace when present', () => {
      const result = resolveSpaceId(
        {
          formData: { SelectDocumentSpace: 'Space-ABC' },
          spaces: [{ id: 'space-abc-id', name: 'Space-ABC' }],
        }
      );
      expect(result).toBe('space-abc-id');
    });

    it('returns spaceId from suffixed SelectDocumentSpace_<spaceType> matching activeSpaceType', () => {
      const result = resolveSpaceId(
        {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'project-folder-id',
            SelectDocumentSpace_proposals: 'proposal-folder-id',
          },
          activeSpaceType: 'projects',
          spaces: [{ id: 'project-folder-id', name: 'Project Folder' }],
        }
      );
      expect(result).toBe('project-folder-id');
    });

    it('trims whitespace and ignores blank strings', () => {
      const result = resolveSpaceId(
        {
          formData: {
            spaceId: '   ',
            SelectDocumentSpace: '  valid-space  ',
          },
          spaces: [{ id: 'valid-space-id', name: 'valid-space' }],
        }
      );
      expect(result).toBe('valid-space-id');
    });

    it('returns undefined when formData is missing or has no space ID', () => {
      expect(resolveSpaceId()).toBeUndefined();
      expect(resolveSpaceId({ formData: {} })).toBeUndefined();
      expect(resolveSpaceId({ formData: { spaceId: '   ' } })).toBeUndefined();
    });

    it('resolves spaceId by exact ID match', () => {
      const spaces = [
        { id: 'space-folder-alpha-id', name: 'Project Alpha' },
        { id: 'space-folder-beta-id', name: 'Project Beta' },
      ];
      const result = resolveSpaceId(
        { formData: { SelectDocumentSpace: 'space-folder-alpha-id' } },
        spaces
      );
      expect(result).toBe('space-folder-alpha-id');
    });

    it('resolves spaceId by case-insensitive name match', () => {
      const spaces = [
        { id: 'space-folder-alpha-id', name: 'Project Alpha' },
      ];
      const resultLower = resolveSpaceId(
        { formData: { SelectDocumentSpace: 'project alpha' } },
        spaces
      );
      expect(resultLower).toBe('space-folder-alpha-id');

      const resultUpper = resolveSpaceId(
        { formData: { SelectDocumentSpace: 'PROJECT ALPHA' } },
        spaces
      );
      expect(resultUpper).toBe('space-folder-alpha-id');
    });

    it('resolves spaceId with whitespace trimming around input and space names', () => {
      const spaces = [
        { id: 'space-folder-alpha-id', name: 'Project Alpha' },
      ];
      const result = resolveSpaceId(
        { formData: { SelectDocumentSpace: '   Project Alpha   ' } },
        spaces
      );
      expect(result).toBe('space-folder-alpha-id');
    });

    it('returns undefined when space does not match any known name or ID', () => {
      const spaces = [
        { id: 'space-folder-alpha-id', name: 'Project Alpha' },
      ];
      const result = resolveSpaceId(
        { formData: { SelectDocumentSpace: 'unlisted-custom-id-999' } },
        spaces
      );
      expect(result).toBeUndefined();
    });

    it('returns undefined when input is empty or whitespace only', () => {
      const spaces = [
        { id: 'space-folder-alpha-id', name: 'Project Alpha' },
      ];
      expect(resolveSpaceId({ formData: { SelectDocumentSpace: '' } }, spaces)).toBeUndefined();
      expect(resolveSpaceId({ formData: { SelectDocumentSpace: '   ' } }, spaces)).toBeUndefined();
      expect(resolveSpaceId({ formData: {} }, spaces)).toBeUndefined();
    });

    it('returns undefined when name collision occurs in resolveSpaceId', () => {
      const spaces = [
        { id: 'alpha-1', name: 'Duplicate Space' },
        { id: 'alpha-2', name: 'Duplicate Space' },
      ];
      expect(
        resolveSpaceId({ formData: { SelectDocumentSpace: 'Duplicate Space' } }, spaces)
      ).toBeUndefined();
    });

    it('disambiguates duplicate space names when entering unique space ID', () => {
      const spaces = [
        { id: 'alpha-1', name: 'Duplicate Space' },
        { id: 'alpha-2', name: 'Duplicate Space' },
      ];
      expect(
        resolveSpaceId({ formData: { SelectDocumentSpace: 'alpha-1' } }, spaces)
      ).toBe('alpha-1');
    });

    it('returns undefined when name collision occurs with whitespace and case variations', () => {
      const spaces = [
        { id: 'alpha-1', name: '  Duplicate Space  ' },
        { id: 'alpha-2', name: 'DUPLICATE SPACE' },
      ];
      expect(
        resolveSpaceId({ formData: { SelectDocumentSpace: '   duplicate space   ' } }, spaces)
      ).toBeUndefined();
    });

    it('disambiguates duplicate space names when entering unique space ID with surrounding whitespace', () => {
      const spaces = [
        { id: 'alpha-1', name: 'Duplicate Space' },
        { id: 'alpha-2', name: 'Duplicate Space' },
      ];
      expect(
        resolveSpaceId({ formData: { SelectDocumentSpace: '   alpha-2   ' } }, spaces)
      ).toBe('alpha-2');
    });

    it('returns undefined without falling back to formData.spaceId when spaceSelectorKey is cleared', () => {
      const result = resolveSpaceId({
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: '',
          spaceId: 'existing-id',
        },
        activeSpaceType: 'projects',
      });
      expect(result).toBeUndefined();
    });
  });

  describe('resolveSpace', () => {
    const spaces = [
      { id: 'alpha-1', name: 'Project Alpha' },
      { id: 'alpha-2', name: 'Project Alpha' },
      { id: 'beta-1', name: 'Project Beta' },
    ];

    it('detects multiple spaces sharing normalized name and returns collisionError', () => {
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: 'Project Alpha' } },
        spaces
      );
      expect(result.spaceId).toBeUndefined();
      expect(result.matchedSpace).toBeUndefined();
      expect(result.collisionError).toBe(
        'Multiple spaces match "Project Alpha". Please choose or enter a unique space identifier.'
      );
    });

    it('detects collision across case variations of space names', () => {
      const caseSpaces = [
        { id: 'alpha-1', name: 'Project Alpha' },
        { id: 'alpha-2', name: 'PROJECT ALPHA' },
      ];
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: 'project alpha' } },
        caseSpaces
      );
      expect(result.spaceId).toBeUndefined();
      expect(result.collisionError).toBe(
        'Multiple spaces match "project alpha". Please choose or enter a unique space identifier.'
      );
    });

    it('detects collision across whitespace variations of space names and input', () => {
      const whitespaceSpaces = [
        { id: 'alpha-1', name: '  Project Alpha  ' },
        { id: 'alpha-2', name: 'Project Alpha' },
      ];
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: '   project alpha   ' } },
        whitespaceSpaces
      );
      expect(result.spaceId).toBeUndefined();
      expect(result.collisionError).toBe(
        'Multiple spaces match "project alpha". Please choose or enter a unique space identifier.'
      );
    });

    it('resolves cleanly to technical ID when entering exact unique technical ID for collided space', () => {
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: 'alpha-1' } },
        spaces
      );
      expect(result.spaceId).toBe('alpha-1');
      expect(result.matchedSpace).toEqual({ id: 'alpha-1', name: 'Project Alpha' });
      expect(result.isIdMatch).toBe(true);
      expect(result.collisionError).toBeUndefined();
    });

    it('resolves cleanly to technical ID when technical ID has surrounding whitespace', () => {
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: '   alpha-2   ' } },
        spaces
      );
      expect(result.spaceId).toBe('alpha-2');
      expect(result.matchedSpace).toEqual({ id: 'alpha-2', name: 'Project Alpha' });
      expect(result.isIdMatch).toBe(true);
      expect(result.collisionError).toBeUndefined();
    });

    it('resolves single unique space by case-insensitive and trimmed name match', () => {
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: '  PROJECT BETA  ' } },
        spaces
      );
      expect(result.spaceId).toBe('beta-1');
      expect(result.matchedSpace).toEqual({ id: 'beta-1', name: 'Project Beta' });
      expect(result.isIdMatch).toBe(false);
      expect(result.collisionError).toBeUndefined();
    });

    it('returns notFoundError and undefined spaceId when space does not match any known name or ID', () => {
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: 'custom-unlisted-id' } },
        spaces
      );
      expect(result.spaceId).toBeUndefined();
      expect(result.matchedSpace).toBeUndefined();
      expect(result.isIdMatch).toBeUndefined();
      expect(result.collisionError).toBeUndefined();
      expect(result.notFoundError).toBe(
        'Document space "custom-unlisted-id" was not found. Please select an existing space.'
      );
    });

    it('trims whitespace and returns notFoundError when unknown space has surrounding whitespace', () => {
      const result = resolveSpace(
        { formData: { SelectDocumentSpace: '   unknown-space   ' } },
        spaces
      );
      expect(result.spaceId).toBeUndefined();
      expect(result.matchedSpace).toBeUndefined();
      expect(result.notFoundError).toBe(
        'Document space "unknown-space" was not found. Please select an existing space.'
      );
    });

    it('returns empty result when formData is missing or empty', () => {
      expect(resolveSpace()).toEqual({});
      expect(resolveSpace({ formData: {} })).toEqual({});
      expect(resolveSpace({ formData: { SelectDocumentSpace: '   ' } })).toEqual({});
    });

    it('returns empty result without falling back to formData.spaceId when spaceSelectorKey is cleared to empty or whitespace string', () => {
      const spaces = [
        { id: 'space-folder-alpha-id', name: 'Project Alpha' },
        { id: 'existing-id', name: 'Existing Space' },
      ];
      const emptyResult = resolveSpace(
        {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: '',
            spaceId: 'existing-id',
          },
          activeSpaceType: 'projects',
        },
        spaces
      );
      expect(emptyResult).toEqual({});
      expect(emptyResult.spaceId).toBeUndefined();

      const whitespaceResult = resolveSpace(
        {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: '   ',
            spaceId: 'existing-id',
          },
          activeSpaceType: 'projects',
        },
        spaces
      );
      expect(whitespaceResult).toEqual({});
      expect(whitespaceResult.spaceId).toBeUndefined();
    });

    it('returns empty result without falling back to formData.spaceId when SelectDocumentSpace is cleared to empty or whitespace string', () => {
      const spaces = [{ id: 'existing-id', name: 'Existing Space' }];
      const emptyResult = resolveSpace(
        {
          formData: {
            SelectDocumentSpace: '',
            spaceId: 'existing-id',
          },
        },
        spaces
      );
      expect(emptyResult).toEqual({});
      expect(emptyResult.spaceId).toBeUndefined();

      const whitespaceResult = resolveSpace(
        {
          formData: {
            SelectDocumentSpace: '   ',
            spaceId: 'existing-id',
          },
        },
        spaces
      );
      expect(whitespaceResult).toEqual({});
      expect(whitespaceResult.spaceId).toBeUndefined();
    });

    it('falls back to formData.spaceId only when neither spaceSelectorKey nor SelectDocumentSpace is present', () => {
      const spaces = [{ id: 'existing-id', name: 'Existing Space' }];
      const result = resolveSpace(
        {
          formData: {
            spaceId: 'existing-id',
          },
        },
        spaces
      );
      expect(result.spaceId).toBe('existing-id');
      expect(result.matchedSpace).toEqual({ id: 'existing-id', name: 'Existing Space' });
    });

    it('returns a result conforming to ResolveSpaceResultSchema and re-exported from ports', () => {
      expect(ResolveSpaceResultSchema).toBe(PortsResolveSpaceResultSchema);

      const spaces = [{ id: 'existing-id', name: 'Existing Space' }];
      const result = resolveSpace(
        {
          formData: {
            spaceId: 'existing-id',
          },
        },
        spaces
      );
      expect(Value.Check(ResolveSpaceResultSchema, result)).toBe(true);

      const collisionResult = resolveSpace(
        {
          formData: {
            SelectDocumentSpace: 'Dup',
          },
        },
        [
          { id: 'd1', name: 'Dup' },
          { id: 'd2', name: 'Dup' },
        ]
      );
      expect(Value.Check(ResolveSpaceResultSchema, collisionResult)).toBe(true);

      const emptyResult = resolveSpace();
      expect(Value.Check(ResolveSpaceResultSchema, emptyResult)).toBe(true);
    });
  });

  describe('evaluateProcessUiState', () => {
    const sampleSpaceTypes = [
      {
        id: 'projects',
        displayName: 'Projects',
        spaceSchema: { allowedDocumentTypes: ['communication-project', 'invoice-project'] },
      },
      {
        id: 'proposals',
        displayName: 'Proposals',
        spaceSchema: { allowedDocumentTypes: ['communication-proposal'] },
      },
    ];

    it('defaults document type to the first allowed type and retains form data when Space Type changes', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onSpaceTypeChange',
          formData: {
            SelectDocumentSpaceType: 'proposals',
            SelectDocumentType: 'communication-project', // previous doc type from projects
            contact: 'Jane',
          },
        },
        config: {
          defaultDocumentSpaceType: 'projects',
          defaultDocumentType: 'communication-project',
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'prop-a', name: 'Proposal A' },
          { id: 'prop-b', name: 'Proposal B' },
        ],
      };

      const state = evaluateProcessUiState(input);

      // Must trigger UI reload
      expect(state.isUpdateCard).toBe(true);
      // Must default Document Type to first allowed type in proposals
      expect(state.documentTypeKey).toBe('communication-proposal');
      expect(state.formData.SelectDocumentType).toBe('communication-proposal');
      // Must retain form data entered previously
      expect(state.formData).toEqual({
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType: 'communication-proposal',
        contact: 'Jane',
      });
      expect(state.formData.contact).toBe('Jane');
    });

    it('retains form data and triggers isUpdateCard when Document Type changes', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onDocumentTypeChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace: 'Project Alpha',
            SelectDocumentType: 'invoice-project',
            contact: 'Jane',
            date: '260920',
          },
        },
        config: {
          defaultDocumentSpaceType: 'projects',
          defaultDocumentType: 'communication-project',
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'space-alpha-id', name: 'Project Alpha' }],
      };

      const state = evaluateProcessUiState(input);

      expect(state.isUpdateCard).toBe(true);
      expect(state.documentTypeKey).toBe('invoice-project');
      expect(state.formData).toEqual({
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'invoice-project',
        contact: 'Jane',
        date: '260920',
      });
      expect(state.formData.contact).toBe('Jane');
      expect(state.formData.date).toBe('260920');
      expect(state.spaceId).toBe('space-alpha-id');
    });

    it('evaluates and includes spaceId in output when space is selected', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'project-folder-456',
            SelectDocumentType_projects: 'communication-project',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'project-folder-456', name: 'Project 456' }],
      };

      const result = evaluateProcessUiState(input);
      expect(result.spaceId).toBe('project-folder-456');
    });

    it('auto-translates raw space ID to display name in effectiveFormData upon evaluateProcessUiState', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'space-folder-alpha-id',
            SelectDocumentType_projects: 'communication-project',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'space-folder-alpha-id', name: 'Project Alpha' }],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBe('space-folder-alpha-id');
      expect(state.formData.SelectDocumentSpace_projects).toBe('Project Alpha');
    });

    it('auto-translates raw space ID in unsuffixed SelectDocumentSpace to display name in effectiveFormData', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace: 'space-folder-alpha-id',
            SelectDocumentType: 'communication-project',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'space-folder-alpha-id', name: 'Project Alpha' }],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBe('space-folder-alpha-id');
      expect(state.formData.SelectDocumentSpace).toBe('Project Alpha');
    });

    it('auto-translates raw space ID in formData.spaceId to display name when no explicit selector keys are present', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
            spaceId: 'space-folder-alpha-id',
            SelectDocumentType: 'communication-project',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'space-folder-alpha-id', name: 'Project Alpha' }],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBe('space-folder-alpha-id');
      expect(state.formData.spaceId).toBe('Project Alpha');
    });

    it('derives selectionState.spaces from spaces collection', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 's1', name: 'Project Alpha' },
          { id: 's2', name: 'Project Beta' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.selectionState.spaces).toEqual(['Project Alpha', 'Project Beta']);
    });

    it('surfaces collision error in validationErrors and sets spaceId undefined when duplicate space names exist', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Dup',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'dup-1', name: 'Project Dup' },
          { id: 'dup-2', name: 'Project Dup' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.validationErrors).toContain(
        'Multiple spaces match "Project Dup". Please choose or enter a unique space identifier.'
      );
      expect(state.isUpdateCard).toBe(true);
    });

    it('sets spaceId undefined, sets isUpdateCard true, and adds collision error during onFormChange', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Dup',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'dup-1', name: 'Project Dup' },
          { id: 'dup-2', name: 'Project Dup' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.isUpdateCard).toBe(true);
      expect(state.validationErrors).toContain(
        'Multiple spaces match "Project Dup". Please choose or enter a unique space identifier.'
      );
    });

    it('resolves cleanly to technical ID and translates name when entering exact ID for collided space during onFormChange', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'dup-2',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'dup-1', name: 'Project Dup' },
          { id: 'dup-2', name: 'Project Dup' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBe('dup-2');
      expect(state.formData.SelectDocumentSpace_projects).toBe('Project Dup');
      expect(state.validationErrors).toBeUndefined();
    });

    it('detects collision across whitespace and case variations during onFormChange', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: '   project dup   ',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'dup-1', name: '  Project Dup  ' },
          { id: 'dup-2', name: 'PROJECT DUP' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.isUpdateCard).toBe(true);
      expect(state.validationErrors).toContain(
        'Multiple spaces match "project dup". Please choose or enter a unique space identifier.'
      );
    });

    it('does not duplicate collision error if validationErrors already contains it', () => {
      const collisionMsg = 'Multiple spaces match "Project Dup". Please choose or enter a unique space identifier.';
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Dup',
          },
          validationErrors: [collisionMsg, 'Other error'],
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'dup-1', name: 'Project Dup' },
          { id: 'dup-2', name: 'Project Dup' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.validationErrors).toEqual([collisionMsg, 'Other error']);
    });

    it('surfaces notFoundError in validationErrors and sets isUpdateCard when space does not match', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Nonexistent Space',
            SelectDocumentType_projects: 'communication-project',
            spaceId: 'stale-space-id',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'proj-1', name: 'Project Alpha' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.formData.spaceId).toBeUndefined();
      expect(state.formData).not.toHaveProperty('spaceId');
      expect(state.isUpdateCard).toBe(true);
      expect(state.validationErrors).toContain(
        'Document space "Nonexistent Space" was not found. Please select an existing space.'
      );
    });

    it('does not duplicate notFoundError if validationErrors already contains it', () => {
      const notFoundMsg = 'Document space "Nonexistent Space" was not found. Please select an existing space.';
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Nonexistent Space',
          },
          validationErrors: [notFoundMsg, 'Other error'],
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'proj-1', name: 'Project Alpha' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.validationErrors).toEqual([notFoundMsg, 'Other error']);
    });

    it('sets spaceId undefined and removes stale formData.spaceId when user clears space input on form change', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          isUpdateCard: true,
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: '',
            SelectDocumentType_projects: 'communication-project',
            spaceId: 'stale-space-id',
            'contact_communication-project': 'Previous Contact',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [
          { id: 'stale-space-id', name: 'Stale Space' },
          { id: 'proj-1', name: 'Project Alpha' },
        ],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.formData.spaceId).toBeUndefined();
      expect(state.formData).not.toHaveProperty('spaceId');
      expect(state.isUpdateCard).toBe(true);
    });

    it('removes stale formData.spaceId when user clears generic SelectDocumentSpace with whitespace', () => {
      const input: ProcessUiStateInput = {
        context: {
          actionName: 'onFormChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace: '   ',
            spaceId: 'stale-space-id',
          },
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'stale-space-id', name: 'Stale Space' }],
      };

      const state = evaluateProcessUiState(input);
      expect(state.spaceId).toBeUndefined();
      expect(state.formData.spaceId).toBeUndefined();
      expect(state.formData).not.toHaveProperty('spaceId');
    });

    it('retains inactive document type form inputs across type toggles', () => {
      // Step 1: User fills communication-project data and toggles to invoice-project
      const toggleToInvoice: ProcessUiStateInput = {
        context: {
          actionName: 'onDocumentTypeChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace: 'Project Alpha',
            SelectDocumentType: 'invoice-project',
            'contact_communication-project': 'Jane Doe',
            'date_communication-project': '260920',
          },
        },
        config: {
          defaultDocumentSpaceType: 'projects',
          defaultDocumentType: 'communication-project',
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'space-alpha-id', name: 'Project Alpha' }],
      };

      const invoiceState = evaluateProcessUiState(toggleToInvoice);
      expect(invoiceState.documentTypeKey).toBe('invoice-project');
      expect(invoiceState.formData['contact_communication-project']).toBe('Jane Doe');
      expect(invoiceState.formData['date_communication-project']).toBe('260920');

      // Step 2: User fills invoice-project data and toggles back to communication-project
      const toggleBackToComm: ProcessUiStateInput = {
        context: {
          actionName: 'onDocumentTypeChange',
          formData: {
            ...invoiceState.formData,
            SelectDocumentType: 'communication-project',
            'invoiceNumber_invoice-project': 'INV-1001',
          },
        },
        config: {
          defaultDocumentSpaceType: 'projects',
          defaultDocumentType: 'communication-project',
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [{ id: 'space-alpha-id', name: 'Project Alpha' }],
      };

      const commState = evaluateProcessUiState(toggleBackToComm);
      expect(commState.documentTypeKey).toBe('communication-project');
      expect(commState.formData['contact_communication-project']).toBe('Jane Doe');
      expect(commState.formData['date_communication-project']).toBe('260920');
      expect(commState.formData['invoiceNumber_invoice-project']).toBe('INV-1001');
    });

    it('translates human-readable names in formData to backend keys', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentType: 'Communication Project',
          },
        },
        resolvedDocumentTypeKey: 'communication-project',
        config: {
          defaultDocumentSpaceType: 'projects',
        },
        spaceTypes: sampleSpaceTypes,
        spaces: [],
      };

      const state = evaluateProcessUiState(input);

      expect(state.documentTypeKey).toBe('communication-project');
      expect(state.formData.SelectDocumentType).toBe('communication-project');
    });

    describe('fallback behaviors when domain state is invalid or missing', () => {
      it('falls back to the first allowed type of the active space when an invalid SelectDocumentType string is passed in formData', () => {
        const input: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'projects',
              SelectDocumentType: 'completely-invalid-type',
            },
          },
          config: {
            defaultDocumentSpaceType: 'projects',
          },
          spaceTypes: sampleSpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);

        // Must resolve to first allowed type of 'projects'
        expect(state.documentTypeKey).toBe('communication-project');
        expect(state.formData.SelectDocumentType).toBe('communication-project');
        expect(state.selectionState.documentTypes).toHaveLength(2);
        expect(state.selectionState.documentTypes[0]).toEqual({
          text: 'communication-project',
          value: 'communication-project',
          selected: true,
        });
        expect(state.selectionState.documentTypes[1]).toEqual({
          text: 'invoice-project',
          value: 'invoice-project',
          selected: false,
        });
      });

      it('falls back to the first allowed type when SelectDocumentType is valid for another space but not the active space', () => {
        // 'communication-project' is valid in 'projects', but NOT in 'proposals' (which only allows 'communication-proposal')
        const input: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'proposals',
              SelectDocumentType: 'communication-project',
            },
          },
          spaceTypes: sampleSpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);

        expect(state.documentTypeKey).toBe('communication-proposal');
        expect(state.formData.SelectDocumentType).toBe('communication-proposal');
        expect(state.selectionState.documentTypes).toHaveLength(1);
        expect(state.selectionState.documentTypes[0]).toEqual({
          text: 'communication-proposal',
          value: 'communication-proposal',
          selected: true,
        });
      });

      it('falls back to the first allowed type when an invalid document type is passed in suffixed SelectDocumentType_<spaceType>', () => {
        const input: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'projects',
              SelectDocumentType_projects: 'nonexistent-doc-type',
            },
          },
          spaceTypes: sampleSpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);

        expect(state.documentTypeKey).toBe('communication-project');
        expect(state.formData.SelectDocumentType).toBe('communication-project');
        expect(state.selectionState.documentTypes[0].selected).toBe(true);
      });

      it('falls back to the first allowed type when an invalid document type is passed in parameters.documentTypeKey', () => {
        const input: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'projects',
            },
            parameters: {
              documentTypeKey: 'invalid-from-param',
            },
          },
          spaceTypes: sampleSpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);

        expect(state.documentTypeKey).toBe('communication-project');
        expect(state.formData.SelectDocumentType).toBe('communication-project');
      });

      it('falls back to the first allowed type when resolvedDocumentTypeKey is invalid for the active space', () => {
        const input: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'projects',
            },
          },
          resolvedDocumentTypeKey: 'invalid-resolved-key',
          spaceTypes: sampleSpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);

        expect(state.documentTypeKey).toBe('communication-project');
        expect(state.formData.SelectDocumentType).toBe('communication-project');
      });

      it('asserts exact behavior when a Space Type has no allowedDocumentTypes and no doc type is provided', () => {
        const emptySpaceTypes = [
          {
            id: 'empty-space',
            displayName: 'Empty Space',
            spaceSchema: { allowedDocumentTypes: [] },
          },
        ];

        // Case A: with config defaultDocumentType
        const inputWithConfig: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'empty-space',
            },
          },
          config: {
            defaultDocumentType: 'communication-project',
          },
          spaceTypes: emptySpaceTypes,
          spaces: [],
        };

        const stateWithConfig = evaluateProcessUiState(inputWithConfig);
        expect(stateWithConfig.selectionState.documentTypes).toEqual([]);
        expect(stateWithConfig.documentTypeKey).toBe('communication-project');
        expect(stateWithConfig.formData.SelectDocumentType).toBe('communication-project');

        // Case B: without config defaultDocumentType
        const inputWithoutConfig: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'empty-space',
            },
          },
          spaceTypes: emptySpaceTypes,
          spaces: [],
        };

        const stateWithoutConfig = evaluateProcessUiState(inputWithoutConfig);
        expect(stateWithoutConfig.selectionState.documentTypes).toEqual([]);
        expect(stateWithoutConfig.documentTypeKey).toBe('');
      });

      it('asserts exact behavior when a Space Type has no allowedDocumentTypes and a doc type is provided', () => {
        const emptySpaceTypes = [
          {
            id: 'empty-space',
            displayName: 'Empty Space',
            spaceSchema: { allowedDocumentTypes: [] },
          },
        ];

        const input: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'empty-space',
              SelectDocumentType: 'custom-type',
            },
          },
          spaceTypes: emptySpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);
        expect(state.selectionState.documentTypes).toEqual([]);
        expect(state.documentTypeKey).toBe('custom-type');
        expect(state.formData.SelectDocumentType).toBe('custom-type');
      });

      it('gracefully handles missing space type by treating allowedDocumentTypes as empty', () => {
        const input: ProcessUiStateInput = {
          context: {
            formData: {
              SelectDocumentSpaceType: 'nonexistent-space',
            },
          },
          config: {
            defaultDocumentType: 'communication-project',
          },
          spaceTypes: sampleSpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);
        expect(state.selectionState.documentTypes).toEqual([]);
        expect(state.documentTypeKey).toBe('communication-project');
      });

      it('defaults space and document type when context formData is empty or undefined', () => {
        const input: ProcessUiStateInput = {
          context: {},
          spaceTypes: sampleSpaceTypes,
          spaces: [],
        };

        const state = evaluateProcessUiState(input);
        // Default space should be 'projects'
        expect(state.documentTypeKey).toBe('communication-project');
        expect(state.formData.SelectDocumentType).toBe('communication-project');
        expect(state.selectionState.documentTypes).toHaveLength(2);
        expect(state.selectionState.documentTypes[0].selected).toBe(true);
      });

      describe('selectionState.files population', () => {
        it('populates selectionState.files from valid selectedItems with trimmed title and selected: true', () => {
          const input: ProcessUiStateInput = {
            context: {
              selectedItems: [
                { id: 'drive-1', title: '  Proposal 2026.pdf  ' },
                { id: 'drive-2', title: 'Contract.pdf' },
              ],
            },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };

          const state = evaluateProcessUiState(input);

          expect(state.selectionState.files).toEqual([
            { text: 'Proposal 2026.pdf', value: 'drive-1', selected: true },
            { text: 'Contract.pdf', value: 'drive-2', selected: true },
          ]);
        });

        it('falls back to item.id when title is undefined or whitespace-only', () => {
          const input: ProcessUiStateInput = {
            context: {
              selectedItems: [
                { id: 'file-no-title' },
                { id: 'file-whitespace-title', title: '   ' },
              ],
            },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };

          const state = evaluateProcessUiState(input);

          expect(state.selectionState.files).toEqual([
            { text: 'file-no-title', value: 'file-no-title', selected: true },
            { text: 'file-whitespace-title', value: 'file-whitespace-title', selected: true },
          ]);
        });

        it('filters out items with missing, empty, or whitespace-only ids', () => {
          const input: ProcessUiStateInput = {
            context: {
              selectedItems: [
                { id: 'valid-1', title: 'Valid 1' },
                { title: 'No Id' },
                { id: '', title: 'Empty Id' },
                { id: '   ', title: 'Whitespace Id' },
                { id: 'valid-2', title: 'Valid 2' },
              ],
            },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };

          const state = evaluateProcessUiState(input);

          expect(state.selectionState.files).toEqual([
            { text: 'Valid 1', value: 'valid-1', selected: true },
            { text: 'Valid 2', value: 'valid-2', selected: true },
          ]);
        });

        it('sets selectionState.files to an empty array when selectedItems is undefined or empty', () => {
          const inputUndefined: ProcessUiStateInput = {
            context: {},
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };
          expect(evaluateProcessUiState(inputUndefined).selectionState.files).toEqual([]);

          const inputEmpty: ProcessUiStateInput = {
            context: { selectedItems: [] },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };
          expect(evaluateProcessUiState(inputEmpty).selectionState.files).toEqual([]);
        });

        describe('two-branch precedence & stateful retention', () => {
          const sampleSelectedItems = [
            { id: 'drive-1', title: 'File 1.pdf' },
            { id: 'drive-2', title: 'File 2.pdf' },
            { id: 'drive-3', title: 'File 3.pdf' },
          ];

          it.each([
            'onSpaceTypeChange',
            'onDocumentTypeChange',
            'onFormChange',
            'processDocument',
            'viewJson',
          ])('retains partial file selection on in-card action: %s', (actionName) => {
            const input: ProcessUiStateInput = {
              context: {
                actionName,
                selectedItems: sampleSelectedItems,
                formData: {
                  SelectFiles: ['drive-2', 'drive-3'],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);

            expect(state.selectionState.files).toEqual([
              { text: 'File 1.pdf', value: 'drive-1', selected: false },
              { text: 'File 2.pdf', value: 'drive-2', selected: true },
              { text: 'File 3.pdf', value: 'drive-3', selected: true },
            ]);
          });

          it('supports scalar string in formData.SelectFiles during in-card actions', () => {
            const input: ProcessUiStateInput = {
              context: {
                actionName: 'onFormChange',
                selectedItems: sampleSelectedItems,
                formData: {
                  SelectFiles: 'drive-1',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);

            expect(state.selectionState.files).toEqual([
              { text: 'File 1.pdf', value: 'drive-1', selected: true },
              { text: 'File 2.pdf', value: 'drive-2', selected: false },
              { text: 'File 3.pdf', value: 'drive-3', selected: false },
            ]);
          });

          it('marks all files unselected when all checkboxes are unchecked during in-card actions', () => {
            const inputUndefinedSelectFiles: ProcessUiStateInput = {
              context: {
                actionName: 'onFormChange',
                selectedItems: sampleSelectedItems,
                formData: {
                  contact: 'Acme Corp',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state1 = evaluateProcessUiState(inputUndefinedSelectFiles);
            expect(state1.selectionState.files).toEqual([
              { text: 'File 1.pdf', value: 'drive-1', selected: false },
              { text: 'File 2.pdf', value: 'drive-2', selected: false },
              { text: 'File 3.pdf', value: 'drive-3', selected: false },
            ]);

            const inputEmptySelectFiles: ProcessUiStateInput = {
              context: {
                actionName: 'onSpaceTypeChange',
                selectedItems: sampleSelectedItems,
                formData: {
                  SelectFiles: [],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state2 = evaluateProcessUiState(inputEmptySelectFiles);
            expect(state2.selectionState.files).toEqual([
              { text: 'File 1.pdf', value: 'drive-1', selected: false },
              { text: 'File 2.pdf', value: 'drive-2', selected: false },
              { text: 'File 3.pdf', value: 'drive-3', selected: false },
            ]);
          });

          it('applies in-card stateful retention branch whenever formData contains SelectFiles or SelectDocument* keys even without explicit in-card action', () => {
            const inputWithSelectFiles: ProcessUiStateInput = {
              context: {
                selectedItems: sampleSelectedItems,
                formData: {
                  SelectFiles: ['drive-1'],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state1 = evaluateProcessUiState(inputWithSelectFiles);
            expect(state1.selectionState.files).toEqual([
              { text: 'File 1.pdf', value: 'drive-1', selected: true },
              { text: 'File 2.pdf', value: 'drive-2', selected: false },
              { text: 'File 3.pdf', value: 'drive-3', selected: false },
            ]);

            const inputWithSelectDocKey: ProcessUiStateInput = {
              context: {
                selectedItems: sampleSelectedItems,
                formData: {
                  SelectDocumentType: 'communication-project',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state2 = evaluateProcessUiState(inputWithSelectDocKey);
            expect(state2.selectionState.files).toEqual([
              { text: 'File 1.pdf', value: 'drive-1', selected: false },
              { text: 'File 2.pdf', value: 'drive-2', selected: false },
              { text: 'File 3.pdf', value: 'drive-3', selected: false },
            ]);
          });

          it('resets all files to selected: true on refresh action and maintains isUpdateCard false', () => {
            const input: ProcessUiStateInput = {
              context: {
                actionName: 'refresh',
                selectedItems: sampleSelectedItems,
                formData: {
                  SelectFiles: ['drive-2'],
                  SelectDocumentType: 'communication-project',
                  contact: 'Acme Corp',
                },
                isUpdateCard: true,
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);

            expect(state.selectionState.files).toEqual([
              { text: 'File 1.pdf', value: 'drive-1', selected: true },
              { text: 'File 2.pdf', value: 'drive-2', selected: true },
              { text: 'File 3.pdf', value: 'drive-3', selected: true },
            ]);
            expect(state.isUpdateCard).toBe(false);
          });

          it('does not synthetically populate effectiveFormData.SelectFiles on initial load or refresh', () => {
            const initialLoadInput: ProcessUiStateInput = {
              context: {
                selectedItems: sampleSelectedItems,
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const initialState = evaluateProcessUiState(initialLoadInput);
            expect(initialState.formData.SelectFiles).toBeUndefined();

            const refreshInput: ProcessUiStateInput = {
              context: {
                actionName: 'refresh',
                selectedItems: sampleSelectedItems,
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const refreshState = evaluateProcessUiState(refreshInput);
            expect(refreshState.formData.SelectFiles).toBeUndefined();
          });
        });
      });

      describe('hostApp and Gmail view routing', () => {
        it('routes to DRIVE_WORKSPACE_ADDON_VIEW_ID by default when hostApp is absent', () => {
          const input: ProcessUiStateInput = {
            context: {},
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };
          const state = evaluateProcessUiState(input);
          expect(state.viewId).toBe(DRIVE_WORKSPACE_ADDON_VIEW_ID);
          expect(state.viewId).toBe('drive-document-process-card');
        });

        it('routes to DRIVE_WORKSPACE_ADDON_VIEW_ID when hostApp is DRIVE', () => {
          const input: ProcessUiStateInput = {
            context: { hostApp: 'DRIVE' },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };
          const state = evaluateProcessUiState(input);
          expect(state.viewId).toBe(DRIVE_WORKSPACE_ADDON_VIEW_ID);
        });

        it('routes to GMAIL_WORKSPACE_ADDON_VIEW_ID when hostApp is GMAIL (case-insensitive)', () => {
          const upperInput: ProcessUiStateInput = {
            context: { hostApp: 'GMAIL' },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };
          expect(evaluateProcessUiState(upperInput).viewId).toBe(GMAIL_WORKSPACE_ADDON_VIEW_ID);

          const lowerInput: ProcessUiStateInput = {
            context: { hostApp: 'gmail' },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };
          expect(evaluateProcessUiState(lowerInput).viewId).toBe(GMAIL_WORKSPACE_ADDON_VIEW_ID);
          expect(evaluateProcessUiState(lowerInput).viewId).toBe('gmail-document-process-card');
        });

        it('routes to GMAIL_WORKSPACE_ADDON_VIEW_ID when context.gmail.messageId is present even without hostApp', () => {
          const input: ProcessUiStateInput = {
            context: {
              gmail: {
                messageId: 'msg-abc-123',
              },
            },
            spaceTypes: sampleSpaceTypes,
            spaces: [],
          };
          const state = evaluateProcessUiState(input);
          expect(state.viewId).toBe(GMAIL_WORKSPACE_ADDON_VIEW_ID);
        });

        describe('Gmail attachment selection & SelectAttachments state persistence (Ticket #195)', () => {
          const sampleAttachments = [
            { id: 'att-1', title: 'Invoice.pdf', mimeType: 'application/pdf' },
            { id: 'att-2', title: 'Specs.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
            { id: 'att-3', title: 'Receipt.png', mimeType: 'image/png' },
          ];

          it('resolves selectionState.files using SELECT_ATTACHMENTS_KEY', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                selectedItems: sampleAttachments,
                formData: {
                  SelectAttachments: ['att-1', 'att-3'],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: true },
              { text: 'Specs.docx', value: 'att-2', selected: false },
              { text: 'Receipt.png', value: 'att-3', selected: true },
            ]);
          });

          it('defaults all attachments to selected: true on initial load', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                selectedItems: sampleAttachments,
                formData: {},
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: true },
              { text: 'Specs.docx', value: 'att-2', selected: true },
              { text: 'Receipt.png', value: 'att-3', selected: true },
            ]);
          });

          it('defaults all attachments to selected: true on refresh action even with previous selection in formData', () => {
            const input: ProcessUiStateInput = {
              context: {
                actionName: 'refresh',
                hostApp: 'GMAIL',
                selectedItems: sampleAttachments,
                formData: {
                  SelectAttachments: ['att-2'],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: true },
              { text: 'Specs.docx', value: 'att-2', selected: true },
              { text: 'Receipt.png', value: 'att-3', selected: true },
            ]);
          });

          it('persists checked and unchecked attachments across in-card actions', () => {
            const inCardActions = ['onFormChange', 'onSpaceTypeChange', 'onDocumentTypeChange'];

            for (const action of inCardActions) {
              const input: ProcessUiStateInput = {
                context: {
                  actionName: action,
                  hostApp: 'GMAIL',
                  selectedItems: sampleAttachments,
                  formData: {
                    SelectAttachments: ['att-2'],
                  },
                },
                spaceTypes: sampleSpaceTypes,
                spaces: [],
              };

              const state = evaluateProcessUiState(input);
              expect(state.selectionState.files).toEqual([
                { text: 'Invoice.pdf', value: 'att-1', selected: false },
                { text: 'Specs.docx', value: 'att-2', selected: true },
                { text: 'Receipt.png', value: 'att-3', selected: false },
              ]);
            }
          });

          it('persists empty selection when user unchecks all attachments in SelectAttachments', () => {
            const input: ProcessUiStateInput = {
              context: {
                actionName: 'onFormChange',
                hostApp: 'GMAIL',
                selectedItems: sampleAttachments,
                formData: {
                  SelectAttachments: [],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: false },
              { text: 'Specs.docx', value: 'att-2', selected: false },
              { text: 'Receipt.png', value: 'att-3', selected: false },
            ]);
          });

          it('returns empty array when context.selectedItems is empty or undefined in Gmail context', () => {
            const stateEmpty = evaluateProcessUiState({
              context: {
                hostApp: 'GMAIL',
                selectedItems: [],
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            });
            expect(stateEmpty.selectionState.files).toEqual([]);

            const stateUndefined = evaluateProcessUiState({
              context: {
                hostApp: 'GMAIL',
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            });
            expect(stateUndefined.selectionState.files).toEqual([]);
          });

          it('ensures Drive context continues using SELECT_FILES_KEY unchanged', () => {
            const input: ProcessUiStateInput = {
              context: {
                actionName: 'onFormChange',
                hostApp: 'DRIVE',
                selectedItems: sampleAttachments,
                formData: {
                  SelectFiles: ['att-2'],
                  SelectAttachments: ['att-1', 'att-3'],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: false },
              { text: 'Specs.docx', value: 'att-2', selected: true },
              { text: 'Receipt.png', value: 'att-3', selected: false },
            ]);
          });
        });

        describe('SaveEmailToPdf toggle in Gmail context', () => {
          it('defaults SaveEmailToPdf to false on initial load (initial trigger)', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                selectedItems: [{ id: 'att-1', title: 'test.pdf' }],
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.formData[SAVE_EMAIL_TO_PDF_KEY]).toBe(false);
          });

          it('resets SaveEmailToPdf to false on refresh action even if formData had it true', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'refresh',
                formData: {
                  [SAVE_EMAIL_TO_PDF_KEY]: true,
                  SelectAttachments: ['att-1'],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.formData[SAVE_EMAIL_TO_PDF_KEY]).toBe(false);
          });

          it('retains SaveEmailToPdf state on subsequent in-card actions when true', () => {
            const inputBool: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFormChange',
                formData: {
                  [SAVE_EMAIL_TO_PDF_KEY]: true,
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };
            expect(evaluateProcessUiState(inputBool).formData[SAVE_EMAIL_TO_PDF_KEY]).toBe(true);

            const inputString: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onDocumentTypeChange',
                formData: {
                  [SAVE_EMAIL_TO_PDF_KEY]: 'true',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };
            expect(evaluateProcessUiState(inputString).formData[SAVE_EMAIL_TO_PDF_KEY]).toBe(true);

            const inputArray: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFormChange',
                formData: {
                  [SAVE_EMAIL_TO_PDF_KEY]: ['true'],
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };
            expect(evaluateProcessUiState(inputArray).formData[SAVE_EMAIL_TO_PDF_KEY]).toBe(true);
          });

          it('sets SaveEmailToPdf to false on in-card actions when absent or false in formData', () => {
            const inputAbsent: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFormChange',
                formData: {
                  otherField: 'val',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };
            expect(evaluateProcessUiState(inputAbsent).formData[SAVE_EMAIL_TO_PDF_KEY]).toBe(false);

            const inputFalse: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFormChange',
                formData: {
                  [SAVE_EMAIL_TO_PDF_KEY]: false,
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };
            expect(evaluateProcessUiState(inputFalse).formData[SAVE_EMAIL_TO_PDF_KEY]).toBe(false);
          });

          it('does not evaluate SaveEmailToPdf when not in Gmail context (e.g. Drive)', () => {
            const inputDrive: ProcessUiStateInput = {
              context: {
                hostApp: 'DRIVE',
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };
            expect(evaluateProcessUiState(inputDrive).formData[SAVE_EMAIL_TO_PDF_KEY]).toBeUndefined();
          });
        });

        describe('SelectFileSource, onFileSourceChange and stateless parameter retention', () => {
          const sampleAttachments = [
            { id: 'att-1', title: 'Invoice.pdf' },
            { id: 'att-2', title: 'Statement.pdf' },
            { id: 'att-3', title: 'Summary.pdf' },
          ];

          it('populates fileSources in Gmail context with Email Attachments selected by default', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                selectedItems: sampleAttachments,
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.fileSources).toEqual([
              { text: 'Email Attachments', value: 'Email Attachments', selected: true },
              { text: 'Google Drive URL', value: 'Google Drive URL', selected: false },
            ]);
            expect(state.formData[SELECT_FILE_SOURCE_KEY]).toBe('Email Attachments');
            expect(state.formData[INPUT_DRIVE_URL_KEY]).toBe('');
          });

          it('treats onFileSourceChange as an in-card action and sets isUpdateCard = true', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFileSourceChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Google Drive URL',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.isUpdateCard).toBe(true);
            expect(state.formData[SELECT_FILE_SOURCE_KEY]).toBe('Google Drive URL');
            expect(state.selectionState.fileSources).toEqual([
              { text: 'Email Attachments', value: 'Email Attachments', selected: false },
              { text: 'Google Drive URL', value: 'Google Drive URL', selected: true },
            ]);
          });

          it('restores Drive URL from context.parameters.previousDriveUrl when context.formData.InputDriveURL is undefined', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFileSourceChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Google Drive URL',
                },
                parameters: {
                  previousDriveUrl: 'https://drive.google.com/folder/abc',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.formData[INPUT_DRIVE_URL_KEY]).toBe('https://drive.google.com/folder/abc');
          });

          it('prefers context.formData.InputDriveURL over context.parameters.previousDriveUrl when present', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFormChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Google Drive URL',
                  [INPUT_DRIVE_URL_KEY]: ' https://drive.google.com/folder/new ',
                },
                parameters: {
                  previousDriveUrl: 'https://drive.google.com/folder/old',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.formData[INPUT_DRIVE_URL_KEY]).toBe('https://drive.google.com/folder/new');
          });

          it('restores attachment selections from context.parameters.previousAttachments when formData.SelectAttachments is undefined', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFileSourceChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Email Attachments',
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-2', 'att-3']),
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: false },
              { text: 'Statement.pdf', value: 'att-2', selected: true },
              { text: 'Summary.pdf', value: 'att-3', selected: true },
            ]);
          });

          it('prefers context.formData.SelectAttachments when defined even if parameters.previousAttachments exists', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFormChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Email Attachments',
                  [SELECT_ATTACHMENTS_KEY]: ['att-1'],
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-2']),
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: true },
              { text: 'Statement.pdf', value: 'att-2', selected: false },
              { text: 'Summary.pdf', value: 'att-3', selected: false },
            ]);
          });

          it('evaluates absent SelectAttachments key as intentional zero-selection in Email Attachments mode on in-card action even if previousAttachments exists', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onDocumentTypeChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Email Attachments',
                  // SelectAttachments is absent (user unchecked all attachments)
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-1', 'att-2']),
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: false },
              { text: 'Statement.pdf', value: 'att-2', selected: false },
              { text: 'Summary.pdf', value: 'att-3', selected: false },
            ]);
          });

          it('restores attachment selections from previousAttachments in Google Drive URL mode across intermediate in-card actions', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onSpaceTypeChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Google Drive URL',
                  // SelectAttachments is hidden in Google Drive URL mode
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-1', 'att-3']),
                  previousDriveUrl: 'https://drive.google.com/test-doc',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: true },
              { text: 'Statement.pdf', value: 'att-2', selected: false },
              { text: 'Summary.pdf', value: 'att-3', selected: true },
            ]);
            expect(state.formData[INPUT_DRIVE_URL_KEY]).toBe('https://drive.google.com/test-doc');
          });

          it('restores attachment selections when switching File Source back to Email Attachments (onFileSourceChange)', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFileSourceChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Email Attachments',
                  // SelectAttachments was absent on the Google Drive URL card
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-2']),
                  previousDriveUrl: 'https://drive.google.com/my-folder',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: false },
              { text: 'Statement.pdf', value: 'att-2', selected: true },
              { text: 'Summary.pdf', value: 'att-3', selected: false },
            ]);
            expect(state.formData[INPUT_DRIVE_URL_KEY]).toBe('https://drive.google.com/my-folder');
          });

          it('preserves InputDriveURL when switching to Email Attachments, modifying dropdowns, and switching back', () => {
            // Step 1: Switch from Google Drive URL to Email Attachments
            const step1 = evaluateProcessUiState({
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFileSourceChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Email Attachments',
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-1']),
                  previousDriveUrl: 'https://drive.google.com/preserved-url',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            });
            expect(step1.formData[INPUT_DRIVE_URL_KEY]).toBe('https://drive.google.com/preserved-url');

            // Step 2: In Email Attachments mode, modify Document Type (onDocumentTypeChange)
            const step2 = evaluateProcessUiState({
              context: {
                hostApp: 'GMAIL',
                actionName: 'onDocumentTypeChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Email Attachments',
                  [SELECT_ATTACHMENTS_KEY]: ['att-1'],
                  // InputDriveURL is hidden and absent in formData
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-1']),
                  previousDriveUrl: 'https://drive.google.com/preserved-url',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            });
            expect(step2.formData[INPUT_DRIVE_URL_KEY]).toBe('https://drive.google.com/preserved-url');

            // Step 3: Switch back to Google Drive URL
            const step3 = evaluateProcessUiState({
              context: {
                hostApp: 'GMAIL',
                actionName: 'onFileSourceChange',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Google Drive URL',
                  // InputDriveURL absent in formData
                },
                parameters: {
                  previousAttachments: JSON.stringify(['att-1']),
                  previousDriveUrl: 'https://drive.google.com/preserved-url',
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            });
            expect(step3.formData[INPUT_DRIVE_URL_KEY]).toBe('https://drive.google.com/preserved-url');
            expect(step3.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: true },
              { text: 'Statement.pdf', value: 'att-2', selected: false },
              { text: 'Summary.pdf', value: 'att-3', selected: false },
            ]);
          });

          it('resets file source to Email Attachments, clears InputDriveURL, and selects all attachments on refresh', () => {
            const input: ProcessUiStateInput = {
              context: {
                hostApp: 'GMAIL',
                actionName: 'refresh',
                selectedItems: sampleAttachments,
                formData: {
                  [SELECT_FILE_SOURCE_KEY]: 'Google Drive URL',
                  [INPUT_DRIVE_URL_KEY]: 'https://drive.google.com/old',
                  [SELECT_ATTACHMENTS_KEY]: ['att-1'],
                },
                parameters: {
                  previousDriveUrl: 'https://drive.google.com/old',
                  previousAttachments: JSON.stringify(['att-1']),
                },
              },
              spaceTypes: sampleSpaceTypes,
              spaces: [],
            };

            const state = evaluateProcessUiState(input);
            expect(state.isUpdateCard).toBe(false);
            expect(state.formData[SELECT_FILE_SOURCE_KEY]).toBe('Email Attachments');
            expect(state.formData[INPUT_DRIVE_URL_KEY]).toBe('');
            expect(state.selectionState.fileSources).toEqual([
              { text: 'Email Attachments', value: 'Email Attachments', selected: true },
              { text: 'Google Drive URL', value: 'Google Drive URL', selected: false },
            ]);
            expect(state.selectionState.files).toEqual([
              { text: 'Invoice.pdf', value: 'att-1', selected: true },
              { text: 'Statement.pdf', value: 'att-2', selected: true },
              { text: 'Summary.pdf', value: 'att-3', selected: true },
            ]);
          });
        });
      });
    });
  });

  describe('UiProcessSpaceItemSchema and ResolveSpaceResultSchema', () => {
    it('validates space item with optional typeId and abstractStorageId in both domain and ports', () => {
      const fullItem = {
        id: 'space-1',
        name: 'Space One',
        typeId: 'projects',
        abstractStorageId: 'storage-1',
      };
      expect(Value.Check(UiProcessSpaceItemSchema, fullItem)).toBe(true);
      expect(Value.Check(PortsUiProcessSpaceItemSchema, fullItem)).toBe(true);

      const minimalItem = {
        id: 'space-2',
        name: 'Space Two',
      };
      expect(Value.Check(UiProcessSpaceItemSchema, minimalItem)).toBe(true);
      expect(Value.Check(PortsUiProcessSpaceItemSchema, minimalItem)).toBe(true);
    });

    it('validates resolve space result with notFoundError in both domain and ports', () => {
      const resultWithNotFound = {
        spaceId: undefined,
        matchedSpace: undefined,
        notFoundError: 'Document space "abc" was not found. Please select an existing space.',
      };
      expect(Value.Check(ResolveSpaceResultSchema, resultWithNotFound)).toBe(true);
      expect(Value.Check(PortsResolveSpaceResultSchema, resultWithNotFound)).toBe(true);
    });
  });
});


import { describe, it, expect } from 'vitest';
import {
  retainSelectionState,
  extractDocumentData,
  translateDocumentType,
  resolveSpaceType,
  resolveDocumentType,
  evaluateProcessUiState,
  type ProcessUiStateInput,
} from './domain';

describe('ui-process-manager domain', () => {
  describe('retainSelectionState', () => {
    it('clears all non-SelectDocument keys from formData and retains selection state', () => {
      const formData = {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'communication-project',
        contact: 'John Doe',
        date: '260920',
        direction: 'IN',
        description: 'Call with client',
        incomingNotes: 'Follow up required',
      };

      const result = retainSelectionState(formData);

      expect(result).toEqual({
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'communication-project',
      });
      expect(result).not.toHaveProperty('contact');
      expect(result).not.toHaveProperty('date');
      expect(result).not.toHaveProperty('direction');
      expect(result).not.toHaveProperty('description');
      expect(result).not.toHaveProperty('incomingNotes');
    });

    it('returns empty object when formData is undefined or empty', () => {
      expect(retainSelectionState(undefined)).toEqual({});
      expect(retainSelectionState({})).toEqual({});
    });
  });

  describe('extractDocumentData', () => {
    it('extracts only non-SelectDocument keys from formData', () => {
      const formData = {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'communication-project',
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
    });

    it('returns empty object when formData is undefined or empty', () => {
      expect(extractDocumentData(undefined)).toEqual({});
      expect(extractDocumentData({})).toEqual({});
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
      const result = resolveSpaceType(
        { SelectDocumentSpaceType: 'proposals' },
        { defaultDocumentSpaceType: 'projects' }
      );
      expect(result).toBe('proposals');
    });

    it('falls back to config defaultDocumentSpaceType when not in formData', () => {
      const result = resolveSpaceType({}, { defaultDocumentSpaceType: 'invoices' });
      expect(result).toBe('invoices');
    });

    it('falls back to projects when neither formData nor config provides it', () => {
      expect(resolveSpaceType(undefined, undefined)).toBe('projects');
      expect(resolveSpaceType({}, {})).toBe('projects');
    });
  });

  describe('resolveDocumentType', () => {
    it('returns document type from formData.SelectDocumentType when present', () => {
      const result = resolveDocumentType(
        { SelectDocumentType: 'invoice-project' },
        { defaultDocumentType: 'communication-project' }
      );
      expect(result).toBe('invoice-project');
    });

    it('returns document type from suffixed SelectDocumentType_<spaceType> matching activeSpaceType', () => {
      const result = resolveDocumentType(
        {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType_projects: 'communication-project',
          SelectDocumentType_proposals: 'communication-proposal',
        },
        undefined,
        'projects'
      );
      expect(result).toBe('communication-project');
    });

    it('resolves activeSpaceType from formData when activeSpaceType is not passed', () => {
      const result = resolveDocumentType({
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType_projects: 'communication-project',
        SelectDocumentType_proposals: 'communication-proposal',
      });
      expect(result).toBe('communication-proposal');
    });

    it('returns document type from any SelectDocumentType_ key when spaceType is not matched', () => {
      const result = resolveDocumentType({
        SelectDocumentType_custom: 'custom-doc-type',
      });
      expect(result).toBe('custom-doc-type');
    });

    it('returns document type from parameters.documentTypeKey when not in formData', () => {
      const result = resolveDocumentType(
        {},
        { defaultDocumentType: 'default-doc' },
        undefined,
        { documentTypeKey: 'param-doc-type' }
      );
      expect(result).toBe('param-doc-type');
    });

    it('falls back to config defaultDocumentType when not in formData or parameters', () => {
      const result = resolveDocumentType(
        {},
        { defaultDocumentType: 'default-doc' }
      );
      expect(result).toBe('default-doc');
    });

    it('returns undefined when neither formData, parameters, nor config provides document type', () => {
      expect(resolveDocumentType(undefined, undefined)).toBeUndefined();
      expect(resolveDocumentType({}, {})).toBeUndefined();
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

    const sampleNameMap = {
      'Communication Project': 'communication-project',
      'Invoice Project': 'invoice-project',
      'Communication Proposal': 'communication-proposal',
    };

    it('defaults document type to the first allowed type and sets isUpdateCard when Space Type changes', () => {
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
        collectionSpaces: ['Proposal A', 'Proposal B'],
        nameToKeyMap: sampleNameMap,
      };

      const state = evaluateProcessUiState(input);

      // Must trigger UI reload
      expect(state.isUpdateCard).toBe(true);
      // Must default Document Type to first allowed type in proposals
      expect(state.documentTypeKey).toBe('communication-proposal');
      expect(state.formData.SelectDocumentType).toBe('communication-proposal');
      // Must clear DocumentInfo segment because document type effectively changed
      expect(state.formData).toEqual({
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType: 'communication-proposal',
      });
    });

    it('explicitly clears DocumentInfo segment and triggers isUpdateCard when Document Type changes', () => {
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
        collectionSpaces: ['Alpha'],
        nameToKeyMap: sampleNameMap,
      };

      const state = evaluateProcessUiState(input);

      expect(state.isUpdateCard).toBe(true);
      expect(state.documentTypeKey).toBe('invoice-project');
      expect(state.formData).toEqual({
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'invoice-project',
      });
      expect(state.formData.contact).toBeUndefined();
    });

    it('translates human-readable names in formData to backend keys', () => {
      const input: ProcessUiStateInput = {
        context: {
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentType: 'Communication Project',
          },
        },
        config: {
          defaultDocumentSpaceType: 'projects',
        },
        spaceTypes: sampleSpaceTypes,
        collectionSpaces: [],
        nameToKeyMap: sampleNameMap,
      };

      const state = evaluateProcessUiState(input);

      expect(state.documentTypeKey).toBe('communication-project');
      expect(state.formData.SelectDocumentType).toBe('communication-project');
    });
  });
});

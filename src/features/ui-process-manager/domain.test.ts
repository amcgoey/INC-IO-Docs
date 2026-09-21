import { describe, it, expect } from 'vitest';
import {
  extractDocumentData,
  translateDocumentType,
  resolveSpaceType,
  resolveDocumentType,
  evaluateProcessUiState,
  type ProcessUiStateInput,
} from './domain';

describe('ui-process-manager domain', () => {

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
        collectionSpaces: ['Proposal A', 'Proposal B'],
        nameToKeyMap: sampleNameMap,
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
        contact: 'Jane',
        date: '260920',
      });
      expect(state.formData.contact).toBe('Jane');
      expect(state.formData.date).toBe('260920');
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
            contact_communication_project: 'Jane Doe',
            date_communication_project: '260920',
          },
        },
        config: {
          defaultDocumentSpaceType: 'projects',
          defaultDocumentType: 'communication-project',
        },
        spaceTypes: sampleSpaceTypes,
        collectionSpaces: ['Project Alpha'],
        nameToKeyMap: sampleNameMap,
      };

      const invoiceState = evaluateProcessUiState(toggleToInvoice);
      expect(invoiceState.documentTypeKey).toBe('invoice-project');
      expect(invoiceState.formData.contact_communication_project).toBe('Jane Doe');
      expect(invoiceState.formData.date_communication_project).toBe('260920');

      // Step 2: User fills invoice-project data and toggles back to communication-project
      const toggleBackToComm: ProcessUiStateInput = {
        context: {
          actionName: 'onDocumentTypeChange',
          formData: {
            ...invoiceState.formData,
            SelectDocumentType: 'communication-project',
            invoiceNumber_invoice_project: 'INV-1001',
          },
        },
        config: {
          defaultDocumentSpaceType: 'projects',
          defaultDocumentType: 'communication-project',
        },
        spaceTypes: sampleSpaceTypes,
        collectionSpaces: ['Project Alpha'],
        nameToKeyMap: sampleNameMap,
      };

      const commState = evaluateProcessUiState(toggleBackToComm);
      expect(commState.documentTypeKey).toBe('communication-project');
      expect(commState.formData.contact_communication_project).toBe('Jane Doe');
      expect(commState.formData.date_communication_project).toBe('260920');
      expect(commState.formData.invoiceNumber_invoice_project).toBe('INV-1001');
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

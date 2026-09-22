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
            'contact_communication-project': 'Jane Doe',
            'date_communication-project': '260920',
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
        collectionSpaces: ['Project Alpha'],
        nameToKeyMap: sampleNameMap,
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
          collectionSpaces: [],
          nameToKeyMap: sampleNameMap,
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
          collectionSpaces: [],
          nameToKeyMap: sampleNameMap,
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
          collectionSpaces: [],
          nameToKeyMap: sampleNameMap,
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
          collectionSpaces: [],
          nameToKeyMap: sampleNameMap,
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
          collectionSpaces: [],
          nameToKeyMap: sampleNameMap,
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
          collectionSpaces: [],
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
          collectionSpaces: [],
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
          collectionSpaces: [],
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
          collectionSpaces: [],
        };

        const state = evaluateProcessUiState(input);
        expect(state.selectionState.documentTypes).toEqual([]);
        expect(state.documentTypeKey).toBe('communication-project');
      });

      it('defaults space and document type when context formData is empty or undefined', () => {
        const input: ProcessUiStateInput = {
          context: {},
          spaceTypes: sampleSpaceTypes,
          collectionSpaces: [],
        };

        const state = evaluateProcessUiState(input);
        // Default space should be 'projects'
        expect(state.documentTypeKey).toBe('communication-project');
        expect(state.formData.SelectDocumentType).toBe('communication-project');
        expect(state.selectionState.documentTypes).toHaveLength(2);
        expect(state.selectionState.documentTypes[0].selected).toBe(true);
      });
    });
  });
});


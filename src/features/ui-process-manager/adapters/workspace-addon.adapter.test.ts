import { describe, it, expect, vi } from 'vitest';
import { WorkspaceAddonAdapter, normalizeFormData } from './workspace-addon.adapter';
import type {
  UiProcessSpaceProviderPort,
  UiProcessConfigProviderPort,
  UiProcessManifestPort,
  UiProcessViewGeneratorPort,
  UiProcessEventContext,
  UiProcessCardRequest,
  UiProcessFormEvaluatorPort,
} from '../ports';

describe('WorkspaceAddonAdapter in ui-process-manager', () => {
  const mockSpaceProvider: UiProcessSpaceProviderPort = {
    getAllTypes: vi.fn().mockReturnValue([
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
    ]),
    getCollection: vi.fn().mockImplementation(async (typeId: string) => {
      if (typeId === 'proposals') {
        return {
          spaces: [{ id: 'p1', name: 'Proposal Alpha' }],
        };
      }
      return {
        spaces: [{ id: 'proj1', name: 'Project Main' }],
      };
    }),
  };

  const mockConfigProvider: UiProcessConfigProviderPort = {
    getWorkspaceConfig: vi.fn().mockResolvedValue({
      defaultDocumentSpaceType: 'projects',
      defaultDocumentType: 'communication-project',
    }),
  };

  const mockManifestPort: UiProcessManifestPort = {
    resolveDocumentTypeKey: vi.fn().mockImplementation(async (nameOrKey: string) => {
      if (nameOrKey === 'Communication Project') return 'communication-project';
      return nameOrKey;
    }),
    getAllDocumentTypes: vi.fn().mockResolvedValue([
      { key: 'communication-project', name: 'Communication Project' },
      { key: 'communication-proposal', name: 'Communication Proposal' },
    ]),
    getDocumentTypeSchemas: vi.fn().mockResolvedValue({}),
  };

  const mockViewGenerator: UiProcessViewGeneratorPort = {
    generateCard: vi.fn().mockImplementation(async (request) => ({
      renderedCard: true,
      request,
    })),
  };

  it('triggers UI reload and defaults Document Type to first allowed when Space Type changes', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      actionName: 'onSpaceTypeChange',
      formData: {
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType: 'communication-project',
        contact: 'Alice',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.renderedCard).toBe(true);
    expect(result.request.isUpdateCard).toBe(true);
    expect(result.request.documentTypeKey).toBe('communication-proposal');
    expect(result.request.formData).toEqual({
      SelectDocumentSpaceType: 'proposals',
      SelectDocumentType: 'communication-proposal',
    });
  });

  it('explicitly clears DocumentInfo segment of formData when Document Type changes', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      actionName: 'onDocumentTypeChange',
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Main',
        SelectDocumentType: 'invoice-project',
        contact: 'Bob',
        date: '260920',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.renderedCard).toBe(true);
    expect(result.request.isUpdateCard).toBe(true);
    expect(result.request.documentTypeKey).toBe('invoice-project');
    expect(result.request.formData).toEqual({
      SelectDocumentSpaceType: 'projects',
      SelectDocumentSpace: 'Project Main',
      SelectDocumentType: 'invoice-project',
    });
    expect(result.request.formData?.contact).toBeUndefined();
    expect(result.request.formData?.date).toBeUndefined();
  });

  it('normalizes dynamic SelectDocumentType_ keys to standard SelectDocumentType in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType_projects: 'communication-project',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.request.documentTypeKey).toBe('communication-project');
    expect(result.request.formData?.SelectDocumentType).toBe('communication-project');
    expect(result.request.formData).not.toHaveProperty('SelectDocumentType_projects');
  });

  it('normalizes dynamic SelectDocumentSpace_<activeSpaceType> keys to standard SelectDocumentSpace in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Project Alpha',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.request.formData?.SelectDocumentSpace).toBe('Project Alpha');
    expect(result.request.formData).not.toHaveProperty('SelectDocumentSpace_projects');
  });

  it('leaves inactive SelectDocumentSpace_<inactiveSpaceType> keys untouched in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Project Alpha',
        SelectDocumentSpace_proposals: 'Proposal Beta',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.request.formData?.SelectDocumentSpace).toBe('Project Alpha');
    expect(result.request.formData).not.toHaveProperty('SelectDocumentSpace_projects');
    expect(result.request.formData?.SelectDocumentSpace_proposals).toBe('Proposal Beta');
  });

  it('normalizes dynamic <field>_<activeDocumentType> keys to standard <field> in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType_projects: 'communication-project',
        'contact_communication-project': 'Acme Corp',
        'notes_communication-project': 'Important notes',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.request.formData?.contact).toBe('Acme Corp');
    expect(result.request.formData?.notes).toBe('Important notes');
    expect(result.request.formData).not.toHaveProperty('contact_communication-project');
    expect(result.request.formData).not.toHaveProperty('notes_communication-project');
  });

  it('leaves inactive <field>_<inactiveDocumentType> keys untouched in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType_projects: 'communication-project',
        'contact_communication-project': 'Active Contact',
        'contact_invoice-project': 'Inactive Invoice Contact',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.request.formData?.contact).toBe('Active Contact');
    expect(result.request.formData).not.toHaveProperty('contact_communication-project');
    expect(result.request.formData?.['contact_invoice-project']).toBe('Inactive Invoice Contact');
  });

  describe('normalizeFormData unit tests', () => {
    it('normalizes space and active document type suffixes, leaving inactive suffixes untouched', () => {
      const raw = {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Active Space',
        SelectDocumentSpace_proposals: 'Inactive Space',
        SelectDocumentType_projects: 'communication-project',
        'contact_communication-project': 'Alice',
        'contact_proposal-doc': 'Bob',
      };

      const normalized = normalizeFormData(raw, 'projects', 'communication-project');

      expect(normalized).toEqual({
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Active Space',
        SelectDocumentSpace_proposals: 'Inactive Space',
        SelectDocumentType: 'communication-project',
        contact: 'Alice',
        'contact_proposal-doc': 'Bob',
      });
    });

    it('handles undefined formData gracefully', () => {
      expect(normalizeFormData(undefined)).toBeUndefined();
    });
  });

  it('translates human-readable names into backend keys in the write model', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'Communication Project',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(result.request.documentTypeKey).toBe('communication-project');
    expect(result.request.formData?.SelectDocumentType).toBe('communication-project');
  });

  it('resolves human-readable names using manifestPort.resolveDocumentTypeKey', async () => {
    const customManifestPort: UiProcessManifestPort = {
      resolveDocumentTypeKey: vi.fn().mockImplementation(async (nameOrKey: string) => {
        if (nameOrKey === 'Human Readable Proposal') return 'communication-proposal';
        return nameOrKey;
      }),
      getAllDocumentTypes: vi.fn().mockResolvedValue([]),
      getDocumentTypeSchemas: vi.fn().mockResolvedValue({}),
    };

    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-proposal'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({ spaces: [] }),
      },
      manifestPort: customManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'Human Readable Proposal',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(customManifestPort.resolveDocumentTypeKey).toHaveBeenCalledWith('Human Readable Proposal');
    expect(result.request.documentTypeKey).toBe('communication-proposal');
    expect(result.request.formData?.SelectDocumentType).toBe('communication-proposal');
  });

  describe('processDocument action handling', () => {
    it('executes documentRunner and returns notification on success', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({
          success: true,
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        viewGenerator: mockViewGenerator,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'communication-project',
          contact: 'Acme Corp',
          date: '260920',
        },
        userOAuthToken: 'test-oauth-token',
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        {
          type: 'communication-project',
          space: 'Project Main',
          data: {
            contact: 'Acme Corp',
            date: '260920',
          },
        },
        'onSubmit',
        {
          credentials: { oauthToken: 'test-oauth-token' },
          resources: { primaryTargetId: 'drive-item-123' },
        }
      );

      expect(response).toEqual({
        action: {
          notification: {
            text: 'Document processed successfully',
          },
        },
      });
    });

    it('executes documentRunner with space from dynamically suffixed SelectDocumentSpace_<activeSpaceType>', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({
          success: true,
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        viewGenerator: mockViewGenerator,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Suffixed',
          SelectDocumentSpace_proposals: 'Inactive Proposal Space',
          SelectDocumentType: 'communication-project',
          contact: 'Acme Corp',
        },
      };

      await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: 'Project Suffixed',
        }),
        'onSubmit',
        expect.any(Object)
      );
    });

    it('executes documentRunner with data from dynamically suffixed <field>_<activeDocumentType>', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({
          success: true,
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        viewGenerator: mockViewGenerator,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Suffixed',
          SelectDocumentType_projects: 'communication-project',
          'contact_communication-project': 'Acme Suffixed',
          'contact_invoice-project': 'Inactive Invoice Contact',
        },
      };

      await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: 'Project Suffixed',
          data: expect.objectContaining({
            contact: 'Acme Suffixed',
          }),
        }),
        'onSubmit',
        expect.any(Object)
      );
    });

    it('re-renders card with validationErrors when documentRunner reports failure', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({
          success: false,
          errors: ['Contact is required'],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        viewGenerator: mockViewGenerator,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const response = (await adapter.processUiEvent(context)) as {
        renderedCard: boolean;
        request: UiProcessCardRequest;
      };

      expect(response.renderedCard).toBe(true);
      expect(response.request.isUpdateCard).toBe(true);
      expect(response.request.validationErrors).toEqual(['Contact is required']);
    });

    it('re-renders card with error message in validationErrors when documentRunner throws', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockRejectedValue(new Error('Connection timed out')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        viewGenerator: mockViewGenerator,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const response = (await adapter.processUiEvent(context)) as {
        renderedCard: boolean;
        request: UiProcessCardRequest;
      };

      expect(response.renderedCard).toBe(true);
      expect(response.request.isUpdateCard).toBe(true);
      expect(response.request.validationErrors).toEqual(['Connection timed out']);
    });
  });

  describe('onFormChange action handling', () => {
    it('evaluates form change using formEvaluator and updates formData and hiddenFields', async () => {
      const mockFormEvaluator = {
        evaluate: vi.fn().mockResolvedValue({
          computedData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentType: 'communication-project',
            contact: 'Alice',
            computedSummary: 'Alice - Projects',
          },
          hiddenFields: ['internalNotes'],
          disabledFields: [],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        viewGenerator: mockViewGenerator,
        formEvaluator: mockFormEvaluator,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
          contact: 'Alice',
        },
      };

      const response = (await adapter.processUiEvent(context)) as {
        renderedCard: boolean;
        request: UiProcessCardRequest;
      };

      expect(mockFormEvaluator.evaluate).toHaveBeenCalledWith(
        context.formData,
        'communication-project'
      );
      expect(response.renderedCard).toBe(true);
      expect(response.request.isUpdateCard).toBe(true);
      expect(response.request.formData).toEqual({
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'communication-project',
        contact: 'Alice',
        computedSummary: 'Alice - Projects',
      });
      expect(response.request.hiddenFields).toEqual(['internalNotes']);
    });

    it('renders error card when formEvaluator throws an error on onFormChange', async () => {
      const failingFormEvaluator: UiProcessFormEvaluatorPort = {
        evaluate: vi.fn().mockRejectedValue(new Error('Rule syntax error')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        viewGenerator: mockViewGenerator,
        formEvaluator: failingFormEvaluator,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const response = (await adapter.processUiEvent(context)) as {
        renderedCard: boolean;
        request: UiProcessCardRequest;
      };

      expect(response.renderedCard).toBe(true);
      expect(response.request.isUpdateCard).toBe(true);
      expect(response.request.validationErrors).toEqual(['Rule syntax error']);
    });
  });
});


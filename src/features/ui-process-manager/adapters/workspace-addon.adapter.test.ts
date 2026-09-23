import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { WorkspaceAddonAdapter, normalizeFormData } from './workspace-addon.adapter';
import {
  UiProcessResultSchema,
  type UiProcessSpaceProviderPort,
  type UiProcessConfigProviderPort,
  type UiProcessManifestPort,
  type UiProcessEventContext,
  type UiProcessRenderResult,
  type UiProcessFormEvaluatorPort,
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

  it('triggers UI reload and defaults Document Type to first allowed when Space Type changes', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    const context: UiProcessEventContext = {
      actionName: 'onSpaceTypeChange',
      formData: {
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType: 'communication-project',
        contact: 'Alice',
      },
    };

    const result = await adapter.processUiEvent(context);

    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;
    expect(renderResult.isUpdateCard).toBe(true);
    expect(renderResult.documentTypeKey).toBe('communication-proposal');
    expect(renderResult.formData).toEqual({
      SelectDocumentSpaceType: 'proposals',
      SelectDocumentType: 'communication-proposal',
      contact: 'Alice',
    });
    expect(renderResult.formData?.contact).toBe('Alice');
  });

  it('retains DocumentInfo segment of formData when Document Type changes', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
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

    const result = await adapter.processUiEvent(context);

    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;
    expect(renderResult.isUpdateCard).toBe(true);
    expect(renderResult.documentTypeKey).toBe('invoice-project');
    expect(renderResult.formData).toEqual({
      SelectDocumentSpaceType: 'projects',
      SelectDocumentSpace: 'Project Main',
      SelectDocumentType: 'invoice-project',
      contact: 'Bob',
      date: '260920',
    });
    expect(renderResult.formData?.contact).toBe('Bob');
    expect(renderResult.formData?.date).toBe('260920');
  });

  it('retains inactive form data across document type toggles and restores entered data when switching back', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    // 1. User is on communication-project, inputs contact, then switches to invoice-project
    const switchContext1: UiProcessEventContext = {
      actionName: 'onDocumentTypeChange',
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Project Main',
        SelectDocumentType_projects: 'invoice-project',
        'contact_communication-project': 'Alice from Comm',
      },
    };

    const result1 = await adapter.processUiEvent(switchContext1);
    expect(Value.Check(UiProcessResultSchema, result1)).toBe(true);
    expect(result1.type).toBe('render');
    const renderResult1 = result1 as UiProcessRenderResult;

    expect(renderResult1.documentTypeKey).toBe('invoice-project');
    // Inactive field contact_communication-project should still be in formData
    expect(renderResult1.formData?.['contact_communication-project']).toBe('Alice from Comm');

    // 2. User fills invoice-project data, and switches back to communication-project
    const switchContext2: UiProcessEventContext = {
      actionName: 'onDocumentTypeChange',
      formData: {
        ...renderResult1.formData,
        SelectDocumentType_projects: 'communication-project',
        'invoiceNumber_invoice-project': 'INV-555',
      },
    };

    const result2 = await adapter.processUiEvent(switchContext2);
    expect(Value.Check(UiProcessResultSchema, result2)).toBe(true);
    expect(result2.type).toBe('render');
    const renderResult2 = result2 as UiProcessRenderResult;

    expect(renderResult2.documentTypeKey).toBe('communication-project');
    // Active field is normalized to contact, while inactive invoice field is preserved
    expect(renderResult2.formData?.contact).toBe('Alice from Comm');
    expect(renderResult2.formData?.['invoiceNumber_invoice-project']).toBe('INV-555');
  });

  it('normalizes dynamic SelectDocumentType_ keys to standard SelectDocumentType in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType_projects: 'communication-project',
      },
    };

    const result = await adapter.processUiEvent(context);
    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;

    expect(renderResult.documentTypeKey).toBe('communication-project');
    expect(renderResult.formData?.SelectDocumentType).toBe('communication-project');
    expect(renderResult.formData).not.toHaveProperty('SelectDocumentType_projects');
  });

  it('normalizes dynamic SelectDocumentSpace_<activeSpaceType> keys to standard SelectDocumentSpace in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Project Alpha',
      },
    };

    const result = await adapter.processUiEvent(context);
    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;

    expect(renderResult.formData?.SelectDocumentSpace).toBe('Project Alpha');
    expect(renderResult.formData).not.toHaveProperty('SelectDocumentSpace_projects');
  });

  it('leaves inactive SelectDocumentSpace_<inactiveSpaceType> keys untouched in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Project Alpha',
        SelectDocumentSpace_proposals: 'Proposal Beta',
      },
    };

    const result = await adapter.processUiEvent(context);
    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;

    expect(renderResult.formData?.SelectDocumentSpace).toBe('Project Alpha');
    expect(renderResult.formData).not.toHaveProperty('SelectDocumentSpace_projects');
    expect(renderResult.formData?.SelectDocumentSpace_proposals).toBe('Proposal Beta');
  });

  it('normalizes dynamic <field>_<activeDocumentType> keys to standard <field> in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType_projects: 'communication-project',
        'contact_communication-project': 'Acme Corp',
        'notes_communication-project': 'Important notes',
      },
    };

    const result = await adapter.processUiEvent(context);
    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;

    expect(renderResult.formData?.contact).toBe('Acme Corp');
    expect(renderResult.formData?.notes).toBe('Important notes');
    expect(renderResult.formData).not.toHaveProperty('contact_communication-project');
    expect(renderResult.formData).not.toHaveProperty('notes_communication-project');
  });

  it('leaves inactive <field>_<inactiveDocumentType> keys untouched in formData', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType_projects: 'communication-project',
        'contact_communication-project': 'Active Contact',
        'contact_invoice-project': 'Inactive Invoice Contact',
      },
    };

    const result = await adapter.processUiEvent(context);
    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;

    expect(renderResult.formData?.contact).toBe('Active Contact');
    expect(renderResult.formData).not.toHaveProperty('contact_communication-project');
    expect(renderResult.formData?.['contact_invoice-project']).toBe('Inactive Invoice Contact');
  });

  describe('normalizeFormData unit tests', () => {
    it('normalizes space and active document type suffixes, leaving inactive suffixes untouched', () => {
      const raw = {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Active Space',
        SelectDocumentSpace_proposals: 'Inactive Space',
        SelectDocumentType_projects: 'communication-project',
        SelectDocumentType_proposals: 'communication-proposal',
        'contact_communication-project': 'Alice',
        'contact_proposal-doc': 'Bob',
      };

      const normalized = normalizeFormData(
        {
          formData: raw,
          activeSpaceType: 'projects',
        },
        'communication-project'
      );

      expect(normalized).toEqual({
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Active Space',
        SelectDocumentSpace_proposals: 'Inactive Space',
        SelectDocumentType: 'communication-project',
        SelectDocumentType_proposals: 'communication-proposal',
        contact: 'Alice',
        'contact_proposal-doc': 'Bob',
      });
    });

    it('does not normalize SelectDocumentType_<space> from inactive spaces', () => {
      const raw = {
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType_projects: 'communication-project',
        SelectDocumentType_proposals: 'communication-proposal',
      };
      const normalized = normalizeFormData({ formData: raw });
      expect(normalized).toEqual({
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType: 'communication-proposal',
        SelectDocumentType_projects: 'communication-project',
      });
    });

    it('does not normalize SelectDocumentType_<space> when active space cannot be determined', () => {
      const raw = {
        SelectDocumentType_projects: 'communication-project',
      };
      const normalized = normalizeFormData({ formData: raw, activeSpaceType: '' });
      expect(normalized).toEqual({
        SelectDocumentType_projects: 'communication-project',
      });
    });

    it('handles undefined formData gracefully', () => {
      expect(normalizeFormData()).toBeUndefined();
      expect(normalizeFormData({ formData: undefined })).toBeUndefined();
    });

    it('prioritizes active selector keys over stale unsuffixed keys regardless of object key order', () => {
      // Case 1: active suffixed keys appear before stale unsuffixed keys
      const rawSuffixedFirst = {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'active-space',
        SelectDocumentType_projects: 'active-type',
        SelectDocumentSpace: 'stale-space',
        SelectDocumentType: 'stale-type',
      };
      const normalized1 = normalizeFormData({ formData: rawSuffixedFirst, activeSpaceType: 'projects' });
      expect(normalized1?.SelectDocumentSpace).toBe('active-space');
      expect(normalized1?.SelectDocumentType).toBe('active-type');

      // Case 2: stale unsuffixed keys appear before active suffixed keys
      const rawStaleFirst = {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'stale-space',
        SelectDocumentType: 'stale-type',
        SelectDocumentSpace_projects: 'active-space',
        SelectDocumentType_projects: 'active-type',
      };
      const normalized2 = normalizeFormData({ formData: rawStaleFirst, activeSpaceType: 'projects' });
      expect(normalized2?.SelectDocumentSpace).toBe('active-space');
      expect(normalized2?.SelectDocumentType).toBe('active-type');
    });
  });

  it('translates human-readable names into backend keys in the write model', async () => {
    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: mockSpaceProvider,
      configProvider: mockConfigProvider,
      manifestPort: mockManifestPort,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'Communication Project',
      },
    };

    const result = await adapter.processUiEvent(context);
    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;

    expect(renderResult.documentTypeKey).toBe('communication-project');
    expect(renderResult.formData?.SelectDocumentType).toBe('communication-project');
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
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'Human Readable Proposal',
      },
    };

    const result = await adapter.processUiEvent(context);
    expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
    expect(result.type).toBe('render');
    const renderResult = result as UiProcessRenderResult;

    expect(customManifestPort.resolveDocumentTypeKey).toHaveBeenCalledWith('Human Readable Proposal');
    expect(renderResult.documentTypeKey).toBe('communication-proposal');
    expect(renderResult.formData?.SelectDocumentType).toBe('communication-proposal');
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

      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
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
          data: {
            contact: 'Acme Suffixed',
            'contact_invoice-project': 'Inactive Invoice Contact',
          },
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
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.validationErrors).toEqual(['Contact is required']);
    });

    it('re-renders card with error message in validationErrors when documentRunner throws', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockRejectedValue(new Error('Connection timed out')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.validationErrors).toEqual(['Connection timed out']);
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

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(mockFormEvaluator.evaluate).toHaveBeenCalledWith(
        context.formData,
        'communication-project'
      );
      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.formData).toEqual({
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'communication-project',
        contact: 'Alice',
        computedSummary: 'Alice - Projects',
      });
      expect(renderResult.hiddenFields).toEqual(['internalNotes']);
    });

    it('renders error card when formEvaluator throws an error on onFormChange', async () => {
      const failingFormEvaluator: UiProcessFormEvaluatorPort = {
        evaluate: vi.fn().mockRejectedValue(new Error('Rule syntax error')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        formEvaluator: failingFormEvaluator,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.validationErrors).toEqual(['Rule syntax error']);
    });

    it('passes userOAuthToken as auth option to spaceProvider.getCollection', async () => {
      const getCollectionMock = vi.fn().mockResolvedValue({ spaces: [{ id: 's-1', name: 'Space One' }] });
      const customSpaceProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: getCollectionMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: customSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onSpaceTypeChange',
        userOAuthToken: 'test-user-oauth-token',
        formData: {
          SelectDocumentSpaceType: 'projects',
        },
      };

      await adapter.processUiEvent(context);

      expect(getCollectionMock).toHaveBeenCalledWith('projects', {
        auth: 'test-user-oauth-token',
      });
    });
  });

  describe('Space Collection Failure error display & schema adherence', () => {
    it('returns a render intent conforming to UiProcessResultSchema without requiring baseUrl', async () => {
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
      expect(result.type).toBe('render');
      expect((result as Record<string, unknown>).baseUrl).toBeUndefined();
    });

    it('catches spaceProvider.getCollection error, logs warning, and surfaces error in validationErrors for status message', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const failingSpaceProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockRejectedValue(new Error('Shared Drive permission denied')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: failingSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onSpaceTypeChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
      expect(result.type).toBe('render');
      const renderResult = result as UiProcessRenderResult;

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Could not fetch collection for space type: projects',
        expect.any(Error)
      );

      expect(renderResult.validationErrors).toEqual(
        expect.arrayContaining(['Shared Drive permission denied'])
      );

      consoleWarnSpy.mockRestore();
    });

    it('combines space collection failure error with existing validationErrors', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const failingSpaceProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockRejectedValue(new Error('Drive network failure')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: failingSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        formData: {
          SelectDocumentSpaceType: 'projects',
        },
        validationErrors: ['Pre-existing field error'],
      };

      const result = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
      expect(result.type).toBe('render');
      const renderResult = result as UiProcessRenderResult;

      expect(renderResult.validationErrors).toEqual([
        'Pre-existing field error',
        'Drive network failure',
      ]);
    });
  });
});


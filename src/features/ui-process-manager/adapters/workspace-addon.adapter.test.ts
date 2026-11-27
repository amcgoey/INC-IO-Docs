import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { WorkspaceAddonAdapter, normalizeFormData } from './workspace-addon.adapter';
import {
  DRIVE_ROUTING_FALLBACK_NOTICE,
  DRIVE_METADATA_FALLBACK_NOTICE,
} from '../domain';
import {
  UiProcessResultSchema,
  type UiProcessSpaceProviderPort,
  type UiProcessConfigProviderPort,
  type UiProcessManifestPort,
  type UiProcessEventContext,
  type UiProcessRenderResult,
  type UiProcessFormEvaluatorPort,
  type UiProcessGmailPort,
  type UiProcessGmailMessageDescriptor,
  type UiProcessSourceParserPort,
  type UiProcessSourceContext,
  type UiProcessDocumentLogPort,
  type UiProcessDocumentRunnerPort,
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
        spaces: [
          { id: 'proj1', name: 'Project Main' },
          { id: 'proj-suffixed-id', name: 'Project Suffixed' },
        ],
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
      if (nameOrKey === 'Communication Proposal') return 'communication-proposal';
      if (nameOrKey === 'Invoice Project') return 'invoice-project';
      return nameOrKey;
    }),
    getAllDocumentTypes: vi.fn().mockResolvedValue([
      { key: 'communication-project', name: 'Communication Project' },
      { key: 'communication-proposal', name: 'Communication Proposal' },
      { key: 'invoice-project', name: 'Invoice Project' },
    ]),
    getDocumentTypeSchemas: vi.fn().mockImplementation(async (key: string) => {
      if (key === 'communication-project' || key === 'communication-proposal') {
        return { allowEmptySourceFiles: true };
      }
      return {};
    }),
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

  describe('Declarative default DocumentType and DocumentSpaceType resolution (Ticket #289)', () => {
    const customSpaceTypes = [
      {
        id: 'special-projects',
        displayName: 'Special Projects',
        spaceSchema: {
          allowedDocumentTypes: ['submittal-arch', 'communication-project', 'submittal-ffe'],
          defaultDocumentType: 'communication-project',
        },
      },
      {
        id: 'special-proposals',
        displayName: 'Special Proposals',
        spaceSchema: {
          allowedDocumentTypes: ['submittal-ffe', 'communication-proposal'],
          defaultDocumentType: 'communication-proposal',
        },
      },
    ];

    it('resolves fallback DocumentType on initial card load from spaceSchema.defaultDocumentType when not at index 0', async () => {
      const customProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue(customSpaceTypes),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'sp-1', name: 'Special Project One' }],
        }),
      };

      const customConfig: UiProcessConfigProviderPort = {
        getWorkspaceConfig: vi.fn().mockResolvedValue({
          defaultDocumentSpaceType: 'special-projects',
          defaultDocumentType: 'global-fallback-type',
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: customProvider,
        configProvider: customConfig,
        manifestPort: mockManifestPort,
      });

      const result = await adapter.processUiEvent({});
      expect(result.type).toBe('render');
      const renderResult = result as UiProcessRenderResult;
      expect(renderResult.documentTypeKey).toBe('communication-project');
      expect(renderResult.formData?.SelectDocumentType).toBe('communication-project');
    });

    it('resolves fallback DocumentType on onSpaceTypeChange from target spaceSchema.defaultDocumentType when not at index 0', async () => {
      const customProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue(customSpaceTypes),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'prop-1', name: 'Proposal One' }],
        }),
      };

      const customConfig: UiProcessConfigProviderPort = {
        getWorkspaceConfig: vi.fn().mockResolvedValue({
          defaultDocumentSpaceType: 'special-projects',
          defaultDocumentType: 'global-fallback-type',
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: customProvider,
        configProvider: customConfig,
        manifestPort: mockManifestPort,
      });

      const result = await adapter.processUiEvent({
        actionName: 'onSpaceTypeChange',
        formData: {
          SelectDocumentSpaceType: 'special-proposals',
          SelectDocumentType: 'communication-project',
        },
      });

      expect(result.type).toBe('render');
      const renderResult = result as UiProcessRenderResult;
      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.documentTypeKey).toBe('communication-proposal');
      expect(renderResult.formData?.SelectDocumentType).toBe('communication-proposal');
    });

    it('resolves active DocumentSpaceType from spaceTypes[0]?.id when formData and config default are empty', async () => {
      const customProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue(customSpaceTypes),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'sp-1', name: 'Special Project One' }],
        }),
      };

      const emptyConfig: UiProcessConfigProviderPort = {
        getWorkspaceConfig: vi.fn().mockResolvedValue({}),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: customProvider,
        configProvider: emptyConfig,
        manifestPort: mockManifestPort,
      });

      const result = await adapter.processUiEvent({});
      expect(result.type).toBe('render');
      expect(customProvider.getCollection).toHaveBeenCalledWith('special-projects');
      const renderResult = result as UiProcessRenderResult;
      expect(renderResult.selectionState?.spaceTypes.find((s) => s.value === 'special-projects')?.selected).toBe(true);
      expect(renderResult.documentTypeKey).toBe('communication-project');
    });
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
          SelectFiles: 'drive-item-123',
          contact: 'Acme Corp',
          date: '260920',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        {
          type: 'communication-project',
          space: {
            id: 'proj1',
            name: 'Project Main',
            typeId: 'projects',
            abstractStorageId: 'proj1',
          },
          data: {
            contact: 'Acme Corp',
            date: '260920',
          },
          sourceFiles: [
            {
              id: 'drive-item-123',
              name: 'File.pdf',
            },
          ],
        },
        'onSubmit'
      );


      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('aborts submission and returns error update card when selectedItems is missing or empty', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn(),
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
          SelectDocumentType: 'invoice-project',
          contact: 'Acme Corp',
          date: '260920',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        type: 'render',
        isUpdateCard: true,
        validationErrors: ['Please select at least one file in Google Drive to process.'],
      });
    });

    it('aborts submission and returns error update card when selectedItems items have empty id', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn(),
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
          SelectDocumentType: 'invoice-project',
          contact: 'Acme Corp',
          date: '260920',
        },
        selectedItems: [{ id: '   ', title: 'File.pdf' }],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        type: 'render',
        isUpdateCard: true,
        validationErrors: ['Please select at least one file in Google Drive to process.'],
      });
    });

    it('aborts submission and returns error update card retaining files with selected: false when all items are unchecked in SelectFiles', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn(),
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
          SelectDocumentType: 'invoice-project',
          SelectFiles: [],
          contact: 'Acme Corp',
          date: '260920',
        },
        selectedItems: [
          { id: 'drive-file-1', title: 'File1.pdf' },
          { id: 'drive-file-2', title: 'File2.pdf' },
        ],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        type: 'render',
        isUpdateCard: true,
        validationErrors: ['Please select at least one file in Google Drive to process.'],
        selectionState: {
          files: [
            { text: 'File1.pdf', value: 'drive-file-1', selected: false },
            { text: 'File2.pdf', value: 'drive-file-2', selected: false },
          ],
        },
      });
    });

    it('allows submission with 0 source files when allowEmptySourceFiles is true and passes sourceFiles: [] to documentRunner in Drive context', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
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
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledTimes(1);
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        {
          type: 'communication-project',
          data: { contact: 'Acme Corp', date: '260920' },
          space: {
            id: 'proj1',
            name: 'Project Main',
            typeId: 'projects',
            abstractStorageId: 'proj1',
          },
          sourceFiles: [],
        },
        'onSubmit'
      );
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('allows submission with 0 source files when allowEmptySourceFiles is true in Gmail context', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-123',
          threadId: 'th-123',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'communication-project',
          contact: 'Acme Corp',
          date: '260920',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledTimes(1);
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'communication-project',
          sourceFiles: [],
        }),
        'onSubmit'
      );
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('aborts submission with Gmail-specific error message when 0 files and allowEmptySourceFiles is false or omitted in Gmail context', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-123',
          threadId: 'th-123',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'invoice-project',
          contact: 'Acme Corp',
          date: '260920',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        type: 'render',
        isUpdateCard: true,
        validationErrors: ['Please select at least one file to process or enable Save Email to PDF.'],
      });
    });

    it('in Gmail context with SelectFileSource = "Google Drive URL" and valid file URL, appends parsed file to activeSourceFiles and calls documentRunner', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const driveUrl = 'https://drive.google.com/file/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/view?usp=sharing';
      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-123',
          threadId: 'th-123',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: driveUrl,
          contact: 'Acme Corp',
          date: '260920',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledTimes(1);
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'communication-project',
          sourceFiles: [
            {
              id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
              name: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
            },
          ],
        }),
        'onSubmit'
      );
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('in Gmail context with SelectFileSource = "Google Drive URL" and valid folder URL, appends parsed folder to activeSourceFiles', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const folderUrl = 'https://drive.google.com/drive/u/1/folders/1ABC_xyz-789?usp=drive_link';
      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-123',
          threadId: 'th-123',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: folderUrl,
          contact: 'Acme Corp',
          date: '260920',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledTimes(1);
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'communication-project',
          sourceFiles: [
            {
              id: '1ABC_xyz-789',
              name: '1ABC_xyz-789',
            },
          ],
        }),
        'onSubmit'
      );
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('in Gmail context with SelectFileSource = "Google Drive URL" and invalid URL, aborts submission immediately and preserves user form inputs', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-123',
          threadId: 'th-123',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: 'https://dropbox.com/s/invalid-file',
          contact: 'Acme Corp',
          date: '260920',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        type: 'render',
        isUpdateCard: true,
        validationErrors: [
          'Invalid Google Drive URL. Please enter a valid Google Drive file or folder link.',
        ],
        formData: expect.objectContaining({
          contact: 'Acme Corp',
          date: '260920',
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: 'https://dropbox.com/s/invalid-file',
        }),
      });
    });

    it('in Gmail context with SelectFileSource = "Google Drive URL" and blank InputDriveURL, falls through to zero-file policy check', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-123',
          threadId: 'th-123',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'invoice-project', // allowEmptySourceFiles is false
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: '   ',
          contact: 'Acme Corp',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(response).toMatchObject({
        type: 'render',
        isUpdateCard: true,
        validationErrors: ['Please select at least one file to process or enable Save Email to PDF.'],
      });
    });

    it('filters active sourceFiles to only checked items and passes them to documentRunner preserving mimeType', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
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
          SelectFiles: ['drive-file-2', 'drive-file-3'],
          contact: 'Acme Corp',
          date: '260920',
        },
        selectedItems: [
          { id: 'drive-file-1', title: 'File1.pdf', mimeType: 'application/pdf' },
          { id: 'drive-file-2', title: 'File2.png', mimeType: 'image/png' },
          { id: 'drive-file-3', title: 'File3.txt', mimeType: 'text/plain' },
        ],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFiles: [
            { id: 'drive-file-2', name: 'File2.png', mimeType: 'image/png' },
            { id: 'drive-file-3', name: 'File3.txt', mimeType: 'text/plain' },
          ],
        }),
        'onSubmit'
      );
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('preserves empty string title and mimeType while cleanly omitting undefined in sourceFiles mapping', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
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
          SelectFiles: ['file-empty-strings', 'file-undefined-fields'],
          contact: 'Acme Corp',
          date: '260920',
        },
        selectedItems: [
          { id: 'file-empty-strings', title: '', mimeType: '' },
          { id: 'file-undefined-fields', title: undefined, mimeType: undefined },
        ],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFiles: [
            { id: 'file-empty-strings', name: '', mimeType: '' },
            { id: 'file-undefined-fields' },
          ],
        }),
        'onSubmit'
      );

      const passedCall = (mockDocumentRunner.processDocument.mock.calls as unknown[][])[0][0] as {
        sourceFiles: Array<Record<string, unknown>>;
      };
      const secondFile = passedCall.sourceFiles[1];
      expect(secondFile).toHaveProperty('id', 'file-undefined-fields');
      expect(Object.prototype.hasOwnProperty.call(secondFile, 'name')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(secondFile, 'mimeType')).toBe(false);

      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });


    it('proceeds with submission when parameters.fileId is present even without selectedItems', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
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
        parameters: { fileId: 'param-file-123' },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalled();
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
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
          SelectFiles: 'drive-item-123',
          contact: 'Acme Corp',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'proj-suffixed-id',
            name: 'Project Suffixed',
            typeId: 'projects',
            abstractStorageId: 'proj-suffixed-id',
          },
        }),
        'onSubmit'
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
          SelectFiles: 'drive-item-123',
          'contact_communication-project': 'Acme Suffixed',
          'contact_invoice-project': 'Inactive Invoice Contact',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'proj-suffixed-id',
            name: 'Project Suffixed',
            typeId: 'projects',
            abstractStorageId: 'proj-suffixed-id',
          },
          data: {
            contact: 'Acme Suffixed',
            'contact_invoice-project': 'Inactive Invoice Contact',
          },
        }),
        'onSubmit'
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
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectFiles: 'drive-item-123',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
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
          SelectDocumentSpace: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectFiles: 'drive-item-123',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.validationErrors).toEqual(['Connection timed out']);
    });

    it('resolves human-readable space display name to complete DocumentSpace entity before passing to documentRunner', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithAlpha: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'space-folder-alpha-id', name: 'Project Alpha' }],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithAlpha,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Alpha',
          SelectDocumentType_projects: 'communication-project',
          SelectFiles: 'drive-item-123',
          contact: 'Test Contact',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'space-folder-alpha-id',
            name: 'Project Alpha',
            typeId: 'projects',
            abstractStorageId: 'space-folder-alpha-id',
          },
        }),
        'onSubmit'
      );
    });

    it('passes complete DocumentSpace entity to documentRunner when submitted with space ID directly', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithAlpha: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'space-folder-alpha-id', name: 'Project Alpha' }],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithAlpha,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'space-folder-alpha-id',
          SelectDocumentType: 'communication-project',
          SelectFiles: 'drive-item-123',
          contact: 'Test Contact',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'space-folder-alpha-id',
            name: 'Project Alpha',
            typeId: 'projects',
            abstractStorageId: 'space-folder-alpha-id',
          },
        }),
        'onSubmit'
      );
    });

    it('aborts submission and returns update card with notFoundError when submitted with an unlisted space ID', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithAlpha: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'space-folder-alpha-id', name: 'Project Alpha' }],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithAlpha,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: '  unlisted-custom-folder-id  ',
          SelectDocumentType: 'communication-project',
          contact: 'Test Contact',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;
      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.spaceId).toBeUndefined();
      expect(renderResult.validationErrors).toContain(
        'Document space "unlisted-custom-folder-id" was not found. Please select an existing space.'
      );
    });

    it('aborts submission and returns update card when space input is missing or empty', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithAlpha: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'space-folder-alpha-id', name: 'Project Alpha' }],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithAlpha,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: '',
          SelectDocumentType: 'communication-project',
          SelectFiles: 'drive-item-123',
          contact: 'Test Contact',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;
      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.spaceId).toBeUndefined();
      expect(renderResult.validationErrors).toContain('Please select a Document Space.');
    });

    it('preserves collection typeId and abstractStorageId when delivering DocumentSpace to documentRunner', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithAttributes: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            {
              id: 'space-folder-alpha-id',
              name: 'Project Alpha',
              typeId: 'custom-type-id',
              abstractStorageId: 'custom-drive-storage-id',
            },
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithAttributes,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Alpha',
          SelectDocumentType: 'communication-project',
          SelectFiles: 'drive-item-123',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'space-folder-alpha-id',
            name: 'Project Alpha',
            typeId: 'custom-type-id',
            abstractStorageId: 'custom-drive-storage-id',
          },
        }),
        'onSubmit'
      );
    });

    it('aborts submission and returns update card with collision error when duplicate space names exist', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithDuplicates: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            { id: 'space-alpha-1', name: 'Project Alpha' },
            { id: 'space-alpha-2', name: 'Project Alpha' },
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithDuplicates,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Alpha',
          SelectDocumentType: 'communication-project',
          SelectFiles: 'drive-item-123',
          contact: 'Test Contact',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;
      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.spaceId).toBeUndefined();
      expect(renderResult.validationErrors).toContain(
        'Multiple spaces match "Project Alpha". Please choose or enter a unique space identifier.'
      );
    });

    it('resolves cleanly and completes submission when exact technical ID is entered for a space with colliding names', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithDuplicates: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            { id: 'space-alpha-1', name: 'Project Alpha' },
            { id: 'space-alpha-2', name: 'Project Alpha' },
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithDuplicates,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'space-alpha-1',
          SelectDocumentType: 'communication-project',
          SelectFiles: 'drive-item-123',
          contact: 'Test Contact',
        },
        selectedItems: [{ id: 'drive-item-123', title: 'File.pdf' }],
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        {
          type: 'communication-project',
          space: {
            id: 'space-alpha-1',
            name: 'Project Alpha',
            typeId: 'projects',
            abstractStorageId: 'space-alpha-1',
          },
          data: {
            contact: 'Test Contact',
          },
          sourceFiles: [
            {
              id: 'drive-item-123',
              name: 'File.pdf',
            },
          ],
        },
        'onSubmit'
      );

      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((response as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('aborts submission and returns update card with collision error on whitespace and case variations of colliding space names', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const spaceProviderWithDuplicates: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            { id: 'space-alpha-1', name: '  Project Alpha  ' },
            { id: 'space-alpha-2', name: 'PROJECT ALPHA' },
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithDuplicates,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: '   project alpha   ',
          SelectDocumentType: 'communication-project',
          contact: 'Test Contact',
        },
      };

      const response = await adapter.processUiEvent(context);

      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;
      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.spaceId).toBeUndefined();
      expect(renderResult.validationErrors).toContain(
        'Multiple spaces match "project alpha". Please choose or enter a unique space identifier.'
      );
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

    it('displays error banner in validationErrors and leaves spaceId undefined when spaces collide during onFormChange', async () => {
      const spaceProviderWithDuplicates: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            { id: 'dup-1', name: 'Project Alpha' },
            { id: 'dup-2', name: 'Project Alpha' },
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithDuplicates,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Alpha',
          SelectDocumentType_projects: 'communication-project',
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.spaceId).toBeUndefined();
      expect(renderResult.validationErrors).toContain(
        'Multiple spaces match "Project Alpha". Please choose or enter a unique space identifier.'
      );
    });

    it('resolves cleanly to technical ID and clears collision error when exact technical ID is entered for collided space on onFormChange', async () => {
      const spaceProviderWithDuplicates: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            { id: 'dup-1', name: 'Project Alpha' },
            { id: 'dup-2', name: 'Project Alpha' },
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithDuplicates,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'dup-1',
          SelectDocumentType_projects: 'communication-project',
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.spaceId).toBe('dup-1');
      expect(renderResult.formData?.SelectDocumentSpace).toBe('Project Alpha');
      expect(renderResult.validationErrors).toBeUndefined();
    });

    it('handles whitespace and case variations of colliding space names during onFormChange', async () => {
      const spaceProviderWithDuplicates: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['communication-project'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            { id: 'dup-1', name: '  Project Alpha  ' },
            { id: 'dup-2', name: 'PROJECT ALPHA' },
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: spaceProviderWithDuplicates,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: '   project alpha   ',
          SelectDocumentType_projects: 'communication-project',
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(Value.Check(UiProcessResultSchema, response)).toBe(true);
      expect(response.type).toBe('render');
      const renderResult = response as UiProcessRenderResult;

      expect(renderResult.isUpdateCard).toBe(true);
      expect(renderResult.spaceId).toBeUndefined();
      expect(renderResult.validationErrors).toContain(
        'Multiple spaces match "project alpha". Please choose or enter a unique space identifier.'
      );
    });

    it('calls spaceProvider.getCollection with selected space type on onSpaceTypeChange', async () => {
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
        formData: {
          SelectDocumentSpaceType: 'projects',
        },
      };

      await adapter.processUiEvent(context);

      expect(getCollectionMock).toHaveBeenCalledWith('projects');
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

    it('retains partial file selection in selectionState.files on in-card action and does not synthetically populate formData.SelectFiles', async () => {
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        selectedItems: [
          { id: 'drive-file-1', title: 'File 1.pdf' },
          { id: 'drive-file-2', title: 'File 2.pdf' },
        ],
        formData: {
          SelectFiles: ['drive-file-2'],
          contact: 'Test Contact',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const renderResult = result as UiProcessRenderResult;

      expect(renderResult.selectionState?.files).toEqual([
        { text: 'File 1.pdf', value: 'drive-file-1', selected: false },
        { text: 'File 2.pdf', value: 'drive-file-2', selected: true },
      ]);
    });

    it('resets selectionState.files to all selected: true and isUpdateCard: false on refresh action', async () => {
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'refresh',
        selectedItems: [
          { id: 'drive-file-1', title: 'File 1.pdf' },
          { id: 'drive-file-2', title: 'File 2.pdf' },
        ],
        formData: {
          SelectFiles: ['drive-file-2'],
          contact: 'Test Contact',
        },
        isUpdateCard: true,
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const renderResult = result as UiProcessRenderResult;

      expect(renderResult.selectionState?.files).toEqual([
        { text: 'File 1.pdf', value: 'drive-file-1', selected: true },
        { text: 'File 2.pdf', value: 'drive-file-2', selected: true },
      ]);
      expect(renderResult.isUpdateCard).toBe(false);
    });
  });

  describe('Gmail attachment discovery via UiProcessGmailPort (Ticket #195)', () => {
    it('calls gmailPort.getMessageAttachments on initial load and maps returned attachments to selectionState.files', async () => {
      const getAttachmentsMock = vi.fn().mockResolvedValue([
        { id: 'att-1', title: 'Invoice.pdf', mimeType: 'application/pdf' },
        { id: 'att-2', title: 'Specs.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ]);
      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: getAttachmentsMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-load-123',
          threadId: 'th-load-456',
          accessToken: 'token-gmail-123',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const render = result as UiProcessRenderResult;

      expect(getAttachmentsMock).toHaveBeenCalledWith('msg-load-123', 'token-gmail-123');
      expect(render.selectionState?.files).toEqual([
        { text: 'Invoice.pdf', value: 'att-1', selected: true },
        { text: 'Specs.docx', value: 'att-2', selected: true },
      ]);
    });

    it('uses userOAuthToken over gmail.accessToken when calling gmailPort', async () => {
      const getAttachmentsMock = vi.fn().mockResolvedValue([]);
      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: getAttachmentsMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        hostApp: 'GMAIL',
        userOAuthToken: 'ya29.user-oauth-token',
        gmail: {
          messageId: 'msg-token-123',
          accessToken: 'ya29.fallback-gmail-token',
        },
      };

      await adapter.processUiEvent(context);
      expect(getAttachmentsMock).toHaveBeenCalledWith('msg-token-123', 'ya29.user-oauth-token');
    });

    it('calls gmailPort.getMessageAttachments on refresh action', async () => {
      const getAttachmentsMock = vi.fn().mockResolvedValue([
        { id: 'att-ref-1', title: 'Refreshed.pdf', mimeType: 'application/pdf' },
      ]);
      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: getAttachmentsMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'refresh',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-refresh-789',
          accessToken: 'ya29.refresh-token',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const render = result as UiProcessRenderResult;

      expect(getAttachmentsMock).toHaveBeenCalledWith('msg-refresh-789', 'ya29.refresh-token');
      expect(render.selectionState?.files).toEqual([
        { text: 'Refreshed.pdf', value: 'att-ref-1', selected: true },
      ]);
    });

    it('calls gmailPort on in-card action like onFormChange when only getMessageAttachments is mocked to construct threadMessages fallback', async () => {
      const getAttachmentsMock = vi.fn().mockResolvedValue([]);
      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: getAttachmentsMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-form-change',
          accessToken: 'ya29.token',
        },
        selectedItems: [
          { id: 'att-cached', title: 'Cached.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectAttachments: ['att-cached'],
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      expect(getAttachmentsMock).toHaveBeenCalledWith('msg-form-change', 'ya29.token');
    });

    it('logs warning and continues gracefully without throwing when gmailPort fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failingGmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn().mockRejectedValue(new Error('Gmail API 500 Internal Error')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort: failingGmailPort,
      });

      const context: UiProcessEventContext = {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-error-test',
          accessToken: 'token-error',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const render = result as UiProcessRenderResult;

      expect(warnSpy).toHaveBeenCalledWith(
        'Could not fetch attachments for message: msg-error-test',
        expect.any(Error)
      );
      expect(render.selectionState?.files).toEqual([]);
      warnSpy.mockRestore();
    });

    it('calls gmailPort.getThreadMessages on initial load when threadId is present', async () => {
      const getThreadMessagesMock = vi.fn().mockResolvedValue([
        {
          id: 'msg-1',
          from: 'Alice <alice@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 +0000',
          attachments: [{ id: 'att-1', title: 'File1.pdf', mimeType: 'application/pdf' }],
        },
        {
          id: 'msg-2',
          from: 'Bob <bob@example.com>',
          date: 'Mon, 19 Oct 2026 11:00:00 +0000',
          attachments: [{ id: 'att-2', title: 'File2.pdf', mimeType: 'application/pdf' }],
        },
      ]);

      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn(),
        getThreadMessages: getThreadMessagesMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-1',
          threadId: 'th-1',
          accessToken: 'ya29.token',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const render = result as UiProcessRenderResult;

      expect(getThreadMessagesMock).toHaveBeenCalledWith('th-1', { skipCache: false });
      expect(render.selectionState?.threadMessages).toHaveLength(2);
      expect(render.selectionState?.threadMessages?.[0].value).toBe('msg-1');
      expect(render.selectionState?.threadMessages?.[0].selected).toBe(true);
      expect(render.selectionState?.files).toEqual([
        { text: 'File1.pdf', value: 'att-1', selected: true },
      ]);
    });

    it('calls gmailPort.getThreadMessages on in-card actions (onEmailMessageChange, onFormChange, onSpaceTypeChange, onDocumentTypeChange, onFileSourceChange)', async () => {
      const getThreadMessagesMock = vi.fn().mockResolvedValue([
        {
          id: 'msg-1',
          from: 'Alice <alice@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 +0000',
          attachments: [{ id: 'att-1', title: 'File1.pdf', mimeType: 'application/pdf' }],
        },
        {
          id: 'msg-2',
          from: 'Bob <bob@example.com>',
          date: 'Mon, 19 Oct 2026 11:00:00 +0000',
          attachments: [{ id: 'att-2', title: 'File2.pdf', mimeType: 'application/pdf' }],
        },
      ]);

      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn(),
        getThreadMessages: getThreadMessagesMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const inCardActions = [
        'onEmailMessageChange',
        'onFormChange',
        'onSpaceTypeChange',
        'onDocumentTypeChange',
        'onFileSourceChange',
        'copyDocumentLog',
      ] as const;

      for (const actionName of inCardActions) {
        getThreadMessagesMock.mockClear();

        const context: UiProcessEventContext = {
          actionName,
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-1',
            threadId: 'th-card-actions',
            accessToken: 'ya29.token',
          },
          selectedItems: [
            { id: 'att-1', title: 'File1.pdf', mimeType: 'application/pdf' },
          ],
          formData: {
            SelectEmailMessage: 'msg-2',
            SelectFileSource: 'Email Attachments',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const render = result as UiProcessRenderResult;

        expect(getThreadMessagesMock).toHaveBeenCalledWith('th-card-actions', { skipCache: false });
        expect(render.selectionState?.threadMessages).toHaveLength(2);
        expect(render.formData?.SelectEmailMessage).toBe('msg-2');
      }
    });

    it('falls back to gmailPort.getMessageDetails on in-card action when threadId is absent', async () => {
      const getMessageDetailsMock = vi.fn().mockResolvedValue({
        id: 'msg-single',
        from: 'Alice <alice@example.com>',
        date: 'Mon, 19 Oct 2026 10:00:00 +0000',
        attachments: [{ id: 'att-single', title: 'Single.pdf', mimeType: 'application/pdf' }],
      });

      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn(),
        getMessageDetails: getMessageDetailsMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-single',
          accessToken: 'ya29.token',
        },
        selectedItems: [
          { id: 'att-single', title: 'Single.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectFileSource: 'Email Attachments',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      expect(getMessageDetailsMock).toHaveBeenCalledWith('msg-single', { skipCache: false });
    });

    it('preserves selectionState.threadMessages on in-card actions when only getMessageAttachments is mocked on gmailPort', async () => {
      const getMessageAttachmentsMock = vi.fn().mockResolvedValue([
        { id: 'att-double-1', title: 'Double1.pdf', mimeType: 'application/pdf' },
      ]);

      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: getMessageAttachmentsMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onFormChange',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-double',
          accessToken: 'ya29.token',
        },
        selectedItems: [
          { id: 'att-double-1', title: 'Double1.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectFileSource: 'Email Attachments',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const render = result as UiProcessRenderResult;
      expect(render.selectionState?.threadMessages).toBeDefined();
      expect(render.selectionState?.threadMessages).toHaveLength(1);
      expect(render.selectionState?.threadMessages?.[0].value).toBe('msg-double');
    });

    it('handles onEmailMessageChange action returning isUpdateCard = true, updates SelectEmailMessage, selects all attachments, and updates formData[SelectAttachments]', async () => {
      const getThreadMessagesMock = vi.fn().mockResolvedValue([
        {
          id: 'msg-1',
          from: 'Alice <alice@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 +0000',
          attachments: [{ id: 'att-1', title: 'File1.pdf', mimeType: 'application/pdf' }],
        },
        {
          id: 'msg-2',
          from: 'Bob <bob@example.com>',
          date: 'Mon, 19 Oct 2026 11:00:00 +0000',
          attachments: [
            { id: 'att-2a', title: 'Doc2a.pdf', mimeType: 'application/pdf' },
            { id: 'att-2b', title: 'Doc2b.pdf', mimeType: 'application/pdf' },
          ],
        },
      ]);

      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn(),
        getThreadMessages: getThreadMessagesMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        actionName: 'onEmailMessageChange',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-1',
          threadId: 'th-switch-test',
          accessToken: 'ya29.token',
        },
        selectedItems: [
          { id: 'att-1', title: 'File1.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectEmailMessage: 'msg-2',
          SelectAttachments: ['att-1'],
          SelectFileSource: 'Email Attachments',
        },
        parameters: {
          previousMessageId: 'msg-1',
          previousAttachments: JSON.stringify(['att-1']),
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const render = result as UiProcessRenderResult;

      expect(render.isUpdateCard).toBe(true);
      expect(render.formData?.SelectEmailMessage).toBe('msg-2');
      expect(render.formData?.SelectAttachments).toEqual(['att-2a', 'att-2b']);
      expect(render.selectionState?.files).toEqual([
        { text: 'Doc2a.pdf', value: 'att-2a', selected: true },
        { text: 'Doc2b.pdf', value: 'att-2b', selected: true },
      ]);
    });

    describe('Refresh action handling with skipCache and state reset (Ticket #213)', () => {
      it('passes skipCache: true to getThreadMessages on refresh, resets SelectEmailMessage to trigger messageId, selects all its attachments, and resets SaveEmailToPdf to false', async () => {
        const getThreadMessagesMock = vi.fn().mockResolvedValue([
          {
            id: 'msg-trigger-1',
            from: 'Alice <alice@example.com>',
            date: 'Mon, 19 Oct 2026 10:00:00 +0000',
            attachments: [
              { id: 'att-trig-1', title: 'TriggerDoc1.pdf', mimeType: 'application/pdf' },
              { id: 'att-trig-2', title: 'TriggerDoc2.pdf', mimeType: 'application/pdf' },
            ],
          },
          {
            id: 'msg-other-2',
            from: 'Bob <bob@example.com>',
            date: 'Mon, 19 Oct 2026 11:00:00 +0000',
            attachments: [
              { id: 'att-other-1', title: 'OtherDoc.pdf', mimeType: 'application/pdf' },
            ],
          },
        ]);

        const gmailPort: UiProcessGmailPort = {
          getMessageAttachments: vi.fn(),
          getThreadMessages: getThreadMessagesMock,
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          gmailPort,
        });

        // User previously switched to msg-other-2, checked its attachment, and enabled SaveEmailToPdf
        const context: UiProcessEventContext = {
          actionName: 'refresh',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-trigger-1',
            threadId: 'th-refresh-test',
            accessToken: 'ya29.refresh-token',
          },
          formData: {
            SelectEmailMessage: 'msg-other-2',
            SelectAttachments: ['att-other-1'],
            SaveEmailToPdf: true,
            SelectFileSource: 'Email Attachments',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const render = result as UiProcessRenderResult;

        // Passed skipCache: true to getThreadMessages
        expect(getThreadMessagesMock).toHaveBeenCalledWith('th-refresh-test', { skipCache: true });

        // isUpdateCard is false on refresh
        expect(render.isUpdateCard).toBe(false);

        // SelectEmailMessage is reset to trigger messageId (msg-trigger-1)
        expect(render.formData?.SelectEmailMessage).toBe('msg-trigger-1');

        // SaveEmailToPdf is reset to false
        expect(render.formData?.SaveEmailToPdf).toBe(false);

        // Selection items for threadMessages show msg-trigger-1 selected
        const threadItems = render.selectionState?.threadMessages;
        expect(threadItems).toHaveLength(2);
        expect(threadItems?.find((t) => t.value === 'msg-trigger-1')?.selected).toBe(true);
        expect(threadItems?.find((t) => t.value === 'msg-other-2')?.selected).toBe(false);

        // Files are reset to msg-trigger-1's attachments, all selected: true
        expect(render.selectionState?.files).toEqual([
          { text: 'TriggerDoc1.pdf', value: 'att-trig-1', selected: true },
          { text: 'TriggerDoc2.pdf', value: 'att-trig-2', selected: true },
        ]);
      });

      it('passes skipCache: true to getMessageDetails on refresh when threadId is absent', async () => {
        const getMessageDetailsMock = vi.fn().mockResolvedValue({
          id: 'msg-single-refresh',
          from: 'Alice <alice@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 +0000',
          attachments: [
            { id: 'att-sr-1', title: 'SingleRefreshed.pdf', mimeType: 'application/pdf' },
          ],
        });

        const gmailPort: UiProcessGmailPort = {
          getMessageAttachments: vi.fn(),
          getMessageDetails: getMessageDetailsMock,
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          gmailPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'refresh',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-single-refresh',
            accessToken: 'ya29.refresh-token',
          },
          formData: {
            SaveEmailToPdf: true,
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const render = result as UiProcessRenderResult;

        expect(getMessageDetailsMock).toHaveBeenCalledWith('msg-single-refresh', { skipCache: true });
        expect(render.formData?.SaveEmailToPdf).toBe(false);
        expect(render.selectionState?.files).toEqual([
          { text: 'SingleRefreshed.pdf', value: 'att-sr-1', selected: true },
        ]);
      });
    });
  });

  describe('Gmail attachment mapping during processDocument (Ticket #200)', () => {
    it('maps checked attachments in SelectAttachments to activeSourceFiles preserving metadata from selectedItems', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-attachments-test',
        },
        selectedItems: [
          { id: 'att-1', title: 'Invoice.pdf', mimeType: 'application/pdf' },
          { id: 'att-2', title: 'Receipt.png', mimeType: 'image/png' },
        ],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectAttachments: ['att-1'],
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFiles: [
            {
              id: 'att-1',
              name: 'Invoice.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        'onSubmit'
      );
    });

    it('maps attachment selection item id and checkbox value to partId when partId is present', async () => {
      const getAttachmentsMock = vi.fn().mockResolvedValue([
        { id: 'att-1', partId: 'part-0.1', attachmentId: 'att-1', title: 'Invoice.pdf', mimeType: 'application/pdf' },
        { id: 'att-2', partId: '', attachmentId: 'att-2', title: 'Specs.docx', mimeType: 'application/pdf' },
      ]);
      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: getAttachmentsMock,
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
      });

      const context: UiProcessEventContext = {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-part-test',
          threadId: 'th-part-test',
          accessToken: 'token-part',
        },
      };

      const result = await adapter.processUiEvent(context);
      expect(result.type).toBe('render');
      const render = result as UiProcessRenderResult;

      expect(render.selectionState?.files).toEqual([
        { text: 'Invoice.pdf', value: 'part-0.1', selected: true },
        { text: 'Specs.docx', value: 'att-2', selected: true },
      ]);
    });

    it('maps checked attachments to { id } fallback when metadata is not provided', async () => {
      const mockDocumentRunner = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner: mockDocumentRunner,
      });

      const context: UiProcessEventContext = {
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-bare-test',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectAttachments: ['att-bare'],
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFiles: [
            {
              id: 'att-bare',
            },
          ],
        }),
        'onSubmit'
      );
    });

    describe('SaveEmailToPdf handling', () => {
      it('appends email-pdf-<messageId> to activeSourceFiles when SaveEmailToPdf is true with 0 attachments, satisfying zero-file policy', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const manifestPortWithEmptyPolicy: UiProcessManifestPort = {
          ...mockManifestPort,
          getDocumentTypeSchemas: vi.fn().mockResolvedValue({
            allowEmptySourceFiles: false,
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: manifestPortWithEmptyPolicy,
          documentRunner: mockDocumentRunner,
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-save-pdf-1',
          },
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            SaveEmailToPdf: true,
            SelectAttachments: [],
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceFiles: [
              {
                id: 'email-pdf-msg-save-pdf-1',
                mimeType: 'application/pdf',
              },
            ],
          }),
          'onSubmit'
        );
      });

      it('appends email-pdf-<messageId> alongside checked attachments when both are present', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          documentRunner: mockDocumentRunner,
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-both-123',
          },
          selectedItems: [
            { id: 'att-1', title: 'Invoice.pdf', mimeType: 'application/pdf' },
          ],
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            SelectFileSource: 'Email Attachments',
            SelectAttachments: ['att-1'],
            SaveEmailToPdf: 'true',
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceFiles: [
              {
                id: 'att-1',
                name: 'Invoice.pdf',
                mimeType: 'application/pdf',
              },
              {
                id: 'email-pdf-msg-both-123',
                mimeType: 'application/pdf',
              },
            ],
          }),
          'onSubmit'
        );
      });

      it('appends email-pdf-<messageId> alongside Google Drive URL item when SelectFileSource is Google Drive URL', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          documentRunner: mockDocumentRunner,
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-drive-combo',
          },
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            SelectFileSource: 'Google Drive URL',
            InputDriveURL: 'https://drive.google.com/file/d/1A2B3C4D5E6F/view',
            SaveEmailToPdf: true,
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceFiles: [
              {
                id: '1A2B3C4D5E6F',
                name: '1A2B3C4D5E6F',
              },
              {
                id: 'email-pdf-msg-drive-combo',
                mimeType: 'application/pdf',
              },
            ],
          }),
          'onSubmit'
        );
      });

      it('fails with zero-file error when SaveEmailToPdf is false and 0 attachments are checked on allowEmptySourceFiles: false', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const manifestPortWithEmptyPolicy: UiProcessManifestPort = {
          ...mockManifestPort,
          getDocumentTypeSchemas: vi.fn().mockResolvedValue({
            allowEmptySourceFiles: false,
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: manifestPortWithEmptyPolicy,
          documentRunner: mockDocumentRunner,
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-no-save',
          },
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            SaveEmailToPdf: false,
            SelectAttachments: [],
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;
        expect(renderResult.validationErrors).toContain(
          'Please select at least one file to process or enable Save Email to PDF.'
        );
        expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      });
      it('does NOT restore previousAttachments on processDocument when SelectAttachments is absent and files are unchecked in Email Attachments mode', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const manifestPortWithEmptyPolicy: UiProcessManifestPort = {
          ...mockManifestPort,
          getDocumentTypeSchemas: vi.fn().mockResolvedValue({
            allowEmptySourceFiles: false,
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: manifestPortWithEmptyPolicy,
          documentRunner: mockDocumentRunner,
        });

        // The user unchecked all attachments and clicked Process Document
        // Google Workspace omits SelectAttachments from formData completely
        // Action parameters from the card still contain previousAttachments: '["att-1"]'
        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-uncheck-all',
          },
          parameters: {
            previousAttachments: JSON.stringify(['att-1']),
          },
          selectedItems: [
            { id: 'att-1', title: 'Invoice.pdf' },
          ],
          formData: {
            SelectFileSource: 'Email Attachments',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            SaveEmailToPdf: false,
            // SelectAttachments is absent
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;
        expect(renderResult.validationErrors).toContain(
          'Please select at least one file to process or enable Save Email to PDF.'
        );
        expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
      });

      it('saves only the generated Email PDF when all attachments are unchecked and SaveEmailToPdf is true', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const manifestPortWithEmptyPolicy: UiProcessManifestPort = {
          ...mockManifestPort,
          getDocumentTypeSchemas: vi.fn().mockResolvedValue({
            allowEmptySourceFiles: false,
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: manifestPortWithEmptyPolicy,
          documentRunner: mockDocumentRunner,
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-save-only-pdf',
          },
          parameters: {
            previousAttachments: JSON.stringify(['att-1']),
          },
          selectedItems: [
            { id: 'att-1', title: 'Invoice.pdf' },
          ],
          formData: {
            SelectFileSource: 'Email Attachments',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            SaveEmailToPdf: true,
            // SelectAttachments is absent
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceFiles: [
              {
                id: 'email-pdf-msg-save-only-pdf',
                mimeType: 'application/pdf',
              },
            ],
          }),
          'onSubmit'
        );
      });

      it('creates target folder without errors when all attachments are unchecked for DocumentType with allowEmptySourceFiles: true', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const manifestPortWithAllowEmpty: UiProcessManifestPort = {
          ...mockManifestPort,
          getDocumentTypeSchemas: vi.fn().mockResolvedValue({
            allowEmptySourceFiles: true,
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: manifestPortWithAllowEmpty,
          documentRunner: mockDocumentRunner,
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-allow-empty',
          },
          parameters: {
            previousAttachments: JSON.stringify(['att-1']),
          },
          selectedItems: [
            { id: 'att-1', title: 'Invoice.pdf' },
          ],
          formData: {
            SelectFileSource: 'Email Attachments',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            SaveEmailToPdf: false,
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceFiles: [],
          }),
          'onSubmit'
        );
      });
    });

    describe('processDocument with thread message selection (Ticket #212)', () => {
      const threadMessages: UiProcessGmailMessageDescriptor[] = [
        {
          id: 'msg-email-1',
          from: 'Alice <alice@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 +0000',
          attachments: [
            {
              id: 'att-1-part',
              partId: 'att-1-part',
              attachmentId: 'att-1-id',
              title: 'Invoice.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
        {
          id: 'msg-email-2',
          from: 'Bob <bob@example.com>',
          date: 'Mon, 19 Oct 2026 11:00:00 +0000',
          attachments: [
            {
              id: 'att-2-part-a',
              partId: 'att-2-part-a',
              attachmentId: 'att-2-id-a',
              title: 'Email2A.pdf',
              mimeType: 'application/pdf',
            },
            {
              id: 'att-2-part-b',
              partId: 'att-2-part-b',
              attachmentId: 'att-2-id-b',
              title: 'Email2B.png',
              mimeType: 'image/png',
            },
          ],
        },
      ];

      const createGmailPort = (): UiProcessGmailPort => ({
        getMessageAttachments: vi.fn(),
        getThreadMessages: vi.fn().mockResolvedValue(threadMessages),
        getMessageDetails: vi.fn(),
      });

      it('passes targetMessageId to runner, constructs correct attachment SourceFiles from non-initial email, and strips SelectEmailMessage from data', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          documentRunner: mockDocumentRunner,
          gmailPort: createGmailPort(),
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-123',
          },
          formData: {
            SelectEmailMessage: 'msg-email-2',
            SelectFileSource: 'Email Attachments',
            SelectAttachments: ['att-2-part-a', 'att-2-part-b'],
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            contact: 'Acme Corp',
            SaveEmailToPdf: false,
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledTimes(1);
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          {
            type: 'communication-project',
            data: {
              contact: 'Acme Corp',
            },
            space: {
              id: 'proj1',
              name: 'Project Main',
              typeId: 'projects',
              abstractStorageId: 'proj1',
            },
            sourceFiles: [
              {
                id: 'att-2-part-a',
                name: 'Email2A.pdf',
                mimeType: 'application/pdf',
              },
              {
                id: 'att-2-part-b',
                name: 'Email2B.png',
                mimeType: 'image/png',
              },
            ],
            targetMessageId: 'msg-email-2',
          },
          'onSubmit'
        );
      });

      it('constructs id: email-pdf-${selectedMessageId} and passes targetMessageId for non-initial email with SaveEmailToPdf enabled', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const manifestPortWithAllowEmpty: UiProcessManifestPort = {
          ...mockManifestPort,
          getDocumentTypeSchemas: vi.fn().mockResolvedValue({
            allowEmptySourceFiles: true,
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: manifestPortWithAllowEmpty,
          documentRunner: mockDocumentRunner,
          gmailPort: createGmailPort(),
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-123',
          },
          formData: {
            SelectEmailMessage: 'msg-email-2',
            SelectFileSource: 'Email Attachments',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            contact: 'Acme Corp',
            SaveEmailToPdf: true,
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledTimes(1);
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          {
            type: 'communication-project',
            data: {
              contact: 'Acme Corp',
            },
            space: {
              id: 'proj1',
              name: 'Project Main',
              typeId: 'projects',
              abstractStorageId: 'proj1',
            },
            sourceFiles: [
              {
                id: 'email-pdf-msg-email-2',
                mimeType: 'application/pdf',
              },
            ],
            targetMessageId: 'msg-email-2',
          },
          'onSubmit'
        );
      });

      it('constructs both attachment SourceFiles and email-pdf-${selectedMessageId} with targetMessageId for non-initial email', async () => {
        const mockDocumentRunner = {
          processDocument: vi.fn().mockResolvedValue({ success: true }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          documentRunner: mockDocumentRunner,
          gmailPort: createGmailPort(),
        });

        const context: UiProcessEventContext = {
          actionName: 'processDocument',
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-email-1',
            threadId: 'th-multi-123',
          },
          formData: {
            SelectEmailMessage: 'msg-email-2',
            SelectFileSource: 'Email Attachments',
            SelectAttachments: ['att-2-part-a'],
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType: 'communication-project',
            contact: 'Acme Corp',
            SaveEmailToPdf: true,
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledTimes(1);
        expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
          {
            type: 'communication-project',
            data: {
              contact: 'Acme Corp',
            },
            space: {
              id: 'proj1',
              name: 'Project Main',
              typeId: 'projects',
              abstractStorageId: 'proj1',
            },
            sourceFiles: [
              {
                id: 'att-2-part-a',
                name: 'Email2A.pdf',
                mimeType: 'application/pdf',
              },
              {
                id: 'email-pdf-msg-email-2',
                mimeType: 'application/pdf',
              },
            ],
            targetMessageId: 'msg-email-2',
          },
          'onSubmit'
        );
      });
    });

    describe('SourceParser Pass 1 Integration (Ticket #290)', () => {
      const mockSpaceTypesWithProposals = [
        {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: {
            allowedDocumentTypes: ['communication-project', 'submittal-ffe', 'submittal-arch'],
            defaultDocumentType: 'communication-project',
          },
        },
        {
          id: 'proposals',
          displayName: 'Proposals',
          spaceSchema: {
            allowedDocumentTypes: ['communication-proposal'],
            defaultDocumentType: 'communication-proposal',
          },
        },
      ];

      const multiSpaceProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue(mockSpaceTypesWithProposals),
        getCollection: vi.fn().mockImplementation(async (typeId: string) => {
          if (typeId === 'proposals') {
            return {
              spaces: [
                { id: 'prop-1', name: 'Proposal Alpha', abstractStorageId: 'opp-folder-alpha' },
              ],
            };
          }
          return {
            spaces: [
              { id: 'proj-1', name: 'Project Alpha', abstractStorageId: 'drive-alpha-id' },
            ],
          };
        }),
      };

      it('invokes sourceParser.inferRouting on initial card open and populates inferred space and documentType', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn().mockResolvedValue({
            spaceTypeId: 'proposals',
            spaceIdOrName: 'opp-folder-alpha',
            documentTypeKey: 'communication-proposal',
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          sourceParser: mockSourceParser,
        });

        const context: UiProcessEventContext = {
          selectedItems: [
            { id: 'file-prop-1', title: 'Proposal.pdf', mimeType: 'application/pdf' },
          ],
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;

        expect(mockSourceParser.inferRouting).toHaveBeenCalledWith({
          items: [{ id: 'file-prop-1', name: 'Proposal.pdf', mimeType: 'application/pdf' }],
        });

        expect(renderResult.formData?.SelectDocumentSpaceType).toBe('proposals');
        expect(renderResult.formData?.SelectDocumentSpace).toBe('Proposal Alpha');
        expect(renderResult.formData?.SelectDocumentType).toBe('communication-proposal');
        expect(renderResult.validationErrors).toBeUndefined();
      });

      it('leaves space selector blank and suppresses notFoundError when inferred space is unknown', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn().mockResolvedValue({
            spaceTypeId: 'projects',
            spaceIdOrName: 'unknown-drive-id',
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          sourceParser: mockSourceParser,
        });

        const context: UiProcessEventContext = {
          selectedItems: [{ id: 'file-unknown', title: 'Doc.pdf' }],
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;

        expect(renderResult.formData?.SelectDocumentSpaceType).toBe('projects');
        expect(renderResult.formData?.SelectDocumentSpace_projects).toBeUndefined();
        expect(renderResult.validationErrors).toBeUndefined();
      });

      it('re-runs inferRouting on refresh action', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn().mockResolvedValue({
            spaceTypeId: 'projects',
            spaceIdOrName: 'drive-alpha-id',
            documentTypeKey: 'submittal-ffe',
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          sourceParser: mockSourceParser,
        });

        const context: UiProcessEventContext = {
          actionName: 'refresh',
          selectedItems: [{ id: 'file-ffe-1', title: 'Chair.pdf' }],
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;

        expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
        expect(renderResult.formData?.SelectDocumentSpaceType).toBe('projects');
        expect(renderResult.formData?.SelectDocumentSpace).toBe('Project Alpha');
        expect(renderResult.formData?.SelectDocumentType).toBe('submittal-ffe');
      });

      it('skips inferRouting on in-card interactions (onSpaceTypeChange, onDocumentTypeChange, onFormChange)', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn(),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          sourceParser: mockSourceParser,
        });

        await adapter.processUiEvent({
          actionName: 'onSpaceTypeChange',
          formData: { SelectDocumentSpaceType: 'proposals' },
        });

        await adapter.processUiEvent({
          actionName: 'onDocumentTypeChange',
          formData: { SelectDocumentType: 'submittal-arch' },
        });

        await adapter.processUiEvent({
          actionName: 'onFormChange',
          formData: { contact: 'New Contact' },
        });

        expect(mockSourceParser.inferRouting).not.toHaveBeenCalled();
      });

      it('propagates statusMessages from inferRouting and renders Manifest defaults on systemic Drive error (Ticket #291)', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn().mockResolvedValue({
            statusMessages: [
              'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.',
            ],
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          sourceParser: mockSourceParser,
        });

        const context: UiProcessEventContext = {
          selectedItems: [{ id: 'file-rate-limited', title: 'File.pdf' }],
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;

        expect(renderResult.statusMessages).toEqual([
          'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.',
        ]);
        // Clean fallback to Manifest defaults
        expect(
          renderResult.selectionState?.spaceTypes.find((s) => s.value === 'projects')?.selected
        ).toBe(true);
        expect(renderResult.documentTypeKey).toBe('communication-project');
        expect(renderResult.formData?.SelectDocumentType).toBe('communication-project');
        expect(renderResult.validationErrors).toBeUndefined();
      });

      it('forwards all multi-item selectedItems in order to sourceParser.inferRouting (Ticket #291)', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn().mockResolvedValue({
            spaceTypeId: 'projects',
            spaceIdOrName: 'drive-alpha-id',
            documentTypeKey: 'submittal-arch',
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          sourceParser: mockSourceParser,
        });

        const context: UiProcessEventContext = {
          selectedItems: [
            { id: 'file-1', title: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
            { id: 'file-2', title: 'Notes.pdf', mimeType: 'application/pdf' },
          ],
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;

        expect(mockSourceParser.inferRouting).toHaveBeenCalledWith({
          items: [
            { id: 'file-1', name: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
            { id: 'file-2', name: 'Notes.pdf', mimeType: 'application/pdf' },
          ],
        });
        expect(renderResult.formData?.SelectDocumentSpaceType).toBe('projects');
        expect(renderResult.formData?.SelectDocumentSpace).toBe('Project Alpha');
        expect(renderResult.formData?.SelectDocumentType).toBe('submittal-arch');
      });

      it('renders all selectionState.files with selected: true on Drive initial load when Pass 1 infers spaceType + space + documentType without synthetically populating formData.SelectFiles', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn().mockResolvedValue({
            spaceTypeId: 'projects',
            spaceIdOrName: 'drive-alpha-id',
            documentTypeKey: 'submittal-arch',
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          sourceParser: mockSourceParser,
        });

        const context: UiProcessEventContext = {
          selectedItems: [
            { id: 'file-1', title: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
            { id: 'file-2', title: 'Notes.pdf', mimeType: 'application/pdf' },
          ],
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;

        expect(renderResult.formData?.SelectDocumentSpaceType).toBe('projects');
        expect(renderResult.formData?.SelectDocumentSpace).toBe('Project Alpha');
        expect(renderResult.formData?.SelectDocumentType).toBe('submittal-arch');
        expect(renderResult.formData?.SelectFiles).toBeUndefined();
        expect(renderResult.selectionState?.files).toEqual([
          { text: '071200-001_Waterproofing.pdf', value: 'file-1', selected: true },
          { text: 'Notes.pdf', value: 'file-2', selected: true },
        ]);
      });

      it('renders all selectionState.files with selected: true on Gmail initial load when Pass 1 infers spaceType + space + documentType', async () => {
        const mockSourceParser: UiProcessSourceParserPort = {
          inferRouting: vi.fn().mockResolvedValue({
            spaceTypeId: 'projects',
            spaceIdOrName: 'drive-alpha-id',
            documentTypeKey: 'submittal-arch',
          }),
        };

        const mockGmailPort: UiProcessGmailPort = {
          getMessageAttachments: vi.fn(),
          getThreadMessages: vi.fn().mockResolvedValue([
            {
              id: 'msg-1',
              threadId: 'th-1',
              subject: 'Submittal 071200-001 Waterproofing',
              from: 'Bob <bob@example.com>',
              date: 'Mon, 19 Oct 2026 11:00:00 +0000',
              plainTextBody: 'Attached submittal.',
              attachments: [
                { id: 'att-1', title: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
                { id: 'att-2', title: 'CoverSheet.pdf', mimeType: 'application/pdf' },
              ],
            },
          ]),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: multiSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          gmailPort: mockGmailPort,
          sourceParser: mockSourceParser,
        });

        const context: UiProcessEventContext = {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-1',
            threadId: 'th-1',
            accessToken: 'ya29.valid-token',
          },
        };

        const response = await adapter.processUiEvent(context);
        expect(response.type).toBe('render');
        const renderResult = response as UiProcessRenderResult;

        expect(renderResult.formData?.SelectDocumentSpaceType).toBe('projects');
        expect(renderResult.formData?.SelectDocumentSpace).toBe('Project Alpha');
        expect(renderResult.formData?.SelectDocumentType).toBe('submittal-arch');
        expect(renderResult.selectionState?.files).toEqual([
          { text: '071200-001_Waterproofing.pdf', value: 'att-1', selected: true },
          { text: 'CoverSheet.pdf', value: 'att-2', selected: true },
        ]);
      });

      describe('Gmail Pass 1 routing triggers and active message resolution (Ticket #292)', () => {
        const gmailThread: UiProcessGmailMessageDescriptor[] = [
          {
            id: 'msg-plain-1',
            threadId: 'th-gmail-pass1',
            subject: 'Kickoff notes',
            from: 'Alice <alice@example.com>',
            date: 'Mon, 19 Oct 2026 10:00:00 +0000',
            plainTextBody: 'Attached are notes from kickoff.',
            attachments: [{ id: 'att-notes', title: 'Notes.pdf', mimeType: 'application/pdf' }],
          },
          {
            id: 'msg-submittal-2',
            threadId: 'th-gmail-pass1',
            subject: 'Submittal 071200-001 Waterproofing for Review',
            from: 'Bob <bob@example.com>',
            date: 'Mon, 19 Oct 2026 11:00:00 +0000',
            plainTextBody: 'Please review the waterproofing submittal.',
            attachments: [{ id: 'att-sub-arch', title: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' }],
          },
        ];

        it('invokes sourceParser.inferRouting on Gmail initial card open, resolving active message and pre-selecting inferred submittal-arch', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              spaceTypeId: 'projects',
              documentTypeKey: 'submittal-arch',
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: multiSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          // User opens thread with trigger messageId pointing to msg-submittal-2
          const context: UiProcessEventContext = {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-submittal-2',
              threadId: 'th-gmail-pass1',
              accessToken: 'ya29.valid-token',
            },
          };

          const response = await adapter.processUiEvent(context);
          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;

          expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
          expect(mockSourceParser.inferRouting).toHaveBeenCalledWith(
            expect.objectContaining({
              items: [
                { id: 'att-sub-arch', name: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
              ],
              email: expect.objectContaining({
                id: 'msg-submittal-2',
                threadId: 'th-gmail-pass1',
                subject: 'Submittal 071200-001 Waterproofing for Review',
                from: 'Bob <bob@example.com>',
                date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                plainTextBody: 'Please review the waterproofing submittal.',
                attachments: [
                  { id: 'att-sub-arch', name: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
                ],
              }),
            })
          );

          expect(renderResult.formData?.SelectDocumentSpaceType).toBe('projects');
          expect(renderResult.formData?.SelectDocumentType).toBe('submittal-arch');
          expect(renderResult.documentTypeKey).toBe('submittal-arch');
        });

        it('re-runs sourceParser.inferRouting on Gmail refresh action with skipCache: true', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              spaceTypeId: 'projects',
              documentTypeKey: 'submittal-arch',
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: multiSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const context: UiProcessEventContext = {
            actionName: 'refresh',
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-submittal-2',
              threadId: 'th-gmail-pass1',
              accessToken: 'ya29.valid-token',
            },
          };

          const response = await adapter.processUiEvent(context);
          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;

          expect(mockGmailPort.getThreadMessages).toHaveBeenCalledWith('th-gmail-pass1', { skipCache: true });
          expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
          expect(renderResult.formData?.SelectDocumentType).toBe('submittal-arch');
        });

        it('re-runs sourceParser.inferRouting on Gmail onEmailMessageChange for selected message in thread', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockImplementation(async (ctx: UiProcessSourceContext) => {
              if (ctx.email?.id === 'msg-submittal-2') {
                return {
                  spaceTypeId: 'projects',
                  documentTypeKey: 'submittal-arch',
                };
              }
              return {}; // msg-plain-1 has no submittal markers
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: multiSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          // Switching to msg-submittal-2
          const switchContext: UiProcessEventContext = {
            actionName: 'onEmailMessageChange',
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-plain-1',
              threadId: 'th-gmail-pass1',
              accessToken: 'ya29.valid-token',
            },
            formData: {
              SelectEmailMessage: 'msg-submittal-2',
              SelectDocumentSpaceType: 'projects',
              SelectDocumentType: 'communication-project',
              SelectDocumentType_projects: 'communication-project',
            },
            parameters: {
              previousMessageId: 'msg-plain-1',
            },
          };

          const response = await adapter.processUiEvent(switchContext);
          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;

          expect(mockSourceParser.inferRouting).toHaveBeenCalledWith(
            expect.objectContaining({
              items: [
                { id: 'att-sub-arch', name: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
              ],
              email: expect.objectContaining({
                id: 'msg-submittal-2',
              }),
            })
          );
          expect(renderResult.formData?.SelectDocumentType).toBe('submittal-arch');

          // Now switch back to msg-plain-1
          mockSourceParser.inferRouting = vi.fn().mockResolvedValue({});
          const switchBackContext: UiProcessEventContext = {
            actionName: 'onEmailMessageChange',
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-plain-1',
              threadId: 'th-gmail-pass1',
              accessToken: 'ya29.valid-token',
            },
            formData: {
              SelectEmailMessage: 'msg-plain-1',
              SelectDocumentSpaceType: 'projects',
              SelectDocumentType: 'submittal-arch',
              SelectDocumentType_projects: 'submittal-arch',
            },
            parameters: {
              previousMessageId: 'msg-submittal-2',
            },
          };

          const response2 = await adapter.processUiEvent(switchBackContext);
          const renderResult2 = response2 as UiProcessRenderResult;

          // Reverts back to Manifest default communication type (communication-project)
          expect(renderResult2.formData?.SelectDocumentType).toBe('communication-project');
          expect(renderResult2.documentTypeKey).toBe('communication-project');
        });

        it('skips inferRouting on in-card interactions in Gmail (onSpaceTypeChange, onDocumentTypeChange, onFormChange)', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn(),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: multiSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          await adapter.processUiEvent({
            actionName: 'onSpaceTypeChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-plain-1', threadId: 'th-gmail-pass1' },
            formData: { SelectDocumentSpaceType: 'proposals' },
          });

          await adapter.processUiEvent({
            actionName: 'onDocumentTypeChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-plain-1', threadId: 'th-gmail-pass1' },
            formData: { SelectDocumentType: 'submittal-ffe' },
          });

          await adapter.processUiEvent({
            actionName: 'onFormChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-plain-1', threadId: 'th-gmail-pass1' },
            formData: { contact: 'Acme' },
          });

          expect(mockSourceParser.inferRouting).not.toHaveBeenCalled();
        });
      });

      describe('Gmail Pass 1 DocumentSpace inference via latency-bounded candidateSpaces (Ticket #293)', () => {
        const gmailThreadWithSpaces: UiProcessGmailMessageDescriptor[] = [
          {
            id: 'msg-project-1',
            threadId: 'th-spaces-1',
            subject: 'Skyline Tower - Weekly update',
            from: 'Alice <alice@example.com>',
            date: 'Mon, 19 Oct 2026 10:00:00 +0000',
            plainTextBody: 'Status update on Skyline Tower progress.',
            attachments: [{ id: 'att-1', title: 'Schedule.pdf', mimeType: 'application/pdf' }],
          },
          {
            id: 'msg-proposal-2',
            threadId: 'th-spaces-1',
            subject: 'RFP for Proposal Alpha',
            from: 'Bob <bob@example.com>',
            date: 'Mon, 19 Oct 2026 11:00:00 +0000',
            plainTextBody: 'Please review the proposal figures.',
            attachments: [{ id: 'att-2', title: 'Proposal.pdf', mimeType: 'application/pdf' }],
          },
          {
            id: 'msg-unmatched-3',
            threadId: 'th-spaces-1',
            subject: 'General discussion',
            from: 'Carol <carol@example.com>',
            date: 'Mon, 19 Oct 2026 12:00:00 +0000',
            plainTextBody: 'No project mentioned here.',
            attachments: [],
          },
        ];

        it('hydrates candidateSpaces for active/default space type only when email has no proposal markers, with no duplicate getCollection calls', async () => {
          const getCollectionSpy = vi.fn().mockImplementation(async (typeId: string) => {
            if (typeId === 'proposals') {
              return { spaces: [{ id: 'prop-1', name: 'Proposal Alpha', abstractStorageId: 'opp-folder-alpha' }] };
            }
            return { spaces: [{ id: 'proj-1', name: 'Skyline Tower', abstractStorageId: 'drive-skyline-id' }] };
          });

          const spaceProvider: UiProcessSpaceProviderPort = {
            getAllTypes: vi.fn().mockReturnValue(mockSpaceTypesWithProposals),
            getCollection: getCollectionSpy,
          };

          let capturedContext: UiProcessSourceContext | undefined;
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockImplementation(async (ctx: UiProcessSourceContext) => {
              capturedContext = ctx;
              return {
                spaceTypeId: 'projects',
                spaceIdOrName: 'proj-1',
              };
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThreadWithSpaces),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const response = await adapter.processUiEvent({
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-project-1',
              threadId: 'th-spaces-1',
            },
          });

          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;

          // Candidate spaces contains only project spaces
          expect(capturedContext?.candidateSpaces).toEqual([
            { id: 'proj-1', name: 'Skyline Tower', typeId: 'projects' },
          ]);

          // proposals collection was NOT fetched
          expect(getCollectionSpy).toHaveBeenCalledWith('projects');
          expect(getCollectionSpy).not.toHaveBeenCalledWith('proposals');

          // Exactly 1 call to getCollection total (reused for card render)
          expect(getCollectionSpy).toHaveBeenCalledTimes(1);

          // Populates space input with matched space name
          expect(renderResult.formData?.SelectDocumentSpace).toBe('Skyline Tower');
          expect(renderResult.validationErrors).toBeUndefined();
        });

        it('queries secondary proposals collection when proposal/opportunity marker appears in email subject or body', async () => {
          const getCollectionSpy = vi.fn().mockImplementation(async (typeId: string) => {
            if (typeId === 'proposals') {
              return { spaces: [{ id: 'prop-1', name: 'Proposal Alpha', abstractStorageId: 'opp-folder-alpha' }] };
            }
            return { spaces: [{ id: 'proj-1', name: 'Skyline Tower', abstractStorageId: 'drive-skyline-id' }] };
          });

          const spaceProvider: UiProcessSpaceProviderPort = {
            getAllTypes: vi.fn().mockReturnValue(mockSpaceTypesWithProposals),
            getCollection: getCollectionSpy,
          };

          let capturedContext: UiProcessSourceContext | undefined;
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockImplementation(async (ctx: UiProcessSourceContext) => {
              capturedContext = ctx;
              return {
                spaceTypeId: 'proposals',
                spaceIdOrName: 'prop-1',
              };
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThreadWithSpaces),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const response = await adapter.processUiEvent({
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-proposal-2', // Subject contains 'RFP'
              threadId: 'th-spaces-1',
            },
          });

          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;

          // Candidate spaces contains both projects and proposals
          expect(capturedContext?.candidateSpaces).toEqual([
            { id: 'proj-1', name: 'Skyline Tower', typeId: 'projects' },
            { id: 'prop-1', name: 'Proposal Alpha', typeId: 'proposals' },
          ]);

          // Both fetched once each, no duplicate calls
          expect(getCollectionSpy).toHaveBeenCalledWith('projects');
          expect(getCollectionSpy).toHaveBeenCalledWith('proposals');
          expect(getCollectionSpy).toHaveBeenCalledTimes(2);

          // Card renders with proposals selected
          expect(renderResult.formData?.SelectDocumentSpaceType).toBe('proposals');
          expect(renderResult.formData?.SelectDocumentSpace).toBe('Proposal Alpha');
          expect(renderResult.formData?.SelectDocumentType).toBe('communication-proposal');
          expect(renderResult.validationErrors).toBeUndefined();
        });

        it('queries proposals collection when SelectDocumentSpaceType is already proposals even without email markers', async () => {
          const getCollectionSpy = vi.fn().mockImplementation(async (typeId: string) => {
            if (typeId === 'proposals') {
              return { spaces: [{ id: 'prop-1', name: 'Proposal Alpha', abstractStorageId: 'opp-folder-alpha' }] };
            }
            return { spaces: [{ id: 'proj-1', name: 'Skyline Tower', abstractStorageId: 'drive-skyline-id' }] };
          });

          const spaceProvider: UiProcessSpaceProviderPort = {
            getAllTypes: vi.fn().mockReturnValue(mockSpaceTypesWithProposals),
            getCollection: getCollectionSpy,
          };

          let capturedContext: UiProcessSourceContext | undefined;
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockImplementation(async (ctx: UiProcessSourceContext) => {
              capturedContext = ctx;
              return {
                spaceTypeId: 'proposals',
                spaceIdOrName: 'prop-1',
              };
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThreadWithSpaces),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          // Refresh on msg-unmatched-3 with proposals already in formData
          const response = await adapter.processUiEvent({
            actionName: 'refresh',
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-unmatched-3',
              threadId: 'th-spaces-1',
            },
            formData: {
              SelectDocumentSpaceType: 'proposals',
            },
          });

          expect(response.type).toBe('render');
          expect(capturedContext?.candidateSpaces).toEqual([
            { id: 'proj-1', name: 'Skyline Tower', typeId: 'projects' },
            { id: 'prop-1', name: 'Proposal Alpha', typeId: 'proposals' },
          ]);
        });

        it('leaves DocumentSpace blank without notFoundError when zero spaces match or collision occurs', async () => {
          const getCollectionSpy = vi.fn().mockImplementation(async () => ({
            spaces: [{ id: 'proj-1', name: 'Skyline Tower', abstractStorageId: 'drive-skyline-id' }],
          }));

          const spaceProvider: UiProcessSpaceProviderPort = {
            getAllTypes: vi.fn().mockReturnValue(mockSpaceTypesWithProposals),
            getCollection: getCollectionSpy,
          };

          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              // Zero spaces match or collision -> spaceIdOrName is undefined
              spaceTypeId: 'projects',
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThreadWithSpaces),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const response = await adapter.processUiEvent({
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-unmatched-3',
              threadId: 'th-spaces-1',
            },
          });

          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;

          expect(renderResult.formData?.SelectDocumentSpace_projects).toBeUndefined();
          expect(renderResult.formData?.SelectDocumentSpace).toBeUndefined();
          expect(renderResult.formData?.spaceId).toBeUndefined();
          expect(renderResult.validationErrors).toBeUndefined();
        });

        it('clears space input without notFoundError when switching to an email with no matching space on onEmailMessageChange', async () => {
          const getCollectionSpy = vi.fn().mockImplementation(async () => ({
            spaces: [{ id: 'proj-1', name: 'Skyline Tower', abstractStorageId: 'drive-skyline-id' }],
          }));

          const spaceProvider: UiProcessSpaceProviderPort = {
            getAllTypes: vi.fn().mockReturnValue(mockSpaceTypesWithProposals),
            getCollection: getCollectionSpy,
          };

          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              spaceTypeId: 'projects',
              // No spaceIdOrName on msg-unmatched-3
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThreadWithSpaces),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          // User was on msg-project-1 (Skyline Tower) and switches to msg-unmatched-3
          const response = await adapter.processUiEvent({
            actionName: 'onEmailMessageChange',
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-project-1',
              threadId: 'th-spaces-1',
            },
            formData: {
              SelectEmailMessage: 'msg-unmatched-3',
              SelectDocumentSpaceType: 'projects',
              SelectDocumentSpace_projects: 'Skyline Tower',
              SelectDocumentSpace: 'Skyline Tower',
            },
            parameters: {
              previousMessageId: 'msg-project-1',
            },
          });

          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;

          expect(renderResult.formData?.SelectDocumentSpace_projects).toBeUndefined();
          expect(renderResult.formData?.SelectDocumentSpace).toBeUndefined();
          expect(renderResult.validationErrors).toBeUndefined();
        });

        it('does not query projects collection when spaceTypes is empty and no default space type configured', async () => {
          const getCollectionSpy = vi.fn();
          const emptySpaceProvider: UiProcessSpaceProviderPort = {
            getAllTypes: vi.fn().mockReturnValue([]),
            getCollection: getCollectionSpy,
          };
          const emptyConfigProvider: UiProcessConfigProviderPort = {
            getWorkspaceConfig: vi.fn().mockResolvedValue({}),
          };

          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({}),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThreadWithSpaces),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: emptySpaceProvider,
            configProvider: emptyConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          await adapter.processUiEvent({
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-project-1',
              threadId: 'th-spaces-1',
            },
          });

          expect(getCollectionSpy).not.toHaveBeenCalledWith('projects');
          expect(getCollectionSpy).not.toHaveBeenCalled();
        });

        it('does not overfetch non-proposal secondary space types when proposal markers are present in email', async () => {
          const getCollectionSpy = vi.fn().mockImplementation(async (typeId: string) => {
            if (typeId === 'proposals') {
              return { spaces: [{ id: 'prop-1', name: 'Proposal Alpha' }] };
            }
            if (typeId === 'projects') {
              return { spaces: [{ id: 'proj-1', name: 'Skyline Tower' }] };
            }
            return { spaces: [{ id: 'fin-1', name: 'Finance Q4' }] };
          });

          const multiSpaceTypesWithFinance = [
            {
              id: 'projects',
              displayName: 'Projects',
              spaceSchema: { allowedDocumentTypes: ['communication-project', 'submittal-arch'] },
            },
            {
              id: 'finance',
              displayName: 'Finance',
              spaceSchema: { allowedDocumentTypes: ['invoice-project'] },
            },
            {
              id: 'proposals',
              displayName: 'Proposals',
              spaceSchema: { allowedDocumentTypes: ['communication-proposal'] },
            },
          ];

          const spaceProvider: UiProcessSpaceProviderPort = {
            getAllTypes: vi.fn().mockReturnValue(multiSpaceTypesWithFinance),
            getCollection: getCollectionSpy,
          };

          let capturedContext: UiProcessSourceContext | undefined;
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockImplementation(async (ctx: UiProcessSourceContext) => {
              capturedContext = ctx;
              return {
                spaceTypeId: 'proposals',
                spaceIdOrName: 'prop-1',
              };
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThreadWithSpaces),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const response = await adapter.processUiEvent({
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-proposal-2', // Contains 'RFP'
              threadId: 'th-spaces-1',
            },
          });

          expect(response.type).toBe('render');
          // Candidate spaces contains only projects and proposals, NOT finance
          expect(capturedContext?.candidateSpaces).toEqual([
            { id: 'proj-1', name: 'Skyline Tower', typeId: 'projects' },
            { id: 'prop-1', name: 'Proposal Alpha', typeId: 'proposals' },
          ]);

          expect(getCollectionSpy).toHaveBeenCalledWith('projects');
          expect(getCollectionSpy).toHaveBeenCalledWith('proposals');
          expect(getCollectionSpy).not.toHaveBeenCalledWith('finance');
        });
      });

      describe('Gmail interactive Google Drive URL routing delegation and file-source switching (Ticket #294)', () => {
        const gmailThread: UiProcessGmailMessageDescriptor[] = [
          {
            id: 'msg-drive-1',
            threadId: 'th-drive-1',
            subject: 'Review attached files for Skyline Tower',
            from: 'Alice <alice@example.com>',
            date: 'Mon, 19 Oct 2026 10:00:00 +0000',
            plainTextBody: 'Please see Google Drive link and attached details.',
            attachments: [
              { id: 'att-1', title: 'Details.pdf', mimeType: 'application/pdf' },
            ],
          },
        ];

        const testSpaceProvider: UiProcessSpaceProviderPort = {
          getAllTypes: vi.fn().mockReturnValue(mockSpaceTypesWithProposals),
          getCollection: vi.fn().mockImplementation(async (typeId: string) => {
            if (typeId === 'proposals') {
              return {
                spaces: [
                  { id: 'prop-1', name: 'Proposal Alpha', abstractStorageId: 'opp-folder-alpha' },
                ],
              };
            }
            return {
              spaces: [
                { id: 'proj-skyline', name: 'Skyline Tower', abstractStorageId: 'drive-skyline-id' },
              ],
            };
          }),
        };

        it('skips inferRouting and preserves current spaceType, space, and docType when switching SelectFileSource to Google Drive URL while InputDriveURL is blank (Criterion 2)', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn(),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: testSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const response = await adapter.processUiEvent({
            actionName: 'onFileSourceChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Google Drive URL',
              InputDriveURL: '   ',
              SelectDocumentSpaceType: 'proposals',
              SelectDocumentSpace_proposals: 'Proposal Alpha',
              SelectDocumentSpace: 'Proposal Alpha',
              SelectDocumentType_proposals: 'communication-proposal',
              SelectDocumentType: 'communication-proposal',
            },
          });

          expect(mockSourceParser.inferRouting).not.toHaveBeenCalled();
          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;
          expect(renderResult.documentTypeKey).toBe('communication-proposal');
          expect(renderResult.formData?.SelectDocumentSpaceType).toBe('proposals');
          expect(renderResult.formData?.SelectDocumentSpace).toBe('Proposal Alpha');
          expect(renderResult.spaceId).toBe('prop-1');
        });

        it('runs inferRouting on onFormChange when SelectFileSource is Google Drive URL and InputDriveURL transitions to a valid Drive URL (Criterion 3)', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              spaceTypeId: 'projects',
              spaceIdOrName: 'proj-skyline',
              documentTypeKey: 'submittal-arch',
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: testSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const driveUrl = 'https://drive.google.com/file/d/drive-file-xyz/view';
          const response = await adapter.processUiEvent({
            actionName: 'onFormChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Google Drive URL',
              InputDriveURL: driveUrl,
            },
            parameters: {
              previousDriveUrl: '',
            },
          });

          expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
          expect(mockSourceParser.inferRouting).toHaveBeenCalledWith(
            expect.objectContaining({
              items: [{ id: 'drive-file-xyz' }],
              isDriveUrl: true,
              email: expect.objectContaining({ id: 'msg-drive-1' }),
            })
          );

          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;
          expect(renderResult.formData?.SelectDocumentSpaceType).toBe('projects');
          expect(renderResult.formData?.SelectDocumentSpace).toBe('Skyline Tower');
          expect(renderResult.spaceId).toBe('proj-skyline');
          expect(renderResult.documentTypeKey).toBe('submittal-arch');
        });

        it('runs inferRouting on onFileSourceChange when switching to Google Drive URL if InputDriveURL already holds a valid Drive URL (Criterion 3)', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              spaceTypeId: 'projects',
              spaceIdOrName: 'proj-skyline',
              documentTypeKey: 'submittal-arch',
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: testSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const driveUrl = 'https://drive.google.com/file/d/drive-file-xyz/view';
          const response = await adapter.processUiEvent({
            actionName: 'onFileSourceChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Google Drive URL',
              InputDriveURL: driveUrl,
            },
            parameters: {
              previousDriveUrl: '',
            },
          });

          expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
          expect(mockSourceParser.inferRouting).toHaveBeenCalledWith(
            expect.objectContaining({
              items: [{ id: 'drive-file-xyz' }],
              isDriveUrl: true,
              email: expect.objectContaining({ id: 'msg-drive-1' }),
            })
          );

          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;
          expect(renderResult.documentTypeKey).toBe('submittal-arch');
          expect(renderResult.formData?.SelectDocumentSpace).toBe('Skyline Tower');
          expect(renderResult.spaceId).toBe('proj-skyline');
        });

        it('re-runs inferRouting against active email message on onFileSourceChange when switching SelectFileSource back to Email Attachments (Criterion 4)', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              spaceTypeId: 'projects',
              spaceIdOrName: 'proj-skyline',
              documentTypeKey: 'communication-project',
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: testSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          await adapter.processUiEvent({
            actionName: 'onFileSourceChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Email Attachments',
              SelectDocumentSpaceType: 'proposals',
            },
            parameters: {
              previousDriveUrl: 'https://drive.google.com/file/d/drive-file-xyz/view',
            },
          });

          expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
          expect(mockSourceParser.inferRouting).toHaveBeenCalledWith(
            expect.objectContaining({
              items: [
                { id: 'att-1', name: 'Details.pdf', mimeType: 'application/pdf' },
              ],
              email: expect.objectContaining({ id: 'msg-drive-1' }),
            })
          );
        });

        it('skips inferRouting on regular onFormChange edits and non-DriveURL transitions (Criterion 5)', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn(),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: testSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          // 5a: onFormChange in Email Attachments mode
          await adapter.processUiEvent({
            actionName: 'onFormChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Email Attachments',
              notes: 'Editing notes in attachment mode',
            },
          });
          expect(mockSourceParser.inferRouting).not.toHaveBeenCalled();

          // 5b: onFormChange in Google Drive URL mode when URL did not transition
          const driveUrl = 'https://drive.google.com/file/d/drive-file-xyz/view';
          await adapter.processUiEvent({
            actionName: 'onFormChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Google Drive URL',
              InputDriveURL: driveUrl,
              notes: 'Editing notes after URL was already set',
            },
            parameters: {
              previousDriveUrl: driveUrl,
            },
          });
          expect(mockSourceParser.inferRouting).not.toHaveBeenCalled();

          // 5c: onFormChange in Google Drive URL mode when URL is invalid
          await adapter.processUiEvent({
            actionName: 'onFormChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Google Drive URL',
              InputDriveURL: 'https://not-drive.com/invalid',
            },
            parameters: {
              previousDriveUrl: '',
            },
          });
          expect(mockSourceParser.inferRouting).not.toHaveBeenCalled();
        });

        it('propagates fallback statusMessages when inferRouting fails unexpectedly during Gmail Drive URL Pass 1', async () => {
          const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockRejectedValue(new Error('Network or permission error during Drive inspection')),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue(gmailThread),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: testSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const driveUrl = 'https://drive.google.com/file/d/drive-file-xyz/view';
          const response = await adapter.processUiEvent({
            actionName: 'onFormChange',
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-drive-1', threadId: 'th-drive-1' },
            formData: {
              SelectFileSource: 'Google Drive URL',
              InputDriveURL: driveUrl,
            },
            parameters: {
              previousDriveUrl: '',
            },
          });

          expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;
          expect(renderResult.statusMessages).toContain(DRIVE_ROUTING_FALLBACK_NOTICE);
          expect(consoleWarnSpy).toHaveBeenCalledWith(
            'SourceParser Pass 1 inferRouting error in Gmail:',
            expect.any(Error)
          );
          consoleWarnSpy.mockRestore();
        });

        it('executes Pass 1 Drive URL inference and populates routing when activeMsg is undefined', async () => {
          const mockSourceParser: UiProcessSourceParserPort = {
            inferRouting: vi.fn().mockResolvedValue({
              spaceTypeId: 'projects',
              spaceIdOrName: 'proj-skyline',
              documentTypeKey: 'submittal-arch',
            }),
          };

          const mockGmailPort: UiProcessGmailPort = {
            getMessageAttachments: vi.fn(),
            getThreadMessages: vi.fn().mockResolvedValue([]),
          };

          const adapter = new WorkspaceAddonAdapter({
            spaceProvider: testSpaceProvider,
            configProvider: mockConfigProvider,
            manifestPort: mockManifestPort,
            gmailPort: mockGmailPort,
            sourceParser: mockSourceParser,
          });

          const driveUrl = 'https://drive.google.com/file/d/drive-file-xyz/view';
          const response = await adapter.processUiEvent({
            actionName: 'onFormChange',
            hostApp: 'GMAIL',
            formData: {
              SelectFileSource: 'Google Drive URL',
              InputDriveURL: driveUrl,
            },
            parameters: {
              previousDriveUrl: '',
            },
          });

          expect(mockSourceParser.inferRouting).toHaveBeenCalledTimes(1);
          expect(mockSourceParser.inferRouting).toHaveBeenCalledWith(
            expect.objectContaining({
              items: [{ id: 'drive-file-xyz' }],
              isDriveUrl: true,
            })
          );
          const callArg = (mockSourceParser.inferRouting as ReturnType<typeof vi.fn>).mock.calls[0][0];
          expect(callArg.email).toBeUndefined();

          expect(response.type).toBe('render');
          const renderResult = response as UiProcessRenderResult;
          expect(renderResult.documentTypeKey).toBe('submittal-arch');
          expect(renderResult.formData?.SelectDocumentSpace).toBe('Skyline Tower');
          expect(renderResult.spaceId).toBe('proj-skyline');
        });
      });
    });
  });

  describe('Ticket #301: Card-state cleansing and universal formEvaluator reactive evaluation', () => {
    describe('Source-reset events card-state cleansing', () => {
      it('purges all prior data keys (!isSelectionKey && key !== "spaceId") on initial load', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          formData: {
            subject: 'Old Subject',
            'subject_communication-project': 'Old Suffixed Subject',
            contact: 'Old Contact',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBeUndefined();
        expect(renderResult.formData?.['subject_communication-project']).toBeUndefined();
        expect(renderResult.formData?.contact).toBeUndefined();
      });

      it('purges all prior data keys on refresh action', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'refresh',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            spaceId: 'proj1',
            subject: 'Stale Subject',
            'subject_communication-project': 'Stale Subject',
            date: '261019',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBeUndefined();
        expect(renderResult.formData?.['subject_communication-project']).toBeUndefined();
        expect(renderResult.formData?.date).toBeUndefined();
      });

      it('purges all prior data keys on onEmailMessageChange in Gmail', async () => {
        const mockGmailPort: UiProcessGmailPort = {
          getMessageAttachments: vi.fn().mockResolvedValue([]),
          getThreadMessages: vi.fn().mockResolvedValue([
            { id: 'msg-1', attachments: [] },
            { id: 'msg-2', attachments: [] },
          ]),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          gmailPort: mockGmailPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onEmailMessageChange',
          hostApp: 'GMAIL',
          gmail: { messageId: 'msg-1', threadId: 'th-1' },
          formData: {
            SelectEmailMessage: 'msg-2',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            spaceId: 'proj1',
            subject: 'Email 1 Subject',
            'subject_communication-project': 'Email 1 Subject',
            contact: 'Email 1 Contact',
          },
          parameters: {
            previousMessageId: 'msg-1',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBeUndefined();
        expect(renderResult.formData?.['subject_communication-project']).toBeUndefined();
        expect(renderResult.formData?.contact).toBeUndefined();
      });

      it('purges all prior data keys on onFileSourceChange switching back to Email Attachments', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onFileSourceChange',
          hostApp: 'GMAIL',
          formData: {
            SelectFileSource: 'Email Attachments',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            spaceId: 'proj1',
            subject: 'Drive Stale Subject',
            'subject_communication-project': 'Drive Stale Subject',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBeUndefined();
        expect(renderResult.formData?.['subject_communication-project']).toBeUndefined();
      });

      it('purges all prior data keys on onFileSourceChange when switching to Google Drive URL with valid link', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onFileSourceChange',
          hostApp: 'GMAIL',
          formData: {
            SelectFileSource: 'Google Drive URL',
            InputDriveURL: 'https://drive.google.com/file/d/drive-valid-123/view',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            spaceId: 'proj1',
            subject: 'Prior Attachment Subject',
            'subject_communication-project': 'Prior Attachment Subject',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBeUndefined();
        expect(renderResult.formData?.['subject_communication-project']).toBeUndefined();
      });

      it('preserves all current DocumentField values when onFileSourceChange switches to Google Drive URL with blank InputDriveURL', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onFileSourceChange',
          hostApp: 'GMAIL',
          formData: {
            SelectFileSource: 'Google Drive URL',
            InputDriveURL: '',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            spaceId: 'proj1',
            subject: 'Preserved Subject',
            'contact_communication-project': 'Alice',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBe('Preserved Subject');
        expect(renderResult.formData?.contact).toBe('Alice');
      });

      it('purges prior data keys on onFormChange when SelectFileSource is Google Drive URL and InputDriveURL transitions to valid link', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onFormChange',
          hostApp: 'GMAIL',
          formData: {
            SelectFileSource: 'Google Drive URL',
            InputDriveURL: 'https://drive.google.com/file/d/new-valid-link/view',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            spaceId: 'proj1',
            subject: 'Old Form Subject',
            contact: 'Old Form Contact',
          },
          parameters: {
            previousDriveUrl: 'https://drive.google.com/file/d/old-link/view',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBeUndefined();
        expect(renderResult.formData?.contact).toBeUndefined();
      });

      it('preserves data keys on onFormChange when InputDriveURL does not transition', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onFormChange',
          hostApp: 'GMAIL',
          formData: {
            SelectFileSource: 'Google Drive URL',
            InputDriveURL: 'https://drive.google.com/file/d/same-link/view',
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            spaceId: 'proj1',
            subject: 'User Editing Subject',
          },
          parameters: {
            previousDriveUrl: 'https://drive.google.com/file/d/same-link/view',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.subject).toBe('User Editing Subject');
      });
    });

    describe('Manual type-switch events card-state hygiene', () => {
      const typeSwitchManifestPort: UiProcessManifestPort = {
        resolveDocumentTypeKey: vi.fn().mockImplementation(async (key: string) => key),
        getAllDocumentTypes: vi.fn().mockResolvedValue([
          { key: 'communication-project', name: 'Communication Project' },
          { key: 'submittal-arch', name: 'Submittal Arch' },
        ]),
        getDocumentTypeSchemas: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'submittal-arch') {
            return {
              docSchema: {
                fields: [
                  { key: 'status' },
                  { key: 'section' },
                  { key: 'number' },
                  { key: 'contact' },
                ],
              },
            };
          }
          if (key === 'communication-project') {
            return {
              docSchema: {
                fields: [
                  { key: 'subject' },
                  { key: 'contact' },
                  { key: 'date' },
                ],
              },
            };
          }
          return {};
        }),
      };

      it('retains inactive _${otherDocType} suffixed entries while pruning unsuffixed data keys absent from new DocumentSchema', async () => {
        const customSpaceProvider: UiProcessSpaceProviderPort = {
          getAllTypes: () => [
            {
              id: 'projects',
              displayName: 'Projects',
              spaceSchema: { allowedDocumentTypes: ['communication-project', 'submittal-arch'] },
            },
          ],
          getCollection: async () => ({ spaces: [{ id: 'p1', name: 'Project Main' }] }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: customSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: typeSwitchManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onDocumentTypeChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType_projects: 'submittal-arch',
            'subject_communication-project': 'Comm Subject',
            'section_submittal-arch': '071200',
            subject: 'Comm Subject',
            contact: 'Alice',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.isUpdateCard).toBe(true);
        expect(renderResult.documentTypeKey).toBe('submittal-arch');

        // Retains inactive otherDocType suffixed entry:
        expect(renderResult.formData?.['subject_communication-project']).toBe('Comm Subject');

        // Normalizes and retains submittal-arch field:
        expect(renderResult.formData?.section).toBe('071200');

        // Retains common contact field present in submittal-arch schema:
        expect(renderResult.formData?.contact).toBe('Alice');

        // Prunes unsuffixed subject which is not in submittal-arch schema:
        expect(renderResult.formData?.subject).toBeUndefined();
      });

      it('preserves unsuffixed keys without pruning when docSchema.fields is not returned by manifestPort', async () => {
        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
        });

        const context: UiProcessEventContext = {
          actionName: 'onDocumentTypeChange',
          formData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace_projects: 'Project Main',
            SelectDocumentType_projects: 'invoice-project',
            contact: 'Alice',
            unlistedField: 'KeepMe',
          },
        };

        const result = await adapter.processUiEvent(context);
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(renderResult.formData?.contact).toBe('Alice');
        expect(renderResult.formData?.unlistedField).toBe('KeepMe');
      });
    });

    describe('Universal formEvaluator reactive evaluation', () => {
      it('executes formEvaluator across initial load, seeding defaultValue and applying hiddenFields', async () => {
        const mockFormEvaluator: UiProcessFormEvaluatorPort = {
          evaluate: vi.fn().mockResolvedValue({
            computedData: {
              status: 'Open',
              computedField: 'computed-val',
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

        const result = await adapter.processUiEvent({});
        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(mockFormEvaluator.evaluate).toHaveBeenCalledTimes(1);
        expect(mockFormEvaluator.evaluate).toHaveBeenCalledWith(
          expect.anything(),
          'communication-project'
        );
        expect(renderResult.isUpdateCard).toBe(false);
        expect(renderResult.formData?.status).toBe('Open');
        expect(renderResult.formData?.computedField).toBe('computed-val');
        expect(renderResult.hiddenFields).toEqual(['internalNotes']);
      });

      it('executes formEvaluator on onSpaceTypeChange and retains isUpdateCard: true', async () => {
        const mockFormEvaluator: UiProcessFormEvaluatorPort = {
          evaluate: vi.fn().mockImplementation(async (formData: Record<string, unknown>) => ({
            computedData: {
              ...formData,
              direction: 'IN',
            },
            hiddenFields: [],
            disabledFields: [],
          })),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          formEvaluator: mockFormEvaluator,
        });

        const result = await adapter.processUiEvent({
          actionName: 'onSpaceTypeChange',
          formData: {
            SelectDocumentSpaceType: 'proposals',
            SelectDocumentType_proposals: 'communication-proposal',
          },
        });

        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(mockFormEvaluator.evaluate).toHaveBeenCalledTimes(1);
        expect(renderResult.isUpdateCard).toBe(true);
        expect(renderResult.formData?.direction).toBe('IN');
      });

      it('executes formEvaluator on onEmailMessageChange', async () => {
        const mockGmailPort: UiProcessGmailPort = {
          getMessageAttachments: vi.fn().mockResolvedValue([]),
          getThreadMessages: vi.fn().mockResolvedValue([
            { id: 'm1', attachments: [] },
          ]),
        };

        const mockFormEvaluator: UiProcessFormEvaluatorPort = {
          evaluate: vi.fn().mockResolvedValue({
            computedData: { evaluatedOnEmailSwitch: true },
            hiddenFields: ['notes'],
            disabledFields: [],
          }),
        };

        const adapter = new WorkspaceAddonAdapter({
          spaceProvider: mockSpaceProvider,
          configProvider: mockConfigProvider,
          manifestPort: mockManifestPort,
          gmailPort: mockGmailPort,
          formEvaluator: mockFormEvaluator,
        });

        const result = await adapter.processUiEvent({
          actionName: 'onEmailMessageChange',
          hostApp: 'GMAIL',
          gmail: { messageId: 'm1' },
          formData: {
            SelectEmailMessage: 'm1',
          },
        });

        expect(result.type).toBe('render');
        const renderResult = result as UiProcessRenderResult;
        expect(mockFormEvaluator.evaluate).toHaveBeenCalledTimes(1);
        expect(renderResult.formData?.evaluatedOnEmailSwitch).toBe(true);
        expect(renderResult.hiddenFields).toEqual(['notes']);
        expect(renderResult.isUpdateCard).toBe(true);
      });
    });
  });

  describe('Ticket #303: UiProcessManager Pass 2 extractFields lifecycle and integration', () => {
    it('invokes sourceParser.extractFields on initial card load with no existingData and merges extracted fields', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({
          spaceTypeId: 'projects',
          spaceIdOrName: 'proj1',
          documentTypeKey: 'communication-project',
        }),
        extractFields: vi.fn().mockResolvedValue({
          fields: {
            date: '261019',
            direction: 'IN',
            description: 'Extracted Description',
          },
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      const result = await adapter.processUiEvent({});
      expect(result.type).toBe('render');
      const renderResult = result as UiProcessRenderResult;

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(1);
      const callArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.documentTypeKey).toBe('communication-project');
      expect(callArg.existingData).toBeUndefined();
      expect(renderResult.formData?.date).toBe('261019');
      expect(renderResult.formData?.direction).toBe('IN');
      expect(renderResult.formData?.description).toBe('Extracted Description');
    });

    it('invokes sourceParser.extractFields on refresh and onEmailMessageChange with no existingData', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({
          spaceTypeId: 'projects',
          spaceIdOrName: 'proj1',
          documentTypeKey: 'communication-project',
        }),
        extractFields: vi.fn().mockResolvedValue({
          fields: {
            date: '261020',
            description: 'Refreshed Description',
          },
        }),
      };

      const mockGmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn().mockResolvedValue([]),
        getThreadMessages: vi.fn().mockResolvedValue([
          { id: 'msg-1', attachments: [] },
          { id: 'msg-2', attachments: [] },
        ]),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort: mockGmailPort,
        sourceParser: mockSourceParser,
      });

      // 1. Refresh action
      const refreshResult = await adapter.processUiEvent({
        actionName: 'refresh',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          spaceId: 'proj1',
          description: 'Old Description',
        },
      });

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(1);
      const refreshArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(refreshArg.existingData).toBeUndefined();
      expect((refreshResult as UiProcessRenderResult).formData?.description).toBe('Refreshed Description');

      // 2. onEmailMessageChange action
      const emailChangeResult = await adapter.processUiEvent({
        actionName: 'onEmailMessageChange',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', threadId: 'th-1' },
        formData: {
          SelectEmailMessage: 'msg-2',
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          spaceId: 'proj1',
          description: 'Old Description',
        },
      });

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(2);
      const emailChangeArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(emailChangeArg.existingData).toBeUndefined();
      expect((emailChangeResult as UiProcessRenderResult).formData?.description).toBe('Refreshed Description');
    });

    it('invokes sourceParser.extractFields on manual type-switch events preserving non-empty user edits', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({}),
        extractFields: vi.fn().mockResolvedValue({
          fields: {
            date: '261021',
            direction: 'IN',
            description: 'Extracted Description',
          },
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      const result = await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'communication-project',
          spaceId: 'proj1',
          description: 'User Edited Description', // active-type edit!
        },
      });

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(1);
      const callArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.existingData).toEqual({
        description: 'User Edited Description',
      });
      const renderResult = result as UiProcessRenderResult;
      // User edit was preserved and not overwritten:
      expect(renderResult.formData?.description).toBe('User Edited Description');
      // Blank fields were populated from Pass 2:
      expect(renderResult.formData?.date).toBe('261021');
      expect(renderResult.formData?.direction).toBe('IN');
    });

    it('skips sourceParser.extractFields on regular onFormChange, processDocument, and when InputDriveURL is blank', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({}),
        extractFields: vi.fn().mockResolvedValue({ fields: {} }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      // 1. Regular onFormChange without drive URL update
      await adapter.processUiEvent({
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          description: 'Editing...',
        },
      });
      expect(mockSourceParser.extractFields).not.toHaveBeenCalled();

      // 2. onFileSourceChange to Google Drive URL with blank InputDriveURL
      await adapter.processUiEvent({
        actionName: 'onFileSourceChange',
        hostApp: 'GMAIL',
        formData: {
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: '',
          SelectDocumentSpaceType: 'projects',
        },
      });
      expect(mockSourceParser.extractFields).not.toHaveBeenCalled();
    });

    it('deduplicates combined Pass 1 and Pass 2 statusMessages', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({
          spaceTypeId: 'projects',
          statusMessages: ['Notice A', 'Notice B'],
        }),
        extractFields: vi.fn().mockResolvedValue({
          fields: {},
          statusMessages: ['Notice B', 'Notice C'],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      const result = await adapter.processUiEvent({
        selectedItems: [{ id: 'item-1' }],
      });
      const renderResult = result as UiProcessRenderResult;
      expect(renderResult.statusMessages).toEqual(['Notice A', 'Notice B', 'Notice C']);
    });

    it('excludes inactive docType-suffixed keys from existingData on manual type-switch (Spec #2)', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({}),
        extractFields: vi.fn().mockResolvedValue({
          fields: {
            section: '071200',
          },
        }),
      };

      const manifestWithTypes: UiProcessManifestPort = {
        ...mockManifestPort,
        getDocumentTypeSchemas: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'invoice-project') {
            return {
              docSchema: {
                fields: [
                  { key: 'section' },
                  { key: 'date' },
                ],
              },
            };
          }
          return undefined;
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: manifestWithTypes,
        sourceParser: mockSourceParser,
      });

      const result = await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          spaceId: 'proj1',
          date: '261021',
          'description_communication-project': 'Prior Comm Edit',
        },
      });

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(1);
      const callArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.existingData).toEqual({ date: '261021' });
      expect(callArg.existingData).not.toHaveProperty('description_communication-project');

      const renderResult = result as UiProcessRenderResult;
      expect(renderResult.formData?.['description_communication-project']).toBe('Prior Comm Edit');
      expect(renderResult.formData?.section).toBe('071200');
    });

    it('passes Drive URL item and isDriveUrl: true in pass2Context on manual type-switch in Google Drive URL mode (Spec #7)', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({}),
        extractFields: vi.fn().mockResolvedValue({
          fields: {
            description: 'From Drive File',
          },
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1' },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'communication-project',
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: 'https://drive.google.com/file/d/drive-file-999/view',
        },
      });

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(1);
      const callArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.context.items).toEqual([{ id: 'drive-file-999' }]);
      expect(callArg.context.isDriveUrl).toBe(true);
    });

    it('runs Pass 2 with isDriveUrl: true and items: [] on manual type-switch when SelectFileSource is Google Drive URL with blank InputDriveURL, while onFileSourceChange skips Pass 2', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({}),
        extractFields: vi.fn().mockResolvedValue({
          fields: {
            date: '261118',
            direction: 'IN',
            description: 'From Email Subject',
          },
        }),
      };

      const mockGmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn().mockResolvedValue([
          { attachmentId: 'att-1', title: 'ShouldNotLeak.pdf', mimeType: 'application/pdf' },
        ]),
        getThreadMessages: vi.fn().mockResolvedValue([
          {
            id: 'msg-1',
            subject: 'Project Update',
            attachments: [
              { attachmentId: 'att-1', title: 'ShouldNotLeak.pdf', mimeType: 'application/pdf' },
            ],
          },
        ]),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort: mockGmailPort,
        sourceParser: mockSourceParser,
      });

      // 1. onFileSourceChange to Google Drive URL with blank InputDriveURL -> skips Pass 2 and preserves fields
      const fileSourceSwitchResult = (await adapter.processUiEvent({
        actionName: 'onFileSourceChange',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', threadId: 'th-1' },
        formData: {
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: '',
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'communication-project',
          description: 'Existing User Value',
        },
      })) as UiProcessRenderResult;
      expect(mockSourceParser.extractFields).not.toHaveBeenCalled();
      expect(fileSourceSwitchResult.formData?.description).toBe('Existing User Value');

      // 2. onDocumentTypeChange with blank InputDriveURL -> runs Pass 2 with isDriveUrl: true, items: []
      const docTypeSwitchResult = (await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', threadId: 'th-1' },
        formData: {
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: '',
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'communication-project',
        },
      })) as UiProcessRenderResult;

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(1);
      const docCallArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(docCallArg.context.items).toEqual([]);
      expect(docCallArg.context.isDriveUrl).toBe(true);
      expect(docCallArg.context.email?.subject).toBe('Project Update');
      expect(docTypeSwitchResult.formData?.description).toBe('From Email Subject');

      // 3. onSpaceTypeChange with blank InputDriveURL -> runs Pass 2 with isDriveUrl: true, items: []
      await adapter.processUiEvent({
        actionName: 'onSpaceTypeChange',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', threadId: 'th-1' },
        formData: {
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: '',
          SelectDocumentSpaceType: 'projects',
        },
      });

      expect(mockSourceParser.extractFields).toHaveBeenCalledTimes(2);
      const spaceCallArg = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(spaceCallArg.context.items).toEqual([]);
      expect(spaceCallArg.context.isDriveUrl).toBe(true);
    });
  });

  describe('Ticket #309: Drive SelectFiles filtering, type-switch edit preservation & single-banner suppression', () => {
    it('filters Pass 2 Drive SourceContext.items by SelectFiles when !isResetOrInitial and treats omitted SelectFiles as []', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({}),
        extractFields: vi.fn().mockResolvedValue({ fields: {} }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      const selectedItems = [
        { id: 'file-1', title: 'Cover_Notes.pdf', mimeType: 'application/pdf' },
        { id: 'file-2', title: 'Submittal.pdf', mimeType: 'application/pdf' },
      ];

      // 1. Partial SelectFiles on onDocumentTypeChange -> only checked item passed
      await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        selectedItems,
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          SelectFiles: ['file-2'],
        },
      });

      const partialCall = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(partialCall.context.items).toEqual([
        { id: 'file-2', name: 'Submittal.pdf', mimeType: 'application/pdf' },
      ]);

      // 2. Omitted SelectFiles on onSpaceTypeChange (all checkboxes unchecked) -> items: []
      await adapter.processUiEvent({
        actionName: 'onSpaceTypeChange',
        selectedItems,
        formData: {
          SelectDocumentSpaceType: 'proposals',
        },
      });

      const omittedCall = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[1][0];
      expect(omittedCall.context.items).toEqual([]);

      // 3. Explicit empty SelectFiles: [] on onDocumentTypeChange -> items: []
      await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        selectedItems,
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType_projects: 'communication-project',
          SelectFiles: [],
        },
      });

      const emptyArrayCall = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[2][0];
      expect(emptyArrayCall.context.items).toEqual([]);

      // 4. Refresh (isResetOrInitial = true) -> includes all selectedItems regardless of SelectFiles
      await adapter.processUiEvent({
        actionName: 'refresh',
        selectedItems,
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectFiles: ['file-2'],
        },
      });

      const refreshCall = (mockSourceParser.extractFields as ReturnType<typeof vi.fn>).mock.calls[3][0];
      expect(refreshCall.context.items).toEqual([
        { id: 'file-1', name: 'Cover_Notes.pdf', mimeType: 'application/pdf' },
        { id: 'file-2', name: 'Submittal.pdf', mimeType: 'application/pdf' },
      ]);
    });

    it('suppresses Pass 2 Drive metadata notice when Pass 1 emitted DRIVE_ROUTING_FALLBACK_NOTICE in the same request, while surfacing Pass 2 notice standalone on manual type switches', async () => {
      const pass2DriveNotice =
        'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.';

      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({
          statusMessages: [DRIVE_ROUTING_FALLBACK_NOTICE],
        }),
        extractFields: vi.fn().mockResolvedValue({
          fields: {},
          statusMessages: [pass2DriveNotice],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      // 1. Initial Drive load where both Pass 1 and Pass 2 fail -> only 1 banner
      const initialResult = (await adapter.processUiEvent({
        selectedItems: [{ id: 'broken-drive-item', title: 'Broken.pdf' }],
      })) as UiProcessRenderResult;

      expect(initialResult.statusMessages).toEqual([DRIVE_ROUTING_FALLBACK_NOTICE]);

      // 2. Gmail Google Drive URL onFormChange where both Pass 1 and Pass 2 fail -> only 1 banner
      const gmailDriveUrlResult = (await adapter.processUiEvent({
        actionName: 'onFormChange',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1' },
        parameters: { action: 'onFormChange', previousDriveUrl: '' },
        formData: {
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: 'https://drive.google.com/file/d/forbidden-item/view',
        },
      })) as UiProcessRenderResult;

      expect(gmailDriveUrlResult.statusMessages).toEqual([DRIVE_ROUTING_FALLBACK_NOTICE]);

      // 3. Manual onDocumentTypeChange (Pass 1 does not run) -> Pass 2 notice surfaces standalone
      const docSwitchResult = (await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        selectedItems: [{ id: 'broken-drive-item', title: 'Broken.pdf' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType_projects: 'invoice-project',
          SelectFiles: ['broken-drive-item'],
        },
      })) as UiProcessRenderResult;

      expect(docSwitchResult.statusMessages).toEqual([pass2DriveNotice]);

      // 4. Manual onSpaceTypeChange (Pass 1 does not run) -> Pass 2 notice surfaces standalone
      const spaceSwitchResult = (await adapter.processUiEvent({
        actionName: 'onSpaceTypeChange',
        selectedItems: [{ id: 'broken-drive-item', title: 'Broken.pdf' }],
        formData: {
          SelectDocumentSpaceType: 'proposals',
          SelectFiles: ['broken-drive-item'],
        },
      })) as UiProcessRenderResult;

      expect(spaceSwitchResult.statusMessages).toEqual([pass2DriveNotice]);
    });

    it('never suppresses PDF_FORM_ENCRYPTED_ERROR_MESSAGE, DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE, or ambiguous form-field notices even when Pass 1 emitted DRIVE_ROUTING_FALLBACK_NOTICE', async () => {
      const encryptedMsg =
        'Could not read PDF form fields because the file is password-protected; you can enter them manually.';
      const corruptedMsg =
        'Could not read document form fields because the file could not be parsed; you can enter them manually.';
      const ambiguousMsg =
        'Could not pre-populate from "Submittal Response" because multiple options are selected; please verify manually.';

      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({
          statusMessages: [DRIVE_ROUTING_FALLBACK_NOTICE],
        }),
        extractFields: vi.fn().mockResolvedValue({
          fields: {},
          statusMessages: [
            DRIVE_METADATA_FALLBACK_NOTICE,
            encryptedMsg,
            corruptedMsg,
            ambiguousMsg,
          ],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
      });

      const result = (await adapter.processUiEvent({
        selectedItems: [{ id: 'mixed-items', title: 'Mixed.pdf' }],
      })) as UiProcessRenderResult;

      expect(result.statusMessages).toEqual([
        DRIVE_ROUTING_FALLBACK_NOTICE,
        encryptedMsg,
        corruptedMsg,
        ambiguousMsg,
      ]);
      expect(result.statusMessages).not.toContain(DRIVE_METADATA_FALLBACK_NOTICE);
    });

    it('preserves non-empty active-type user edits, populates blank fields from Pass 2, and evaluates formEvaluator on onDocumentTypeChange and onSpaceTypeChange', async () => {
      const mockSourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({}),
        extractFields: vi.fn().mockResolvedValue({
          fields: {
            date: '261119',
            description: 'From Drive Metadata',
          },
        }),
      };

      const mockFormEvaluator: UiProcessFormEvaluatorPort = {
        evaluate: vi.fn().mockImplementation(async (rawFormData) => ({
          computedData: {
            ...rawFormData,
            direction: rawFormData.direction ?? 'IN',
            computedSummary: `${rawFormData.date ?? ''}-${rawFormData.description ?? ''}`,
          },
          hiddenFields: ['internalNotes'],
          disabledFields: [],
        })),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser: mockSourceParser,
        formEvaluator: mockFormEvaluator,
      });

      const docSwitchResult = (await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        selectedItems: [{ id: 'file-1', title: 'Notes.pdf' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'communication-project',
          SelectFiles: ['file-1'],
          'description_communication-project': 'User Custom Description',
        },
      })) as UiProcessRenderResult;

      expect(docSwitchResult.formData?.description).toBe('User Custom Description');
      expect(docSwitchResult.formData?.date).toBe('261119');
      expect(docSwitchResult.formData?.direction).toBe('IN');
      expect(docSwitchResult.formData?.computedSummary).toBe('261119-User Custom Description');
      expect(mockFormEvaluator.evaluate).toHaveBeenCalledTimes(1);

      const spaceSwitchResult = (await adapter.processUiEvent({
        actionName: 'onSpaceTypeChange',
        selectedItems: [{ id: 'file-1', title: 'Notes.pdf' }],
        formData: {
          SelectDocumentSpaceType: 'proposals',
          SelectFiles: ['file-1'],
          'description_communication-proposal': 'Proposal User Edit',
        },
      })) as UiProcessRenderResult;

      expect(spaceSwitchResult.formData?.description).toBe('Proposal User Edit');
      expect(spaceSwitchResult.formData?.date).toBe('261119');
      expect(spaceSwitchResult.formData?.direction).toBe('IN');
      expect(spaceSwitchResult.formData?.computedSummary).toBe('261119-Proposal User Edit');
      expect(mockFormEvaluator.evaluate).toHaveBeenCalledTimes(2);
    });
  });

  describe('DocumentLog pre-flight guard on processDocument', () => {
    const buildSubmitEvent = (documentTypeKey: string): UiProcessEventContext => ({
      actionName: 'processDocument',
      selectedItems: [{ id: 'file-1', title: 'Submittal.pdf' }],
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Project Main',
        SelectDocumentType_projects: documentTypeKey,
        SelectFiles: ['file-1'],
        [`title_${documentTypeKey}`]: 'Waterproofing',
      },
    });

    it('skips resolveLog for non-logging DocumentTypes and runs documentRunner without selectedLogId', async () => {
      const documentRunner: UiProcessDocumentRunnerPort = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(false),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner,
        documentLogPort,
      });

      const result = await adapter.processUiEvent(buildSubmitEvent('communication-project'));
      expect(result).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((result as UiProcessRenderResult).notification).toBeUndefined();
      expect(documentLogPort.requiresDocumentLog).toHaveBeenCalledWith('communication-project');
      expect(documentLogPort.resolveLog).not.toHaveBeenCalled();
      expect(documentRunner.processDocument).toHaveBeenCalledWith(
        expect.not.objectContaining({ selectedLogId: expect.anything() }),
        'onSubmit'
      );
    });

    it('blocks missing DocumentLog before documentRunner runs and returns updateCard error preserving formData', async () => {
      const documentRunner: UiProcessDocumentRunnerPort = {
        processDocument: vi.fn(),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(true),
        resolveLog: vi.fn().mockResolvedValue({
          status: 'missing',
          expectedFolderPath: '1 Admin',
        }),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(buildSubmitEvent('invoice-project'))) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.validationErrors?.[0]).toContain('Project Main');
      expect(result.validationErrors?.[0]).toContain('1 Admin');
      expect(result.formData?.title).toBe('Waterproofing');
      expect(documentRunner.processDocument).not.toHaveBeenCalled();
    });

    it('blocks un-disambiguated ambiguous DocumentLog before documentRunner runs', async () => {
      const documentRunner: UiProcessDocumentRunnerPort = {
        processDocument: vi.fn(),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(true),
        resolveLog: vi.fn().mockResolvedValue({
          status: 'ambiguous',
          candidates: [
            { id: 'log-1', name: 'Project Main Document Log' },
            { id: 'log-2', name: 'Project Main Document Log v2' },
          ],
        }),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(buildSubmitEvent('invoice-project'))) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.validationErrors?.[0]).toContain('Project Main Document Log');
      expect(result.validationErrors?.[0]).toContain('Project Main Document Log v2');
      expect(documentRunner.processDocument).not.toHaveBeenCalled();
    });

    it('catches pre-flight Drive errors and returns updateCard error rather than throwing', async () => {
      const documentRunner: UiProcessDocumentRunnerPort = {
        processDocument: vi.fn(),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(true),
        resolveLog: vi.fn().mockRejectedValue(new Error('Drive 403 Forbidden')),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(buildSubmitEvent('invoice-project'))) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.validationErrors).toEqual(['Drive 403 Forbidden']);
      expect(result.formData?.title).toBe('Waterproofing');
      expect(documentRunner.processDocument).not.toHaveBeenCalled();
    });

    it('forwards selectedLogId on resolved pre-flight check into documentRunner.processDocument', async () => {
      const documentRunner: UiProcessDocumentRunnerPort = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(true),
        resolveLog: vi.fn().mockResolvedValue({
          status: 'resolved',
          candidate: { id: 'log-resolved-1', name: 'Project Main Document Log' },
        }),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner,
        documentLogPort,
      });

      const result = await adapter.processUiEvent(buildSubmitEvent('invoice-project'));
      expect(result).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((result as UiProcessRenderResult).notification).toBeUndefined();
      expect(documentLogPort.resolveLog).toHaveBeenCalledWith({
        id: 'proj1',
        name: 'Project Main',
        typeId: 'projects',
        abstractStorageId: 'proj1',
      });
      expect(documentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'invoice-project',
          selectedLogId: 'log-resolved-1',
        }),
        'onSubmit'
      );
    });

    it('forwards live selected candidate as selectedLogId on ambiguous pre-flight check while stripping SelectDocumentLog from Document.data (#351)', async () => {
      const documentRunner: UiProcessDocumentRunnerPort = {
        processDocument: vi.fn().mockResolvedValue({ success: true }),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(true),
        resolveLog: vi.fn().mockResolvedValue({
          status: 'ambiguous',
          candidates: [
            { id: 'log-1', name: 'Project Main Document Log' },
            { id: 'log-2', name: 'Project Main Document Log v2' },
          ],
        }),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner,
        documentLogPort,
      });

      const baseEvent = buildSubmitEvent('invoice-project');
      const result = await adapter.processUiEvent({
        ...baseEvent,
        parameters: {
          action: 'processDocument',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
        },
        formData: {
          ...baseEvent.formData,
          SelectDocumentLog: 'log-2',
        },
      });

      expect(result).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((result as UiProcessRenderResult).notification).toBeUndefined();
      expect(documentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'invoice-project',
          selectedLogId: 'log-2',
        }),
        'onSubmit'
      );
      const passedPayload = (documentRunner.processDocument as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as { data: Record<string, unknown> };
      expect(passedPayload.data).not.toHaveProperty('SelectDocumentLog');
    });

    it('blocks stale or cross-space SelectDocumentLog on ambiguous pre-flight check, deletes SelectDocumentLog from formData, and returns updateCard error before documentRunner runs (#351)', async () => {
      const documentRunner: UiProcessDocumentRunnerPort = {
        processDocument: vi.fn(),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(true),
        resolveLog: vi.fn().mockResolvedValue({
          status: 'ambiguous',
          candidates: [
            { id: 'log-1', name: 'Project Main Document Log' },
            { id: 'log-2', name: 'Project Main Document Log v2' },
          ],
        }),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentRunner,
        documentLogPort,
      });

      // 1. Stale selection (not in live candidates) with previousSelectedLogId also pointing to stale ID
      const baseEvent = buildSubmitEvent('invoice-project');
      const staleRes = (await adapter.processUiEvent({
        ...baseEvent,
        parameters: {
          action: 'processDocument',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-deleted',
        },
        formData: {
          ...baseEvent.formData,
          SelectDocumentLog: 'log-deleted',
        },
      })) as UiProcessRenderResult;
      expect(staleRes.type).toBe('render');
      expect(staleRes.isUpdateCard).toBe(true);
      expect(staleRes.validationErrors?.[0]).toContain('Multiple DocumentLog spreadsheets found');
      expect(staleRes.formData).not.toHaveProperty('SelectDocumentLog');
      expect(staleRes.formData?.title).toBe('Waterproofing');
      expect(documentRunner.processDocument).not.toHaveBeenCalled();

      // 2. Unblurred cross-space edit (previousSpaceId differs from resolved proj1) clears SelectDocumentLog even if ID collides
      const crossSpaceRes = (await adapter.processUiEvent({
        ...baseEvent,
        parameters: {
          action: 'processDocument',
          previousSpaceId: 'proj-previous',
          previousSelectedLogId: 'log-1',
        },
        formData: {
          ...baseEvent.formData,
          SelectDocumentLog: 'log-1',
        },
      })) as UiProcessRenderResult;
      expect(crossSpaceRes.type).toBe('render');
      expect(crossSpaceRes.isUpdateCard).toBe(true);
      expect(crossSpaceRes.validationErrors?.[0]).toContain('Multiple DocumentLog spreadsheets found');
      expect(crossSpaceRes.formData).not.toHaveProperty('SelectDocumentLog');
      expect(crossSpaceRes.formData?.title).toBe('Waterproofing');
      expect(documentRunner.processDocument).not.toHaveBeenCalled();
    });
  });

  describe('SelectDocumentLog lifecycle clearing & round-trip restoration (#351)', () => {
    it('preserves SelectDocumentLog on direct onDocumentTypeChange and restores from previousSelectedLogId when absent on same-space round-trip', async () => {
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      // Direct switch with SelectDocumentLog present
      const directSwitch = (await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        parameters: {
          action: 'onDocumentTypeChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(directSwitch.type).toBe('render');
      expect(directSwitch.spaceId).toBe('proj1');
      expect(directSwitch.formData?.SelectDocumentLog).toBe('log-2');

      // Round-trip from non-logging type: SelectDocumentLog omitted from formData, restored via previousSelectedLogId
      const roundTrip = (await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        parameters: {
          action: 'onDocumentTypeChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
        },
      })) as UiProcessRenderResult;
      expect(roundTrip.type).toBe('render');
      expect(roundTrip.spaceId).toBe('proj1');
      expect(roundTrip.formData?.SelectDocumentLog).toBe('log-2');
    });

    it('clears SelectDocumentLog on onSpaceTypeChange, refresh, onFileSourceChange, onEmailMessageChange, Gmail Pass 1 Drive URL reset (even same space), and space change/clear', async () => {
      const twoSpaceProvider: UiProcessSpaceProviderPort = {
        getAllTypes: () => [
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: {
              allowedDocumentTypes: ['communication-project', 'invoice-project'],
              defaultDocumentType: 'communication-project',
            },
          },
          {
            id: 'proposals',
            displayName: 'Proposals',
            spaceSchema: {
              allowedDocumentTypes: ['communication-proposal'],
              defaultDocumentType: 'communication-proposal',
            },
          },
        ],
        getCollection: vi.fn().mockImplementation(async (typeId: string) => {
          if (typeId === 'projects') {
            return {
              spaces: [
                { id: 'proj1', name: 'Project Main', typeId: 'projects', abstractStorageId: 'proj1' },
                { id: 'proj2', name: 'Project Two', typeId: 'projects', abstractStorageId: 'proj2' },
              ],
            };
          }
          return {
            spaces: [
              { id: 'prop1', name: 'Proposal One', typeId: 'proposals', abstractStorageId: 'prop1' },
            ],
          };
        }),
      };

      const sourceParser: UiProcessSourceParserPort = {
        inferRouting: vi.fn().mockResolvedValue({
          spaceTypeId: 'projects',
          spaceIdOrName: 'proj1',
          documentTypeKey: 'invoice-project',
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: twoSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        sourceParser,
      });

      // 1. onSpaceTypeChange clears SelectDocumentLog
      const spaceTypeRes = (await adapter.processUiEvent({
        actionName: 'onSpaceTypeChange',
        parameters: {
          action: 'onSpaceTypeChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
        },
        formData: {
          SelectDocumentSpaceType: 'proposals',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(spaceTypeRes.formData).not.toHaveProperty('SelectDocumentLog');

      // 2. refresh clears SelectDocumentLog even when Pass 1 infers same space proj1
      const refreshRes = (await adapter.processUiEvent({
        actionName: 'refresh',
        selectedItems: [{ id: 'file-1', title: 'doc.pdf' }],
        parameters: {
          action: 'refresh',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(refreshRes.formData).not.toHaveProperty('SelectDocumentLog');

      // 3. onFileSourceChange clears SelectDocumentLog even when switching to empty Google Drive URL
      const fileSourceRes = (await adapter.processUiEvent({
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', threadId: 'th-1' },
        actionName: 'onFileSourceChange',
        parameters: {
          action: 'onFileSourceChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
          previousDriveUrl: '',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: '',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(fileSourceRes.formData).not.toHaveProperty('SelectDocumentLog');

      // 4. onEmailMessageChange clears SelectDocumentLog
      const emailChangeRes = (await adapter.processUiEvent({
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', threadId: 'th-1' },
        actionName: 'onEmailMessageChange',
        parameters: {
          action: 'onEmailMessageChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
          previousMessageId: 'msg-1',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          SelectEmailMessage: 'msg-2',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(emailChangeRes.formData).not.toHaveProperty('SelectDocumentLog');

      // 5. Gmail Pass 1 Drive URL change clears SelectDocumentLog EVEN WHEN Pass 1 infers same space proj1
      const driveUrlPass1Res = (await adapter.processUiEvent({
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1', threadId: 'th-1' },
        actionName: 'onFormChange',
        parameters: {
          action: 'onFormChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
          previousDriveUrl: '',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: 'https://drive.google.com/file/d/new-file-123/view',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(driveUrlPass1Res.spaceId).toBe('proj1');
      expect(driveUrlPass1Res.formData).not.toHaveProperty('SelectDocumentLog');

      // 6. Space switch (proj1 -> proj2) clears SelectDocumentLog
      const spaceSwitchRes = (await adapter.processUiEvent({
        actionName: 'onFormChange',
        parameters: {
          action: 'onFormChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Two',
          SelectDocumentType_projects: 'invoice-project',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(spaceSwitchRes.spaceId).toBe('proj2');
      expect(spaceSwitchRes.formData).not.toHaveProperty('SelectDocumentLog');

      // 7. Clearing space to blank (currentSpaceId becomes undefined) clears SelectDocumentLog
      const spaceClearRes = (await adapter.processUiEvent({
        actionName: 'onFormChange',
        parameters: {
          action: 'onFormChange',
          previousSpaceId: 'proj1',
          previousSelectedLogId: 'log-2',
        },
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: '',
          SelectDocumentType_projects: 'invoice-project',
          SelectDocumentLog: 'log-2',
        },
      })) as UiProcessRenderResult;
      expect(spaceClearRes.spaceId).toBeUndefined();
      expect(spaceClearRes.formData).not.toHaveProperty('SelectDocumentLog');
    });
  });

  describe('copyDocumentLog action handling', () => {
    const buildCopyEvent = (
      overrides?: Partial<UiProcessEventContext>,
      formDataOverrides?: Record<string, unknown>
    ): UiProcessEventContext => ({
      actionName: 'copyDocumentLog',
      selectedItems: [{ id: 'file-1', title: 'Invoice.pdf' }],
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace_projects: 'Project Main',
        SelectDocumentType_projects: 'invoice-project',
        SelectFiles: ['file-1'],
        title_invoice_project_placeholder: undefined,
        'title_invoice-project': 'March Invoice',
        ...formDataOverrides,
      },
      ...overrides,
    });

    it('returns updateCard error preserving formData when documentLogPort is not configured', async () => {
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
      });

      const result = (await adapter.processUiEvent(buildCopyEvent())) as UiProcessRenderResult;
      expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBeUndefined();
      expect(result.validationErrors).toEqual([
        'Document Log provisioning is not configured for this workspace.',
      ]);
      expect(result.formData?.title).toBe('March Invoice');
    });

    it('validates resolveSpace collisionError before calling copyLog and preserves formData', async () => {
      const collidingSpaceProvider: UiProcessSpaceProviderPort = {
        getAllTypes: mockSpaceProvider.getAllTypes,
        getCollection: vi.fn().mockResolvedValue({
          spaces: [
            { id: 'proj-a', name: 'Duplicate Project' },
            { id: 'proj-b', name: 'duplicate project' },
          ],
        }),
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: collidingSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(
        buildCopyEvent({}, { SelectDocumentSpace_projects: 'Duplicate Project' })
      )) as UiProcessRenderResult;

      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBeUndefined();
      expect(result.validationErrors?.[0]).toContain('Multiple spaces match');
      expect(result.formData?.title).toBe('March Invoice');
      expect(documentLogPort.copyLog).not.toHaveBeenCalled();
    });

    it('validates resolveSpace notFoundError before calling copyLog and preserves formData', async () => {
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(
        buildCopyEvent({}, { SelectDocumentSpace_projects: 'Nonexistent Space' })
      )) as UiProcessRenderResult;

      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBeUndefined();
      expect(result.validationErrors?.[0]).toContain('was not found');
      expect(result.formData?.title).toBe('March Invoice');
      expect(documentLogPort.copyLog).not.toHaveBeenCalled();
    });

    it('validates missing space (!matchedSpace) before calling copyLog and preserves formData', async () => {
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(
        buildCopyEvent({}, { SelectDocumentSpace_projects: '' })
      )) as UiProcessRenderResult;

      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBeUndefined();
      expect(result.validationErrors).toEqual([
        'Please select a Document Space before copying a Document Log.',
      ]);
      expect(result.formData?.title).toBe('March Invoice');
      expect(documentLogPort.copyLog).not.toHaveBeenCalled();
    });

    it('calls copyLog with UiProcessDocumentSpaceDto, returns Created toast, and preserves formData and hiddenFields on created: true', async () => {
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockResolvedValue({
          created: true,
          candidate: { id: 'new-log-1', name: 'Project Main Document Log' },
          folderPath: '1 Admin',
        }),
      };
      const formEvaluator: UiProcessFormEvaluatorPort = {
        evaluate: vi.fn().mockResolvedValue({
          computedData: {
            SelectDocumentSpaceType: 'projects',
            SelectDocumentSpace: 'Project Main',
            SelectDocumentType: 'invoice-project',
            SelectFiles: ['file-1'],
            title: 'March Invoice',
            computedTag: 'INV-001',
          },
          hiddenFields: ['internalNotes'],
          disabledFields: [],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
        formEvaluator,
      });

      const result = (await adapter.processUiEvent(buildCopyEvent())) as UiProcessRenderResult;

      expect(Value.Check(UiProcessResultSchema, result)).toBe(true);
      expect(documentLogPort.copyLog).toHaveBeenCalledTimes(1);
      expect(documentLogPort.copyLog).toHaveBeenCalledWith({
        id: 'proj1',
        name: 'Project Main',
        typeId: 'projects',
        abstractStorageId: 'proj1',
      });
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBe('Created "Project Main Document Log" in "1 Admin".');
      expect(result.validationErrors).toBeUndefined();
      expect(result.formData?.title).toBe('March Invoice');
      expect(result.formData?.computedTag).toBe('INV-001');
      expect(result.hiddenFields).toEqual(['internalNotes']);
    });

    it('preserves succeeded copy notification even if formEvaluator throws', async () => {
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockResolvedValue({
          created: true,
          candidate: { id: 'new-log-1', name: 'Project Main Document Log' },
          folderPath: '1 Admin',
        }),
      };
      const formEvaluator: UiProcessFormEvaluatorPort = {
        evaluate: vi.fn().mockRejectedValue(new Error('Evaluator failure')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
        formEvaluator,
      });

      const result = (await adapter.processUiEvent(buildCopyEvent())) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBe('Created "Project Main Document Log" in "1 Admin".');
      expect(result.formData?.title).toBe('March Invoice');
      expect(result.hiddenFields).toBeUndefined();
    });

    it('returns idempotent notification when copyLog returns created: false while preserving formData', async () => {
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockResolvedValue({
          created: false,
          candidate: { id: 'existing-log-1', name: 'Project Main Document Log' },
          folderPath: '1 Admin',
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(buildCopyEvent())) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBe('Document Log already exists: "Project Main Document Log".');
      expect(result.validationErrors).toBeUndefined();
      expect(result.formData?.title).toBe('March Invoice');
    });

    it('returns actionable 403 Shared Drive Contributor guidance for direct statusCode: 403 error and preserves formData', async () => {
      const err403 = Object.assign(new Error('Forbidden'), { statusCode: 403 });
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockRejectedValue(err403),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(buildCopyEvent())) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBeUndefined();
      expect(result.validationErrors?.[0]).toContain('403');
      expect(result.validationErrors?.[0]).toContain('Project Main');
      expect(result.validationErrors?.[0]).toContain('Contributor');
      expect(result.validationErrors?.[0]).toContain('template');
      expect(result.formData?.title).toBe('March Invoice');
    });

    it('detects nested cause statusCode: 403 and returns Shared Drive Contributor guidance', async () => {
      const inner = { statusCode: 403 };
      const outer = new Error('Drive API copy failed', { cause: inner });
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockRejectedValue(outer),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(buildCopyEvent())) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBeUndefined();
      expect(result.validationErrors?.[0]).toContain('Permission denied (403)');
      expect(result.validationErrors?.[0]).toContain('Contributor');
      expect(result.formData?.title).toBe('March Invoice');
    });

    it('returns generic error message for non-403 errors while preserving formData', async () => {
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockRejectedValue(new Error('Network timeout while copying template')),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent(buildCopyEvent())) as UiProcessRenderResult;
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBeUndefined();
      expect(result.validationErrors).toEqual(['Network timeout while copying template']);
      expect(result.formData?.title).toBe('March Invoice');
    });

    it('fetches Gmail thread messages and preserves Gmail attachments, email selection, and form inputs on copyDocumentLog', async () => {
      const getThreadMessagesMock = vi.fn().mockResolvedValue([
        {
          id: 'msg-1',
          from: 'Alice <alice@example.com>',
          date: 'Mon, 19 Oct 2026 10:00:00 +0000',
          attachments: [{ id: 'att-1', title: 'File1.pdf', mimeType: 'application/pdf' }],
        },
        {
          id: 'msg-2',
          from: 'Bob <bob@example.com>',
          date: 'Tue, 20 Oct 2026 11:00:00 +0000',
          attachments: [
            { id: 'att-2a', title: 'Invoice.pdf', mimeType: 'application/pdf' },
            { id: 'att-2b', title: 'Backup.pdf', mimeType: 'application/pdf' },
          ],
        },
      ]);
      const gmailPort: UiProcessGmailPort = {
        getMessageAttachments: vi.fn(),
        getThreadMessages: getThreadMessagesMock,
      };
      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn(),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockResolvedValue({
          created: true,
          candidate: { id: 'log-gmail-1', name: 'Project Main Document Log' },
          folderPath: '1 Admin',
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: mockSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        gmailPort,
        documentLogPort,
      });

      const result = (await adapter.processUiEvent({
        actionName: 'copyDocumentLog',
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-1',
          threadId: 'th-copy',
          accessToken: 'ya29.token',
        },
        selectedItems: [
          { id: 'att-2a', title: 'Invoice.pdf', mimeType: 'application/pdf' },
          { id: 'att-2b', title: 'Backup.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'invoice-project',
          SelectEmailMessage: 'msg-2',
          SelectFileSource: 'Email Attachments',
          SelectAttachments: ['att-2a'],
          'title_invoice-project': 'Gmail Invoice',
        },
      })) as UiProcessRenderResult;

      expect(getThreadMessagesMock).toHaveBeenCalledWith('th-copy', { skipCache: false });
      expect(result.type).toBe('render');
      expect(result.isUpdateCard).toBe(true);
      expect(result.notification).toBe('Created "Project Main Document Log" in "1 Admin".');
      expect(result.selectionState?.threadMessages).toHaveLength(2);
      expect(result.selectionState?.files).toEqual([
        { text: 'Invoice.pdf', value: 'att-2a', selected: true },
        { text: 'Backup.pdf', value: 'att-2b', selected: false },
      ]);
      expect(result.formData?.SelectEmailMessage).toBe('msg-2');
      expect(result.formData?.title).toBe('Gmail Invoice');
    });
  });

  describe('lockedFieldsResolver CQRS integration', () => {
    it('computes lockedFields on initial render, refreshes on onFormChange and copyDocumentLog, and falls back to unlocked when resolver throws', async () => {
      const deriveLockedFields = vi
        .fn()
        .mockResolvedValueOnce({ specTitle: 'HOOK' })
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('Sheets error'))
        .mockResolvedValueOnce({ specTitle: 'COPIED LOG TITLE' });

      const documentLogPort: UiProcessDocumentLogPort = {
        requiresDocumentLog: vi.fn().mockResolvedValue(true),
        resolveLog: vi.fn(),
        copyLog: vi.fn().mockResolvedValue({
          created: true,
          candidate: { id: 'log-new', name: 'Project Main Document Log' },
          folderPath: '1 Admin',
        }),
      };

      const ffeSpaceProvider: UiProcessSpaceProviderPort = {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['submittal-ffe'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({
          spaces: [{ id: 'proj-main-1', name: 'Project Main' }],
        }),
      };

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: ffeSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: mockManifestPort,
        documentLogPort,
        lockedFieldsResolver: { deriveLockedFields },
      });

      const initialRes = (await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-ffe',
          'specTag_submittal-ffe': 'AC102',
        },
      })) as UiProcessRenderResult;

      expect(initialRes.lockedFields).toEqual({ specTitle: 'HOOK' });
      expect(deriveLockedFields).toHaveBeenCalledWith({
        documentTypeKey: 'submittal-ffe',
        space: {
          id: 'proj-main-1',
          name: 'Project Main',
          typeId: 'projects',
          abstractStorageId: 'proj-main-1',
        },
        formData: expect.objectContaining({ specTag: 'AC102' }),
      });

      const customChangeRes = (await adapter.processUiEvent({
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-ffe',
          SelectDocumentLog: 'log-2',
          'specTag_submittal-ffe': 'XX999',
        },
      })) as UiProcessRenderResult;

      expect(customChangeRes.lockedFields).toBeUndefined();
      expect(deriveLockedFields).toHaveBeenNthCalledWith(2, {
        documentTypeKey: 'submittal-ffe',
        space: {
          id: 'proj-main-1',
          name: 'Project Main',
          typeId: 'projects',
          abstractStorageId: 'proj-main-1',
        },
        selectedLogId: 'log-2',
        formData: expect.objectContaining({ specTag: 'XX999' }),
      });

      const errorRes = (await adapter.processUiEvent({
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-ffe',
          'specTag_submittal-ffe': 'AC102',
        },
      })) as UiProcessRenderResult;
      expect(errorRes.lockedFields).toBeUndefined();

      const copyRes = (await adapter.processUiEvent({
        actionName: 'copyDocumentLog',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-ffe',
          'specTag_submittal-ffe': 'AC102',
        },
      })) as UiProcessRenderResult;
      expect(copyRes.lockedFields).toEqual({ specTitle: 'COPIED LOG TITLE' });
    });
  });

  describe('maxSourceFiles & file-only submission guard (#373)', () => {
    const createSubmittalManifestPort = (maxSourceFiles?: number): UiProcessManifestPort => ({
      resolveDocumentTypeKey: vi.fn(async (key: string) => key),
      getAllDocumentTypes: vi.fn().mockResolvedValue([
        { key: 'submittal-arch', name: 'Submittal Arch' },
        { key: 'communication-project', name: 'Communication Project' },
      ]),
      getDocumentTypeSchemas: vi.fn(async (key: string) => {
        if (key === 'submittal-arch') {
          return {
            docSchema: { fields: [] },
            ...(maxSourceFiles !== undefined ? { maxSourceFiles } : {}),
          };
        }
        return {
          docSchema: { fields: [] },
          allowEmptySourceFiles: true,
        };
      }),
    });

    const submittalSpaceProvider: UiProcessSpaceProviderPort = {
      getAllTypes: () => [
        {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: {
            allowedDocumentTypes: ['communication-project', 'submittal-arch'],
            defaultDocumentType: 'communication-project',
          },
        },
      ],
      getCollection: vi.fn().mockResolvedValue({
        typeId: 'projects',
        spaces: [{ id: 'proj-1', name: 'Project Main', typeId: 'projects', abstractStorageId: 'proj-1' }],
      }),
    };

    it('rejects Drive processDocument when more than maxSourceFiles (1) items are checked, without calling documentRunner', async () => {
      const mockDocumentRunner = { processDocument: vi.fn().mockResolvedValue({ success: true }) };
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: mockDocumentRunner,
      });

      const res = (await adapter.processUiEvent({
        actionName: 'processDocument',
        selectedItems: [
          { id: 'file-1', title: 'One.pdf', mimeType: 'application/pdf' },
          { id: 'file-2', title: 'Two.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectFiles: ['file-1', 'file-2'],
        },
      })) as UiProcessRenderResult;

      expect(res.type).toBe('render');
      expect(res.isUpdateCard).toBe(true);
      expect(res.validationErrors?.[0]).toMatch(/only 1 file|at most 1/i);
      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
    });

    it('allows Drive processDocument when 2 items are selected in Drive but only 1 is checked in SelectFiles', async () => {
      const mockDocumentRunner = { processDocument: vi.fn().mockResolvedValue({ success: true }) };
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: mockDocumentRunner,
      });

      const res = await adapter.processUiEvent({
        actionName: 'processDocument',
        selectedItems: [
          { id: 'file-1', title: 'One.pdf', mimeType: 'application/pdf' },
          { id: 'file-2', title: 'Two.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectFiles: ['file-2'],
        },
      });

      expect(res).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((res as UiProcessRenderResult).notification).toBeUndefined();
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFiles: [{ id: 'file-2', name: 'Two.pdf', mimeType: 'application/pdf' }],
        }),
        'onSubmit'
      );
    });

    it('rejects Drive processDocument when selected item is a folder on maxSourceFiles-guarded DocumentType', async () => {
      const mockDocumentRunner = { processDocument: vi.fn().mockResolvedValue({ success: true }) };
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: mockDocumentRunner,
      });

      const res = (await adapter.processUiEvent({
        actionName: 'processDocument',
        selectedItems: [
          { id: 'folder-1', title: 'My Folder', mimeType: 'application/vnd.google-apps.folder' },
        ],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectFiles: ['folder-1'],
        },
      })) as UiProcessRenderResult;

      expect(res.type).toBe('render');
      expect(res.isUpdateCard).toBe(true);
      expect(res.validationErrors?.[0]).toMatch(/folder/i);
      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
    });

    it('counts SaveEmailToPdf + 1 checked attachment as 2 SourceFiles and rejects on maxSourceFiles: 1', async () => {
      const mockDocumentRunner = { processDocument: vi.fn().mockResolvedValue({ success: true }) };
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: mockDocumentRunner,
      });

      const res = (await adapter.processUiEvent({
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1' },
        selectedItems: [{ id: 'att-1', title: 'Submittal.pdf', mimeType: 'application/pdf' }],
        formData: {
          SelectFileSource: 'Email Attachments',
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectAttachments: ['att-1'],
          SaveEmailToPdf: true,
        },
      })) as UiProcessRenderResult;

      expect(res.type).toBe('render');
      expect(res.isUpdateCard).toBe(true);
      expect(res.validationErrors?.[0]).toMatch(/only 1 file|at most 1/i);
      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();
    });

    it('rejects Gmail Drive URL + SaveEmailToPdf (= 2 SourceFiles) on maxSourceFiles: 1, while allowing SaveEmailToPdf alone (= 1)', async () => {
      const mockDocumentRunner = { processDocument: vi.fn().mockResolvedValue({ success: true }) };
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: mockDocumentRunner,
      });

      const twoFilesRes = (await adapter.processUiEvent({
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1' },
        formData: {
          SelectFileSource: 'Google Drive URL',
          InputDriveURL: 'https://drive.google.com/file/d/drive-file-1/view',
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SaveEmailToPdf: true,
        },
      })) as UiProcessRenderResult;

      expect(twoFilesRes.type).toBe('render');
      expect(twoFilesRes.validationErrors?.[0]).toMatch(/only 1 file|at most 1/i);
      expect(mockDocumentRunner.processDocument).not.toHaveBeenCalled();

      const savePdfOnlyRes = await adapter.processUiEvent({
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-1' },
        formData: {
          SelectFileSource: 'Email Attachments',
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SaveEmailToPdf: true,
        },
      });
      expect(savePdfOnlyRes).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((savePdfOnlyRes as UiProcessRenderResult).notification).toBeUndefined();
    });

    it('preserves multi-file submission for Communications (maxSourceFiles omitted) in both Drive and Gmail', async () => {
      const mockDocumentRunner = { processDocument: vi.fn().mockResolvedValue({ success: true }) };
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: mockDocumentRunner,
      });

      const gmailMultiRes = await adapter.processUiEvent({
        actionName: 'processDocument',
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-comm' },
        selectedItems: [
          { id: 'att-1', title: 'A.pdf', mimeType: 'application/pdf' },
          { id: 'att-2', title: 'B.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectFileSource: 'Email Attachments',
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'communication-project',
          SelectAttachments: ['att-1', 'att-2'],
          SaveEmailToPdf: true,
        },
      });

      expect(gmailMultiRes).toMatchObject({
        type: 'render',
        viewId: 'document-success-card',
        isUpdateCard: false,
      });
      expect((gmailMultiRes as UiProcessRenderResult).notification).toBeUndefined();
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFiles: expect.arrayContaining([
            expect.objectContaining({ id: 'att-1' }),
            expect.objectContaining({ id: 'att-2' }),
            expect.objectContaining({ id: 'email-pdf-msg-comm' }),
          ]),
        }),
        'onSubmit'
      );
    });

    it('emits a non-blocking statusMessages warning on onDocumentTypeChange when > maxSourceFiles items are selected', async () => {
      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
      });

      const res = (await adapter.processUiEvent({
        actionName: 'onDocumentTypeChange',
        selectedItems: [
          { id: 'file-1', title: 'One.pdf', mimeType: 'application/pdf' },
          { id: 'file-2', title: 'Two.pdf', mimeType: 'application/pdf' },
        ],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectFiles: ['file-1', 'file-2'],
        },
      })) as UiProcessRenderResult;

      expect(res.type).toBe('render');
      expect(res.documentTypeKey).toBe('submittal-arch');
      expect(res.validationErrors).toBeUndefined();
      expect(res.statusMessages?.some((msg) => /1|single|uncheck/i.test(msg))).toBe(true);
    });

    it('surfaces contextVariables.notices as statusMessages alongside notification on success and preserves notices on error (#380)', async () => {
      const processDocument = vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          contextVariables: {
            notices: [
              'Cover sheet could not be inserted into "_071200-001.docx" because it is not a PDF. Created sibling Transmittal PDF "_071200-001 Transmittal.pdf".',
            ],
          },
        })
        .mockResolvedValueOnce({
          success: false,
          errors: ['Failed step writeLog'],
          contextVariables: {
            notices: ['Sibling Transmittal notice prior to failure'],
          },
        });

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: { processDocument },
      });

      const baseEvent = {
        hostApp: 'DRIVE' as const,
        actionName: 'processDocument',
        selectedItems: [{ id: 'file-1', title: 'Submittal.docx' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectFiles: ['file-1'],
        },
      };

      const successRes = (await adapter.processUiEvent(baseEvent)) as UiProcessRenderResult;
      expect(successRes.type).toBe('render');
      expect(successRes.viewId).toBe('document-success-card');
      expect(successRes.isUpdateCard).toBe(false);
      expect(successRes.notification).toBeUndefined();
      expect(successRes.executionOutcome?.notices).toEqual([
        'Cover sheet could not be inserted into "_071200-001.docx" because it is not a PDF. Created sibling Transmittal PDF "_071200-001 Transmittal.pdf".',
      ]);

      const errorRes = (await adapter.processUiEvent(baseEvent)) as UiProcessRenderResult;
      expect(errorRes.type).toBe('render');
      expect(errorRes.isUpdateCard).toBe(true);
      expect(errorRes.validationErrors).toEqual(['Failed step writeLog']);
      expect(errorRes.statusMessages).toEqual(['Sibling Transmittal notice prior to failure']);
    });

    it('pushes document-success-card (isUpdateCard: false, no toast), skips lockedFieldsResolver, and handles startOver with popToRoot: true + isUpdateCard: true (#382)', async () => {
      const lockedFieldsResolver = {
        deriveLockedFields: vi.fn().mockResolvedValue({ specTitle: 'HOOK' }),
      };
      const processDocument = vi.fn().mockResolvedValue({
        success: true,
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalReceived',
          completedStepCount: 2,
          spaceName: 'Project Main',
          documentData: { title: 'Waterproofing' },
          stepResults: [
            {
              stepId: 'moveOriginal',
              activityType: 'MOVE_FILE',
              files: [{ id: 'f-1', name: 'Submittal.pdf', uri: 'https://drive.google.com/file/d/f-1/view' }],
            },
          ],
          notices: [],
          errors: [],
        },
      });

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(1),
        documentRunner: { processDocument },
        lockedFieldsResolver,
      });

      const submitRes = (await adapter.processUiEvent({
        hostApp: 'DRIVE',
        actionName: 'processDocument',
        selectedItems: [{ id: 'file-1', title: 'Submittal.pdf' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectFiles: ['file-1'],
          title_submittal_arch: 'Waterproofing',
        },
      })) as UiProcessRenderResult;

      expect(submitRes.type).toBe('render');
      expect(submitRes.viewId).toBe('document-success-card');
      expect(submitRes.documentTypeKey).toBe('submittal-arch');
      expect(submitRes.spaceId).toBe('proj-1');
      expect(submitRes.isUpdateCard).toBe(false);
      expect(submitRes.notification).toBeUndefined();
      expect(submitRes.executionOutcome?.workflowName).toBe('SubmittalReceived');
      expect(submitRes.executionOutcome?.stepResults).toHaveLength(1);
      expect(lockedFieldsResolver.deriveLockedFields).not.toHaveBeenCalled();

      const startOverRes = (await adapter.processUiEvent({
        hostApp: 'DRIVE',
        actionName: 'startOver',
        selectedItems: [{ id: 'file-1', title: 'Submittal.pdf' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          title_submittal_arch: 'Stale Value',
        },
      })) as UiProcessRenderResult;

      expect(startOverRes.type).toBe('render');
      expect(startOverRes.viewId).toBe('drive-document-process-card');
      expect(startOverRes.popToRoot).toBe(true);
      expect(startOverRes.isUpdateCard).toBe(true);
      expect(startOverRes.formData?.title).toBeUndefined();
    });

    it('enforces partial-failure routing threshold: pushes document-success-card when completedStepCount >= 1 or producedFiles.length >= 1, and keeps inline validationErrors when both are 0 (#386)', async () => {
      const processDocument = vi
        .fn()
        // Case 1: completedStepCount === 1, 0 files (e.g., Step 1 WRITE_LOG succeeded, Step 2 failed)
        .mockResolvedValueOnce({
          success: false,
          errors: ['Step 2 failed'],
          executionOutcome: {
            success: false,
            workflowName: 'SubmittalSent',
            completedStepCount: 1,
            failedStepId: 'moveOriginal',
            spaceName: 'Project Main',
            documentData: {},
            stepResults: [],
            notices: ['Early notice'],
            errors: ['Step 2 failed'],
          },
        })
        // Case 2: completedStepCount === 0, producedFiles.length === 1 (Step 1 multi-file batch failure)
        .mockResolvedValueOnce({
          success: false,
          errors: ['Failed on file 2'],
          executionOutcome: {
            success: false,
            workflowName: 'FileCommProject',
            completedStepCount: 0,
            failedStepId: 'moveFiles',
            spaceName: 'Project Main',
            documentData: {},
            stepResults: [
              {
                stepId: 'moveFiles',
                activityType: 'MOVE_FILE',
                files: [
                  {
                    id: 'moved-1',
                    name: 'First.pdf',
                    parentId: 'dest-1',
                    parentName: 'Communications',
                    uri: 'https://drive.google.com/file/d/moved-1/view',
                  },
                ],
              },
            ],
            notices: [],
            errors: ['Failed on file 2'],
          },
        })
        // Case 3: completedStepCount === 0 && producedFiles.length === 0 (zero-effect failure)
        .mockResolvedValueOnce({
          success: false,
          errors: ['Validation failed before Step 1'],
          contextVariables: { notices: ['Preflight notice'] },
          executionOutcome: {
            success: false,
            workflowName: 'SubmittalReceived',
            completedStepCount: 0,
            failedStepId: 'moveOriginal',
            spaceName: 'Project Main',
            documentData: {},
            stepResults: [],
            notices: ['Preflight notice'],
            errors: ['Validation failed before Step 1'],
          },
        });

      const adapter = new WorkspaceAddonAdapter({
        spaceProvider: submittalSpaceProvider,
        configProvider: mockConfigProvider,
        manifestPort: createSubmittalManifestPort(2),
        documentRunner: { processDocument },
      });

      const baseEvent = {
        hostApp: 'DRIVE' as const,
        actionName: 'processDocument',
        selectedItems: [{ id: 'file-1', title: 'A.pdf' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType_projects: 'submittal-arch',
          SelectFiles: ['file-1'],
        },
      };

      const step1CompleteFail = (await adapter.processUiEvent(baseEvent)) as UiProcessRenderResult;
      expect(step1CompleteFail.viewId).toBe('document-success-card');
      expect(step1CompleteFail.isUpdateCard).toBe(false);
      expect(step1CompleteFail.notification).toBeUndefined();
      expect(step1CompleteFail.executionOutcome?.completedStepCount).toBe(1);
      expect(step1CompleteFail.executionOutcome?.failedStepId).toBe('moveOriginal');

      const batchFail = (await adapter.processUiEvent(baseEvent)) as UiProcessRenderResult;
      expect(batchFail.viewId).toBe('document-success-card');
      expect(batchFail.isUpdateCard).toBe(false);
      expect(batchFail.notification).toBeUndefined();
      expect(batchFail.executionOutcome?.completedStepCount).toBe(0);
      expect(batchFail.executionOutcome?.stepResults[0]?.files).toHaveLength(1);

      const zeroEffectFail = (await adapter.processUiEvent(baseEvent)) as UiProcessRenderResult;
      expect(zeroEffectFail.viewId).toBe('drive-document-process-card');
      expect(zeroEffectFail.isUpdateCard).toBe(true);
      expect(zeroEffectFail.validationErrors).toEqual(['Validation failed before Step 1']);
      expect(zeroEffectFail.statusMessages).toEqual(['Preflight notice']);
    });
  });
});



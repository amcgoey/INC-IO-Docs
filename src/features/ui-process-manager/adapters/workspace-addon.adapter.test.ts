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
  type UiProcessGmailPort,
  type UiProcessGmailMessageDescriptor,
  type UiProcessSourceParserPort,
  type UiProcessSourceContext,
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
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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

      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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
      expect(response).toEqual({
        type: 'notification',
        text: 'Document processed successfully',
      });
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
      expect(response.type).toBe('notification');
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
      expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
        expect(response.type).toBe('notification');
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
      });
    });
  });
});


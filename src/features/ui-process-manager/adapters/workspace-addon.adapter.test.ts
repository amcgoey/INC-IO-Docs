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
  type UiProcessGmailEventContext,
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

    it('does not call gmailPort on in-card action like onFormChange', async () => {
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
      expect(getAttachmentsMock).not.toHaveBeenCalled();
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

    it('maps checked attachments from context.gmail.messageDetails.attachments when selectedItems is empty', async () => {
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
          messageId: 'msg-details-test',
          messageDetails: {
            attachments: [
              {
                attachmentId: 'att-x',
                filename: 'Doc.pdf',
                mimeType: 'application/pdf',
              },
            ],
          },
        } as unknown as UiProcessGmailEventContext,
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'Project Main',
          SelectDocumentType: 'communication-project',
          SelectAttachments: ['att-x'],
        },
      };

      const response = await adapter.processUiEvent(context);
      expect(response.type).toBe('notification');
      expect(mockDocumentRunner.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFiles: [
            {
              id: 'att-x',
              name: 'Doc.pdf',
              mimeType: 'application/pdf',
            },
          ],
        }),
        'onSubmit'
      );
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
    });
  });
});


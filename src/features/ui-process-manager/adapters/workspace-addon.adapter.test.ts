import { describe, it, expect, vi } from 'vitest';
import { WorkspaceAddonAdapter } from './workspace-addon.adapter';
import type {
  UiProcessSpaceProviderPort,
  UiProcessConfigProviderPort,
  UiProcessManifestPort,
  UiProcessViewGeneratorPort,
  UiProcessEventContext,
  UiProcessCardRequest,
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

  it('warns and retains first mapping when document type display names collide', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const collidingManifestPort: UiProcessManifestPort = {
      resolveDocumentTypeKey: vi.fn(),
      getAllDocumentTypes: vi.fn().mockResolvedValue([
        { key: 'first-key', displayName: 'Duplicate Name' },
        { key: 'second-key', displayName: 'Duplicate Name' },
      ]),
    };

    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: {
        getAllTypes: vi.fn().mockReturnValue([
          {
            id: 'projects',
            displayName: 'Projects',
            spaceSchema: { allowedDocumentTypes: ['first-key', 'second-key'] },
          },
        ]),
        getCollection: vi.fn().mockResolvedValue({ spaces: [] }),
      },
      manifestPort: collidingManifestPort,
      viewGenerator: mockViewGenerator,
    });

    const context: UiProcessEventContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'Duplicate Name',
      },
    };

    const result = (await adapter.processUiEvent(context)) as {
      renderedCard: boolean;
      request: UiProcessCardRequest;
    };

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Document type display name collision: "Duplicate Name" is already mapped to "first-key"')
    );
    // Should retain first mapped key
    expect(result.request.documentTypeKey).toBe('first-key');

    warnSpy.mockRestore();
  });
});

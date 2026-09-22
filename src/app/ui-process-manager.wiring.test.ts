import { describe, it, expect, vi } from 'vitest';
import { createUiProcessManagerWiring, resolveActionRoute } from './ui-process-manager.wiring';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { DocumentService } from '../features/document/domain';
import type { RawManifestProviderPort } from './schema-driven-ui.wiring';

import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceSection,
  GoogleWorkspaceWidget,
} from '../infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../features/schema-driven-ui/blocks/document-info';

describe('ui-process-manager.wiring (CQRS Loop)', () => {
  const mockManifestProvider: RawManifestProviderPort = {
    getRawManifest: vi.fn().mockResolvedValue({
      documentTypes: [
        './document-types/communication-project.json',
        './document-types/communication-proposal.json',
      ],
      configuration: {
        workspace: {
          defaultDocumentType: 'communication-project',
          defaultDocumentSpaceType: 'projects',
        },
      },
    }),
    readParsedSchema: vi.fn().mockImplementation(async (relPath: string) => {
      if (relPath.includes('communication-project')) {
        return {
          key: 'communication-project',
          name: 'Communication Project',
          documentSchema: {
            fields: [
              { key: 'contact', name: 'Contact', type: 'string' },
              { key: 'date', name: 'Date', type: 'string' },
            ],
          },
          documentUiSchema: {
            layout: ['contact', 'date'],
            fields: {
              contact: { widget: 'textInput', label: 'Contact', onChange: true },
              date: { widget: 'textInput', label: 'Date' },
            },
          },
        };
      }
      if (relPath.includes('communication-proposal')) {
        return {
          key: 'communication-proposal',
          name: 'Communication Proposal',
          documentSchema: {
            fields: [
              { key: 'proposalId', name: 'Proposal ID', type: 'string' },
            ],
          },
          documentUiSchema: {
            layout: ['proposalId'],
            fields: {
              proposalId: { widget: 'textInput', label: 'Proposal ID' },
            },
          },
        };
      }
      return undefined;
    }),
  };

  const mockDocumentSpaceService = {
    getAllTypes: vi.fn().mockReturnValue([
      {
        id: 'projects',
        displayName: 'Projects',
        spaceSchema: { allowedDocumentTypes: ['communication-project'] },
        storageConfig: {},
      },
      {
        id: 'proposals',
        displayName: 'Proposals',
        spaceSchema: { allowedDocumentTypes: ['communication-proposal'] },
        storageConfig: {},
      },
    ]),
    getCollection: vi.fn().mockImplementation(async (typeId: string) => {
      if (typeId === 'proposals') {
        return {
          type: {
            id: 'proposals',
            displayName: 'Proposals',
            spaceSchema: { allowedDocumentTypes: ['communication-proposal'] },
          },
          spaces: [{ id: 'prop-1', name: 'Proposal 2026' }],
        };
      }
      return {
        type: {
          id: 'projects',
          displayName: 'Projects',
          spaceSchema: { allowedDocumentTypes: ['communication-project'] },
        },
        spaces: [{ id: 'proj-1', name: 'Project Alpha' }],
      };
    }),
  } as unknown as DocumentSpaceService;

  const mockConfigProvider = {
    getWorkspaceConfig: vi.fn().mockResolvedValue({
      defaultDocumentSpaceType: 'projects',
      defaultDocumentType: 'communication-project',
    }),
  };

  it('triggers UI reload and defaults Document Type to first allowed type when Space Type changes', async () => {
    const wiring = createUiProcessManagerWiring({
      configProvider: mockConfigProvider,
      documentSpaceService: mockDocumentSpaceService,
      manifestProvider: mockManifestProvider,
    });

    const simulatedContext: WorkspaceExecutionContext = {
      actionName: 'onSpaceTypeChange',
      formData: {
        SelectDocumentSpaceType: 'proposals',
        SelectDocumentType: 'communication-project',
        contact: 'Should be cleared',
      },
    };

    const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

    // Assert updateCard is returned (UI reload)
    expect(response.action?.navigations?.[0]?.updateCard).toBeDefined();
    const updateCard = response.action!.navigations![0].updateCard!;

    // Find Document Type Selection Section
    const selectionSection = updateCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Type');
    expect(selectionSection).toBeDefined();

    // Verify Document Type defaulted to communication-proposal (first allowed type for proposals)
    const docTypeDropdown = selectionSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) => w.selectionInput?.name === getDocumentTypeWidgetName('proposals')
    )?.selectionInput;
    expect(docTypeDropdown).toBeDefined();
    expect(docTypeDropdown?.items).toHaveLength(1);
    expect(docTypeDropdown?.items?.[0].value).toBe('communication-proposal');
    expect(docTypeDropdown?.items?.[0].text).toBe('Communication Proposal');

    // Find Document Data Section to assert DocumentInfo segment renders active document type widgets
    const dataSection = updateCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Data');
    expect(dataSection).toBeDefined();
    const proposalIdWidget = dataSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) =>
        w.textInput?.name === getDocumentInfoWidgetName('proposalId', 'communication-proposal')
    );
    expect(proposalIdWidget).toBeDefined();
    expect(proposalIdWidget?.textInput?.value).toBeUndefined();

    // Verify previously entered inactive 'contact' widget is not rendered in communication-proposal view
    const contactWidget = dataSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) =>
        w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project') ||
        w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-proposal')
    );
    expect(contactWidget).toBeUndefined();
  });

  it('retains DocumentInfo segment of formData when Document Type changes', async () => {
    const wiring = createUiProcessManagerWiring({
      configProvider: mockConfigProvider,
      documentSpaceService: mockDocumentSpaceService,
      manifestProvider: mockManifestProvider,
    });

    const simulatedContext: WorkspaceExecutionContext = {
      actionName: 'onDocumentTypeChange',
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'communication-project',
        [getDocumentInfoWidgetName('contact', 'communication-project')]: 'Entered Contact Value',
        [getDocumentInfoWidgetName('date', 'communication-project')]: '260920',
      },
    };

    const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

    const updateCard = response.action!.navigations![0].updateCard!;
    const dataSection = updateCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Data');
    expect(dataSection).toBeDefined();

    // Form data must be retained for the document type
    const contactWidget = dataSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) =>
        w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
    );
    const dateWidget = dataSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) =>
        w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
    );
    expect(contactWidget?.textInput?.value).toBe('Entered Contact Value');
    expect(dateWidget?.textInput?.value).toBe('260920');
  });

  it('translates human-readable names into backend keys in write model and resolves display names in read model', async () => {
    const wiring = createUiProcessManagerWiring({
      configProvider: mockConfigProvider,
      documentSpaceService: mockDocumentSpaceService,
      manifestProvider: mockManifestProvider,
    });

    // Client passes human-readable name in SelectDocumentType
    const simulatedContext: WorkspaceExecutionContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'Communication Project',
      },
    };

    const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

    const pushCard = response.action!.navigations![0].pushCard!;
    const selectionSection = pushCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Type');
    const docTypeDropdown = selectionSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) => w.selectionInput?.name === getDocumentTypeWidgetName('projects')
    )?.selectionInput;

    expect(docTypeDropdown).toBeDefined();
    // Query model resolved display name: text: "Communication Project", value: "communication-project"
    expect(docTypeDropdown?.items?.[0]).toEqual({
      text: 'Communication Project',
      value: 'communication-project',
      selected: true,
    });

    const spaceWidget = selectionSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) => w.textInput?.name === getDocumentSpaceWidgetName('projects')
    )?.textInput;
    expect(spaceWidget).toBeDefined();
  });

  it('handles processDocument through wired documentService returning notification on success', async () => {
    const mockDocService = {
      processDocument: vi.fn().mockResolvedValue({
        success: true,
        outputs: [{ id: 'doc-123' }],
      }),
    } as unknown as DocumentService;

    const wiring = createUiProcessManagerWiring({
      configProvider: mockConfigProvider,
      documentSpaceService: mockDocumentSpaceService,
      manifestProvider: mockManifestProvider,
      documentService: mockDocService,
    });

    const simulatedContext: WorkspaceExecutionContext = {
      actionName: 'processDocument',
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'Communication Project',
        contact: 'Alice Corp',
        date: '260920',
      },
      userOAuthToken: 'test-oauth-token',
      selectedItems: [{ id: 'file-123' }],
    };

    const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

    expect(mockDocService.processDocument).toHaveBeenCalledWith(
      {
        type: 'communication-project',
        space: 'Project Alpha',
        data: {
          contact: 'Alice Corp',
          date: '260920',
        },
      },
      'onSubmit',
      {
        credentials: { oauthToken: 'test-oauth-token' },
        resources: { primaryTargetId: 'file-123' },
      }
    );

    expect(response.action?.notification?.text).toBe('Document processed successfully');
  });

  it('handles processDocument failure through wired documentService returning error card with validation errors', async () => {
    const mockDocService = {
      processDocument: vi.fn().mockResolvedValue({
        success: false,
        errors: ['Missing required field: contact'],
      }),
    } as unknown as DocumentService;

    const wiring = createUiProcessManagerWiring({
      configProvider: mockConfigProvider,
      documentSpaceService: mockDocumentSpaceService,
      manifestProvider: mockManifestProvider,
      documentService: mockDocService,
    });

    const simulatedContext: WorkspaceExecutionContext = {
      actionName: 'processDocument',
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'communication-project',
      },
    };

    const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

    expect(response.action?.navigations?.[0]?.updateCard).toBeDefined();
    const updateCard = response.action!.navigations![0].updateCard!;
    const statusSection = updateCard.sections?.find((s: GoogleWorkspaceSection) =>
      s.widgets?.some((w) => w.textParagraph?.text?.includes('Missing required field: contact'))
    );
    expect(statusSection).toBeDefined();
  });

  it('correctly routes onFormChange actions to /workspace/on-form-change and standard actions to /workspace/action in generated navigation cards', async () => {
    const wiring = createUiProcessManagerWiring({
      configProvider: mockConfigProvider,
      documentSpaceService: mockDocumentSpaceService,
      manifestProvider: mockManifestProvider,
    });

    const simulatedContext: WorkspaceExecutionContext = {
      formData: {
        SelectDocumentSpaceType: 'projects',
        SelectDocumentType: 'communication-project',
      },
    };

    const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;
    const pushCard = response.action!.navigations![0].pushCard!;

    // 1. Verify onSpaceTypeChange on selectionInput is routed to /workspace/action
    const docTypeSection = pushCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Type');
    const spaceTypeWidget = docTypeSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) => w.selectionInput?.name === 'SelectDocumentSpaceType'
    )?.selectionInput;
    expect(spaceTypeWidget?.onChangeAction).toEqual({
      function: '/workspace/action',
      parameters: [{ key: 'action', value: 'onSpaceTypeChange' }],
      loadIndicator: 'SPINNER',
    });

    // 2. Verify contact textInput with onChange: true is routed to /workspace/on-form-change
    const dataSection = pushCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Data');
    const contactWidget = dataSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) =>
        w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
    )?.textInput;
    expect(contactWidget?.onChangeAction).toEqual({
      function: '/workspace/on-form-change',
      parameters: [{ key: 'action', value: 'onFormChange' }],
      loadIndicator: 'SPINNER',
    });

    // 3. Verify processDocument button is routed to /workspace/action
    const buttonListWidget = dataSection?.widgets?.find(
      (w: GoogleWorkspaceWidget) => w.buttonList !== undefined
    )?.buttonList;
    const processButton = buttonListWidget?.buttons.find((b) => b.text === 'Process Document');
    expect(processButton?.onClick).toEqual({
      action: {
        function: '/workspace/action',
        parameters: [{ key: 'action', value: 'processDocument' }],
        loadIndicator: 'SPINNER',
      },
    });
  });

  describe('resolveActionRoute & baseUrl URL resolution in wiring layer', () => {
    it('prepends baseUrl to relative paths and handles slashes cleanly', () => {
      expect(resolveActionRoute('/workspace/action', 'https://example.com')).toBe(
        'https://example.com/workspace/action'
      );
      expect(resolveActionRoute('workspace/action', 'https://example.com')).toBe(
        'https://example.com/workspace/action'
      );
      expect(resolveActionRoute('/workspace/action', 'https://example.com/')).toBe(
        'https://example.com/workspace/action'
      );
      expect(resolveActionRoute('/workspace/action', 'https://example.com///')).toBe(
        'https://example.com/workspace/action'
      );
    });

    it('preserves already fully-qualified HTTPS and HTTP URLs', () => {
      expect(resolveActionRoute('https://my-host.com/workspace/action', 'https://example.com')).toBe(
        'https://my-host.com/workspace/action'
      );
      expect(resolveActionRoute('http://my-host.com/workspace/action', 'https://example.com')).toBe(
        'http://my-host.com/workspace/action'
      );
    });

    it('returns relative route as-is when baseUrl is undefined', () => {
      expect(resolveActionRoute('/workspace/action', undefined)).toBe('/workspace/action');
    });

    it('resolves action URLs to fully-qualified HTTPS URLs when baseUrl is provided in WorkspaceExecutionContext', async () => {
      const wiring = createUiProcessManagerWiring({
        configProvider: mockConfigProvider,
        documentSpaceService: mockDocumentSpaceService,
        manifestProvider: mockManifestProvider,
      });

      const simulatedContext: WorkspaceExecutionContext = {
        baseUrl: 'https://addon.wired.com',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;
      const pushCard = response.action!.navigations![0].pushCard!;

      const docTypeSection = pushCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Type');
      const spaceTypeWidget = docTypeSection?.widgets?.find(
        (w: GoogleWorkspaceWidget) => w.selectionInput?.name === 'SelectDocumentSpaceType'
      )?.selectionInput;
      expect(spaceTypeWidget?.onChangeAction?.function).toBe(
        'https://addon.wired.com/workspace/action'
      );

      const dataSection = pushCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Data');
      const contactWidget = dataSection?.widgets?.find(
        (w: GoogleWorkspaceWidget) =>
          w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      )?.textInput;
      expect(contactWidget?.onChangeAction?.function).toBe(
        'https://addon.wired.com/workspace/on-form-change'
      );
    });
  });
});



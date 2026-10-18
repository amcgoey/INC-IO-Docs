import { describe, it, expect, vi } from 'vitest';
import {
  createUiProcessManagerWiring,
  resolveActionRoute,
  createUiProcessRequestWrapper,
} from './ui-process-manager.wiring';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { DocumentService } from '../features/document/domain';
import type { SchemaDrivenUiService } from '../features/schema-driven-ui/domain';
import type { RawManifestProviderPort } from './schema-driven-ui.wiring';
import type { OptionsFetcherPort } from '../features/schema-driven-ui/ports';
import type { UiProcessOrchestratorPort } from '../features/ui-process-manager/ports';

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
        spaces: [
          { id: 'proj-1', name: 'Project Alpha' },
          { id: 'space-folder-xyz', name: 'Folder XYZ' },
          { id: 'new-space-folder-id', name: 'new-space-folder-id' },
        ],
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

    const response = (await wiring.requestScopedWrapper.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

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

    const response = (await wiring.requestScopedWrapper.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

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

    const response = (await wiring.requestScopedWrapper.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

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

    const response = (await wiring.requestScopedWrapper.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

    expect(mockDocService.processDocument).toHaveBeenCalledWith(
      {
        type: 'communication-project',
        space: {
          id: 'proj-1',
          name: 'Project Alpha',
          typeId: 'projects',
          abstractStorageId: 'proj-1',
        },
        data: {
          contact: 'Alice Corp',
          date: '260920',
        },
      },
      'onSubmit'
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
        SelectDocumentSpace: 'Project Alpha',
        SelectDocumentType: 'communication-project',
      },
      selectedItems: [{ id: 'file-123' }],
    };

    const response = (await wiring.requestScopedWrapper.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

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

    const response = (await wiring.requestScopedWrapper.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;
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

      const response = (await wiring.requestScopedWrapper.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;
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

  describe('createUiProcessRequestWrapper (CQRS Request-Scoped Wrapper)', () => {
    it('intercepts notification intent and translates into infrastructure notification JSON', async () => {
      const mockOrchestrator = {
        processUiEvent: vi.fn().mockResolvedValue({
          type: 'notification',
          text: 'Operation completed successfully',
        }),
      };
      const mockSchemaDrivenUi = {
        generateView: vi.fn(),
      } as unknown as SchemaDrivenUiService;

      const wrapper = createUiProcessRequestWrapper(mockOrchestrator, mockSchemaDrivenUi);

      const context: WorkspaceExecutionContext = {
        actionName: 'processDocument',
        formData: { some: 'value' },
        baseUrl: 'https://example.com',
      };

      const result = await wrapper(context);

      expect(mockOrchestrator.processUiEvent).toHaveBeenCalledWith({
        actionName: 'processDocument',
        formData: { some: 'value' },
        parameters: undefined,
        validationErrors: undefined,
        userOAuthToken: undefined,
        selectedItems: undefined,
      });
      expect(mockSchemaDrivenUi.generateView).not.toHaveBeenCalled();
      expect(result).toEqual({
        action: {
          notification: {
            text: 'Operation completed successfully',
          },
        },
      });
    });

    it('intercepts render intent, queries SchemaDrivenUi read module, and translates with baseUrl', async () => {
      const mockOrchestrator = {
        processUiEvent: vi.fn().mockResolvedValue({
          type: 'render',
          viewId: 'test-view',
          documentTypeKey: 'doc-type-1',
          formData: { field1: 'val1' },
          isUpdateCard: true,
        }),
      };
      const mockSchemaDrivenUi = {
        generateView: vi.fn().mockResolvedValue({
          id: 'rendered-view',
          sections: [
            {
              header: 'Section 1',
              widgets: [
                {
                  textInput: {
                    name: 'field1',
                    onChangeAction: { action: 'onFormChange' },
                  },
                },
              ],
            },
          ],
        }),
      } as unknown as SchemaDrivenUiService;

      const wrapper = createUiProcessRequestWrapper(mockOrchestrator, mockSchemaDrivenUi);

      const context: WorkspaceExecutionContext = {
        baseUrl: 'https://my-host.internal',
        formData: { field1: 'val1' },
      };

      const result = (await wrapper(context)) as GoogleWorkspaceActionResponse;

      expect(mockOrchestrator.processUiEvent).toHaveBeenCalled();
      expect(mockSchemaDrivenUi.generateView).toHaveBeenCalledWith(
        expect.objectContaining({
          viewId: 'test-view',
          documentTypeKey: 'doc-type-1',
          formData: { field1: 'val1' },
        })
      );

      // Verify updateCard returned and baseUrl applied to action routes
      expect(result.action.navigations?.[0]?.updateCard).toBeDefined();
      const updateCard = result.action.navigations![0].updateCard!;
      const widget = updateCard.sections[0].widgets[0];
      expect(widget.textInput?.onChangeAction?.function).toBe(
        'https://my-host.internal/workspace/on-form-change'
      );
    });

    it('supports asynchronous resolver functions for per-request instantiation', async () => {
      const mockOrchestrator = {
        processUiEvent: vi.fn().mockResolvedValue({
          type: 'notification',
          text: 'Resolved per-request',
        }),
      };
      const mockSchemaDrivenUi = {} as unknown as SchemaDrivenUiService;

      const orchestratorResolver = vi.fn().mockResolvedValue(mockOrchestrator);
      const schemaUiResolver = vi.fn().mockResolvedValue(mockSchemaDrivenUi);

      const wrapper = createUiProcessRequestWrapper(orchestratorResolver, schemaUiResolver);

      const context: WorkspaceExecutionContext = {
        actionName: 'customAction',
        userOAuthToken: 'token-resolver-test',
      };

      const result = await wrapper(context);

      expect(orchestratorResolver).toHaveBeenCalledWith(context);
      expect(mockOrchestrator.processUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'customAction',
        })
      );
      expect(result).toEqual({
        action: {
          notification: {
            text: 'Resolved per-request',
          },
        },
      });
    });
  });

  describe('Request-scoped wiring and concurrency token isolation', () => {
    it('isolates OAuth tokens and execution context across concurrent requests using createDocumentService', async () => {
      interface TrackedService {
        token?: string | undefined;
        targetId?: string | undefined;
        mockProcessDocument: ReturnType<typeof vi.fn>;
      }

      const trackedServices: TrackedService[] = [];

      const createDocumentService = vi.fn(async (context: WorkspaceExecutionContext) => {
        // Asynchronous delay simulating per-request client/adapter instantiation
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 20 + 5));

        const mockProcessDocument = vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 15 + 5));
          return {
            success: true,
            outputs: [{ id: context.selectedItems?.[0]?.id }],
          };
        });

        const service = {
          processDocument: mockProcessDocument,
        } as unknown as DocumentService;

        trackedServices.push({
          token: context.userOAuthToken,
          targetId: context.selectedItems?.[0]?.id,
          mockProcessDocument,
        });

        return service;
      });

      const wiring = createUiProcessManagerWiring({
        configProvider: mockConfigProvider,
        documentSpaceService: mockDocumentSpaceService,
        manifestProvider: mockManifestProvider,
        createDocumentService,
      });

      const req1: WorkspaceExecutionContext = {
        actionName: 'processDocument',
        userOAuthToken: 'token-user-alpha',
        selectedItems: [{ id: 'file-target-alpha' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Alpha',
          SelectDocumentType: 'communication-project',
          contact: 'Alpha Contact',
          date: '260901',
        },
      };

      const req2: WorkspaceExecutionContext = {
        actionName: 'processDocument',
        userOAuthToken: 'token-user-beta',
        selectedItems: [{ id: 'file-target-beta' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Alpha',
          SelectDocumentType: 'communication-project',
          contact: 'Beta Contact',
          date: '260902',
        },
      };

      const req3: WorkspaceExecutionContext = {
        actionName: 'processDocument',
        userOAuthToken: 'token-user-gamma',
        selectedItems: [{ id: 'file-target-gamma' }],
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace: 'Project Alpha',
          SelectDocumentType: 'communication-project',
          contact: 'Gamma Contact',
          date: '260903',
        },
      };

      // Launch all 3 requests simultaneously
      const [res1, res2, res3] = (await Promise.all([
        wiring.requestScopedWrapper.processUiEvent(req1),
        wiring.requestScopedWrapper.processUiEvent(req2),
        wiring.requestScopedWrapper.processUiEvent(req3),
      ])) as GoogleWorkspaceActionResponse[];

      // All requests must succeed
      expect(res1.action?.notification?.text).toBe('Document processed successfully');
      expect(res2.action?.notification?.text).toBe('Document processed successfully');
      expect(res3.action?.notification?.text).toBe('Document processed successfully');

      // createDocumentService factory was invoked exactly 3 times
      expect(createDocumentService).toHaveBeenCalledTimes(3);

      // Verify each factory invocation received isolated request context
      const alphaTracked = trackedServices.find((s) => s.token === 'token-user-alpha');
      const betaTracked = trackedServices.find((s) => s.token === 'token-user-beta');
      const gammaTracked = trackedServices.find((s) => s.token === 'token-user-gamma');

      expect(alphaTracked).toBeDefined();
      expect(alphaTracked?.targetId).toBe('file-target-alpha');
      expect(alphaTracked?.mockProcessDocument).toHaveBeenCalledTimes(1);
      expect(alphaTracked?.mockProcessDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'proj-1',
            name: 'Project Alpha',
            typeId: 'projects',
            abstractStorageId: 'proj-1',
          },
          data: expect.objectContaining({ contact: 'Alpha Contact', date: '260901' }),
        }),
        'onSubmit'
      );

      expect(betaTracked).toBeDefined();
      expect(betaTracked?.targetId).toBe('file-target-beta');
      expect(betaTracked?.mockProcessDocument).toHaveBeenCalledTimes(1);
      expect(betaTracked?.mockProcessDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'proj-1',
            name: 'Project Alpha',
            typeId: 'projects',
            abstractStorageId: 'proj-1',
          },
          data: expect.objectContaining({ contact: 'Beta Contact', date: '260902' }),
        }),
        'onSubmit'
      );

      expect(gammaTracked).toBeDefined();
      expect(gammaTracked?.targetId).toBe('file-target-gamma');
      expect(gammaTracked?.mockProcessDocument).toHaveBeenCalledTimes(1);
      expect(gammaTracked?.mockProcessDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          space: {
            id: 'proj-1',
            name: 'Project Alpha',
            typeId: 'projects',
            abstractStorageId: 'proj-1',
          },
          data: expect.objectContaining({ contact: 'Gamma Contact', date: '260903' }),
        }),
        'onSubmit'
      );
    });

    it('isolates request-scoped DocumentSpaceService instances across concurrent requests', async () => {
      const spaceCalls: Array<{ token?: string | undefined }> = [];

      const createDocumentSpaceService = vi.fn(async (context: WorkspaceExecutionContext) => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15 + 5));

        return {
          getAllTypes: () => [
            {
              id: 'projects',
              displayName: 'Projects',
              spaceSchema: { allowedDocumentTypes: ['communication-project'] },
              storageConfig: {},
            },
          ],
          getCollection: vi.fn(async () => {
            spaceCalls.push({ token: context.userOAuthToken });
            return {
              type: {
                id: 'projects',
                displayName: 'Projects',
                spaceSchema: { allowedDocumentTypes: ['communication-project'] },
              },
              spaces: [{ id: `space-${context.userOAuthToken}`, name: `Space for ${context.userOAuthToken}` }],
            };
          }),
        } as unknown as DocumentSpaceService;
      });

      const wiring = createUiProcessManagerWiring({
        configProvider: mockConfigProvider,
        createDocumentSpaceService,
        manifestProvider: mockManifestProvider,
      });

      const reqA: WorkspaceExecutionContext = {
        actionName: 'onSpaceTypeChange',
        userOAuthToken: 'token-client-A',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const reqB: WorkspaceExecutionContext = {
        actionName: 'onSpaceTypeChange',
        userOAuthToken: 'token-client-B',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentType: 'communication-project',
        },
      };

      const [resA, resB] = (await Promise.all([
        wiring.requestScopedWrapper.processUiEvent(reqA),
        wiring.requestScopedWrapper.processUiEvent(reqB),
      ])) as GoogleWorkspaceActionResponse[];

      expect(resA.action?.navigations?.[0]?.updateCard).toBeDefined();
      expect(resB.action?.navigations?.[0]?.updateCard).toBeDefined();

      expect(createDocumentSpaceService).toHaveBeenCalledTimes(2);
      expect(createDocumentSpaceService).toHaveBeenCalledWith(reqA);
      expect(createDocumentSpaceService).toHaveBeenCalledWith(reqB);

      expect(spaceCalls).toEqual(
        expect.arrayContaining([{ token: 'token-client-A' }, { token: 'token-client-B' }])
      );
    });

    it('throws error on startup if neither documentSpaceService nor createDocumentSpaceService is provided', () => {
      expect(() =>
        createUiProcessManagerWiring({
          configProvider: mockConfigProvider,
          manifestProvider: mockManifestProvider,
        })
      ).toThrow(/Either documentSpaceService or createDocumentSpaceService must be provided/);
    });

    const createDynamicManifestProvider = (): RawManifestProviderPort => ({
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/communication-project.json'],
        configuration: {
          workspace: {
            defaultDocumentType: 'communication-project',
            defaultDocumentSpaceType: 'projects',
          },
        },
      }),
      readParsedSchema: vi.fn().mockImplementation(async () => {
        return {
          key: 'communication-project',
          name: 'Communication Project',
          documentSchema: {
            fields: [
              {
                key: 'contact',
                name: 'Contact',
                type: 'string',
                options: {
                  source: 'contactFolders',
                  key: 'name',
                  name: 'name',
                  allowUserInput: true,
                  dynamicConfig: {
                    provider: 'google_drive',
                    method: 'list_folders',
                    relativePath: '1 Admin/Communication',
                  },
                },
              },
            ],
          },
          documentUiSchema: {
            layout: ['contact'],
            fields: {
              contact: { widget: 'selectionInput', label: 'Contact' },
            },
          },
        };
      }),
    });

    it('wires dynamic options fetcher so that documents load dynamic dropdown options', async () => {
      const dynamicManifestProvider = createDynamicManifestProvider();

      const mockFetcher: OptionsFetcherPort = {
        fetchOptions: vi.fn().mockResolvedValue({
          contactFolders: [
            { text: 'Folder Alpha', value: 'Folder Alpha' },
            { text: 'Folder Beta', value: 'Folder Beta' },
          ],
        }),
      };

      const wiring = createUiProcessManagerWiring({
        configProvider: mockConfigProvider,
        documentSpaceService: mockDocumentSpaceService,
        manifestProvider: dynamicManifestProvider,
        optionsFetcher: mockFetcher,
      });

      const response = (await wiring.requestScopedWrapper.processUiEvent({
        actionName: 'onSpaceTypeChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'space-folder-xyz',
          SelectDocumentType: 'communication-project',
        },
      })) as GoogleWorkspaceActionResponse;

      expect(mockFetcher.fetchOptions).toHaveBeenCalledWith(
        [
          {
            sourceKey: 'contactFolders',
            config: {
              provider: 'google_drive',
              method: 'list_folders',
              relativePath: '1 Admin/Communication',
            },
          },
        ],
        expect.objectContaining({
          spaceId: 'space-folder-xyz',
        })
      );

      const updateCard = response.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();
      const docInfoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
      expect(docInfoSection).toBeDefined();
      const contactWidget = docInfoSection!.widgets.find(
        (w) => w.selectionInput?.name === 'contact_communication-project'
      );
      expect(contactWidget).toBeDefined();
      expect(contactWidget!.selectionInput?.items).toEqual([
        { text: 'Folder Alpha', value: 'Folder Alpha' },
        { text: 'Folder Beta', value: 'Folder Beta' },
      ]);
    });

    it('fetches dynamic options for contact field and retains space input value when onFormChange is triggered by document space change', async () => {
      const mockFetcher = {
        fetchOptions: vi.fn().mockResolvedValue({
          contactFolders: [
            { text: 'Client ACME', value: 'Client ACME' },
          ],
        }),
      };

      const wiring = createUiProcessManagerWiring({
        configProvider: mockConfigProvider,
        documentSpaceService: mockDocumentSpaceService,
        manifestProvider: createDynamicManifestProvider(),
        optionsFetcher: mockFetcher,
      });

      const response = (await wiring.requestScopedWrapper.processUiEvent({
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: 'new-space-folder-id',
          SelectDocumentType_projects: 'communication-project',
        },
      })) as GoogleWorkspaceActionResponse;

      expect(mockFetcher.fetchOptions).toHaveBeenCalledWith(
        [
          {
            sourceKey: 'contactFolders',
            config: {
              provider: 'google_drive',
              method: 'list_folders',
              relativePath: '1 Admin/Communication',
            },
          },
        ],
        expect.objectContaining({
          spaceId: 'new-space-folder-id',
        })
      );

      const updateCard = response.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      // Document Type Selection section: Document Space widget retains value and has onChangeAction
      const docTypeSection = updateCard!.sections.find((s) => s.header === 'Document Type');
      expect(docTypeSection).toBeDefined();
      const spaceWidget = docTypeSection!.widgets.find(
        (w) => w.textInput?.name === 'SelectDocumentSpace_projects'
      );
      expect(spaceWidget).toBeDefined();
      expect(spaceWidget!.textInput?.value).toBe('new-space-folder-id');
      expect(spaceWidget!.textInput?.onChangeAction?.function).toMatch(/\/workspace\/on-form-change$/);

      // Document Data section: Contact widget receives updated options
      const docInfoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
      expect(docInfoSection).toBeDefined();
      const contactWidget = docInfoSection!.widgets.find(
        (w) => w.selectionInput?.name === 'contact_communication-project'
      );
      expect(contactWidget).toBeDefined();
      expect(contactWidget!.selectionInput?.items).toEqual([
        { text: 'Client ACME', value: 'Client ACME' },
      ]);
    });

    it('clears spaceId and does not pass stale spaceId to dynamic options fetcher when user clears space input on onFormChange', async () => {
      const mockFetcher: OptionsFetcherPort = {
        fetchOptions: vi.fn().mockResolvedValue({
          contactFolders: [],
        }),
      };

      const wiring = createUiProcessManagerWiring({
        configProvider: mockConfigProvider,
        documentSpaceService: mockDocumentSpaceService,
        manifestProvider: createDynamicManifestProvider(),
        optionsFetcher: mockFetcher,
      });

      const response = (await wiring.requestScopedWrapper.processUiEvent({
        actionName: 'onFormChange',
        formData: {
          SelectDocumentSpaceType: 'projects',
          SelectDocumentSpace_projects: '',
          SelectDocumentType_projects: 'communication-project',
          spaceId: 'stale-space-folder-id',
        },
      })) as GoogleWorkspaceActionResponse;

      expect(mockFetcher.fetchOptions).toHaveBeenCalledWith(
        expect.any(Array),
        expect.not.objectContaining({
          spaceId: 'stale-space-folder-id',
        })
      );
      const callContext = (mockFetcher.fetchOptions as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(callContext.spaceId).toBeUndefined();
      expect(callContext.formData?.spaceId).toBeUndefined();

      const updateCard = response.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      const docInfoSection = updateCard!.sections.find((s) => s.header === 'Document Data');
      expect(docInfoSection).toBeDefined();
      const contactWidget = docInfoSection!.widgets.find(
        (w) => w.selectionInput?.name === 'contact_communication-project'
      );
      expect(contactWidget).toBeDefined();
      expect(contactWidget!.selectionInput?.items).toEqual([]);
    });
  });

  describe('createUiProcessRequestWrapper file selection forwarding', () => {
    it('forwards intent.selectionState.files to schemaDrivenUiService.generateView', async () => {
      const mockOrchestrator = {
        processUiEvent: vi.fn().mockResolvedValue({
          type: 'render',
          viewId: 'drive-document-process-card',
          documentTypeKey: 'communication-project',
          selectionState: {
            spaces: ['Project Alpha'],
            spaceTypes: [{ text: 'Projects', value: 'projects', selected: true }],
            documentTypes: [{ text: 'Comm Project', value: 'comm-project', selected: true }],
            files: [{ text: 'Proposal.pdf', value: 'file-123', selected: true }],
          },
          formData: {},
          isUpdateCard: false,
        }),
      };

      const mockSchemaDrivenUi = {
        generateView: vi.fn().mockResolvedValue({
          id: 'drive-document-process-card',
          header: { title: 'Test', subtitle: 'Test' },
          sections: [{ header: 'Test', widgets: [{ textParagraph: { text: 'test' } }] }],
        }),
      };

      const wrapper = createUiProcessRequestWrapper(
        mockOrchestrator as unknown as UiProcessOrchestratorPort,
        mockSchemaDrivenUi as unknown as SchemaDrivenUiService
      );

      await wrapper.processUiEvent({
        baseUrl: 'http://localhost:3000',
        selectedItems: [{ id: 'file-123', title: 'Proposal.pdf' }],
      });

      expect(mockSchemaDrivenUi.generateView).toHaveBeenCalledWith(
        expect.objectContaining({
          selectionState: expect.objectContaining({
            files: [{ text: 'Proposal.pdf', value: 'file-123', selected: true }],
          }),
        })
      );
    });
  });
});



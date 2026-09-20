import { describe, it, expect, vi } from 'vitest';
import { createUiProcessManagerWiring } from './ui-process-manager.wiring';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type { RawManifestProviderPort } from './schema-driven-ui.wiring';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceSection,
  GoogleWorkspaceWidget,
} from '../infrastructure/workspace-addon/ui-blocks';

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
              contact: { widget: 'textInput', label: 'Contact' },
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
      (w: GoogleWorkspaceWidget) => w.selectionInput?.name === 'SelectDocumentType'
    )?.selectionInput;
    expect(docTypeDropdown).toBeDefined();
    expect(docTypeDropdown?.items).toHaveLength(1);
    expect(docTypeDropdown?.items?.[0].value).toBe('communication-proposal');
    expect(docTypeDropdown?.items?.[0].text).toBe('Communication Proposal');

    // Find Document Data Section to assert DocumentInfo segment was cleared
    const dataSection = updateCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Data');
    expect(dataSection).toBeDefined();
    const contactWidget = dataSection?.widgets?.find((w: GoogleWorkspaceWidget) => w.textInput?.name === 'contact');
    expect(contactWidget?.textInput?.value).toBeUndefined();
  });

  it('explicitly clears DocumentInfo segment of formData when Document Type changes', async () => {
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
        contact: 'Old Contact Value',
        date: '260920',
      },
    };

    const response = (await wiring.orchestrator.processUiEvent(simulatedContext)) as GoogleWorkspaceActionResponse;

    const updateCard = response.action!.navigations![0].updateCard!;
    const dataSection = updateCard.sections?.find((s: GoogleWorkspaceSection) => s.header === 'Document Data');
    expect(dataSection).toBeDefined();

    // Form data must be cleared of old values
    const contactWidget = dataSection?.widgets?.find((w: GoogleWorkspaceWidget) => w.textInput?.name === 'contact');
    const dateWidget = dataSection?.widgets?.find((w: GoogleWorkspaceWidget) => w.textInput?.name === 'date');
    expect(contactWidget?.textInput?.value).toBeUndefined();
    expect(dateWidget?.textInput?.value).toBeUndefined();
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
      (w: GoogleWorkspaceWidget) => w.selectionInput?.name === 'SelectDocumentType'
    )?.selectionInput;

    expect(docTypeDropdown).toBeDefined();
    // Query model resolved display name: text: "Communication Project", value: "communication-project"
    expect(docTypeDropdown?.items?.[0]).toEqual({
      text: 'Communication Project',
      value: 'communication-project',
      selected: true,
    });
  });
});

import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance, type Mock } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { OAuth2Client } from 'google-auth-library';
import { createApp, type AppInstance } from '../../src/app/server';
import {
  injectWorkspaceRequest,
  DEFAULT_WORKSPACE_BASE_URL,
} from './utils/workspace-request';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import type { WorkspaceAuthVerifierPort } from '../../src/infrastructure/workspace-addon/api';
import type { DocumentSpaceStoragePort } from '../../src/features/document-space/ports';
import type { DriveServicePort, DocumentServicePort } from '../../src/features/document/ports';
import {
  GoogleWorkspaceActionResponseSchema,
  GoogleWorkspaceCardSchema,
  GoogleWorkspaceHeaderSchema,
  GoogleWorkspaceSectionSchema,
} from '../../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../../src/features/schema-driven-ui/blocks/document-info';

interface WidgetStub {
  textParagraph?: { text?: string };
  textInput?: { name: string; value?: string; initialSuggestions?: { items: { text: string }[] } };
  selectionInput?: { name: string; type?: string; items: { text?: string; value: string; selected?: boolean }[] };
  buttonList?: { buttons: Array<{ text: string; onClick?: { action?: { function?: string; parameters?: Array<{ key: string; value: string }> } } }> };
}

interface SectionStub {
  header?: string;
  collapsible?: boolean;
  widgets: WidgetStub[];
}

function findSection(sections: SectionStub[], header: string): SectionStub | undefined {
  return sections.find((s) => s.header === header);
}

function findWidget(section: SectionStub | undefined, name: string): WidgetStub | undefined {
  return section?.widgets.find(
    (w) => w.textInput?.name === name || w.selectionInput?.name === name
  );
}

describe('Workspace Addon UI E2E Test Suite', () => {
  let app: AppInstance;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockStorageAdapter: DocumentSpaceStoragePort;
  let mockDriveService: DriveServicePort;
  let mockDocumentService: DocumentServicePort & {
    initialize: ReturnType<typeof vi.fn>;
    processDocument: Mock<DocumentServicePort['processDocument']>;
  };

  let driveNetworkSpy: MockInstance;
  let oauthNetworkSpy: MockInstance;
  let fetchSpy: MockInstance;

  beforeEach(async () => {
    // 1. Guard against any real network calls from Google SDKs or global fetch
    driveNetworkSpy = vi
      .spyOn(
        GoogleDriveClient.prototype as unknown as { executeWithRetry: () => unknown },
        'executeWithRetry'
      )
      .mockImplementation(() => {
        throw new Error('Unexpected network call via GoogleDriveClient.executeWithRetry');
      });
    oauthNetworkSpy = vi
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockImplementation(async () => {
        throw new Error('Unexpected network call via OAuth2Client.verifyIdToken');
      });
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected network call via globalThis.fetch');
    });

    // 2. Configure mocks injected at the application edge
    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return {
            isValid: true,
            payload: { email: 'e2e-tester@example.com', sub: 'user-e2e-123' },
          };
        }
        return {
          isValid: false,
          error: 'Unauthorized ID token',
        };
      }),
    };

    mockStorageAdapter = {
      fetchSpaces: vi.fn().mockImplementation(async (_config, typeId: string) => [
        {
          id: `space-${typeId}-1`,
          typeId,
          name: typeId === 'projects' ? 'Active Projects' : 'Client Proposals',
          abstractStorageId: `folder-${typeId}-1`,
        },
      ]),
      resolveStorageLocation: vi.fn().mockImplementation(async (abstractStorageId: string) => ({
        provider: 'google_drive',
        abstractStorageId,
      })),
    };

    mockDriveService = {
      getFile: vi.fn().mockResolvedValue({ id: 'file-123', name: 'Invoice.pdf', parents: ['root'] }),
      findOrCreateFolder: vi.fn().mockResolvedValue({ id: 'folder-1', name: '!TestMove', parents: ['root'] }),
      move: vi.fn().mockResolvedValue({ id: 'file-123', name: 'Invoice.pdf', parents: ['folder-1'] }),
      rename: vi.fn().mockResolvedValue({ id: 'file-123', name: 'Renamed.pdf', parents: ['root'] }),
      duplicate: vi.fn().mockResolvedValue({ id: 'file-123-copy', name: 'Invoice.pdf', parents: ['root'] }),
      searchFiles: vi.fn().mockResolvedValue([]),
      downloadAsBuffer: vi.fn().mockResolvedValue(new Uint8Array()),
      saveBuffer: vi.fn().mockResolvedValue({ id: 'saved-1', name: 'Saved.pdf', parents: ['root'] }),
      uploadStream: vi.fn().mockResolvedValue({ id: 'stream-1', name: 'Streamed.pdf', parents: ['root'] }),
    };

    mockDocumentService = {
      initialize: vi.fn().mockResolvedValue(undefined),
      processDocument: vi.fn().mockResolvedValue({
        success: true,
        data: {
          type: 'communication-project',
          data: {
            contact: 'Acme Corp',
            date: '260921',
            direction: 'IN',
            description: 'E2E Test Execution',
          },
        },
        activities: [],
        outputs: [],
      }),
    };

    // 3. Load the real manifest configuration from disk
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });

    // 4. Initialize application with edge-injected mocks
    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
      storageAdapter: mockStorageAdapter,
      driveService: mockDriveService,
      documentService: mockDocumentService,
    });

    await app.initialize();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Skeleton initialization & dependency injection', () => {
    it('initializes app with real assets/manifest.json and edge-injected mock documentService', () => {
      expect(app.server).toBeDefined();
      expect(app.documentService).toBe(mockDocumentService);
      expect(mockDocumentService.initialize).toHaveBeenCalled();
    });

    it('proves no real network calls are made during initialization', () => {
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Base server.inject execution against mock and manifest', () => {
    it('executes POST /workspace/drive-items-selected with server.inject using real manifest and mocks', async () => {
      const triggerPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        drive: {
          selectedItems: [
            {
              id: 'drive-file-001',
              title: 'Q4_Strategy_Plan.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: triggerPayload,
      });

      // 1. Assert status code
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);

      // 2. Validate Google Workspace Action Response contract
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.navigations).toBeDefined();

      const pushCard = body.action!.navigations![0].pushCard;
      expect(pushCard).toBeDefined();
      expect(pushCard.header.title).toBe('INC-IO Engine');
      expect(pushCard.header.subtitle).toBe('Process Document');

      // 3. Verify sections loaded from real manifest.json
      const sections = pushCard.sections;

      // Section 1: Document Type selection block
      const docTypeSection = findSection(sections, 'Document Type');
      expect(docTypeSection).toBeDefined();
      expect(docTypeSection?.widgets).toHaveLength(3);

      const spaceTypeWidget = findWidget(docTypeSection, 'SelectDocumentSpaceType');
      expect(spaceTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Projects', value: 'projects' }),
          expect.objectContaining({ text: 'Proposals', value: 'proposals' }),
        ])
      );

      // Verify Document Space text input has suggestions populated from mockStorageAdapter
      const spaceWidget = findWidget(docTypeSection, getDocumentSpaceWidgetName('projects'));
      expect(spaceWidget?.textInput?.initialSuggestions?.items).toEqual([
        { text: 'Active Projects' },
      ]);

      // Verify Document Type dropdown contains allowed document types for 'projects' from manifest
      const docTypeWidget = findWidget(docTypeSection, getDocumentTypeWidgetName('projects'));
      expect(docTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'communication-project' }),
        ])
      );

      // Section 2: Document Data section from communication-project.json
      const docDataSection = findSection(sections, 'Document Data');
      expect(docDataSection).toBeDefined();

      const fieldNames = (docDataSection?.widgets ?? []).map(
        (w) => w.textInput?.name ?? w.selectionInput?.name
      );
      expect(fieldNames).toContain(getDocumentInfoWidgetName('contact', 'communication-project'));
      expect(fieldNames).toContain(getDocumentInfoWidgetName('date', 'communication-project'));
      expect(fieldNames).toContain(getDocumentInfoWidgetName('direction', 'communication-project'));
      expect(fieldNames).toContain(getDocumentInfoWidgetName('description', 'communication-project'));

      // Section 3: Admin collapsible section
      const adminSection = findSection(sections, 'Admin');
      expect(adminSection).toBeDefined();
      expect(adminSection?.collapsible).toBe(true);

      // 4. Assert mocks were invoked
      expect(mockAuthVerifier.verifyToken).toHaveBeenCalledWith('Bearer valid-e2e-token');
      expect(mockStorageAdapter.fetchSpaces).toHaveBeenCalledWith(
        expect.objectContaining({ fetchMethod: 'shared_drives' }),
        'projects',
        undefined
      );

      // 5. Explicitly prove NO real network calls occurred
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('executes POST /workspace/homepage with server.inject and proves zero network calls', async () => {
      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/homepage',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.navigations?.[0]?.pushCard?.header?.title).toBe('INC-IO Engine');

      // Verify zero network calls
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects unauthorized requests with 401 without making external network calls', async () => {
      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer invalid-token',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(401);
      expect(mockAuthVerifier.verifyToken).toHaveBeenCalledWith('Bearer invalid-token');

      // Verify zero network calls
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Form Change Behaviors (onSpaceTypeChange & onDocumentTypeChange)', () => {
    const createCommunicationProjectInputs = () => ({
      [getDocumentInfoWidgetName('contact', 'communication-project')]: {
        stringInputs: { value: ['Acme Corp'] },
      },
      [getDocumentInfoWidgetName('date', 'communication-project')]: {
        stringInputs: { value: ['260921'] },
      },
      [getDocumentInfoWidgetName('direction', 'communication-project')]: {
        stringInputs: { value: ['OT'] },
      },
      [getDocumentInfoWidgetName('description', 'communication-project')]: {
        stringInputs: { value: ['Initial Discussion'] },
      },
      [getDocumentInfoWidgetName('incomingNotes', 'communication-project')]: {
        stringInputs: { value: ['Notes from call'] },
      },
    });

    it('executes onSpaceTypeChange, ensures no field input collisions on new document type via dynamic suffixes, and retains all previous data when toggling back', async () => {
      const spaceChangeToProposalsPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onSpaceTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: {
              stringInputs: { value: ['proposals'] },
            },
            [getDocumentTypeWidgetName('projects')]: {
              stringInputs: { value: ['communication-project'] },
            },
            [getDocumentSpaceWidgetName('projects')]: {
              stringInputs: { value: ['Active Projects'] },
            },
            ...createCommunicationProjectInputs(),
          },
        },
      };

      const response1 = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: spaceChangeToProposalsPayload,
      });

      // 1. Assert status code and schema
      expect(response1.statusCode).toBe(200);
      const body1 = JSON.parse(response1.payload);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body1)).toBe(true);

      // 2. Assert updateCard UI reload
      const updateCard1 = body1.action?.navigations?.[0]?.updateCard;
      expect(updateCard1).toBeDefined();

      const sections1 = updateCard1.sections;

      // 3. Assert Document Type Selection Section
      const docTypeSection1 = sections1.find(
        (s: { header?: string }) => s.header === 'Document Type'
      );
      expect(docTypeSection1).toBeDefined();

      const spaceTypeWidget1 = docTypeSection1.widgets.find(
        (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentSpaceType'
      );
      const selectedSpaceItem1 = spaceTypeWidget1?.selectionInput?.items.find(
        (item: { value: string; selected?: boolean }) => item.value === 'proposals'
      );
      expect(selectedSpaceItem1?.selected).toBe(true);

      // Assert Document Space widget updated for proposals
      const spaceWidget1 = docTypeSection1.widgets.find(
        (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentSpaceWidgetName('proposals')
      );
      expect(spaceWidget1).toBeDefined();

      // Assert Document Type defaults to first allowed type for proposals (communication-proposal)
      const docTypeWidget1 = docTypeSection1.widgets.find(
        (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === getDocumentTypeWidgetName('proposals')
      );
      expect(docTypeWidget1).toBeDefined();
      expect(docTypeWidget1?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'communication-proposal', selected: true }),
        ])
      );

      // 4. Assert Document Data Section: dynamic suffixes ensure no collisions for communication-proposal
      const docDataSection1 = sections1.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      expect(docDataSection1).toBeDefined();

      // Check fields for the newly active document type (communication-proposal) are clean (no collision from communication-project)
      const contactWidget1 = docDataSection1.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-proposal')
      );
      expect(contactWidget1).toBeDefined();
      expect(contactWidget1?.textInput?.value).toBeUndefined();

      const dateWidget1 = docDataSection1.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
      );
      expect(dateWidget1).toBeDefined();
      expect(dateWidget1?.textInput?.value).toBeUndefined();

      const descriptionWidget1 = docDataSection1.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-proposal')
      );
      expect(descriptionWidget1).toBeDefined();
      expect(descriptionWidget1?.textInput?.value).toBeUndefined();

      // Direction should default to schema defaultValue ('IN') rather than previous entered value ('OT')
      const directionWidget1 = docDataSection1.widgets.find(
        (w: { selectionInput?: { name: string } }) =>
          w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-proposal')
      );
      expect(directionWidget1).toBeDefined();
      const selectedDirectionItem1 = directionWidget1?.selectionInput?.items.find(
        (item: { value: string; selected?: boolean }) => item.value === 'IN'
      );
      expect(selectedDirectionItem1?.selected).toBe(true);

      // Verify old document type widgets are not rendered in proposal view
      const oldFields1 = docDataSection1.widgets.filter(
        (w: { textInput?: { name: string }; selectionInput?: { name: string } }) => {
          const name = w.textInput?.name ?? w.selectionInput?.name ?? '';
          return name.endsWith('_communication-project');
        }
      );
      expect(oldFields1).toHaveLength(0);

      // 5. Toggle back to 'projects': all previous form data must be fully retained and restored
      const spaceChangeBackToProjectsPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onSpaceTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: {
              stringInputs: { value: ['projects'] },
            },
            [getDocumentTypeWidgetName('proposals')]: {
              stringInputs: { value: ['communication-proposal'] },
            },
            [getDocumentSpaceWidgetName('proposals')]: {
              stringInputs: { value: ['Client Proposals'] },
            },
            ...createCommunicationProjectInputs(),
          },
        },
      };

      const response2 = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: spaceChangeBackToProjectsPayload,
      });

      expect(response2.statusCode).toBe(200);
      const body2 = JSON.parse(response2.payload);
      const updateCard2 = body2.action?.navigations?.[0]?.updateCard;
      expect(updateCard2).toBeDefined();

      const docDataSection2 = updateCard2.sections.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      expect(docDataSection2).toBeDefined();

      // Verify all retained communication-project fields are faithfully restored
      const contactWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      );
      expect(contactWidget2?.textInput?.value).toBe('Acme Corp');

      const dateWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      );
      expect(dateWidget2?.textInput?.value).toBe('260921');

      const directionWidget2 = docDataSection2.widgets.find(
        (w: { selectionInput?: { name: string } }) =>
          w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
      );
      const selectedDirectionItem2 = directionWidget2?.selectionInput?.items.find(
        (item: { value: string; selected?: boolean }) => item.value === 'OT'
      );
      expect(selectedDirectionItem2?.selected).toBe(true);

      const descriptionWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
      );
      expect(descriptionWidget2?.textInput?.value).toBe('Initial Discussion');

      const incomingNotesWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('incomingNotes', 'communication-project')
      );
      expect(incomingNotesWidget2?.textInput?.value).toBe('Notes from call');

      // 6. Explicitly prove NO real network calls occurred throughout
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('executes onDocumentTypeChange, avoids field collisions on switching document type, and retains data when switching back', async () => {
      // Step 1: Switch document type from 'communication-project' to 'communication-proposal' within 'projects' space
      const docTypeChangeToProposalPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onDocumentTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: {
              stringInputs: { value: ['projects'] },
            },
            [getDocumentTypeWidgetName('projects')]: {
              stringInputs: { value: ['communication-proposal'] },
            },
            [getDocumentSpaceWidgetName('projects')]: {
              stringInputs: { value: ['Active Projects'] },
            },
            ...createCommunicationProjectInputs(),
          },
        },
      };

      const response1 = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: docTypeChangeToProposalPayload,
      });

      // 1. Assert status code and schema
      expect(response1.statusCode).toBe(200);
      const body1 = JSON.parse(response1.payload);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body1)).toBe(true);

      // 2. Assert updateCard UI reload
      const updateCard1 = body1.action?.navigations?.[0]?.updateCard;
      expect(updateCard1).toBeDefined();

      const sections1 = updateCard1.sections;

      // 3. Assert Document Type Selection Section shows communication-proposal selected
      const docTypeSection1 = sections1.find(
        (s: { header?: string }) => s.header === 'Document Type'
      );
      expect(docTypeSection1).toBeDefined();

      const docTypeWidget1 = docTypeSection1.widgets.find(
        (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === getDocumentTypeWidgetName('projects')
      );
      expect(docTypeWidget1).toBeDefined();
      const selectedDocTypeItem1 = docTypeWidget1?.selectionInput?.items.find(
        (item: { value: string; selected?: boolean }) => item.value === 'communication-proposal'
      );
      expect(selectedDocTypeItem1?.selected).toBe(true);

      // 4. Assert Document Data Section renders clean communication-proposal fields (no collision with communication-project)
      const docDataSection1 = sections1.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      expect(docDataSection1).toBeDefined();

      const contactWidget1 = docDataSection1.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-proposal')
      );
      expect(contactWidget1).toBeDefined();
      expect(contactWidget1?.textInput?.value).toBeUndefined();

      const directionWidget1 = docDataSection1.widgets.find(
        (w: { selectionInput?: { name: string } }) =>
          w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-proposal')
      );
      expect(directionWidget1).toBeDefined();
      const selectedDirectionItem1 = directionWidget1?.selectionInput?.items.find(
        (item: { value: string; selected?: boolean }) => item.value === 'IN'
      );
      expect(selectedDirectionItem1?.selected).toBe(true);

      // Verify inactive communication-project widgets are not rendered
      const oldFields = docDataSection1.widgets.filter(
        (w: { textInput?: { name: string }; selectionInput?: { name: string } }) => {
          const name = w.textInput?.name ?? w.selectionInput?.name ?? '';
          return name.endsWith('_communication-project');
        }
      );
      expect(oldFields).toHaveLength(0);

      // Step 2: Switch document type back to 'communication-project' within 'projects' space
      const docTypeChangeBackToProjectPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onDocumentTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: {
              stringInputs: { value: ['projects'] },
            },
            [getDocumentTypeWidgetName('projects')]: {
              stringInputs: { value: ['communication-project'] },
            },
            [getDocumentSpaceWidgetName('projects')]: {
              stringInputs: { value: ['Active Projects'] },
            },
            // Previous communication-project values retained in the client form data
            ...createCommunicationProjectInputs(),
            // Along with newly entered proposal values
            [getDocumentInfoWidgetName('contact', 'communication-proposal')]: {
              stringInputs: { value: ['Proposal Client Corp'] },
            },
          },
        },
      };

      const response2 = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: docTypeChangeBackToProjectPayload,
      });

      expect(response2.statusCode).toBe(200);
      const body2 = JSON.parse(response2.payload);
      const updateCard2 = body2.action?.navigations?.[0]?.updateCard;
      expect(updateCard2).toBeDefined();

      const docDataSection2 = updateCard2.sections.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      expect(docDataSection2).toBeDefined();

      // Verify all retained communication-project fields are restored
      const contactWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      );
      expect(contactWidget2?.textInput?.value).toBe('Acme Corp');

      const dateWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      );
      expect(dateWidget2?.textInput?.value).toBe('260921');

      const directionWidget2 = docDataSection2.widgets.find(
        (w: { selectionInput?: { name: string } }) =>
          w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
      );
      const selectedDirectionItem2 = directionWidget2?.selectionInput?.items.find(
        (item: { value: string; selected?: boolean }) => item.value === 'OT'
      );
      expect(selectedDirectionItem2?.selected).toBe(true);

      const descriptionWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
      );
      expect(descriptionWidget2?.textInput?.value).toBe('Initial Discussion');

      const incomingNotesWidget2 = docDataSection2.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('incomingNotes', 'communication-project')
      );
      expect(incomingNotesWidget2?.textInput?.value).toBe('Notes from call');

      // 5. Explicitly prove NO real network calls occurred
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Document Processing & Action Schema Conformance (processDocument)', () => {
    const baseProcessInputs = () => ({
      SelectDocumentSpaceType: {
        stringInputs: { value: ['projects'] },
      },
      [getDocumentSpaceWidgetName('projects')]: {
        stringInputs: { value: ['Active Projects'] },
      },
      [getDocumentInfoWidgetName('contact', 'communication-project')]: {
        stringInputs: { value: ['Acme Corp'] },
      },
      [getDocumentInfoWidgetName('date', 'communication-project')]: {
        stringInputs: { value: ['260921'] },
      },
      [getDocumentInfoWidgetName('direction', 'communication-project')]: {
        stringInputs: { value: ['IN'] },
      },
      [getDocumentInfoWidgetName('description', 'communication-project')]: {
        stringInputs: { value: ['E2E Test Execution'] },
      },
    });

    it('executes processDocument action successfully, maps human-readable document type to canonical backend key, asserts mocked service call, and returns schema-compliant success notification', async () => {
      const processPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        drive: {
          selectedItems: [
            {
              id: 'drive-file-001',
              title: 'Q4_Strategy_Plan.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
        commonEventObject: {
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            ...baseProcessInputs(),
            // Human-readable document type display name from manifest
            [getDocumentTypeWidgetName('projects')]: {
              stringInputs: { value: ['Communication Project'] },
            },
          },
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: processPayload,
      });

      // 1. Assert status code
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.payload);

      // 2. Structurally validate against GoogleWorkspaceActionResponse JSON schema
      expect([...Value.Errors(GoogleWorkspaceActionResponseSchema, body)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      // 3. Verify response includes success notification action
      expect(body).toEqual({
        action: {
          notification: {
            text: 'Document processed successfully',
          },
        },
      });

      // 4. Assert that the documentService mock is called with the correct backend key mapped from the UI payload
      expect(mockDocumentService.processDocument).toHaveBeenCalledWith(
        {
          type: 'communication-project', // Canonical backend key strictly mapped from 'Communication Project'
          space: 'Active Projects',
          data: {
            contact: 'Acme Corp',
            date: '260921',
            direction: 'IN',
            description: 'E2E Test Execution',
          },
        },
        'onSubmit',
        {
          credentials: { oauthToken: 'ya29.sample-e2e-token' },
          resources: { primaryTargetId: 'drive-file-001' },
        }
      );

      // 5. Explicitly prove NO real network calls occurred
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('executes processDocument action when payload passes canonical document type key directly', async () => {
      const processPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        drive: {
          selectedItems: [
            {
              id: 'drive-file-002',
              title: 'Proposal_Draft.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
        commonEventObject: {
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            ...baseProcessInputs(),
            [getDocumentTypeWidgetName('projects')]: {
              stringInputs: { value: ['communication-project'] },
            },
          },
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: processPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect([...Value.Errors(GoogleWorkspaceActionResponseSchema, body)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
      expect(body.action?.notification?.text).toBe('Document processed successfully');

      expect(mockDocumentService.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'communication-project',
          space: 'Active Projects',
        }),
        'onSubmit',
        expect.objectContaining({
          resources: { primaryTargetId: 'drive-file-002' },
        })
      );
    });

    it('handles document processing validation errors, returning an updateCard that structurally adheres to schema with Document Type selection block and error feedback', async () => {
      mockDocumentService.processDocument.mockResolvedValueOnce({
        success: false,
        errors: ['Contact name is required', 'Date format invalid'],
      });

      const processPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            ...baseProcessInputs(),
            [getDocumentTypeWidgetName('projects')]: {
              stringInputs: { value: ['communication-project'] },
            },
          },
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: processPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      // Structurally validate full action response against schema
      expect([...Value.Errors(GoogleWorkspaceActionResponseSchema, body)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      // Verify updateCard navigation action
      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();

      // Structurally validate every field of updateCard against GoogleWorkspaceCardSchema
      expect([...Value.Errors(GoogleWorkspaceCardSchema, updateCard)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceCardSchema, updateCard)).toBe(true);

      // Validate header against GoogleWorkspaceHeaderSchema
      expect([...Value.Errors(GoogleWorkspaceHeaderSchema, updateCard.header)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceHeaderSchema, updateCard.header)).toBe(true);
      expect(updateCard.header.title).toBe('INC-IO Engine');

      // Validate every section conforms to GoogleWorkspaceSectionSchema
      for (const section of updateCard.sections) {
        expect([...Value.Errors(GoogleWorkspaceSectionSchema, section)]).toHaveLength(0);
        expect(Value.Check(GoogleWorkspaceSectionSchema, section)).toBe(true);
      }

      // Assert Document Type selection block is present and structurally intact
      const docTypeSection = findSection(updateCard.sections, 'Document Type');
      expect(docTypeSection).toBeDefined();
      expect(docTypeSection?.widgets).toHaveLength(3);

      const spaceTypeWidget = findWidget(docTypeSection, 'SelectDocumentSpaceType');
      expect(spaceTypeWidget?.selectionInput?.type).toBe('DROPDOWN');
      expect(spaceTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Projects', value: 'projects', selected: true }),
        ])
      );

      const spaceWidget = findWidget(docTypeSection, getDocumentSpaceWidgetName('projects'));
      expect(spaceWidget?.textInput?.name).toBe('SelectDocumentSpace_projects');

      const docTypeWidget = findWidget(docTypeSection, getDocumentTypeWidgetName('projects'));
      expect(docTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'communication-project', selected: true }),
        ])
      );

      // Assert validation error feedback is rendered
      const errorSection = updateCard.sections.find((s: SectionStub) =>
        s.widgets.some((w) => w.textParagraph?.text?.includes('Validation Errors:'))
      );
      expect(errorSection).toBeDefined();
      const errorWidget = errorSection?.widgets.find((w: WidgetStub) =>
        w.textParagraph?.text?.includes('Validation Errors:')
      );
      expect(errorWidget?.textParagraph?.text).toContain('Contact name is required');
      expect(errorWidget?.textParagraph?.text).toContain('Date format invalid');

      // Verify zero real network calls occurred
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('handles document processing exceptions gracefully, returning an updateCard with error message adhering to schema', async () => {
      mockDocumentService.processDocument.mockRejectedValueOnce(
        new Error('Document processing pipeline failure')
      );

      const processPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            ...baseProcessInputs(),
            [getDocumentTypeWidgetName('projects')]: {
              stringInputs: { value: ['communication-project'] },
            },
          },
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: processPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect([...Value.Errors(GoogleWorkspaceActionResponseSchema, body)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      const updateCard = body.action?.navigations?.[0]?.updateCard;
      expect(updateCard).toBeDefined();
      expect([...Value.Errors(GoogleWorkspaceCardSchema, updateCard)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceCardSchema, updateCard)).toBe(true);

      const errorSection = updateCard.sections.find((s: SectionStub) =>
        s.widgets.some((w) => w.textParagraph?.text?.includes('Document processing pipeline failure'))
      );
      expect(errorSection).toBeDefined();
    });

    it('structurally validates pushCard action from drive-items-selected against schema, confirming every field of Document Type selection block and card output adheres strictly', async () => {
      const triggerPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        drive: {
          selectedItems: [
            {
              id: 'drive-file-001',
              title: 'Q4_Strategy_Plan.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: triggerPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      // 1. Structurally validate whole response against GoogleWorkspaceActionResponseSchema
      expect([...Value.Errors(GoogleWorkspaceActionResponseSchema, body)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      // 2. Structurally validate pushCard against GoogleWorkspaceCardSchema
      const pushCard = body.action?.navigations?.[0]?.pushCard;
      expect(pushCard).toBeDefined();
      expect([...Value.Errors(GoogleWorkspaceCardSchema, pushCard)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceCardSchema, pushCard)).toBe(true);

      // 3. Structurally validate card header
      expect([...Value.Errors(GoogleWorkspaceHeaderSchema, pushCard.header)]).toHaveLength(0);
      expect(Value.Check(GoogleWorkspaceHeaderSchema, pushCard.header)).toBe(true);

      // 4. Structurally validate every section
      for (const section of pushCard.sections) {
        expect([...Value.Errors(GoogleWorkspaceSectionSchema, section)]).toHaveLength(0);
        expect(Value.Check(GoogleWorkspaceSectionSchema, section)).toBe(true);
      }

      // 5. Validate Document Type selection block
      const docTypeSection = findSection(pushCard.sections, 'Document Type');
      expect(docTypeSection).toBeDefined();
      expect(docTypeSection?.widgets).toHaveLength(3);

      const spaceTypeWidget = findWidget(docTypeSection, 'SelectDocumentSpaceType');
      expect(spaceTypeWidget?.selectionInput?.type).toBe('DROPDOWN');
      expect(spaceTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Projects', value: 'projects', selected: true }),
          expect.objectContaining({ text: 'Proposals', value: 'proposals' }),
        ])
      );

      const spaceWidget = findWidget(docTypeSection, getDocumentSpaceWidgetName('projects'));
      expect(spaceWidget?.textInput?.name).toBe('SelectDocumentSpace_projects');

      const docTypeWidget = findWidget(docTypeSection, getDocumentTypeWidgetName('projects'));
      expect(docTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'communication-project', selected: true }),
        ])
      );

      // 6. Verify Process Document action button is present and points to processDocument action
      const docDataSection = pushCard.sections.find((s: SectionStub) => s.header === 'Document Data');
      expect(docDataSection).toBeDefined();
      const processButtonWidget = docDataSection?.widgets.find(
        (w: WidgetStub & { buttonList?: { buttons: Array<{ text: string; onClick?: { action?: { function?: string; parameters?: Array<{ key: string; value: string }> } } }> } }) =>
          w.buttonList?.buttons.some((b) => b.text === 'Process Document')
      );
      expect(processButtonWidget).toBeDefined();

      const button = (processButtonWidget as { buttonList: { buttons: Array<{ text: string; onClick?: { action?: { function?: string; parameters?: Array<{ key: string; value: string }> } } }> } }).buttonList.buttons.find(
        (b) => b.text === 'Process Document'
      );
      expect(button?.onClick?.action?.function).toBe(`${DEFAULT_WORKSPACE_BASE_URL}/workspace/action`);
      expect(button?.onClick?.action?.parameters).toEqual(
        expect.arrayContaining([{ key: 'action', value: 'processDocument' }])
      );
    });
  });

  describe('End-to-End Action URL Resolution & Space Collection Errors', () => {
    it('resolves all action routes to fully-qualified HTTPS URLs when incoming request headers contain x-forwarded-proto and x-forwarded-host', async () => {
      const triggerPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        drive: {
          selectedItems: [
            {
              id: 'drive-file-001',
              title: 'Q4_Strategy_Plan.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-e2e-token',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'workspace-addon.prod.run.app',
        },
        payload: triggerPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      const pushCard = body.action!.navigations![0].pushCard;

      // 1. Check Document Type Selection dropdown onChangeAction
      const docTypeSection = findSection(pushCard.sections, 'Document Type');
      expect(docTypeSection).toBeDefined();

      const spaceTypeWidget = findWidget(docTypeSection, 'SelectDocumentSpaceType');
      expect(
        (spaceTypeWidget?.selectionInput as { onChangeAction?: { function: string } })?.onChangeAction?.function
      ).toBe('https://workspace-addon.prod.run.app/workspace/action');

      const docTypeWidget = findWidget(docTypeSection, getDocumentTypeWidgetName('projects'));
      expect(
        (docTypeWidget?.selectionInput as { onChangeAction?: { function: string } })?.onChangeAction?.function
      ).toBe('https://workspace-addon.prod.run.app/workspace/action');

      // 2. Check Process Document button onClick action
      const docDataSection = findSection(pushCard.sections, 'Document Data');
      const processButtonWidget = docDataSection?.widgets.find(
        (w: WidgetStub & { buttonList?: { buttons: Array<{ text: string; onClick?: { action?: { function?: string } } }> } }) =>
          w.buttonList?.buttons.some((b) => b.text === 'Process Document')
      );
      expect(processButtonWidget).toBeDefined();

      const button = (processButtonWidget as { buttonList: { buttons: Array<{ text: string; onClick?: { action?: { function?: string } } }> } }).buttonList.buttons.find(
        (b) => b.text === 'Process Document'
      );
      expect(button?.onClick?.action?.function).toBe('https://workspace-addon.prod.run.app/workspace/action');
    });

    it('resolves all action routes to fully-qualified HTTPS URLs during onSpaceTypeChange updateCard response when proxy headers are present', async () => {
      const spaceChangePayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onSpaceTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: {
              stringInputs: { value: ['proposals'] },
            },
          },
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'workspace-addon.prod.run.app',
        },
        payload: spaceChangePayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      const updateCard = body.action!.navigations![0].updateCard;
      expect(updateCard).toBeDefined();

      // 1. Check Document Type Selection dropdown onChangeAction
      const docTypeSection = findSection(updateCard.sections, 'Document Type');
      expect(docTypeSection).toBeDefined();

      const spaceTypeWidget = findWidget(docTypeSection, 'SelectDocumentSpaceType');
      expect(
        (spaceTypeWidget?.selectionInput as { onChangeAction?: { function: string } })?.onChangeAction?.function
      ).toBe('https://workspace-addon.prod.run.app/workspace/action');

      const docTypeWidget = findWidget(docTypeSection, getDocumentTypeWidgetName('proposals'));
      expect(
        (docTypeWidget?.selectionInput as { onChangeAction?: { function: string } })?.onChangeAction?.function
      ).toBe('https://workspace-addon.prod.run.app/workspace/action');

      // 2. Check Document Data section actions (e.g. processDocument button)
      const docDataSection = findSection(updateCard.sections, 'Document Data');
      expect(docDataSection).toBeDefined();
      const buttonWidget = docDataSection?.widgets.find(
        (w: WidgetStub) => w.buttonList?.buttons.some((b) => b.text === 'Process Document')
      );
      expect(buttonWidget).toBeDefined();
      const processButton = buttonWidget?.buttonList?.buttons.find((b) => b.text === 'Process Document');
      expect(processButton?.onClick?.action?.function).toBe('https://workspace-addon.prod.run.app/workspace/action');
    });

    it('resolves action routes using standalone host header during onSpaceTypeChange request', async () => {
      const spaceChangePayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-e2e-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onSpaceTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: {
              stringInputs: { value: ['proposals'] },
            },
          },
        },
      };

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-e2e-token',
          host: 'standalone-host.internal.app',
        },
        payload: spaceChangePayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      const updateCard = body.action!.navigations![0].updateCard;
      expect(updateCard).toBeDefined();

      const docTypeSection = findSection(updateCard.sections, 'Document Type');
      const spaceTypeWidget = findWidget(docTypeSection, 'SelectDocumentSpaceType');
      expect(
        (spaceTypeWidget?.selectionInput as { onChangeAction?: { function: string } })?.onChangeAction?.function
      ).toBe('https://standalone-host.internal.app/workspace/action');
    });

    it('resolves action routes using process.env.APP_BASE_URL when forwarded headers are not present', async () => {
      const originalEnv = process.env.APP_BASE_URL;
      process.env.APP_BASE_URL = 'https://env-addon.internal.net';

      try {
        const response = await injectWorkspaceRequest(app, {
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: {
            authorization: 'Bearer valid-e2e-token',
          },
          payload: {
            drive: {
              selectedItems: [{ id: 'drive-file-001', title: 'File.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const pushCard = body.action!.navigations![0].pushCard;

        const docTypeSection = findSection(pushCard.sections, 'Document Type');
        const spaceTypeWidget = findWidget(docTypeSection, 'SelectDocumentSpaceType');
        expect(
          (spaceTypeWidget?.selectionInput as { onChangeAction?: { function: string } })?.onChangeAction?.function
        ).toBe('https://env-addon.internal.net/workspace/action');
      } finally {
        if (originalEnv !== undefined) {
          process.env.APP_BASE_URL = originalEnv;
        } else {
          delete process.env.APP_BASE_URL;
        }
      }
    });

    it('surfaces error in Status Message section when storageAdapter fails to fetch space collection', async () => {
      mockStorageAdapter.fetchSpaces = vi
        .fn()
        .mockRejectedValueOnce(new Error('Google Drive 403: Insufficient permissions for shared drive'));

      const response = await injectWorkspaceRequest(app, {
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-e2e-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.sample-e2e-token',
          },
          drive: {
            selectedItems: [{ id: 'drive-file-001', title: 'File.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

      const pushCard = body.action!.navigations![0].pushCard;

      // Status Message section should be rendered with the error
      const statusSection = pushCard.sections.find((s: SectionStub) =>
        s.widgets.some((w) =>
          w.textParagraph?.text?.includes('Google Drive 403: Insufficient permissions for shared drive')
        )
      );
      expect(statusSection).toBeDefined();
      expect(statusSection?.widgets[0]?.textParagraph?.text).toContain('Validation Errors:');
      expect(statusSection?.widgets[0]?.textParagraph?.text).toContain(
        'Google Drive 403: Insufficient permissions for shared drive'
      );

      // Remaining functional sections still render cleanly
      const docTypeSection = findSection(pushCard.sections, 'Document Type');
      expect(docTypeSection).toBeDefined();

      const docDataSection = findSection(pushCard.sections, 'Document Data');
      expect(docDataSection).toBeDefined();
    });
  });
});

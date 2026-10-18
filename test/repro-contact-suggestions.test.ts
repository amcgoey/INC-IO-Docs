import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type AppInstance } from '../src/app/server';
import { injectWorkspaceRequest } from './e2e/utils/workspace-request';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type { DocumentSpaceStoragePort, DocumentSpace } from '../src/features/document-space/ports';
import { GoogleDriveClient } from '../src/infrastructure/drive/drive-client';

interface WidgetStub {
  textParagraph?: { text?: string };
  textInput?: {
    name: string;
    value?: string;
    hintText?: string;
    initialSuggestions?: { items?: Array<{ text: string }> };
  };
  selectionInput?: {
    name: string;
    type?: string;
    items?: Array<{ text?: string; value: string; selected?: boolean }>;
  };
}

interface SectionStub {
  header?: string;
  widgets?: WidgetStub[];
}

interface CardStub {
  header?: { title?: string; subtitle?: string };
  sections?: SectionStub[];
}

function findSection(card: CardStub | undefined, header: string): SectionStub | undefined {
  return card?.sections?.find((s) => s.header === header);
}

function findWidget(section: SectionStub | undefined, name: string): WidgetStub | undefined {
  return section?.widgets?.find(
    (w) => w.textInput?.name === name || w.selectionInput?.name === name
  );
}

describe('Permanent E2E Regression Suite: Document Space resolution and Contact suggestions (Issue 161 / 165)', () => {
  let app: AppInstance;
  let mockSpaces: DocumentSpace[];
  let mockStorageAdapter: DocumentSpaceStoragePort;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;

  beforeEach(async () => {
    mockSpaces = [
      {
        id: 'space-folder-alpha-id',
        typeId: 'projects',
        name: 'Project Alpha',
        abstractStorageId: 'space-folder-alpha-id',
      },
      {
        id: 'space-folder-beta-id',
        typeId: 'projects',
        name: 'Project Beta',
        abstractStorageId: 'space-folder-beta-id',
      },
      {
        id: 'space-folder-proposal-alpha-id',
        typeId: 'proposals',
        name: 'Proposal Alpha',
        abstractStorageId: 'space-folder-proposal-alpha-id',
      },
      {
        id: 'space-folder-proposal-beta-id',
        typeId: 'proposals',
        name: 'Proposal Beta',
        abstractStorageId: 'space-folder-proposal-beta-id',
      },
      {
        id: 'space-folder-proposal-dup-id',
        typeId: 'proposals',
        name: 'Proposal Duplicate',
        abstractStorageId: 'space-folder-proposal-dup-id',
      },
      {
        id: 'space-folder-proposal-gamma-id',
        typeId: 'proposals',
        name: 'Proposal Gamma',
        abstractStorageId: 'space-folder-proposal-gamma-id',
      },
      {
        id: 'space-folder-proposal-ambig-path-id',
        typeId: 'proposals',
        name: 'Proposal Ambiguous Path',
        abstractStorageId: 'space-folder-proposal-ambig-path-id',
      },
    ];

    mockAuthVerifier = {
      verifyToken: vi.fn().mockResolvedValue({
        isValid: true,
        payload: { email: 'test@example.com' },
      }),
    };

    mockStorageAdapter = {
      fetchSpaces: vi.fn().mockImplementation(async (_config, typeId?: string) => {
        return typeId ? mockSpaces.filter((s) => s.typeId === typeId) : mockSpaces;
      }),
      resolveStorageLocation: vi.fn().mockImplementation(async (id: string) => ({
        provider: 'google_drive',
        abstractStorageId: id,
      })),
    };

    vi.spyOn(GoogleDriveClient.prototype, 'resolveFolderPath').mockImplementation(async (rootFolderId, segments) => {
      return { id: 'comm-proposal-alpha-folder-id', name: segments[segments.length - 1] ?? 'Communications', parents: [rootFolderId] };
    });
    vi.spyOn(GoogleDriveClient.prototype, 'findOrCreateFolder').mockImplementation(async (parentId, name) => {
      return { id: `folder-${name}`, name, parents: [parentId] };
    });
    vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(async (fileId) => {
      return { id: fileId, name: 'Doc.pdf', parents: ['root'] };
    });
    vi.spyOn(GoogleDriveClient.prototype, 'move').mockImplementation(async (fileId, targetFolderId) => {
      return { id: fileId, name: 'Doc.pdf', parents: [targetFolderId] };
    });

    vi.spyOn(GoogleDriveClient.prototype, 'listFolders').mockImplementation(async (options) => {
      // Alpha space with contacts
      if (options?.parentFolderId === 'space-folder-alpha-id') {
        return { folders: [{ id: 'admin-alpha-folder-id', name: '1 Admin' }] };
      }
      if (options?.parentFolderId === 'admin-alpha-folder-id') {
        return { folders: [{ id: 'comm-alpha-folder-id', name: 'Communication' }] };
      }
      if (options?.parentFolderId === 'comm-alpha-folder-id') {
        return {
          folders: [
            { id: 'contact-1', name: 'Acme Corp' },
            { id: 'contact-2', name: 'Stark Industries' },
          ],
        };
      }

      // Beta space with empty contacts
      if (options?.parentFolderId === 'space-folder-beta-id') {
        return { folders: [{ id: 'admin-beta-folder-id', name: '1 Admin' }] };
      }
      if (options?.parentFolderId === 'admin-beta-folder-id') {
        return { folders: [{ id: 'comm-beta-folder-id', name: 'Communication' }] };
      }
      if (options?.parentFolderId === 'comm-beta-folder-id') {
        return { folders: [] };
      }

      // Proposal Alpha space with contacts
      if (options?.parentFolderId === 'space-folder-proposal-alpha-id') {
        return { folders: [{ id: 'comm-proposal-alpha-folder-id', name: 'Communications' }] };
      }
      if (options?.parentFolderId === 'comm-proposal-alpha-folder-id') {
        return {
          folders: [
            { id: 'prop-contact-1', name: 'Wayne Enterprises' },
            { id: 'prop-contact-2', name: 'LexCorp' },
          ],
        };
      }

      // Proposal Beta space with empty contacts
      if (options?.parentFolderId === 'space-folder-proposal-beta-id') {
        return { folders: [{ id: 'comm-proposal-beta-folder-id', name: 'Communications' }] };
      }
      if (options?.parentFolderId === 'comm-proposal-beta-folder-id') {
        return { folders: [] };
      }

      // Proposal Gamma space with absent Communications folder
      if (options?.parentFolderId === 'space-folder-proposal-gamma-id') {
        return { folders: [] };
      }

      // Proposal Ambiguous Path space with duplicate Communications folders
      if (options?.parentFolderId === 'space-folder-proposal-ambig-path-id') {
        return {
          folders: [
            { id: 'comm-ambig-1', name: 'Communications' },
            { id: 'comm-ambig-2', name: 'Communications' },
          ],
        };
      }

      // Proposal Duplicate space with duplicate contacts
      if (options?.parentFolderId === 'space-folder-proposal-dup-id') {
        return { folders: [{ id: 'comm-proposal-dup-folder-id', name: 'Communications' }] };
      }
      if (options?.parentFolderId === 'comm-proposal-dup-folder-id') {
        return {
          folders: [
            { id: 'prop-contact-dup-1', name: 'Duplicate Contact' },
            { id: 'prop-contact-dup-2', name: 'Duplicate Contact' },
          ],
        };
      }

      // Unlisted / unknown storage ID with contacts
      if (options?.parentFolderId === 'unlisted-with-contacts-id') {
        return { folders: [{ id: 'admin-unlisted-id', name: '1 Admin' }] };
      }
      if (options?.parentFolderId === 'admin-unlisted-id') {
        return { folders: [{ id: 'comm-unlisted-id', name: 'Communication' }] };
      }
      if (options?.parentFolderId === 'comm-unlisted-id') {
        return {
          folders: [{ id: 'contact-unlisted', name: 'Wayne Enterprises' }],
        };
      }

      return { folders: [] };
    });

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });

    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
      storageAdapter: mockStorageAdapter,
      skipSpaceValidation: true,
    });
    await app.initialize();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Lifecycle a: Initial Load renders Document Space with autocomplete suggestions and Contact field present', async () => {
    const initialResponse = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: {
        authorization: 'Bearer valid-token',
      },
      payload: {
        authorizationEventObject: {
          userOAuthToken: 'test-oauth-token',
        },
        drive: {
          selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
        },
      },
    });

    expect(initialResponse.statusCode).toBe(200);
    const initialBody = JSON.parse(initialResponse.payload);
    const pushCard = initialBody.action?.navigations?.[0]?.pushCard as CardStub | undefined;
    expect(pushCard).toBeDefined();

    // Verify Document Space textInput widget has autocomplete suggestions for spaces
    const docTypeSection = findSection(pushCard, 'Document Type');
    expect(docTypeSection).toBeDefined();
    const spaceWidget = findWidget(docTypeSection, 'SelectDocumentSpace_projects');
    expect(spaceWidget).toBeDefined();
    expect(spaceWidget?.textInput?.initialSuggestions?.items).toEqual([
      { text: 'Project Alpha' },
      { text: 'Project Beta' },
    ]);

    // Verify Contact field is present in Document Data section with placeholder prompting space selection
    const dataSection = findSection(pushCard, 'Document Data');
    expect(dataSection).toBeDefined();
    const contactWidget = findWidget(dataSection, 'contact_communication-project');
    expect(contactWidget).toBeDefined();
    expect(contactWidget?.textInput?.hintText).toBe('Select a Space first');
    expect(contactWidget?.textInput?.initialSuggestions).toBeUndefined();
  });

  it('Lifecycle b: Space Selection & Refresh returns update card containing Contact suggestions derived from Drive folders under technical ID', async () => {
    const updateResponse = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-token',
      },
      payload: {
        authorizationEventObject: {
          userOAuthToken: 'test-oauth-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onFormChange',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            SelectDocumentSpace_projects: { stringInputs: { value: ['Project Alpha'] } },
            SelectDocumentType_projects: { stringInputs: { value: ['communication-project'] } },
          },
        },
        drive: {
          selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
        },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updateBody = JSON.parse(updateResponse.payload);
    const updateCard = updateBody.action?.navigations?.[0]?.updateCard as CardStub | undefined;
    expect(updateCard).toBeDefined();

    // Verify no validation errors
    const statusSection = updateCard?.sections?.find((s) =>
      s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
    );
    expect(statusSection).toBeUndefined();

    // Verify Contact suggestions populated based on Alpha's technical ID
    const dataSection = findSection(updateCard, 'Document Data');
    expect(dataSection).toBeDefined();
    const contactWidget = findWidget(dataSection, 'contact_communication-project');
    expect(contactWidget).toBeDefined();
    expect(contactWidget?.textInput?.initialSuggestions?.items).toEqual([
      { text: 'Acme Corp' },
      { text: 'Stark Industries' },
    ]);
  });

  it('Lifecycle c: Space with No Contacts returns update card with empty suggestions gracefully without erroring', async () => {
    const updateResponse = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-token',
      },
      payload: {
        authorizationEventObject: {
          userOAuthToken: 'test-oauth-token',
        },
        commonEventObject: {
          parameters: {
            action: 'onFormChange',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            SelectDocumentSpace_projects: { stringInputs: { value: ['Project Beta'] } },
            SelectDocumentType_projects: { stringInputs: { value: ['communication-project'] } },
          },
        },
        drive: {
          selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
        },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const updateBody = JSON.parse(updateResponse.payload);
    const updateCard = updateBody.action?.navigations?.[0]?.updateCard as CardStub | undefined;
    expect(updateCard).toBeDefined();

    // Verify no validation errors
    const statusSection = updateCard?.sections?.find((s) =>
      s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
    );
    expect(statusSection).toBeUndefined();

    // Verify Contact widget is present but suggestions are empty
    const dataSection = findSection(updateCard, 'Document Data');
    expect(dataSection).toBeDefined();
    const contactWidget = findWidget(dataSection, 'contact_communication-project');
    expect(contactWidget).toBeDefined();
    expect(contactWidget?.textInput?.initialSuggestions?.items ?? []).toEqual([]);
  });

  describe('Lifecycle d: Collision Handling & Graceful Fallback', () => {
    it('returns validation error banner when duplicate space names collide', async () => {
      // Configure duplicate space names in storage collection
      mockSpaces = [
        {
          id: 'space-folder-alpha-1-id',
          typeId: 'projects',
          name: 'Project Alpha',
          abstractStorageId: 'space-folder-alpha-1-id',
        },
        {
          id: 'space-folder-alpha-2-id',
          typeId: 'projects',
          name: 'Project Alpha',
          abstractStorageId: 'space-folder-alpha-2-id',
        },
      ];

      const updateResponse = await injectWorkspaceRequest(app.server, {
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'test-oauth-token',
          },
          commonEventObject: {
            parameters: {
              action: 'onFormChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              SelectDocumentSpace_projects: { stringInputs: { value: ['Project Alpha'] } },
              SelectDocumentType_projects: { stringInputs: { value: ['communication-project'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const updateBody = JSON.parse(updateResponse.payload);
      const updateCard = updateBody.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(updateCard).toBeDefined();

      // Verify validation error banner is displayed
      const statusSection = updateCard?.sections?.find((s) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
      );
      expect(statusSection).toBeDefined();
      const errorTextWidget = statusSection?.widgets?.find((w) =>
        w.textParagraph?.text?.includes(
          'Multiple spaces match "Project Alpha". Please choose or enter a unique space identifier.'
        )
      );
      expect(errorTextWidget).toBeDefined();

      // Verify Contact field suggestions prompt space selection since space resolution was ambiguous (spaceId undefined)
      const dataSection = findSection(updateCard, 'Document Data');
      expect(dataSection).toBeDefined();
      const contactWidget = findWidget(dataSection, 'contact_communication-project');
      expect(contactWidget).toBeDefined();
      expect(contactWidget?.textInput?.hintText).toBe('Select a Space first');
      expect(contactWidget?.textInput?.initialSuggestions).toBeUndefined();
    });

    it('returns validation error banner and resets Contact suggestions when space identifier is unknown or unlisted', async () => {
      const updateResponse = await injectWorkspaceRequest(app.server, {
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'test-oauth-token',
          },
          commonEventObject: {
            parameters: {
              action: 'onFormChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              SelectDocumentSpace_projects: { stringInputs: { value: ['unlisted-folder-id'] } },
              SelectDocumentType_projects: { stringInputs: { value: ['communication-project'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(updateResponse.statusCode).toBe(200);
      const updateBody = JSON.parse(updateResponse.payload);
      const updateCard = updateBody.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(updateCard).toBeDefined();

      // Verify validation error banner is displayed
      const statusSection = updateCard?.sections?.find((s) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
      );
      expect(statusSection).toBeDefined();
      const errorTextWidget = statusSection?.widgets?.find((w) =>
        w.textParagraph?.text?.includes(
          'Document space "unlisted-folder-id" was not found. Please select an existing space.'
        )
      );
      expect(errorTextWidget).toBeDefined();

      // Verify Contact widget suggestions reset to prompt space selection
      const dataSection = findSection(updateCard, 'Document Data');
      expect(dataSection).toBeDefined();
      const contactWidget = findWidget(dataSection, 'contact_communication-project');
      expect(contactWidget).toBeDefined();
      expect(contactWidget?.textInput?.hintText).toBe('Select a Space first');
      expect(contactWidget?.textInput?.initialSuggestions).toBeUndefined();
    });

    it('clears dynamic contact suggestions when user clears Document Space input on form change', async () => {
      const response = await injectWorkspaceRequest(app.server, {
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'test-oauth-token',
          },
          commonEventObject: {
            parameters: {
              action: 'onFormChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              SelectDocumentSpace_projects: { stringInputs: { value: [''] } },
              SelectDocumentType_projects: { stringInputs: { value: ['communication-project'] } },
              spaceId: { stringInputs: { value: ['space-folder-alpha-id'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(updateCard).toBeDefined();

      const dataSection = findSection(updateCard, 'Document Data');
      expect(dataSection).toBeDefined();
      const contactWidget = findWidget(dataSection, 'contact_communication-project');
      expect(contactWidget).toBeDefined();
      expect(contactWidget?.textInput?.hintText).toBe('Select a Space first');
      expect(contactWidget?.textInput?.initialSuggestions).toBeUndefined();
    });
  });

  describe('communication-proposal under proposals DocumentSpaceType', () => {
    it('Initial Load / Missing Space: selecting proposals / communication-proposal without a space renders contact_communication-proposal with Select a Space first', async () => {
      const response = await injectWorkspaceRequest(app.server, {
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'test-oauth-token',
          },
          commonEventObject: {
            parameters: {
              action: 'onFormChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
              SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
              SelectDocumentSpace_proposals: { stringInputs: { value: [''] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(updateCard).toBeDefined();

      const dataSection = findSection(updateCard, 'Document Data');
      expect(dataSection).toBeDefined();
      const contactWidget = findWidget(dataSection, 'contact_communication-proposal');
      expect(contactWidget).toBeDefined();
      expect(contactWidget?.textInput?.hintText).toBe('Select a Space first');
      expect(contactWidget?.textInput?.initialSuggestions).toBeUndefined();
    });

    it('Space Selection & Refresh: selecting Proposal space by display name resolves technical ID, traverses root Communications folder, and populates suggestions', async () => {
      const response = await injectWorkspaceRequest(app.server, {
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'test-oauth-token',
          },
          commonEventObject: {
            parameters: {
              action: 'onFormChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
              SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Alpha'] } },
              SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(updateCard).toBeDefined();

      // Verify no validation errors
      const statusSection = updateCard?.sections?.find((s) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
      );
      expect(statusSection).toBeUndefined();

      // Verify Contact suggestions populated based on Proposal Alpha's technical ID
      const dataSection = findSection(updateCard, 'Document Data');
      expect(dataSection).toBeDefined();
      const contactWidget = findWidget(dataSection, 'contact_communication-proposal');
      expect(contactWidget).toBeDefined();
      expect(contactWidget?.textInput?.initialSuggestions?.items).toEqual([
        { text: 'Wayne Enterprises' },
        { text: 'LexCorp' },
      ]);
    });

    it('Space with No Contacts: selecting Proposal space whose Communications folder is empty or absent returns empty suggestions without erroring', async () => {
      // Test 1: Empty Communications folder (Proposal Beta)
      const betaResponse = await injectWorkspaceRequest(app.server, {
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'test-oauth-token',
          },
          commonEventObject: {
            parameters: {
              action: 'onFormChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
              SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Beta'] } },
              SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(betaResponse.statusCode).toBe(200);
      const betaBody = JSON.parse(betaResponse.payload);
      const betaCard = betaBody.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(betaCard).toBeDefined();

      const betaStatus = betaCard?.sections?.find((s) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
      );
      expect(betaStatus).toBeUndefined();

      const betaData = findSection(betaCard, 'Document Data');
      const betaContact = findWidget(betaData, 'contact_communication-proposal');
      expect(betaContact).toBeDefined();
      expect(betaContact?.textInput?.initialSuggestions?.items ?? []).toEqual([]);

      // Test 2: Absent Communications folder (Proposal Gamma)
      const gammaResponse = await injectWorkspaceRequest(app.server, {
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'test-oauth-token',
          },
          commonEventObject: {
            parameters: {
              action: 'onFormChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
              SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Gamma'] } },
              SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(gammaResponse.statusCode).toBe(200);
      const gammaBody = JSON.parse(gammaResponse.payload);
      const gammaCard = gammaBody.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(gammaCard).toBeDefined();

      const gammaStatus = gammaCard?.sections?.find((s) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
      );
      expect(gammaStatus).toBeUndefined();

      const gammaData = findSection(gammaCard, 'Document Data');
      const gammaContact = findWidget(gammaData, 'contact_communication-proposal');
      expect(gammaContact).toBeDefined();
      expect(gammaContact?.textInput?.initialSuggestions?.items ?? []).toEqual([]);
    });

    describe('Collision & Unknown Space Rejection', () => {
      it('returns validation error banner and resets Contact suggestions when duplicate Proposal space names collide', async () => {
        mockSpaces = [
          {
            id: 'space-folder-proposal-alpha-1-id',
            typeId: 'proposals',
            name: 'Proposal Alpha',
            abstractStorageId: 'space-folder-proposal-alpha-1-id',
          },
          {
            id: 'space-folder-proposal-alpha-2-id',
            typeId: 'proposals',
            name: 'Proposal Alpha',
            abstractStorageId: 'space-folder-proposal-alpha-2-id',
          },
        ];

        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'onFormChange',
              },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Alpha'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
        expect(updateCard).toBeDefined();

        const statusSection = updateCard?.sections?.find((s) =>
          s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
        );
        expect(statusSection).toBeDefined();
        const errorTextWidget = statusSection?.widgets?.find((w) =>
          w.textParagraph?.text?.includes(
            'Multiple spaces match "Proposal Alpha". Please choose or enter a unique space identifier.'
          )
        );
        expect(errorTextWidget).toBeDefined();

        const dataSection = findSection(updateCard, 'Document Data');
        expect(dataSection).toBeDefined();
        const contactWidget = findWidget(dataSection, 'contact_communication-proposal');
        expect(contactWidget).toBeDefined();
        expect(contactWidget?.textInput?.hintText).toBe('Select a Space first');
        expect(contactWidget?.textInput?.initialSuggestions).toBeUndefined();
      });

      it('returns validation error banner and resets Contact suggestions when Proposal space identifier is unknown or unlisted', async () => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'onFormChange',
              },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['unlisted-folder-id'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
        expect(updateCard).toBeDefined();

        const statusSection = updateCard?.sections?.find((s) =>
          s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
        );
        expect(statusSection).toBeDefined();
        const errorTextWidget = statusSection?.widgets?.find((w) =>
          w.textParagraph?.text?.includes(
            'Document space "unlisted-folder-id" was not found. Please select an existing space.'
          )
        );
        expect(errorTextWidget).toBeDefined();

        const dataSection = findSection(updateCard, 'Document Data');
        expect(dataSection).toBeDefined();
        const contactWidget = findWidget(dataSection, 'contact_communication-proposal');
        expect(contactWidget).toBeDefined();
        expect(contactWidget?.textInput?.hintText).toBe('Select a Space first');
        expect(contactWidget?.textInput?.initialSuggestions).toBeUndefined();
      });
    });

    describe('End-to-End Submission (processDocument)', () => {
      it('successfully processes document with valid Proposal space and existing Contact folder', async () => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectFiles: { stringInputs: { value: ['file-1'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Alpha'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
                contact: { stringInputs: { value: ['Wayne Enterprises'] } },
                date: { stringInputs: { value: ['260920'] } },
                direction: { stringInputs: { value: ['IN'] } },
                description: { stringInputs: { value: ['Project Kickoff'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.action?.notification).toBeDefined();
        expect(body.action?.notification?.text).toBe('Document processed successfully');
      });

      it('successfully processes submission when Contact folder does not exist (new contact allowed via allowUserInput)', async () => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectFiles: { stringInputs: { value: ['file-1'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Alpha'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
                contact: { stringInputs: { value: ['NonExistent Contact'] } },
                date: { stringInputs: { value: ['260920'] } },
                direction: { stringInputs: { value: ['IN'] } },
                description: { stringInputs: { value: ['Project Kickoff'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        expect(body.action?.notification).toBeDefined();
        expect(body.action?.notification?.text).toBe('Document processed successfully');
      });

      it('rejects submission when duplicate Contact folders exist', async () => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectFiles: { stringInputs: { value: ['file-1'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Duplicate'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
                contact: { stringInputs: { value: ['Duplicate Contact'] } },
                date: { stringInputs: { value: ['260920'] } },
                direction: { stringInputs: { value: ['IN'] } },
                description: { stringInputs: { value: ['Project Kickoff'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
        expect(updateCard).toBeDefined();

        const statusSection = updateCard?.sections?.find((s) =>
          s.widgets?.some((w) =>
            w.textParagraph?.text?.includes(
              'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.'
            )
          )
        );
        expect(statusSection).toBeDefined();
      });

      it('rejects submission when Document Space is missing with "Please select a Document Space."', async () => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectFiles: { stringInputs: { value: ['file-1'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: [''] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
                contact: { stringInputs: { value: ['Wayne Enterprises'] } },
                date: { stringInputs: { value: ['260920'] } },
                direction: { stringInputs: { value: ['IN'] } },
                description: { stringInputs: { value: ['Project Kickoff'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
        expect(updateCard).toBeDefined();

        const statusSection = updateCard?.sections?.find((s) =>
          s.widgets?.some((w) => w.textParagraph?.text?.includes('Please select a Document Space.'))
        );
        expect(statusSection).toBeDefined();
      });

      it('rejects submission when relativePath folder does not exist (path_not_found) with catalog message', async () => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectFiles: { stringInputs: { value: ['file-1'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Gamma'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
                contact: { stringInputs: { value: ['Wayne Enterprises'] } },
                date: { stringInputs: { value: ['260920'] } },
                direction: { stringInputs: { value: ['IN'] } },
                description: { stringInputs: { value: ['Project Kickoff'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
        expect(updateCard).toBeDefined();

        const statusSection = updateCard?.sections?.find((s) =>
          s.widgets?.some((w) =>
            w.textParagraph?.text?.includes(
              'Folder "Communications" was not found in the selected Document Space.'
            )
          )
        );
        expect(statusSection).toBeDefined();
      });

      it('rejects submission when relativePath folder path is ambiguous (ambiguous_path) with catalog message', async () => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectFiles: { stringInputs: { value: ['file-1'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Ambiguous Path'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
                contact: { stringInputs: { value: ['Wayne Enterprises'] } },
                date: { stringInputs: { value: ['260920'] } },
                direction: { stringInputs: { value: ['IN'] } },
                description: { stringInputs: { value: ['Project Kickoff'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
        expect(updateCard).toBeDefined();

        const statusSection = updateCard?.sections?.find((s) =>
          s.widgets?.some((w) =>
            w.textParagraph?.text?.includes(
              'Multiple folders found along path "Communications" in the selected Document Space. Please resolve this ambiguity in Google Drive manually.'
            )
          )
        );
        expect(statusSection).toBeDefined();
      });

      it.each([
        { desc: 'empty string', contactVal: '' },
        { desc: 'whitespace-only', contactVal: '   ' },
      ])('rejects submission when contact is $desc with schema validation error', async ({ contactVal }) => {
        const response = await injectWorkspaceRequest(app.server, {
          method: 'POST',
          url: '/workspace/action',
          headers: {
            authorization: 'Bearer valid-token',
          },
          payload: {
            authorizationEventObject: {
              userOAuthToken: 'test-oauth-token',
            },
            commonEventObject: {
              parameters: {
                action: 'processDocument',
              },
              formInputs: {
                SelectFiles: { stringInputs: { value: ['file-1'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                SelectDocumentSpace_proposals: { stringInputs: { value: ['Proposal Alpha'] } },
                SelectDocumentType_proposals: { stringInputs: { value: ['communication-proposal'] } },
                contact: { stringInputs: { value: [contactVal] } },
                date: { stringInputs: { value: ['260920'] } },
                direction: { stringInputs: { value: ['IN'] } },
                description: { stringInputs: { value: ['Project Kickoff'] } },
              },
            },
            drive: {
              selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const updateCard = body.action?.navigations?.[0]?.updateCard as CardStub | undefined;
        expect(updateCard).toBeDefined();

        const statusSection = updateCard?.sections?.find((s) =>
          s.widgets?.some((w) =>
            w.textParagraph?.text?.includes('Validation Errors:') &&
            w.textParagraph?.text?.includes('/contact:')
          )
        );
        expect(statusSection).toBeDefined();
      });
    });
  });
});

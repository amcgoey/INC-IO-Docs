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
    ];

    mockAuthVerifier = {
      verifyToken: vi.fn().mockResolvedValue({
        isValid: true,
        payload: { email: 'test@example.com' },
      }),
    };

    mockStorageAdapter = {
      fetchSpaces: vi.fn().mockImplementation(async () => mockSpaces),
      resolveStorageLocation: vi.fn().mockImplementation(async (id: string) => ({
        provider: 'google_drive',
        abstractStorageId: id,
      })),
    };

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
    expect(contactWidget?.textInput?.initialSuggestions?.items).toEqual([
      { text: 'Select a Space first' },
    ]);
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
      expect(contactWidget?.textInput?.initialSuggestions?.items).toEqual([
        { text: 'Select a Space first' },
      ]);
    });

    it('falls back cleanly without erroring when space identifier is unknown or unlisted', async () => {
      // 1. Unknown space with empty folders falls back cleanly without collision error
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
              SelectDocumentSpace_projects: { stringInputs: { value: ['unlisted-empty-folder-id'] } },
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

      // Ensure no collision or validation error banner
      const statusSection = updateCard?.sections?.find((s) =>
        s.widgets?.some((w) => w.textParagraph?.text?.includes('Validation Errors'))
      );
      expect(statusSection).toBeUndefined();

      // Contact widget is present and handled gracefully
      const dataSection = findSection(updateCard, 'Document Data');
      expect(dataSection).toBeDefined();
      const contactWidget = findWidget(dataSection, 'contact_communication-project');
      expect(contactWidget).toBeDefined();
      expect(contactWidget?.textInput?.initialSuggestions?.items ?? []).toEqual([]);

      // 2. Unlisted space with existing contact folders resolves and populates suggestions cleanly
      const unlistedWithContactsResponse = await injectWorkspaceRequest(app.server, {
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
              SelectDocumentSpace_projects: { stringInputs: { value: ['unlisted-with-contacts-id'] } },
              SelectDocumentType_projects: { stringInputs: { value: ['communication-project'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-1', title: 'Doc.pdf' }],
          },
        },
      });

      expect(unlistedWithContactsResponse.statusCode).toBe(200);
      const unlistedBody = JSON.parse(unlistedWithContactsResponse.payload);
      const unlistedCard = unlistedBody.action?.navigations?.[0]?.updateCard as CardStub | undefined;
      expect(unlistedCard).toBeDefined();

      const unlistedDataSection = findSection(unlistedCard, 'Document Data');
      const unlistedContactWidget = findWidget(unlistedDataSection, 'contact_communication-project');
      expect(unlistedContactWidget?.textInput?.initialSuggestions?.items).toEqual([
        { text: 'Wayne Enterprises' },
      ]);
    });
  });
});

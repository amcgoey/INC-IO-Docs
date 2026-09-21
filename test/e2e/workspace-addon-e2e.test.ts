import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { OAuth2Client } from 'google-auth-library';
import { createApp, type AppInstance } from '../../src/app/server';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import type { WorkspaceAuthVerifierPort } from '../../src/infrastructure/workspace-addon/api';
import type { DocumentSpaceStoragePort } from '../../src/features/document-space/ports';
import type { DriveServicePort, DocumentServicePort } from '../../src/features/document/ports';
import { GoogleWorkspaceActionResponseSchema } from '../../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../../src/features/schema-driven-ui/blocks/document-info';

describe('Workspace Addon UI E2E Test Suite', () => {
  let app: AppInstance;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockStorageAdapter: DocumentSpaceStoragePort;
  let mockDriveService: DriveServicePort;
  let mockDocumentService: DocumentServicePort & { initialize: ReturnType<typeof vi.fn> };

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

      const response = await app.server.inject({
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
      const docTypeSection = sections.find(
        (s: { header?: string }) => s.header === 'Document Type'
      );
      expect(docTypeSection).toBeDefined();
      expect(docTypeSection.widgets).toHaveLength(3);

      const spaceTypeWidget = docTypeSection.widgets.find(
        (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentSpaceType'
      );
      expect(spaceTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: 'Projects', value: 'projects' }),
          expect.objectContaining({ text: 'Proposals', value: 'proposals' }),
        ])
      );

      // Verify Document Space text input has suggestions populated from mockStorageAdapter
      const spaceWidget = docTypeSection.widgets.find(
        (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentSpaceWidgetName('projects')
      );
      expect(spaceWidget?.textInput?.initialSuggestions?.items).toEqual([
        { text: 'Active Projects' },
      ]);

      // Verify Document Type dropdown contains allowed document types for 'projects' from manifest
      const docTypeWidget = docTypeSection.widgets.find(
        (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === getDocumentTypeWidgetName('projects')
      );
      expect(docTypeWidget?.selectionInput?.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: 'communication-project' }),
        ])
      );

      // Section 2: Document Data section from communication-project.json
      const docDataSection = sections.find(
        (s: { header?: string }) => s.header === 'Document Data'
      );
      expect(docDataSection).toBeDefined();

      const fieldNames = docDataSection.widgets.map(
        (w: { textInput?: { name: string }; selectionInput?: { name: string } }) =>
          w.textInput?.name ?? w.selectionInput?.name
      );
      expect(fieldNames).toContain(getDocumentInfoWidgetName('contact', 'communication-project'));
      expect(fieldNames).toContain(getDocumentInfoWidgetName('date', 'communication-project'));
      expect(fieldNames).toContain(getDocumentInfoWidgetName('direction', 'communication-project'));
      expect(fieldNames).toContain(getDocumentInfoWidgetName('description', 'communication-project'));

      // Section 3: Admin collapsible section
      const adminSection = sections.find(
        (s: { header?: string }) => s.header === 'Admin'
      );
      expect(adminSection).toBeDefined();
      expect(adminSection.collapsible).toBe(true);

      // 4. Assert mocks were invoked
      expect(mockAuthVerifier.verifyToken).toHaveBeenCalledWith('Bearer valid-e2e-token');
      expect(mockStorageAdapter.fetchSpaces).toHaveBeenCalledWith(
        expect.objectContaining({ fetchMethod: 'shared_drives' }),
        'projects'
      );

      // 5. Explicitly prove NO real network calls occurred
      expect(driveNetworkSpy).not.toHaveBeenCalled();
      expect(oauthNetworkSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('executes POST /workspace/homepage with server.inject and proves zero network calls', async () => {
      const response = await app.server.inject({
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
      const response = await app.server.inject({
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
});

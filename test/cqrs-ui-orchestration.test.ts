import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createApp, type AppInstance } from '../src/app/server';
import { injectWorkspaceRequest } from './e2e/utils/workspace-request';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import { GoogleDriveClient } from '../src/infrastructure/drive/drive-client';
import {
  GoogleWorkspaceActionResponseSchema,
  type GoogleWorkspaceActionResponse,
} from '../src/infrastructure/workspace-addon/ui-blocks';

describe('Integration: CQRS UI Orchestration (Issue 140)', () => {
  let app: AppInstance;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockStorageAdapter: DocumentSpaceStoragePort;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    vi.spyOn(GoogleDriveClient.prototype, 'listFolders').mockImplementation(async (options) => {
      if (options?.parentFolderId === 'folder-projects-1') {
        return { folders: [{ id: 'comm-folder-id', name: 'Communication' }] };
      }
      if (options?.parentFolderId === 'comm-folder-id') {
        return { folders: [{ id: 'contact-acme-id', name: 'Acme Corp' }] };
      }
      return { folders: [] };
    });

    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return {
            isValid: true,
            payload: { email: 'cqrs-test@example.com', sub: 'user-cqrs' },
          };
        }
        return {
          isValid: false,
          error: 'Invalid ID token',
        };
      }),
    };

    mockStorageAdapter = {
      fetchSpaces: vi.fn().mockImplementation(async (_config, typeId: string) => [
        {
          id: `space-${typeId}-1`,
          typeId,
          name: typeId === 'projects' ? 'Project 1' : 'Client Proposals',
          abstractStorageId: `folder-${typeId}-1`,
        },
      ]),
      resolveStorageLocation: vi.fn().mockImplementation(async (abstractStorageId: string) => ({
        provider: 'google_drive',
        abstractStorageId,
      })),
    };

    vi.spyOn(GoogleDriveClient.prototype, 'resolveFolderPath').mockImplementation(async (rootFolderId, segments) => {
      return { id: 'comm-folder-id', name: segments[segments.length - 1] ?? 'Communications', parents: [rootFolderId] };
    });
    vi.spyOn(GoogleDriveClient.prototype, 'findOrCreateFolder').mockImplementation(async (parentId, name) => {
      return { id: `folder-${name}`, name, parents: [parentId] };
    });
    vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockImplementation(async (fileId) => {
      return { id: fileId, name: 'Sample_Doc.pdf', parents: ['root'] };
    });
    vi.spyOn(GoogleDriveClient.prototype, 'move').mockImplementation(async (fileId, targetFolderId) => {
      return { id: fileId, name: 'Sample_Doc.pdf', parents: [targetFolderId] };
    });
    vi.spyOn(GoogleDriveClient.prototype, 'listFolders').mockImplementation(async () => {
      return {
        folders: [
          { id: 'comm-folder-id', name: 'Communication' },
          { id: 'comm-folder-props-id', name: 'Communications' },
          { id: 'acme-id', name: 'Acme Corp' },
        ],
      };
    });

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
      skipSpaceValidation: true,
      appBaseUrl: 'https://cqrs-addon.example.com',
      storageAdapter: mockStorageAdapter,
    });

    await app.initialize();
  });

  it('completes the full CQRS flow for Render intent: Command -> Intent -> Query Read -> Translated JSON with baseUrl', async () => {
    const triggerPayload = {
      authorizationEventObject: {
        userOAuthToken: 'ya29.sample-token',
      },
      drive: {
        selectedItems: [
          {
            id: 'drive-file-101',
            title: 'Sample_Doc.pdf',
          },
        ],
      },
    };

    const response = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: {
        authorization: 'Bearer valid-jwt-token',
        host: 'cqrs-addon.example.com',
      },
      payload: triggerPayload,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;

    // 1. Verify schema adherence
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

    // 2. Verify pushCard navigation action was constructed by the wrapper from render intent
    expect(body.action?.navigations).toBeDefined();
    const pushCard = body.action!.navigations![0].pushCard;
    expect(pushCard).toBeDefined();
    expect(pushCard?.header?.title).toBe('INC-IO Engine');

    // 3. Verify request-scoped baseUrl was applied to action routes
    const allWidgets = pushCard?.sections.flatMap((s) => s.widgets) ?? [];
    const interactiveWidget = allWidgets.find(
      (w) => w.selectionInput?.onChangeAction || w.textInput?.onChangeAction
    );
    expect(interactiveWidget).toBeDefined();

    const actionUrl =
      interactiveWidget?.selectionInput?.onChangeAction?.function ??
      interactiveWidget?.textInput?.onChangeAction?.function;
    expect(actionUrl).toMatch(/^https:\/\/cqrs-addon\.example\.com\/workspace\//);
  });

  it('completes the full CQRS flow for UpdateCard render intent on form change', async () => {
    const formChangePayload = {
      authorizationEventObject: {
        userOAuthToken: 'ya29.sample-token',
      },
      commonEventObject: {
        parameters: {
          action: 'onFormChange',
        },
        formInputs: {
          SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
        },
      },
    };

    const response = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-jwt-token',
        host: 'cqrs-addon.example.com',
      },
      payload: formChangePayload,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

    // Verify updateCard navigation action
    expect(body.action?.navigations?.[0]?.updateCard).toBeDefined();
    const updateCard = body.action!.navigations![0].updateCard!;
    expect(updateCard.header?.title).toBe('INC-IO Engine');
  });

  it('completes the full CQRS flow for Notification intent on successful document processing', async () => {
    const submitPayload = {
      authorizationEventObject: {
        userOAuthToken: 'ya29.sample-token',
      },
      commonEventObject: {
        parameters: {
          action: 'processDocument',
        },
        formInputs: {
          SelectFiles: { stringInputs: { value: ['drive-file-101'] } },
          SelectDocumentType_projects: { stringInputs: { value: ['communication-proposal'] } },
          SelectDocumentSpace_projects: { stringInputs: { value: ['Project 1'] } },
          contact: { stringInputs: { value: ['Acme Corp'] } },
          date: { stringInputs: { value: ['260920'] } },
          direction: { stringInputs: { value: ['IN'] } },
          description: { stringInputs: { value: ['Project Kickoff'] } },
        },
      },
      drive: {
        selectedItems: [{ id: 'drive-file-101', title: 'Sample_Doc.pdf' }],
      },
    };

    const response = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: submitPayload,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload) as GoogleWorkspaceActionResponse;
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

    expect(body.action?.notification).toBeDefined();
    expect(body.action?.notification?.text).toBe('Document processed successfully');
  });
});

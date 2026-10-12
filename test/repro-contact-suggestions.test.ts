import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app/server';
import { injectWorkspaceRequest } from './e2e/utils/workspace-request';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import { GoogleDriveClient } from '../src/infrastructure/drive/drive-client';

describe('Repro: Contact field suggestions after Document Space update', () => {
  it('populates Contact suggestions after updating Document Space field', async () => {
    const mockAuthVerifier: WorkspaceAuthVerifierPort = {
      verifyToken: vi.fn().mockResolvedValue({
        isValid: true,
        payload: { email: 'test@example.com' },
      }),
    };

    const mockStorageAdapter: DocumentSpaceStoragePort = {
      fetchSpaces: vi.fn().mockResolvedValue([
        {
          id: 'space-folder-alpha-id',
          typeId: 'projects',
          name: 'Project Alpha',
          abstractStorageId: 'space-folder-alpha-id',
        },
      ]),
      resolveStorageLocation: vi.fn().mockImplementation(async (id: string) => ({
        provider: 'google_drive',
        abstractStorageId: id,
      })),
    };

    // Spy on GoogleDriveClient.prototype.listFolders to return folders when space-folder-alpha-id is queried
    vi.spyOn(GoogleDriveClient.prototype, 'listFolders').mockImplementation(async (options) => {
      if (options?.parentFolderId === 'space-folder-alpha-id') {
        return { folders: [{ id: 'admin-folder-id', name: '1 Admin' }] };
      }
      if (options?.parentFolderId === 'admin-folder-id') {
        return { folders: [{ id: 'comm-folder-id', name: 'Communication' }] };
      }
      if (options?.parentFolderId === 'comm-folder-id') {
        return {
          folders: [
            { id: 'contact-1', name: 'Acme Corp' },
            { id: 'contact-2', name: 'Stark Industries' },
          ],
        };
      }
      return { folders: [] };
    });

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });

    const app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
      storageAdapter: mockStorageAdapter,
      skipSpaceValidation: true,
    });
    await app.initialize();

    // 1. Initial trigger: Document Space is not yet selected/filled
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

    // 2. User updates Document Space field (SelectDocumentSpace_projects = 'Project Alpha')
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
    if (!updateBody.action?.navigations?.[0]?.updateCard) {
      console.error('UpdateBody:', JSON.stringify(updateBody, null, 2));
    }
    const updateCard = updateBody.action?.navigations?.[0]?.updateCard;
    expect(updateCard).toBeDefined();

    const dataSection = updateCard.sections.find(
      (s: { header?: string }) => s.header === 'Document Data'
    );
    expect(dataSection).toBeDefined();

    const contactWidget = dataSection.widgets.find(
      (w: { textInput?: { name: string } }) =>
        w.textInput?.name === 'contact_communication-project'
    );
    expect(contactWidget).toBeDefined();
    expect(contactWidget.textInput?.initialSuggestions?.items).toEqual([
      { text: 'Acme Corp' },
      { text: 'Stark Industries' },
    ]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpServer, type HttpServer } from '../../../infrastructure/http';
import { registerWorkspaceFeatureRoutes } from './api';
import type { AuthVerifierPort, WorkspaceDocumentRunnerPort } from '../ports';

describe('Workspace Feature Routes', () => {
  let server: HttpServer;
  let mockAuthVerifier: AuthVerifierPort;
  let mockDocumentService: WorkspaceDocumentRunnerPort;

  beforeEach(() => {
    server = createHttpServer();
    mockAuthVerifier = {
      verifyToken: vi.fn().mockResolvedValue({ isValid: true, payload: { email: 'user@example.com' } }),
    };
    mockDocumentService = {
      processRecord: vi.fn().mockResolvedValue({
        success: true,
        data: { type: 'test-document', data: {} },
        activities: [],
        outputs: [],
      }),
    };

    registerWorkspaceFeatureRoutes(server, {
      authVerifier: mockAuthVerifier,
      documentService: mockDocumentService,
    });
  });

  describe('POST /workspace/homepage', () => {
    it('returns 200 with homepage card when auth token is valid', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/workspace/homepage',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action.navigations[0].pushCard.header.title).toBe('INC-IO Docs');
      expect(
        body.action.navigations[0].pushCard.sections[0].widgets[0].buttonList.buttons[0].text
      ).toBe('Move Selected File');
      expect(mockAuthVerifier.verifyToken).toHaveBeenCalledWith('Bearer valid-token');
    });

    it('returns 200 with custom title and button text when configProvider provides workspace config', async () => {
      const customServer = createHttpServer();
      const mockConfigProvider = {
        getWorkspaceConfig: vi.fn().mockResolvedValue({
          appTitle: 'Enterprise Archiver',
          actionButtonText: 'Archive Document',
        }),
      };

      registerWorkspaceFeatureRoutes(customServer, {
        authVerifier: mockAuthVerifier,
        configProvider: mockConfigProvider,
      });

      const response = await customServer.inject({
        method: 'POST',
        url: '/workspace/homepage',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action.navigations[0].pushCard.header.title).toBe('Enterprise Archiver');
      expect(
        body.action.navigations[0].pushCard.sections[0].widgets[0].buttonList.buttons[0].text
      ).toBe('Archive Document');
      expect(mockConfigProvider.getWorkspaceConfig).toHaveBeenCalled();
    });

    it('returns 401 when auth verification fails', async () => {
      (mockAuthVerifier.verifyToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        isValid: false,
        error: 'Invalid token signature',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/homepage',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid token signature');
    });
  });


  describe('POST /workspace/action', () => {
    it('returns 200 with toast notification on successful action execution', async () => {
      const eventPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-user-oauth-token',
        },
        drive: {
          selectedItems: [
            {
              id: 'file-xyz',
              title: 'Proposal.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      };

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
          'x-cloud-trace-context': 'trace-12345',
        },
        payload: eventPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          notification: {
            text: "Moved 'Proposal.pdf' to 'Unfiled'",
          },
        },
      });

      expect(mockDocumentService.processRecord).toHaveBeenCalledWith(
        {
          type: 'test-document',
          data: {
            title: 'Proposal.pdf',
          },
        },
        'onSubmit',
        {
          credentials: {
            oauthToken: 'ya29.sample-user-oauth-token',
          },
          resources: {
            primaryTargetId: 'file-xyz',
          },
        }
      );
    });

    it('scans result.outputs backwards and renders toast notification using the last populated FileLocator', async () => {
      (mockDocumentService.processRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: { type: 'test-document', data: {} },
        activities: [],
        outputs: [
          {
            success: true,
            files: [
              {
                id: 'file-1',
                name: 'InitialDraft.docx',
                parentName: 'Drafts',
                mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                uri: 'https://drive.google.com/file/d/file-1/view',
              },
            ],
          },
          {
            success: true,
            files: [
              {
                id: 'file-2',
                name: 'FinalApprovedProposal.pdf',
                parentName: 'ClientArchive',
                mimeType: 'application/pdf',
                uri: 'https://drive.google.com/file/d/file-2/view',
              },
            ],
          },
          {
            success: true, // Step after file move that produces no files (e.g. logging step)
            documentDataPatch: { logged: true },
          },
        ],
      });

      const eventPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-user-oauth-token',
        },
        drive: {
          selectedItems: [
            {
              id: 'file-1',
              title: 'InitialDraft.docx',
            },
          ],
        },
      };

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
        },
        payload: eventPayload,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          notification: {
            text: "Moved 'FinalApprovedProposal.pdf' to 'ClientArchive'",
          },
        },
      });
    });

    it('resolves defaultDocumentType and defaultEventName dynamically from configProvider for action execution', async () => {
      const customServer = createHttpServer();
      const mockConfigProvider = {
        getWorkspaceConfig: vi.fn().mockResolvedValue({
          defaultDocumentType: 'custom-document-type',
          defaultEventName: 'onCustomAction',
        }),
      };

      registerWorkspaceFeatureRoutes(customServer, {
        authVerifier: mockAuthVerifier,
        documentService: mockDocumentService,
        configProvider: mockConfigProvider,
      });

      const eventPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.valid-oauth-token',
        },
        drive: {
          selectedItems: [{ id: 'file-999', title: 'Invoice.pdf' }],
        },
      };

      const response = await customServer.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
        },
        payload: eventPayload,
      });

      expect(response.statusCode).toBe(200);
      expect(mockDocumentService.processRecord).toHaveBeenCalledWith(
        {
          type: 'custom-document-type',
          data: {
            title: 'Invoice.pdf',
          },
        },
        'onCustomAction',
        expect.any(Object)
      );
    });


    it('returns 200 with AuthorizationAction when userOAuthToken is missing in event payload', async () => {
      const payloadWithoutToken = {
        drive: {
          selectedItems: [{ id: 'file-123', title: 'FileWithoutToken.pdf' }],
        },
      };

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
        },
        payload: payloadWithoutToken,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body).toEqual({
        action: {
          authorizationAction: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          },
        },
      });
      expect(mockDocumentService.processRecord).not.toHaveBeenCalled();
    });

    it('returns 200 with custom authorizationUrl when configured and userOAuthToken is missing', async () => {
      const customServer = createHttpServer();
      const customAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=my-app';
      registerWorkspaceFeatureRoutes(customServer, {
        authVerifier: mockAuthVerifier,
        documentService: mockDocumentService,
        authorizationUrl: customAuthUrl,
      });

      const response = await customServer.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action.authorizationAction.authorizationUrl).toBe(customAuthUrl);
    });

    it('returns 200 with native Error Card when documentService fails validation', async () => {
      (mockDocumentService.processRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        errors: ['Invalid document data: Field contact is required'],
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action).toBeDefined();
      expect(body.action.notification.text).toContain(
        'Invalid document data: Field contact is required'
      );
      expect(
        body.action.navigations[0].pushCard.sections[0].widgets[0].textParagraph.text
      ).toContain('Invalid document data: Field contact is required');
    });

    it('returns 200 with native Error Card when documentService or driven adapter throws an error', async () => {
      (mockDocumentService.processRecord as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Google Drive API error in moveFile: 403 Forbidden')
      );

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.valid-oauth-token',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action).toBeDefined();
      expect(body.action.notification.text).toContain(
        'Google Drive API error in moveFile: 403 Forbidden'
      );
    });

    it('returns 401 when auth verification fails for action endpoint', async () => {
      (mockAuthVerifier.verifyToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        isValid: false,
        error: 'Missing Authorization header',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
      });

      expect(response.statusCode).toBe(401);
      expect(mockDocumentService.processRecord).not.toHaveBeenCalled();
    });
  });
});

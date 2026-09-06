import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpServer, type HttpServer } from '../../../infrastructure/http';
import { registerWorkspaceFeatureRoutes } from './api';
import type {
  AuthVerifierPort,
  WorkspaceConfigProviderPort,
  WorkspaceDocumentRunnerPort,
} from '../ports';
import type { WorkspaceUiBuilderPort } from './ui-builder';

describe('Workspace Feature Routes', () => {
  let server: HttpServer;
  let mockAuthVerifier: AuthVerifierPort;
  let mockUiBuilder: WorkspaceUiBuilderPort;
  let mockDocumentService: WorkspaceDocumentRunnerPort;

  beforeEach(() => {
    server = createHttpServer();
    mockAuthVerifier = {
      verifyToken: vi.fn().mockResolvedValue({ isValid: true, payload: { email: 'user@example.com' } }),
    };
    mockUiBuilder = {
      buildTitleBlock: vi.fn().mockReturnValue({ title: 'INC-IO Engine', subtitle: 'Process Document' }),
      buildStatusMessageBlock: vi.fn().mockReturnValue({
        widgets: [{ textParagraph: { text: 'Processing selected items...' } }],
      }),
      buildDocumentTypeSelectionBlock: vi.fn().mockReturnValue({
        header: 'Document Type',
        widgets: [],
      }),
      buildCard: vi.fn().mockReturnValue({ header: { title: 'INC-IO Engine' }, sections: [] }),
      buildNavigationAction: vi.fn().mockReturnValue({
        action: { navigations: [{ pushCard: { header: { title: 'INC-IO Engine' }, sections: [] } }] },
      }),
      buildErrorCard: vi.fn().mockReturnValue({
        action: { navigations: [{ pushCard: { header: { title: 'Error' }, sections: [] } }] },
      }),
    };
    mockDocumentService = {
      processDocument: vi.fn().mockResolvedValue({
        success: true,
        data: { type: 'test-document', data: {} },
        activities: [],
        outputs: [],
      }),
    };

    registerWorkspaceFeatureRoutes(server, {
      authVerifier: mockAuthVerifier,
      uiBuilder: mockUiBuilder,
      documentService: mockDocumentService,
    });
  });

  describe('POST /workspace/drive-items-selected', () => {
    it('returns 200 with drive document process card when auth token is valid and userOAuthToken is provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.user-token',
          },
          drive: {
            selectedItems: [{ id: 'file-123', title: 'Invoice.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(mockAuthVerifier.verifyToken).toHaveBeenCalledWith('Bearer valid-token');
      expect(mockUiBuilder.buildTitleBlock).toHaveBeenCalledWith({
        title: 'INC-IO Engine',
        subtitle: 'Process Document',
      });
      expect(mockUiBuilder.buildStatusMessageBlock).toHaveBeenCalledWith(
        'Processing selected items...',
        false
      );expect(body).toEqual({
        action: { navigations: [{ pushCard: { header: { title: 'INC-IO Engine' }, sections: [] } }] },
      });
    });

    it('returns 200 with custom title and defaultDocumentType when configProvider provides workspace config', async () => {
      const customServer = createHttpServer();
      const mockConfigProvider: WorkspaceConfigProviderPort = {
        getWorkspaceConfig: vi.fn().mockResolvedValue({
          appTitle: 'Custom Enterprise Workspace',
          defaultDocumentType: 'invoice-doc',
        }),
      };

      registerWorkspaceFeatureRoutes(customServer, {
        authVerifier: mockAuthVerifier,
        uiBuilder: mockUiBuilder,
        configProvider: mockConfigProvider,
      });

      const response = await customServer.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.user-token',
          },
          drive: {
            selectedItems: [{ id: 'file-123', title: 'Invoice.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockConfigProvider.getWorkspaceConfig).toHaveBeenCalled();
      expect(mockUiBuilder.buildTitleBlock).toHaveBeenCalledWith({
        title: 'Custom Enterprise Workspace',
        subtitle: 'Process Document',
      });
      expect(mockUiBuilder.buildStatusMessageBlock).toHaveBeenCalledWith(
        'Current DocumentType: invoice-doc',
        false
      );
    });

    it('returns 200 with drive document process card even when userOAuthToken is omitted', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          drive: {
            selectedItems: [{ id: 'file-123', title: 'Invoice.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(mockAuthVerifier.verifyToken).toHaveBeenCalledWith('Bearer valid-token');
      expect(mockUiBuilder.buildTitleBlock).toHaveBeenCalledWith({
        title: 'INC-IO Engine',
        subtitle: 'Process Document',
      });
      expect(body).toEqual({
        action: { navigations: [{ pushCard: { header: { title: 'INC-IO Engine' }, sections: [] } }] },
      });
    });

    it('returns 401 when auth verification fails', async () => {
      (mockAuthVerifier.verifyToken as ReturnType<typeof vi.fn>).mockResolvedValue({
        isValid: false,
        error: 'Invalid token signature',
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid token signature');
    });

    it('returns 200 with native Error Card when processing throws an unexpected error', async () => {
      const errorServer = createHttpServer();
      const faultyConfigProvider: WorkspaceConfigProviderPort = {
        getWorkspaceConfig: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      };

      registerWorkspaceFeatureRoutes(errorServer, {
        authVerifier: mockAuthVerifier,
        uiBuilder: mockUiBuilder,
        configProvider: faultyConfigProvider,
      });

      const response = await errorServer.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          authorizationEventObject: {
            userOAuthToken: 'ya29.user-token',
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockUiBuilder.buildErrorCard).toHaveBeenCalledWith('Database connection failed');
    });
  });
});

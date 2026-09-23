import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpServer, type HttpServer, type HttpHandler } from '../http';
import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceUiOrchestratorPort,
} from './api';

describe('Workspace Add-on Infrastructure API', () => {
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockUiOrchestrator: WorkspaceUiOrchestratorPort;

  beforeEach(() => {
    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (authHeader?: string) => {
        if (!authHeader) {
          return { isValid: false, error: 'Authorization header missing' };
        }
        if (authHeader === 'Bearer valid-token') {
          return { isValid: true, payload: { email: 'user@example.com' } };
        }
        return { isValid: false, error: 'Invalid token signature' };
      }),
    };

    mockUiOrchestrator = {
      processUiEvent: vi.fn().mockResolvedValue({
        action: {
          navigations: [
            {
              pushCard: {
                header: { title: 'Test Card' },
                sections: [],
              },
            },
          ],
        },
      }),
    };
  });

  describe('POST /workspace/drive-items-selected', () => {
    it('returns 401 Unauthorized if authorization header is missing', async () => {
      const server = createHttpServer();
      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: mockUiOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Authorization header missing');
    });

    it('returns 401 Unauthorized if token is invalid', async () => {
      const server = createHttpServer();
      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: mockUiOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer invalid-token',
        },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid token signature');
    });

    it('delegates to uiOrchestrator when valid token provided', async () => {
      const server = createHttpServer();
      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: mockUiOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          drive: {
            selectedItems: [{ id: 'file-123', title: 'sample.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockUiOrchestrator.processUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedItems: [{ id: 'file-123', title: 'sample.pdf' }],
        })
      );
      const body = JSON.parse(response.payload);
      expect(body.action.navigations[0].pushCard.header.title).toBe('Test Card');
    });

    it('injects appBaseUrl into WorkspaceExecutionContext when host headers are omitted', async () => {
      const routes: Record<string, HttpHandler> = {};
      const mockServer = {
        registerRoute: vi.fn().mockImplementation((route) => {
          routes[route.url] = route.handler;
        }),
        start: vi.fn(),
        close: vi.fn(),
        inject: vi.fn(),
      } as unknown as HttpServer;

      registerWorkspaceAddonRoutes(mockServer, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: mockUiOrchestrator,
        appBaseUrl: 'https://injected.example.com',
      });

      const handler = routes['/workspace/drive-items-selected'];
      const response = await handler({
        headers: {
          authorization: 'Bearer valid-token',
        },
        body: {
          drive: {
            selectedItems: [{ id: 'file-123', title: 'sample.pdf' }],
          },
        },
      });

      expect(response.status).toBe(200);
      expect(mockUiOrchestrator.processUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'https://injected.example.com',
        })
      );
    });

    it('returns 200 with native error card when process throws an unexpected error', async () => {
      const server = createHttpServer();
      const faultyOrchestrator: WorkspaceUiOrchestratorPort = {
        processUiEvent: vi.fn().mockRejectedValue(new Error('Rendering pipeline failed')),
      };

      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: faultyOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          drive: { selectedItems: [{ id: 'file-123' }] },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.action.navigations[0].pushCard.header.title).toBe('Error');
    });
  });

  describe('POST /workspace/homepage', () => {
    it('returns a valid card on homepage trigger', async () => {
      const server = createHttpServer();
      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: mockUiOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/homepage',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockUiOrchestrator.processUiEvent).toHaveBeenCalled();
    });
  });

  describe('POST /workspace/on-form-change', () => {
    it('blindly routes form change event to uiOrchestrator', async () => {
      const server = createHttpServer();
      const updateOrchestrator: WorkspaceUiOrchestratorPort = {
        processUiEvent: vi.fn().mockResolvedValue({
          action: {
            navigations: [
              {
                updateCard: {
                  header: { title: 'Updated Card' },
                  sections: [],
                },
              },
            ],
          },
        }),
      };

      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: updateOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          commonEventObject: {
            formInputs: {
              SelectDocumentType: { stringInputs: { value: ['communication-project'] } },
              contact: { stringInputs: { value: ['Alice'] } },
            },
            parameters: {
              action: 'onFormChange',
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(updateOrchestrator.processUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'onFormChange',
          formData: {
            SelectDocumentType: 'communication-project',
            contact: 'Alice',
          },
        })
      );
      const body = JSON.parse(response.payload);
      expect(body.action.navigations[0].updateCard.header.title).toBe('Updated Card');
    });
  });

  describe('POST /workspace/action', () => {
    it('blindly routes processDocument action to uiOrchestrator', async () => {
      const server = createHttpServer();
      const actionOrchestrator: WorkspaceUiOrchestratorPort = {
        processUiEvent: vi.fn().mockResolvedValue({
          action: {
            notification: {
              text: 'Document processed successfully',
            },
          },
        }),
      };

      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        uiOrchestrator: actionOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-token',
        },
        payload: {
          commonEventObject: {
            parameters: {
              action: 'processDocument',
            },
            formInputs: {
              SelectDocumentType: { stringInputs: { value: ['communication-project'] } },
              contact: { stringInputs: { value: ['Bob'] } },
            },
          },
          drive: {
            selectedItems: [{ id: 'file-123', title: 'contract.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(actionOrchestrator.processUiEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actionName: 'processDocument',
          formData: {
            SelectDocumentType: 'communication-project',
            contact: 'Bob',
          },
          selectedItems: [{ id: 'file-123', title: 'contract.pdf' }],
        })
      );
      const body = JSON.parse(response.payload);
      expect(body.action.notification.text).toBe('Document processed successfully');
    });
  });
});

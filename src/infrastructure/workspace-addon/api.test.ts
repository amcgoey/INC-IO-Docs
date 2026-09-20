import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpServer } from '../http';
import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceDocumentRunnerPort,
  type WorkspaceProcessCardOrchestratorPort,
} from './api';

describe('Workspace Add-on Infrastructure API', () => {
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockDocumentService: WorkspaceDocumentRunnerPort;
  let mockOrchestrator: WorkspaceProcessCardOrchestratorPort;

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

    mockDocumentService = {
      processDocument: vi.fn().mockResolvedValue({
        success: true,
        outputs: [{ status: 'success' }],
      }),
    };

    mockOrchestrator = {
      generateCard: vi.fn().mockResolvedValue({
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

    it('delegates to processCardOrchestrator when valid token provided', async () => {
      const server = createHttpServer();
      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        processCardOrchestrator: mockOrchestrator,
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
      expect(mockOrchestrator.generateCard).toHaveBeenCalledWith(
        expect.objectContaining({
          viewId: 'drive-document-process-card',
        })
      );
      const body = JSON.parse(response.payload);
      expect(body.action.navigations[0].pushCard.header.title).toBe('Test Card');
    });

    it('returns 200 with native error card when process throws an unexpected error', async () => {
      const server = createHttpServer();
      const faultyOrchestrator: WorkspaceProcessCardOrchestratorPort = {
        generateCard: vi.fn().mockRejectedValue(new Error('Rendering pipeline failed')),
      };

      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        processCardOrchestrator: faultyOrchestrator,
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
        processCardOrchestrator: mockOrchestrator,
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/homepage',
        headers: {
          authorization: 'Bearer valid-token',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockOrchestrator.generateCard).toHaveBeenCalled();
    });
  });

  describe('POST /workspace/on-form-change', () => {
    it('evaluates form change and returns an updated card from orchestrator', async () => {
      const server = createHttpServer();
      const updateOrchestrator: WorkspaceProcessCardOrchestratorPort = {
        generateCard: vi.fn().mockResolvedValue({
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

      const mockEvaluateFormChange = vi.fn().mockReturnValue({
        computedData: { contact: 'Alice', computedField: 'Alice - Computed' },
        hiddenFields: [],
        disabledFields: [],
      });

      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        processCardOrchestrator: updateOrchestrator,
        evaluateFormChange: mockEvaluateFormChange,
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
      expect(updateOrchestrator.generateCard).toHaveBeenCalledWith(
        expect.objectContaining({
          viewId: 'drive-document-process-card',
          documentTypeKey: 'communication-project',
          isUpdateCard: true,
        })
      );
      const body = JSON.parse(response.payload);
      expect(body.action.navigations[0].updateCard.header.title).toBe('Updated Card');
    });
  });

  describe('POST /workspace/action', () => {
    it('executes processDocument on success and returns a notification', async () => {
      const server = createHttpServer();
      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        documentService: mockDocumentService,
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
      expect(mockDocumentService.processDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'communication-project',
          data: { contact: 'Bob' },
        }),
        'onSubmit',
        expect.anything()
      );
      const body = JSON.parse(response.payload);
      expect(body.action.notification.text).toBe('Document processed successfully');
    });

    it('passes validation errors back to processCardOrchestrator when processDocument fails', async () => {
      const server = createHttpServer();
      const failingDocService: WorkspaceDocumentRunnerPort = {
        processDocument: vi.fn().mockRejectedValue(new Error('Validation failed: missing contact')),
      };

      registerWorkspaceAddonRoutes(server, {
        authVerifier: mockAuthVerifier,
        documentService: failingDocService,
        processCardOrchestrator: mockOrchestrator,
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
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockOrchestrator.generateCard).toHaveBeenCalledWith(
        expect.objectContaining({
          validationErrors: ['Validation failed: missing contact'],
        })
      );
    });
  });
});

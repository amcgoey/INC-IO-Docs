import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpServer, type HttpServer } from '../../../infrastructure/http';
import { registerWorkspaceFeatureRoutes } from './api';
import type { AuthVerifierPort } from '../ports';
import type { RecordServicePort } from '../../record/ports';

describe('Workspace Feature Routes', () => {
  let server: HttpServer;
  let mockAuthVerifier: AuthVerifierPort;
  let mockRecordService: RecordServicePort;

  beforeEach(() => {
    server = createHttpServer();
    mockAuthVerifier = {
      verifyToken: vi.fn().mockResolvedValue({ isValid: true, payload: { email: 'user@example.com' } }),
    };
    mockRecordService = {
      processRecord: vi.fn().mockResolvedValue({
        success: true,
        data: { type: 'test-record', data: {} },
        activities: [],
      }),
    };

    registerWorkspaceFeatureRoutes(server, {
      authVerifier: mockAuthVerifier,
      recordService: mockRecordService,
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
        renderActions: {
          action: {
            notification: {
              text: "Moved 'Proposal.pdf' to '!TestMove'",
            },
          },
        },
      });

      expect(mockRecordService.processRecord).toHaveBeenCalledWith(
        {
          type: 'test-record',
          data: {
            title: 'Proposal.pdf',
          },
        },
        'onSubmit',
        expect.objectContaining({
          userOAuthToken: 'ya29.sample-user-oauth-token',
          traceId: 'trace-12345',
          selectedItems: [
            {
              id: 'file-xyz',
              title: 'Proposal.pdf',
              mimeType: 'application/pdf',
            },
          ],
        })
      );
    });

    it('returns 400 when recordService fails validation', async () => {
      (mockRecordService.processRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        errors: ['Invalid record data'],
      });

      const response = await server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: {
          authorization: 'Bearer valid-jwt',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload);
      expect(body.success).toBe(false);
      expect(body.errors).toEqual(['Invalid record data']);
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
      expect(mockRecordService.processRecord).not.toHaveBeenCalled();
    });
  });
});

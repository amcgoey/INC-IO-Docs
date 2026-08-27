import { describe, it, expect } from 'vitest';
import {
  extractWorkspaceExecutionContext,
  type WorkspaceEventPayload,
} from './domain';

describe('Workspace Domain Helpers', () => {
  describe('extractWorkspaceExecutionContext', () => {
    it('extracts execution context from complete WorkspaceEventPayload', () => {
      const payload: WorkspaceEventPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.auth-obj-token',
        },
        userEmail: 'alice@example.com',
        commonEventObject: {
          hostApp: 'DRIVE',
          platform: 'WEB',
        },
        drive: {
          selectedItems: [
            {
              id: 'file-abc-123',
              title: 'Summary.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      };

      const context = extractWorkspaceExecutionContext(payload, 'trace-999');

      expect(context).toEqual({
        userOAuthToken: 'ya29.auth-obj-token',
        userEmail: 'alice@example.com',
        hostApp: 'DRIVE',
        platform: 'WEB',
        traceId: 'trace-999',
        selectedItems: [
          {
            id: 'file-abc-123',
            title: 'Summary.pdf',
            mimeType: 'application/pdf',
          },
        ],
        rawEvent: payload,
      });
    });

    it('falls back to top-level userOAuthToken when authorizationEventObject is omitted', () => {
      const payload: Partial<WorkspaceEventPayload> = {
        userOAuthToken: 'ya29.top-level-token',
      };

      const context = extractWorkspaceExecutionContext(payload);
      expect(context.userOAuthToken).toBe('ya29.top-level-token');
    });

    it('handles undefined or null payload gracefully', () => {
      const context = extractWorkspaceExecutionContext(null);
      expect(context).toEqual({
        userOAuthToken: undefined,
        userEmail: undefined,
        hostApp: undefined,
        platform: undefined,
        traceId: undefined,
        selectedItems: undefined,
        rawEvent: null,
      });
    });
  });
});

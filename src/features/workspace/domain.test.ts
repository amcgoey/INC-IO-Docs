import { describe, it, expect } from 'vitest';
import {
  extractWorkspaceExecutionContext,
  findLatestFileLocator,
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

    it('returns default context when payload fails schema validation', () => {
      const invalidPayload = {
        authorizationEventObject: 'invalid-string-instead-of-object',
      };
      const context = extractWorkspaceExecutionContext(invalidPayload);
      expect(context.userOAuthToken).toBeUndefined();
      expect(context.rawEvent).toBe(invalidPayload);
    });
  });

  describe('findLatestFileLocator', () => {
    it('returns undefined when outputs array is empty or undefined', () => {
      expect(findLatestFileLocator(undefined)).toBeUndefined();
      expect(findLatestFileLocator([])).toBeUndefined();
    });

    it('returns the last file locator when multiple outputs and files exist', () => {
      const outputs = [
        {
          files: [
            { id: '1', name: 'File1.pdf' },
            { id: '2', name: 'File2.pdf' },
          ],
        },
        {
          files: [],
        },
        {
          files: [
            { id: '3', name: 'File3.pdf', parentName: 'TargetFolder' },
          ],
        },
      ];

      expect(findLatestFileLocator(outputs)).toEqual({
        id: '3',
        name: 'File3.pdf',
        parentName: 'TargetFolder',
      });
    });

    it('returns undefined when none of the outputs have files', () => {
      const outputs = [{ files: [] }, {}];
      expect(findLatestFileLocator(outputs)).toBeUndefined();
    });
  });
});

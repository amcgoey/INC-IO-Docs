import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  createWorkspaceDocumentExecutionContext,
  extractWorkspaceExecutionContext,
  findLatestFileLocator,
  WorkspaceDocumentExecutionContextSchema,
  type WorkspaceEventPayload,
  type WorkspaceExecutionContext,
  type WorkspaceDocumentExecutionContext,
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

  describe('WorkspaceDocumentExecutionContextSchema', () => {
    it('validates valid and invalid WorkspaceDocumentExecutionContext instances', () => {
      expect(WorkspaceDocumentExecutionContextSchema).toBeDefined();

      const validContext: WorkspaceDocumentExecutionContext = {
        credentials: { oauthToken: 'ya29.valid-token' },
        resources: { primaryTargetId: 'file-123' },
      };
      expect(Value.Check(WorkspaceDocumentExecutionContextSchema, validContext)).toBe(true);

      const emptyContext: WorkspaceDocumentExecutionContext = {};
      expect(Value.Check(WorkspaceDocumentExecutionContextSchema, emptyContext)).toBe(true);

      const invalidCredentials = {
        credentials: 'invalid-string',
      };
      expect(Value.Check(WorkspaceDocumentExecutionContextSchema, invalidCredentials)).toBe(false);

      const invalidResources = {
        resources: 12345,
      };
      expect(Value.Check(WorkspaceDocumentExecutionContextSchema, invalidResources)).toBe(false);
    });
  });

  describe('createWorkspaceDocumentExecutionContext', () => {
    it('creates WorkspaceDocumentExecutionContext with credentials and resources when present', () => {
      const context: WorkspaceExecutionContext = {
        userOAuthToken: 'ya29.my-token',
        selectedItems: [
          { id: 'target-file-123', title: 'Doc.pdf' },
        ],
      };

      const result = createWorkspaceDocumentExecutionContext(context);
      expect(result).toEqual({
        credentials: { oauthToken: 'ya29.my-token' },
        resources: { primaryTargetId: 'target-file-123' },
      });
    });

    it('creates empty object when token and selected items are not present', () => {
      const context: WorkspaceExecutionContext = {};
      const result = createWorkspaceDocumentExecutionContext(context);
      expect(result).toEqual({});
    });

    it('handles context with only token or only selected item', () => {
      const tokenOnly: WorkspaceExecutionContext = {
        userOAuthToken: 'ya29.token-only',
      };
      expect(createWorkspaceDocumentExecutionContext(tokenOnly)).toEqual({
        credentials: { oauthToken: 'ya29.token-only' },
      });

      const itemOnly: WorkspaceExecutionContext = {
        selectedItems: [{ id: 'item-only-456' }],
      };
      expect(createWorkspaceDocumentExecutionContext(itemOnly)).toEqual({
        resources: { primaryTargetId: 'item-only-456' },
      });
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  extractWorkspaceExecutionContext,
  createWorkspaceDocumentExecutionContext,
  findLatestFileLocator,
} from './context';

describe('Workspace Add-on Context', () => {
  describe('extractWorkspaceExecutionContext', () => {
    it('extracts formData and actionName from commonEventObject', () => {
      const rawPayload = {
        commonEventObject: {
          formInputs: {
            SelectDocumentType: {
              stringInputs: {
                value: ['invoice'],
              },
            },
            title: {
              stringInputs: {
                value: ['My Invoice'],
              },
            },
            simpleField: 'simpleValue',
          },
          parameters: {
            action: 'onFormChange',
          },
        },
      };

      const context = extractWorkspaceExecutionContext(rawPayload, 'trace-123');

      expect(context.formData).toEqual({
        SelectDocumentType: 'invoice',
        title: 'My Invoice',
        simpleField: 'simpleValue',
      });
      expect(context.actionName).toBe('onFormChange');
      expect(context.traceId).toBe('trace-123');
    });

    it('extracts validationErrors array when present in parameters', () => {
      const rawPayload = {
        commonEventObject: {
          parameters: {
            validationErrors: JSON.stringify(['Error 1', 'Error 2']),
          },
        },
      };

      const context = extractWorkspaceExecutionContext(rawPayload);
      expect(context.validationErrors).toEqual(['Error 1', 'Error 2']);
    });

    it('extracts single error string when not valid JSON array', () => {
      const rawPayload = {
        commonEventObject: {
          parameters: {
            validationErrors: 'Single error string',
          },
        },
      };

      const context = extractWorkspaceExecutionContext(rawPayload);
      expect(context.validationErrors).toEqual(['Single error string']);
    });

    it('extracts userOAuthToken and selected items from drive event', () => {
      const rawPayload = {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-token',
        },
        drive: {
          selectedItems: [
            { id: 'drive-file-1', title: 'File 1.pdf', mimeType: 'application/pdf' },
          ],
        },
      };

      const context = extractWorkspaceExecutionContext(rawPayload);
      expect(context.userOAuthToken).toBe('ya29.sample-token');
      expect(context.selectedItems).toEqual([
        { id: 'drive-file-1', title: 'File 1.pdf', mimeType: 'application/pdf' },
      ]);
    });
  });

  describe('createWorkspaceDocumentExecutionContext', () => {
    it('maps userOAuthToken and primary target id', () => {
      const execContext = createWorkspaceDocumentExecutionContext({
        userOAuthToken: 'test-oauth-token',
        selectedItems: [{ id: 'target-item-456' }],
      });

      expect(execContext).toEqual({
        credentials: { oauthToken: 'test-oauth-token' },
        resources: { primaryTargetId: 'target-item-456' },
      });
    });

    it('returns empty context when no token or target id', () => {
      const execContext = createWorkspaceDocumentExecutionContext({});
      expect(execContext).toEqual({});
    });
  });

  describe('findLatestFileLocator', () => {
    it('returns undefined if outputs is empty or undefined', () => {
      expect(findLatestFileLocator(undefined)).toBeUndefined();
      expect(findLatestFileLocator([])).toBeUndefined();
    });

    it('returns the last file from the latest output with files', () => {
      const outputs = [
        { files: [{ name: 'first.pdf' }, { name: 'second.pdf' }] },
        { files: [{ name: 'latest.pdf' }] },
      ];
      expect(findLatestFileLocator(outputs)).toEqual({ name: 'latest.pdf' });
    });
  });
});

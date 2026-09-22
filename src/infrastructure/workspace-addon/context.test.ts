import { describe, it, expect, afterEach } from 'vitest';
import {
  extractWorkspaceExecutionContext,
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

    describe('baseUrl extraction', () => {
      const originalEnv = process.env.APP_BASE_URL;

      afterEach(() => {
        if (originalEnv !== undefined) {
          process.env.APP_BASE_URL = originalEnv;
        } else {
          delete process.env.APP_BASE_URL;
        }
      });

      it('extracts baseUrl from x-forwarded-proto and x-forwarded-host headers', () => {
        const headers = {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'workspace-addon.example.com',
        };
        const context = extractWorkspaceExecutionContext({}, undefined, headers);
        expect(context.baseUrl).toBe('https://workspace-addon.example.com');
      });

      it('extracts baseUrl from x-forwarded-proto and host headers', () => {
        const headers = {
          'x-forwarded-proto': 'https',
          host: 'direct-host.example.com',
        };
        const context = extractWorkspaceExecutionContext({}, undefined, headers);
        expect(context.baseUrl).toBe('https://direct-host.example.com');
      });

      it('defaults to https if x-forwarded-host is present without x-forwarded-proto', () => {
        const headers = {
          'x-forwarded-host': 'proxy.example.com',
        };
        const context = extractWorkspaceExecutionContext({}, undefined, headers);
        expect(context.baseUrl).toBe('https://proxy.example.com');
      });

      it('handles comma-separated multi-proxy headers and trims whitespace', () => {
        const headers = {
          'x-forwarded-proto': 'https, http',
          'x-forwarded-host': 'first-proxy.example.com, second-proxy.example.com',
        };
        const context = extractWorkspaceExecutionContext({}, undefined, headers);
        expect(context.baseUrl).toBe('https://first-proxy.example.com');
      });

      it('falls back to process.env.APP_BASE_URL when headers are absent', () => {
        process.env.APP_BASE_URL = 'https://fallback.example.com';
        const context = extractWorkspaceExecutionContext({});
        expect(context.baseUrl).toBe('https://fallback.example.com');
      });

      it('strips trailing slashes from process.env.APP_BASE_URL', () => {
        process.env.APP_BASE_URL = 'https://fallback.example.com///';
        const context = extractWorkspaceExecutionContext({});
        expect(context.baseUrl).toBe('https://fallback.example.com');
      });

      it('returns undefined when headers and process.env.APP_BASE_URL are absent', () => {
        delete process.env.APP_BASE_URL;
        const context = extractWorkspaceExecutionContext({});
        expect(context.baseUrl).toBeUndefined();
      });
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

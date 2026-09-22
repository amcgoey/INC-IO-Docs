import { describe, it, expect, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  extractWorkspaceExecutionContext,
  findLatestFileLocator,
  AppBaseUrlEnvSchema,
  WorkspaceRequestHeadersSchema,
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

      it('defaults to https when standalone host header is present without x-forwarded-proto', () => {
        const headers = {
          host: 'standalone.example.com',
        };
        const context = extractWorkspaceExecutionContext({}, undefined, headers);
        expect(context.baseUrl).toBe('https://standalone.example.com');
      });

      it('defaults to http when standalone host is localhost or localhost with port', () => {
        const headersWithPort = {
          host: 'localhost:3000',
        };
        expect(extractWorkspaceExecutionContext({}, undefined, headersWithPort).baseUrl).toBe(
          'http://localhost:3000'
        );

        const headersWithoutPort = {
          host: 'localhost',
        };
        expect(extractWorkspaceExecutionContext({}, undefined, headersWithoutPort).baseUrl).toBe(
          'http://localhost'
        );
      });

      it('defaults to http when standalone host is 127.0.0.1 or 127.0.0.1 with port', () => {
        const headersWithPort = {
          host: '127.0.0.1:8080',
        };
        expect(extractWorkspaceExecutionContext({}, undefined, headersWithPort).baseUrl).toBe(
          'http://127.0.0.1:8080'
        );

        const headersWithoutPort = {
          host: '127.0.0.1',
        };
        expect(extractWorkspaceExecutionContext({}, undefined, headersWithoutPort).baseUrl).toBe(
          'http://127.0.0.1'
        );
      });

      it('prioritizes standalone host header over process.env.APP_BASE_URL', () => {
        process.env.APP_BASE_URL = 'https://fallback.example.com';
        const headers = {
          host: 'standalone-priority.example.com',
        };
        const context = extractWorkspaceExecutionContext({}, undefined, headers);
        expect(context.baseUrl).toBe('https://standalone-priority.example.com');
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

      it('returns undefined when process.env.APP_BASE_URL is empty string or only whitespace', () => {
        process.env.APP_BASE_URL = '';
        expect(extractWorkspaceExecutionContext({}).baseUrl).toBeUndefined();

        process.env.APP_BASE_URL = '   ';
        expect(extractWorkspaceExecutionContext({}).baseUrl).toBeUndefined();
      });

      it('validates environment variable boundary against AppBaseUrlEnvSchema', () => {
        expect(AppBaseUrlEnvSchema).toBeDefined();
      });

      it('validates headers boundary against WorkspaceRequestHeadersSchema', () => {
        expect(WorkspaceRequestHeadersSchema).toBeDefined();
        expect(Value.Check(WorkspaceRequestHeadersSchema, { host: 'example.com' })).toBe(true);
        expect(
          Value.Check(WorkspaceRequestHeadersSchema, {
            'x-forwarded-proto': ['https'],
            'x-custom': undefined,
          })
        ).toBe(true);
        expect(Value.Check(WorkspaceRequestHeadersSchema, { host: 123 })).toBe(false);
        expect(Value.Check(WorkspaceRequestHeadersSchema, 'not-an-object')).toBe(false);
        expect(Value.Check(WorkspaceRequestHeadersSchema, null)).toBe(false);
      });

      it('falls back gracefully when invalid rawHeaders are passed to extractWorkspaceExecutionContext', () => {
        const context = extractWorkspaceExecutionContext({}, undefined, { host: 123 } as unknown);
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

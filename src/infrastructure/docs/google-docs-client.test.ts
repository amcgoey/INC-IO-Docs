import { describe, it, expect, vi, afterEach } from 'vitest';
import nock from 'nock';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { OAuth2Client } from 'google-auth-library';
import type { docs_v1 } from 'googleapis';
import { GoogleDocsClient } from './google-docs-client';
import {
  GoogleDocsApiError,
  GoogleDocsCorruptedError,
  GoogleDocsNotFoundError,
} from './errors';

describe('GoogleDocsClient', () => {
  describe('extractFormData — validation & tab traversal', () => {
    it('throws GoogleDocsCorruptedError on non-object, missing tabs/body, or invalid tabs/body.content', () => {
      const client = new GoogleDocsClient();

      for (const bad of [
        null,
        undefined,
        'not-a-doc',
        42,
        [],
        {},
        { documentId: 'doc-1', title: 'No tabs or body' },
        { tabs: null, body: null },
        { tabs: 'not-an-array' },
        { body: {} },
        { body: { content: 'not-an-array' } },
        { tabs: [{ documentTab: { body: { content: 'not-an-array' } } }] },
      ]) {
        expect(() => client.extractFormData(bad)).toThrow(GoogleDocsCorruptedError);
      }
    });

    it('tolerates null and undefined optional discovery properties (including ExactOptionalPropertyTypes = true) and returns 0 widgets for empty docs', () => {
      const client = new GoogleDocsClient();
      const prevPolicy = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        const res = client.extractFormData({
          documentId: 'doc-1',
          title: null,
          body: null,
          tabs: [
            {
              tabProperties: { tabId: 't.0', title: null },
              documentTab: {
                dropdownDefinitions: null,
                body: {
                  content: [
                    {
                      sectionBreak: {},
                    },
                    {
                      paragraph: {
                        elements: [{ textRun: { content: 'Plain narrative paragraph.\n', } }],
                      },
                    },
                  ],
                },
              },
              childTabs: null,
            },
          ],
        });

        expect(res).toEqual({ widgetCount: 0, fields: {} });
        expect('ambiguousFields' in res).toBe(false);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prevPolicy;
      }
    });

    it('falls back to document.body when tabs is absent, null, or empty', () => {
      const client = new GoogleDocsClient();

      for (const doc of [
        { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello\n' } }] } }] } },
        { tabs: null, body: { content: [] } },
        { tabs: [], body: { content: [] } },
      ]) {
        expect(client.extractFormData(doc)).toEqual({ widgetCount: 0, fields: {} });
      }
    });

    it('ignores headers, footers, and footnotes when traversing tab.body only', () => {
      const client = new GoogleDocsClient();

      const headerTable = {
        table: {
          rows: 1,
          columns: 2,
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Header Key\n' } }] } }] },
                { content: [{ paragraph: { elements: [{ textRun: { content: 'Header Val\n' } }] } }] },
              ],
            },
          ],
        },
      };

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              headers: {
                h1: { content: [headerTable] },
              },
              footers: {
                f1: { content: [headerTable] },
              },
              footnotes: {
                fn1: { content: [headerTable] },
              },
              body: {
                content: [
                  { paragraph: { elements: [{ textRun: { content: 'Body prose only\n' } }] } },
                ],
              },
            },
          },
        ],
      });

      expect(res).toEqual({ widgetCount: 0, fields: {} });
    });
  });

  describe('extractFormData — Pattern 4 (N×2 Key/Value Form Tables) & foundational guards', () => {
    const textCell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
      content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
      ...(style ? { tableCellStyle: style } : {}),
    });

    it('extracts N×2 Key/Value tables normalizing labels ("Submittal No." -> "Submittal No") and stripping trailing \\n and \\uE907', () => {
      const client = new GoogleDocsClient();

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  {
                    table: {
                      rows: 1,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            textCell('  Submittal   No.: \n'),
                            textCell('071200-001-1\uE907\n'),
                          ],
                        },
                      ],
                    },
                  },
                  {
                    table: {
                      rows: 2,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            textCell('Project Name:\n'),
                            textCell('Acme\uE907 Tower\n'),
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Notes\n'),
                            {
                              content: [
                                { paragraph: { elements: [{ textRun: { content: 'Line A\n' } }] } },
                                { paragraph: { elements: [{ textRun: { content: 'Line B\n' } }] } },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      });

      expect(res).toEqual({
        widgetCount: 3,
        fields: {
          'Submittal No': '071200-001-1',
          'Project Name': 'Acme Tower',
          Notes: 'Line A\nLine B',
        },
      });
    });

    it('strips pure {{...}} placeholders while preserving partial user entries and still counting widgets', () => {
      const client = new GoogleDocsClient();

      const res = client.extractFormData({
        body: {
          content: [
            {
              table: {
                rows: 5,
                columns: 2,
                tableRows: [
                  { tableCells: [textCell('Submittal No.\n'), textCell('{{section}}-{{number}}-{{revision}}\n')] },
                  { tableCells: [textCell('Remarks:\n'), textCell('{{INSERT REMARKS HERE}}\n')] },
                  { tableCells: [textCell('Pair:\n'), textCell('{{a}} / {{b}}\n')] },
                  { tableCells: [textCell('Partial:\n'), textCell('{{section}}-001-{{revision}}\n')] },
                  { tableCells: [textCell('Blank:\n'), textCell('\uE907\n')] },
                ],
              },
            },
          ],
        },
      });

      expect(res).toEqual({
        widgetCount: 5,
        fields: {
          Partial: '{{section}}-001-{{revision}}',
        },
      });
    });

    it('rejects label cells with raw line breaks, smart chips, \\uE907, dividers, >40 chars, Handlebars, or merged cells', () => {
      const client = new GoogleDocsClient();

      const rejectedTables = [
        // Raw \n inside single paragraph
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell('Line 1\nLine 2\n'), textCell('val\n')] }],
        },
        // Raw \r inside single paragraph
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell('Line 1\rLine 2\n'), textCell('val\n')] }],
        },
        // Multi-paragraph label cell
        {
          rows: 1,
          columns: 2,
          tableRows: [
            {
              tableCells: [
                {
                  content: [
                    { paragraph: { elements: [{ textRun: { content: 'Line 1\n' } }] } },
                    { paragraph: { elements: [{ textRun: { content: 'Line 2\n' } }] } },
                  ],
                },
                textCell('val\n'),
              ],
            },
          ],
        },
        // Smart chips in Col 0 label
        {
          rows: 1,
          columns: 2,
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ dropdown: { dropdownId: 'd1' } }] } }] },
                textCell('val\n'),
              ],
            },
          ],
        },
        {
          rows: 1,
          columns: 2,
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ dateElement: { dateElementProperties: { displayText: 'Date' } } }] } }] },
                textCell('val\n'),
              ],
            },
          ],
        },
        {
          rows: 1,
          columns: 2,
          tableRows: [
            {
              tableCells: [
                { content: [{ paragraph: { elements: [{ person: { personProperties: { name: 'Jane' } } }] } }] },
                textCell('val\n'),
              ],
            },
          ],
        },
        // \uE907 in Col 0 label
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell('Date \uE907\n'), textCell('val\n')] }],
        },
        // Divider punctuation
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell('––––\n'), textCell('val\n')] }],
        },
        // > 40 characters
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell(`${'A'.repeat(41)}\n`), textCell('val\n')] }],
        },
        // Pure Handlebars placeholder label
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell('{{Label}}\n'), textCell('val\n')] }],
        },
        // Merged Col 0 cell
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell('Merged\n', { columnSpan: 2 }), textCell('\n')] }],
        },
        // Merged Col 1 cell
        {
          rows: 1,
          columns: 2,
          tableRows: [{ tableCells: [textCell('Label\n'), textCell('val\n', { rowSpan: 2 })] }],
        },
      ];

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              body: {
                content: rejectedTables.map((table) => ({ table })),
              },
            },
          },
        ],
      });

      expect(res).toEqual({ widgetCount: 0, fields: {} });
    });

    it('accepts 40-character labels, traverses nested childTabs in order preserving first-seen values, and handles Object.prototype keys safely', () => {
      const client = new GoogleDocsClient();
      const maxLenLabel = 'A'.repeat(40);

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  {
                    table: {
                      rows: 3,
                      columns: 2,
                      tableRows: [
                        { tableCells: [textCell(`${maxLenLabel}\n`), textCell('ok\n')] },
                        { tableCells: [textCell('toString\n'), textCell('safe-toString\n')] },
                        { tableCells: [textCell('constructor\n'), textCell('safe-constructor\n')] },
                      ],
                    },
                  },
                ],
              },
            },
            childTabs: [
              {
                documentTab: {
                  body: {
                    content: [
                      {
                        table: {
                          rows: 2,
                          columns: 2,
                          tableRows: [
                            { tableCells: [textCell('toString\n'), textCell('should-not-overwrite\n')] },
                            { tableCells: [textCell('__proto__\n'), textCell('safe-proto\n')] },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      });

      expect(res.widgetCount).toBe(5);
      expect(Object.prototype.toString.call(res.fields)).toBe('[object Object]');
      expect(Object.getPrototypeOf(res.fields)).toBe(Object.prototype);
      expect(Object.hasOwn(res.fields, maxLenLabel)).toBe(true);
      expect(Object.hasOwn(res.fields, 'toString')).toBe(true);
      expect(Object.hasOwn(res.fields, 'constructor')).toBe(true);
      expect(Object.hasOwn(res.fields, '__proto__')).toBe(true);
      expect(res.fields[maxLenLabel]).toBe('ok');
      expect(res.fields['toString']).toBe('safe-toString');
      expect(res.fields['constructor']).toBe('safe-constructor');
      expect(res.fields['__proto__']).toBe('safe-proto');
    });
  });

  describe('extractDocumentFormFields — API transport, TypeBox validation, and error wrapping', () => {
    afterEach(() => {
      nock.cleanAll();
      nock.enableNetConnect();
    });

    it('invokes documents.get with includeTabsContent: true, suggestionsViewMode: PREVIEW_WITHOUT_SUGGESTIONS, and default 10_000ms timeout', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: {
          documentId: 'doc-123',
          body: null,
          tabs: [
            {
              documentTab: {
                body: {
                  content: [
                    {
                      table: {
                        rows: 1,
                        columns: 2,
                        tableRows: [
                          {
                            tableCells: [
                              { content: [{ paragraph: { elements: [{ textRun: { content: 'Submittal No.\n' } }] } }] },
                              { content: [{ paragraph: { elements: [{ textRun: { content: '071200-001-1\n' } }] } }] },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      });
      const mockDocs = { documents: { get: mockGet } } as unknown as docs_v1.Docs;
      const client = new GoogleDocsClient({ docs: mockDocs });

      const result = await client.extractDocumentFormFields('doc-123');

      expect(mockGet).toHaveBeenCalledWith(
        {
          documentId: 'doc-123',
          includeTabsContent: true,
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        },
        { timeout: 10_000 }
      );
      expect(result).toEqual({
        widgetCount: 1,
        fields: { 'Submittal No': '071200-001-1' },
      });
    });

    it('respects custom requestTimeoutMs on constructor and per-call options', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: { body: { content: [] } },
      });
      const mockDocs = { documents: { get: mockGet } } as unknown as docs_v1.Docs;
      const client = new GoogleDocsClient({ docs: mockDocs, requestTimeoutMs: 4500 });

      await client.extractDocumentFormFields('doc-a');
      expect(mockGet).toHaveBeenLastCalledWith(
        expect.objectContaining({ documentId: 'doc-a' }),
        { timeout: 4500 }
      );

      await client.extractDocumentFormFields('doc-b', { requestTimeoutMs: 2500 });
      expect(mockGet).toHaveBeenLastCalledWith(
        expect.objectContaining({ documentId: 'doc-b' }),
        { timeout: 2500 }
      );
    });

    it('executes real HTTP GET against docs.googleapis.com with OAuth2Client bearer auth and query parameters via nock', async () => {
      nock.disableNetConnect();
      const oauth2Client = new OAuth2Client();
      oauth2Client.setCredentials({ access_token: 'ya29.docs-oauth-cred' });

      const scope = nock('https://docs.googleapis.com', {
        reqheaders: {
          authorization: 'Bearer ya29.docs-oauth-cred',
        },
      })
        .get('/v1/documents/doc-nock-1')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, {
          documentId: 'doc-nock-1',
          body: null,
          tabs: [
            {
              documentTab: {
                body: {
                  content: [
                    {
                      table: {
                        rows: 1,
                        columns: 2,
                        tableRows: [
                          {
                            tableCells: [
                              { content: [{ paragraph: { elements: [{ textRun: { content: 'Submittal No.\n' } }] } }] },
                              { content: [{ paragraph: { elements: [{ textRun: { content: 'CG104-A\n' } }] } }] },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        });

      const client = new GoogleDocsClient({ auth: oauth2Client });
      const result = await client.extractDocumentFormFields('doc-nock-1');

      expect(result).toEqual({
        widgetCount: 1,
        fields: { 'Submittal No': 'CG104-A' },
      });
      expect(scope.isDone()).toBe(true);
    });

    it('throws GoogleDocsCorruptedError without wrapping when 200 payload fails TypeBox validation', async () => {
      const mockGet = vi
        .fn()
        .mockResolvedValueOnce({ data: {} })
        .mockResolvedValueOnce({ data: { body: { content: 'bad' } } })
        .mockResolvedValueOnce({ data: null });
      const client = new GoogleDocsClient({
        docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
      });

      await expect(client.extractDocumentFormFields('doc-empty')).rejects.toThrow(GoogleDocsCorruptedError);
      await expect(client.extractDocumentFormFields('doc-bad-content')).rejects.toThrow(GoogleDocsCorruptedError);
      await expect(client.extractDocumentFormFields('doc-null')).rejects.toThrow(GoogleDocsCorruptedError);
    });

    it('wraps 404 (numeric and string err.code) in GoogleDocsNotFoundError and other transport failures in GoogleDocsApiError', async () => {
      const mockGet = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
        .mockRejectedValueOnce(Object.assign(new Error('Missing'), { code: '404' }))
        .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { statusCode: 403 }))
        .mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { response: { status: 503 } }))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'));
      const client = new GoogleDocsClient({
        docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
      });

      await expect(client.extractDocumentFormFields('doc-404-num')).rejects.toBeInstanceOf(GoogleDocsNotFoundError);
      await expect(client.extractDocumentFormFields('doc-404-str')).rejects.toBeInstanceOf(GoogleDocsNotFoundError);

      const err403 = await client.extractDocumentFormFields('doc-403').catch((e: unknown) => e);
      expect(err403).toBeInstanceOf(GoogleDocsApiError);
      expect(err403).not.toBeInstanceOf(GoogleDocsNotFoundError);
      expect((err403 as GoogleDocsApiError).statusCode).toBe(403);

      const err503 = await client.extractDocumentFormFields('doc-503').catch((e: unknown) => e);
      expect(err503).toBeInstanceOf(GoogleDocsApiError);
      expect((err503 as GoogleDocsApiError).statusCode).toBe(503);

      const errTimeout = await client.extractDocumentFormFields('doc-timeout').catch((e: unknown) => e);
      expect(errTimeout).toBeInstanceOf(GoogleDocsApiError);
      expect((errTimeout as GoogleDocsApiError).statusCode).toBeUndefined();
    });
  });
});

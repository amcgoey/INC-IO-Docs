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
        { body: { content: null } },
        { body: { content: 'not-an-array' } },
        { tabs: [{ documentTab: { body: { content: null } } }] },
        { tabs: [{ documentTab: { body: { content: 'not-an-array' } } }] },
      ]) {
        expect(() => client.extractFormData(bad)).toThrow(GoogleDocsCorruptedError);
      }
    });

    it('converts unexpected TypeError or RangeError during structural traversal into GoogleDocsCorruptedError', () => {
      const client = new GoogleDocsClient();

      const getterTypeErrorDoc = {
        body: {
          content: [
            {
              get table() {
                throw new TypeError('Unexpected getter failure');
              },
            },
          ],
        },
      };

      const getterRangeErrorDoc = {
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  {
                    get table() {
                      throw new RangeError('Invalid index range');
                    },
                  },
                ],
              },
            },
          },
        ],
      };

      for (const doc of [getterTypeErrorDoc, getterRangeErrorDoc]) {
        let caught: unknown;
        try {
          client.extractFormData(doc);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(GoogleDocsCorruptedError);
        expect((caught as Error).name).toBe('GoogleDocsCorruptedError');
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

  describe('extractFormData — Dropdown smart-chip resolution, deduplication & Pattern 5 (Standalone Dropdowns)', () => {
    const textCell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
      content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
      ...(style ? { tableCellStyle: style } : {}),
    });

    it('resolves omitted/null displayValue via dropdownDefinitions, strips unset prompts/glyphs, and deduplicates Pattern 4 Col 1 dropdowns by dropdownId and WeakSet', () => {
      const client = new GoogleDocsClient();

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              dropdownDefinitions: {
                'def.priority': {
                  dropdownDefinitionId: 'def.priority',
                  dropdownDefinitionProperties: {
                    title: 'Ignored Because Captured In Table',
                    options: [
                      { optionId: 'opt.prompt', displayValue: 'Select priority' },
                      { optionId: 'opt.high', displayValue: 'High' },
                    ],
                  },
                },
                'def.noIdChip': {
                  dropdownDefinitionId: 'def.noIdChip',
                  dropdownDefinitionProperties: {
                    title: 'Duplicate Title If Not WeakSet Deduped',
                    options: [
                      { optionId: 'opt.choose', displayValue: 'Choose...' },
                      { optionId: 'opt.done', displayValue: 'Complete' },
                    ],
                  },
                },
                'def.unsetDash': {
                  dropdownDefinitionId: 'def.unsetDash',
                  dropdownDefinitionProperties: {
                    title: 'Unset Dash In Table',
                    options: [
                      { optionId: 'opt.dash', displayValue: '—' },
                      { optionId: 'opt.yes', displayValue: 'Approved' },
                    ],
                  },
                },
              },
              body: {
                content: [
                  {
                    table: {
                      rows: 4,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            textCell('Priority:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dropdown: {
                                          dropdownId: 'kix.dd.priority',
                                          dropdownProperties: {
                                            dropdownDefinitionId: 'def.priority',
                                            selectedOptionId: 'opt.high',
                                            displayValue: null,
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('NoId Status\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dropdown: {
                                          // Intentionally omit dropdownId to test WeakSet identity tracking
                                          dropdownProperties: {
                                            dropdownDefinitionId: 'def.noIdChip',
                                            selectedOptionId: 'opt.done',
                                            displayValue: 'Complete',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Review Gate\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dropdown: {
                                          dropdownProperties: {
                                            dropdownDefinitionId: 'def.unsetDash',
                                            selectedOptionId: 'opt.dash',
                                            displayValue: '—',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Missing Def Prompt\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dropdown: {
                                          dropdownProperties: {
                                            displayValue: 'Select option',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
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
        widgetCount: 4,
        fields: {
          Priority: 'High',
          'NoId Status': 'Complete',
        },
      });
    });

    it('extracts Pattern 5 standalone dropdown smart chips from paragraphs and unmatched 1-row tables while stripping unset prompts', () => {
      const client = new GoogleDocsClient();

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              dropdownDefinitions: {
                'def.docStatus': {
                  dropdownDefinitionId: 'def.docStatus',
                  dropdownDefinitionProperties: {
                    title: '  Approval   Status: ',
                    options: [
                      { optionId: 'opt.0', displayValue: 'Select...' },
                      { optionId: 'opt.1', displayValue: '  Approved  ' },
                    ],
                  },
                },
                'def.unmatchedCell': {
                  dropdownDefinitionId: 'def.unmatchedCell',
                  dropdownDefinitionProperties: {
                    title: 'Discipline.',
                    options: [
                      { optionId: 'opt.0', displayValue: 'Choose one' },
                      { optionId: 'opt.1', displayValue: 'Architectural' },
                    ],
                  },
                },
                'def.unsetFirst': {
                  dropdownDefinitionId: 'def.unsetFirst',
                  dropdownDefinitionProperties: {
                    title: 'Pending Choice',
                    options: [
                      { optionId: 'opt.0', displayValue: 'Choose...' },
                      { optionId: 'opt.1', displayValue: 'Ready' },
                    ],
                  },
                },
                'def.unsetNoDefFallback': {
                  dropdownDefinitionId: 'def.unsetNoDefFallback',
                  dropdownDefinitionProperties: {
                    title: 'Unset No Sel',
                    options: [
                      { optionId: 'opt.0', displayValue: 'Other' },
                      { optionId: 'opt.1', displayValue: 'Select item' },
                    ],
                  },
                },
                'def.nonFirstSelect': {
                  dropdownDefinitionId: 'def.nonFirstSelect',
                  dropdownDefinitionProperties: {
                    title: 'NonFirst Prompt',
                    options: [
                      { optionId: 'opt.0', displayValue: 'None' },
                      { optionId: 'opt.1', displayValue: 'Select All' },
                    ],
                  },
                },
                'def.uncheckedGlyph': {
                  dropdownDefinitionId: 'def.uncheckedGlyph',
                  dropdownDefinitionProperties: {
                    title: 'Standalone Box',
                    options: [
                      { optionId: 'opt.0', displayValue: '☐' },
                      { optionId: 'opt.1', displayValue: '☑' },
                    ],
                  },
                },
                'def.multilineTitle': {
                  dropdownDefinitionId: 'def.multilineTitle',
                  dropdownDefinitionProperties: {
                    title: 'Line 1\nLine 2',
                    options: [{ optionId: 'opt.0', displayValue: 'Value' }],
                  },
                },
              },
              body: {
                content: [
                  {
                    paragraph: {
                      elements: [
                        {
                          dropdown: {
                            dropdownId: 'kix.standalone.1',
                            dropdownProperties: {
                              dropdownDefinitionId: 'def.docStatus',
                              selectedOptionId: 'opt.1',
                              displayValue: null,
                            },
                          },
                        },
                        {
                          dropdown: {
                            dropdownId: 'kix.standalone.2',
                            dropdownProperties: {
                              dropdownDefinitionId: 'def.unsetFirst',
                              selectedOptionId: 'opt.0',
                              displayValue: 'Choose...',
                            },
                          },
                        },
                        {
                          dropdown: {
                            dropdownId: 'kix.standalone.3',
                            dropdownProperties: {
                              dropdownDefinitionId: 'def.unsetNoDefFallback',
                              // selectedOptionId absent -> prompt stripped
                              displayValue: 'Select item',
                            },
                          },
                        },
                        {
                          dropdown: {
                            dropdownId: 'kix.standalone.4',
                            dropdownProperties: {
                              dropdownDefinitionId: 'def.nonFirstSelect',
                              // selectedOptionId is NOT firstOptionId -> kept
                              selectedOptionId: 'opt.1',
                              displayValue: 'Select All',
                            },
                          },
                        },
                        {
                          dropdown: {
                            dropdownId: 'kix.standalone.5',
                            dropdownProperties: {
                              dropdownDefinitionId: 'def.uncheckedGlyph',
                              selectedOptionId: 'opt.0',
                              displayValue: '☐',
                            },
                          },
                        },
                        {
                          dropdown: {
                            dropdownId: 'kix.standalone.bad',
                            dropdownProperties: {
                              dropdownDefinitionId: 'def.multilineTitle',
                              selectedOptionId: 'opt.0',
                              displayValue: 'Value',
                            },
                          },
                        },
                      ],
                    },
                  },
                  // Unmatched 1-row non-checkbox table containing a standalone dropdown
                  {
                    table: {
                      rows: 1,
                      columns: 1,
                      tableRows: [
                        {
                          tableCells: [
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dropdown: {
                                          dropdownProperties: {
                                            dropdownDefinitionId: 'def.unmatchedCell',
                                            selectedOptionId: 'opt.1',
                                            displayValue: 'Architectural',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
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
        widgetCount: 6,
        fields: {
          'Approval Status': 'Approved',
          'NonFirst Prompt': 'Select All',
          Discipline: 'Architectural',
        },
      });
    });
  });

  describe('extractFormData — Pattern 1 (Heading + Checkbox Option Tables) & precedingHeadingLabel', () => {
    const textCell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
      content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
      ...(style ? { tableCellStyle: style } : {}),
    });

    const RESPONSE_LABELS = [
      'NO EXCEPTIONS TAKEN',
      'NO OBJECTIONS AS CORRECTED',
      'REVISE AND RESUBMIT',
      'REJECTED',
      'NOT REVIEWED',
    ] as const;

    function buildSubmittalStampTab(options: {
      submittalNo?: string;
      checkedIndices?: number[];
      omitDisplayValue?: boolean;
      spacerParagraphsBetweenHeadingAndTable?: Array<Record<string, unknown>>;
    }) {
      const checked = new Set(options.checkedIndices ?? []);
      return {
        documentTab: {
          dropdownDefinitions: {
            'kix.cb': {
              dropdownDefinitionId: 'kix.cb',
              dropdownDefinitionProperties: {
                title: 'Checkbox',
                options: [
                  { optionId: 'opt.off', displayValue: '☐' },
                  { optionId: 'opt.on', displayValue: '☑' },
                ],
              },
            },
          },
          body: {
            content: [
              { sectionBreak: {} },
              {
                table: {
                  rows: 1,
                  columns: 2,
                  tableRows: [
                    {
                      tableCells: [
                        textCell('Submittal No.\n'),
                        textCell(`${options.submittalNo ?? ''}\n`),
                      ],
                    },
                  ],
                },
              },
              { paragraph: { elements: [{ textRun: { content: '––––\n' } }] } },
              { paragraph: { elements: [{ textRun: { content: 'Submittal Response\n' } }] } },
              ...(options.spacerParagraphsBetweenHeadingAndTable ?? []),
              {
                table: {
                  rows: 6,
                  columns: 3,
                  tableRows: [
                    ...RESPONSE_LABELS.map((label, idx) => {
                      const isChecked = checked.has(idx);
                      const col2Cell =
                        idx === 0
                          ? textCell('NET/NOC Legend\n', { rowSpan: 2 })
                          : idx === 1
                            ? textCell('\n')
                            : idx === 2
                              ? textCell('RR/REJ Legend\n', { rowSpan: 2 })
                              : textCell('\n');
                      return {
                        tableCells: [
                          {
                            tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                            content: [
                              {
                                paragraph: {
                                  elements: [
                                    {
                                      dropdown: {
                                        dropdownId: `kix.dd.${idx}`,
                                        dropdownProperties: {
                                          dropdownDefinitionId: 'kix.cb',
                                          selectedOptionId: isChecked ? 'opt.on' : 'opt.off',
                                          displayValue: options.omitDisplayValue
                                            ? null
                                            : isChecked
                                              ? '☑'
                                              : '☐',
                                        },
                                      },
                                    },
                                  ],
                                },
                              },
                            ],
                          },
                          textCell(`${label}\n`, { columnSpan: 1, rowSpan: 1 }),
                          col2Cell,
                        ],
                      };
                    }),
                    {
                      tableCells: [
                        textCell('Disclaimer prose spanning full table width.\n', {
                          columnSpan: 3,
                          rowSpan: 1,
                        }),
                        textCell('\n'),
                        textCell('\n'),
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
      };
    }

    it('extracts all 5 Submittal Response options, handles 0-checked without error, and flags 2+ checked in ambiguousFields while omitting from fields', () => {
      const client = new GoogleDocsClient();

      // 0 checked -> omits Submittal Response, keeps Submittal No
      const zeroRes = client.extractFormData({
        tabs: [buildSubmittalStampTab({ submittalNo: '071200-001-0', checkedIndices: [] })],
      });
      expect(zeroRes).toEqual({
        widgetCount: 2,
        fields: { 'Submittal No': '071200-001-0' },
      });
      expect('ambiguousFields' in zeroRes).toBe(false);

      // 1 checked across all 5 rows (including omitted displayValue resolved via dropdownDefinitions)
      for (const [idx, expectedLabel] of RESPONSE_LABELS.entries()) {
        const oneRes = client.extractFormData({
          tabs: [
            buildSubmittalStampTab({
              submittalNo: '071200-001-1',
              checkedIndices: [idx],
              omitDisplayValue: idx % 2 === 1,
            }),
          ],
        });
        expect(oneRes).toEqual({
          widgetCount: 2,
          fields: {
            'Submittal No': '071200-001-1',
            'Submittal Response': expectedLabel,
          },
        });
      }

      // 2+ checked -> omits Submittal Response, returns ambiguousFields: ['Submittal Response']
      const multiRes = client.extractFormData({
        tabs: [buildSubmittalStampTab({ submittalNo: '071200-001-1', checkedIndices: [0, 3] })],
      });
      expect(multiRes).toEqual({
        widgetCount: 2,
        fields: { 'Submittal No': '071200-001-1' },
        ambiguousFields: ['Submittal Response'],
      });
    });

    it('preserves precedingHeadingLabel across 1-2 blank spacers and resets on 3rd blank spacer, horizontal divider, smart chip, multi-line/non-plausible paragraph, sectionBreak, or table', () => {
      const client = new GoogleDocsClient();

      // 2 blank spacers -> preserved
      const twoSpacers = client.extractFormData({
        tabs: [
          buildSubmittalStampTab({
            checkedIndices: [0],
            spacerParagraphsBetweenHeadingAndTable: [
              { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
              { paragraph: { elements: [{ textRun: { content: '   \n' } }] } },
            ],
          }),
        ],
      });
      expect(twoSpacers.fields['Submittal Response']).toBe('NO EXCEPTIONS TAKEN');

      // Resets on: 3rd blank spacer, horizontal divider, smart chip, \uE907, multi-line, >40 chars, sectionBreak, table
      const resetCases = [
        [
          { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
          { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
          { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
        ],
        [{ paragraph: { elements: [{ textRun: { content: '––––\n' } }] } }],
        [{ paragraph: { elements: [{ dateElement: { dateElementProperties: { displayText: '2026-01-01' } } }] } }],
        [{ paragraph: { elements: [{ person: { personProperties: { name: 'Alice' } } }] } }],
        [{ paragraph: { elements: [{ textRun: { content: 'Note \uE907\n' } }] } }],
        [{ paragraph: { elements: [{ textRun: { content: 'Line 1\nLine 2\n' } }] } }],
        [{ paragraph: { elements: [{ textRun: { content: `${'X'.repeat(41)}\n` } }] } }],
        [{ sectionBreak: {} }],
        [{ tableOfContents: {} }],
        [
          {
            paragraph: {
              elements: [
                {
                  dropdown: {
                    dropdownId: 'kix.breaker',
                    dropdownProperties: { displayValue: 'Option' },
                  },
                },
              ],
            },
          },
        ],
        [
          {
            table: {
              rows: 1,
              columns: 1,
              tableRows: [{ tableCells: [textCell('Separator Table\n')] }],
            },
          },
        ],
      ];

      for (const spacers of resetCases) {
        const res = client.extractFormData({
          tabs: [
            buildSubmittalStampTab({
              submittalNo: '071200-001-1',
              checkedIndices: [0],
              spacerParagraphsBetweenHeadingAndTable: spacers,
            }),
          ],
        });
        expect(res.fields['Submittal Response']).toBeUndefined();
      }
    });

    it('supports explicit non-dropdown checkbox glyphs and typed x/X alongside ☐/[ ] while rejecting blank Col 0, plain x/empty, 0/1/2, Yes/No, true/false, and invalid unmerged rows', () => {
      const client = new GoogleDocsClient();

      // Positive cases with plain textRun checkbox glyphs and typed x/X alongside ☐/[ ]
      const positiveGlyphCases: Array<{
        checkedToken: string;
        uncheckedTokens: string[];
      }> = [
        { checkedToken: '☑', uncheckedTokens: ['☐', '⬚', '□'] },
        { checkedToken: '☒', uncheckedTokens: ['☐'] },
        { checkedToken: '✓', uncheckedTokens: ['☐'] },
        { checkedToken: '✔', uncheckedTokens: ['[ ]'] },
        { checkedToken: '✕', uncheckedTokens: ['[  ]'] },
        { checkedToken: '✖', uncheckedTokens: ['()'] },
        { checkedToken: '[x]', uncheckedTokens: ['( )'] },
        { checkedToken: '[X]', uncheckedTokens: ['[ ]'] },
        { checkedToken: '(x)', uncheckedTokens: ['()'] },
        { checkedToken: '(X)', uncheckedTokens: ['( )'] },
        { checkedToken: 'x', uncheckedTokens: ['☐', ''] },
        { checkedToken: 'X', uncheckedTokens: ['[ ]', ''] },
      ];

      for (const tc of positiveGlyphCases) {
        const rows = [
          { tableCells: [textCell(`${tc.checkedToken}\n`), textCell('NO EXCEPTIONS TAKEN\n'), textCell('Legend\n')] },
          ...tc.uncheckedTokens.map((tok, i) => ({
            tableCells: [textCell(`${tok}\n`), textCell(`OPTION ${i}\n`), textCell('\n')],
          })),
        ];
        const res = client.extractFormData({
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: 'Submittal Response\n' } }] } },
              { table: { rows: rows.length, columns: 3, tableRows: rows } },
            ],
          },
        });
        expect(res, `checked=${tc.checkedToken}`).toEqual({
          widgetCount: 1,
          fields: { 'Submittal Response': 'NO EXCEPTIONS TAKEN' },
        });
      }

      // Adversarial rejections -> widgetCount: 0
      const rejectedTables = [
        // All-blank Col 0 (2-col and 3-col)
        {
          rows: 2,
          columns: 2,
          tableRows: [
            { tableCells: [textCell('\n'), textCell('Option A\n')] },
            { tableCells: [textCell('\n'), textCell('Option B\n')] },
          ],
        },
        // Typed x + blank "" without any explicit checkbox glyph/bracket marker or dropdown
        {
          rows: 2,
          columns: 2,
          tableRows: [
            { tableCells: [textCell('x\n'), textCell('Option A\n')] },
            { tableCells: [textCell('\n'), textCell('Option B\n')] },
          ],
        },
        // 0/1/2 revision table (3 columns)
        {
          rows: 3,
          columns: 3,
          tableRows: [
            { tableCells: [textCell('0\n'), textCell('Initial Issue\n'), textCell('2026-01-01\n')] },
            { tableCells: [textCell('1\n'), textCell('Addendum\n'), textCell('2026-02-01\n')] },
            { tableCells: [textCell('2\n'), textCell('IFC\n'), textCell('2026-03-01\n')] },
          ],
        },
        // Yes/No prose table (3 columns)
        {
          rows: 2,
          columns: 3,
          tableRows: [
            { tableCells: [textCell('Yes\n'), textCell('Proceed with work\n'), textCell('Notes\n')] },
            { tableCells: [textCell('No\n'), textCell('Do not proceed\n'), textCell('Notes\n')] },
          ],
        },
        // true/false table (3 columns)
        {
          rows: 2,
          columns: 3,
          tableRows: [
            { tableCells: [textCell('true\n'), textCell('Enabled\n'), textCell('Flag\n')] },
            { tableCells: [textCell('false\n'), textCell('Disabled\n'), textCell('Flag\n')] },
          ],
        },
        // Unmerged non-checkbox row mixed with valid checkbox rows (must reject whole table and not mark Col 0 dropdown captured)
        {
          rows: 3,
          columns: 3,
          tableRows: [
            {
              tableCells: [
                {
                  content: [
                    {
                      paragraph: {
                        elements: [
                          {
                            dropdown: {
                              dropdownId: 'kix.mixed.0',
                              dropdownProperties: { displayValue: '☑' },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                textCell('Valid Row\n'),
                textCell('\n'),
              ],
            },
            { tableCells: [textCell('☐\n'), textCell('Valid Row 2\n'), textCell('\n')] },
            { tableCells: [textCell('N/A\n'), textCell('Non-checkbox Row\n'), textCell('\n')] },
          ],
        },
        // Merged Col 0 rowSpan > 1 or Col 1 columnSpan > 1
        {
          rows: 2,
          columns: 3,
          tableRows: [
            { tableCells: [textCell('☑\n', { rowSpan: 2 }), textCell('Option A\n'), textCell('\n')] },
            { tableCells: [textCell('☐\n'), textCell('Option B\n'), textCell('\n')] },
          ],
        },
        {
          rows: 2,
          columns: 3,
          tableRows: [
            { tableCells: [textCell('☑\n'), textCell('Option A\n', { columnSpan: 2 }), textCell('\n')] },
            { tableCells: [textCell('☐\n'), textCell('Option B\n'), textCell('\n')] },
          ],
        },
      ];

      for (const table of rejectedTables) {
        const res = client.extractFormData({
          body: {
            content: [
              { paragraph: { elements: [{ textRun: { content: 'Submittal Response\n' } }] } },
              { table },
            ],
          },
        });
        expect(res).toEqual({ widgetCount: 0, fields: {} });
      }
    });

    it('enforces cross-tab Pattern 1 ambiguity semantics and blocks later Pattern 4 and Pattern 5 overwrites of ambiguous fields', () => {
      const client = new GoogleDocsClient();

      // 1. Tab 1 0-checked + Tab 2 1-checked -> succeeds
      const zeroThenOne = client.extractFormData({
        tabs: [
          buildSubmittalStampTab({ checkedIndices: [] }),
          buildSubmittalStampTab({ checkedIndices: [2] }),
        ],
      });
      expect(zeroThenOne).toEqual({
        widgetCount: 4,
        fields: { 'Submittal Response': 'REVISE AND RESUBMIT' },
      });

      // 2. Tab 1 1-checked + Tab 2 0-checked -> succeeds
      const oneThenZero = client.extractFormData({
        tabs: [
          buildSubmittalStampTab({ checkedIndices: [1] }),
          buildSubmittalStampTab({ checkedIndices: [] }),
        ],
      });
      expect(oneThenZero).toEqual({
        widgetCount: 4,
        fields: { 'Submittal Response': 'NO OBJECTIONS AS CORRECTED' },
      });

      // 3. Identical single-checked selections across tabs -> succeeds
      const identicalTabs = client.extractFormData({
        tabs: [
          buildSubmittalStampTab({ checkedIndices: [0] }),
          buildSubmittalStampTab({ checkedIndices: [0] }),
        ],
      });
      expect(identicalTabs).toEqual({
        widgetCount: 4,
        fields: { 'Submittal Response': 'NO EXCEPTIONS TAKEN' },
      });

      // 4. Conflicting single-checked selections across tabs ("NO EXCEPTIONS TAKEN" vs "REJECTED") -> ambiguous
      const conflictingTabs = client.extractFormData({
        tabs: [
          buildSubmittalStampTab({ submittalNo: '071200-001-1', checkedIndices: [0] }),
          buildSubmittalStampTab({ checkedIndices: [3] }),
        ],
      });
      expect(conflictingTabs).toEqual({
        widgetCount: 4,
        fields: { 'Submittal No': '071200-001-1' },
        ambiguousFields: ['Submittal Response'],
      });

      // 5. Single-checked Tab 1 + multi-checked Tab 2 -> ambiguous
      const oneThenMulti = client.extractFormData({
        tabs: [
          buildSubmittalStampTab({ checkedIndices: [0] }),
          buildSubmittalStampTab({ checkedIndices: [1, 2] }),
        ],
      });
      expect(oneThenMulti).toEqual({
        widgetCount: 4,
        fields: {},
        ambiguousFields: ['Submittal Response'],
      });

      // 6. Multi-checked Tab 1 + single-checked Tab 2 + later Pattern 4 & Pattern 5 with same key -> remains omitted & ambiguous
      const multiThenOneAndPattern4And5 = client.extractFormData({
        tabs: [
          buildSubmittalStampTab({ checkedIndices: [0, 3] }),
          buildSubmittalStampTab({ checkedIndices: [0] }),
          {
            documentTab: {
              dropdownDefinitions: {
                'def.resp': {
                  dropdownDefinitionId: 'def.resp',
                  dropdownDefinitionProperties: {
                    title: 'Submittal Response',
                    options: [{ optionId: 'opt.1', displayValue: 'APPROVED' }],
                  },
                },
              },
              body: {
                content: [
                  {
                    table: {
                      rows: 1,
                      columns: 2,
                      tableRows: [
                        { tableCells: [textCell('Submittal Response:\n'), textCell('REJECTED\n')] },
                      ],
                    },
                  },
                  {
                    paragraph: {
                      elements: [
                        {
                          dropdown: {
                            dropdownId: 'kix.p5.ambig',
                            dropdownProperties: {
                              dropdownDefinitionId: 'def.resp',
                              selectedOptionId: 'opt.1',
                              displayValue: 'APPROVED',
                            },
                          },
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
      expect(multiThenOneAndPattern4And5).toEqual({
        widgetCount: 6,
        fields: {},
        ambiguousFields: ['Submittal Response'],
      });
    });
  });

  describe('extractFormData — DateElement & Person smart-chip serialization', () => {
    const textCell = (text: string) => ({
      content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
    });

    it('formats DateElement timestamps to YYYY-MM-DD in timeZoneId, falls back on invalid timeZoneId or missing/invalid timestamp, emits Person name/email, and strips unset \\uE907', () => {
      const client = new GoogleDocsClient();

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  {
                    table: {
                      rows: 9,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            textCell('Date NY:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dateElement: {
                                          dateElementProperties: {
                                            timestamp: '2026-11-22T02:00:00Z',
                                            timeZoneId: 'America/New_York',
                                            displayText: 'Nov 21, 2026',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Date UTC:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dateElement: {
                                          dateElementProperties: {
                                            timestamp: '2026-11-22T02:00:00Z',
                                            displayText: 'Nov 22, 2026',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Date Invalid TZ:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dateElement: {
                                          dateElementProperties: {
                                            timestamp: '2026-11-22T02:00:00Z',
                                            timeZoneId: 'Mars/Olympus_Mons',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Date Missing TS:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dateElement: {
                                          dateElementProperties: {
                                            displayText: '  11/21/2026  ',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Date Invalid TS:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dateElement: {
                                          dateElementProperties: {
                                            timestamp: 'not-a-date',
                                            displayText: '  Sept 8, 2026  ',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Person Name:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        person: {
                                          personProperties: {
                                            name: '  Alice Architect  ',
                                            email: 'alice@inc.nyc',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Person Email Fallback:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        person: {
                                          personProperties: {
                                            name: null,
                                            email: '  bob@inc.nyc  ',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Person Empty:\n'),
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [{ person: { personProperties: {} } }],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Date Placeholder:\n'),
                            textCell('\uE907\n'),
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
        widgetCount: 9,
        fields: {
          'Date NY': '2026-11-21',
          'Date UTC': '2026-11-22',
          'Date Invalid TZ': '2026-11-22',
          'Date Missing TS': '11/21/2026',
          'Date Invalid TS': 'Sept 8, 2026',
          'Person Name': 'Alice Architect',
          'Person Email Fallback': 'bob@inc.nyc',
        },
      });
    });
  });

  describe('extractFormData — Pattern 2 (2×1 Stacked Field Box)', () => {
    const textCell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
      content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
      ...(style ? { tableCellStyle: style } : {}),
    });

    it('extracts multi-line REMARKS value, strips pure {{INSERT REMARKS HERE}} while preserving partial user text, and deduplicates Row 1 dropdowns', () => {
      const client = new GoogleDocsClient();

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              dropdownDefinitions: {
                'def.noteType': {
                  dropdownDefinitionId: 'def.noteType',
                  dropdownDefinitionProperties: {
                    title: 'Should Not Leak To Pattern 5',
                    options: [
                      { optionId: 'opt.0', displayValue: 'Select...' },
                      { optionId: 'opt.1', displayValue: 'Urgent' },
                    ],
                  },
                },
              },
              body: {
                content: [
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('REMARKS:\n')] },
                        {
                          tableCells: [
                            {
                              content: [
                                { paragraph: { elements: [{ textRun: { content: 'Verify flashing details.\n' } }] } },
                                {
                                  paragraph: {
                                    elements: [
                                      {
                                        dropdown: {
                                          dropdownId: 'kix.p2.dd',
                                          dropdownProperties: {
                                            dropdownDefinitionId: 'def.noteType',
                                            selectedOptionId: 'opt.1',
                                            displayValue: 'Urgent',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('EMPTY REMARKS\n')] },
                        { tableCells: [textCell('{{INSERT REMARKS HERE}}\n')] },
                      ],
                    },
                  },
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('PARTIAL REMARKS\n')] },
                        { tableCells: [textCell('Check {{INSERT REMARKS HERE}} before fab\n')] },
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
          REMARKS: 'Verify flashing details.\nUrgent',
          'PARTIAL REMARKS': 'Check {{INSERT REMARKS HERE}} before fab',
        },
      });
    });

    it('rejects 2×1 tables with smart-chip Row 0, multi-line Row 0, or merged cells, and respects first-seen / ambiguous guards', () => {
      const client = new GoogleDocsClient();

      const res = client.extractFormData({
        tabs: [
          {
            documentTab: {
              body: {
                content: [
                  // Smart-chip Row 0 (dateElement) -> rejected
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        {
                          tableCells: [
                            {
                              content: [
                                {
                                  paragraph: {
                                    elements: [{ dateElement: { dateElementProperties: { displayText: 'Date' } } }],
                                  },
                                },
                              ],
                            },
                          ],
                        },
                        { tableCells: [textCell('2026-11-21\n')] },
                      ],
                    },
                  },
                  // Multi-line Row 0 -> rejected
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        {
                          tableCells: [
                            {
                              content: [
                                { paragraph: { elements: [{ textRun: { content: 'Line 1\n' } }] } },
                                { paragraph: { elements: [{ textRun: { content: 'Line 2\n' } }] } },
                              ],
                            },
                          ],
                        },
                        { tableCells: [textCell('Value\n')] },
                      ],
                    },
                  },
                  // Merged Row 0 -> rejected
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('REMARKS\n', { columnSpan: 2 })] },
                        { tableCells: [textCell('Value\n')] },
                      ],
                    },
                  },
                  // Merged Row 1 -> rejected
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('REMARKS\n')] },
                        { tableCells: [textCell('Value\n', { rowSpan: 2 })] },
                      ],
                    },
                  },
                  // Valid first REMARKS
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('REMARKS\n')] },
                        { tableCells: [textCell('First remark\n')] },
                      ],
                    },
                  },
                  // Duplicate REMARKS -> first-seen preserved
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('REMARKS\n')] },
                        { tableCells: [textCell('Second remark\n')] },
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
        widgetCount: 2,
        fields: {
          REMARKS: 'First remark',
        },
      });
    });
  });

  describe('extractFormData — Pattern 3 (2×N Signature / Bottom-Caption Tables) & Full Live-Template Payloads', () => {
    const textCell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
      content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
      ...(style ? { tableCellStyle: style } : {}),
    });

    it('extracts 2×2 Reviewed By | Date with blank/\\uE907, Person + DateElement, ISO, typed dates, and multi-line / >40-char Row 0, plus 2×3 signature tables', () => {
      const client = new GoogleDocsClient();

      // 1. Blank + \uE907 Date Placeholder -> widgetCount: 2, fields: {}
      const unreviewed = client.extractFormData({
        body: {
          content: [
            {
              table: {
                rows: 2,
                columns: 2,
                tableRows: [
                  { tableCells: [textCell('\n'), textCell('\uE907\n')] },
                  { tableCells: [textCell('Reviewed By\n'), textCell('Date\n')] },
                ],
              },
            },
          ],
        },
      });
      expect(unreviewed).toEqual({ widgetCount: 2, fields: {} });

      // 2. Person + DateElement
      const chips = client.extractFormData({
        body: {
          content: [
            {
              table: {
                rows: 2,
                columns: 2,
                tableRows: [
                  {
                    tableCells: [
                      {
                        content: [
                          {
                            paragraph: {
                              elements: [{ person: { personProperties: { name: 'Alice Reviewer', email: 'alice@inc.nyc' } } }],
                            },
                          },
                        ],
                      },
                      {
                        content: [
                          {
                            paragraph: {
                              elements: [
                                {
                                  dateElement: {
                                    dateElementProperties: {
                                      timestamp: '2026-11-21T00:00:00Z',
                                      timeZoneId: 'UTC',
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        ],
                      },
                    ],
                  },
                  { tableCells: [textCell('Reviewed By\n'), textCell('Date\n')] },
                ],
              },
            },
          ],
        },
      });
      expect(chips).toEqual({
        widgetCount: 2,
        fields: {
          'Reviewed By': 'Alice Reviewer',
          Date: '2026-11-21',
        },
      });

      // 3. Typed dates (ISO, US slash, 2-digit year, written month) with alphabetic Row 1 captions
      for (const typedDate of ['2026-11-21', '11/21/2026', '5/8/26', 'Sept 8, 2026']) {
        const res = client.extractFormData({
          body: {
            content: [
              {
                table: {
                  rows: 2,
                  columns: 2,
                  tableRows: [
                    { tableCells: [textCell('Alice\n'), textCell(`${typedDate}\n`)] },
                    { tableCells: [textCell('Reviewed By\n'), textCell('Date\n')] },
                  ],
                },
              },
            ],
          },
        });
        expect(res, `typedDate=${typedDate}`).toEqual({
          widgetCount: 2,
          fields: {
            'Reviewed By': 'Alice',
            Date: typedDate,
          },
        });
      }

      // 4. Multi-line / >40-char Row 0 + 2×3 signature table
      const threeCol = client.extractFormData({
        body: {
          content: [
            {
              table: {
                rows: 2,
                columns: 3,
                tableRows: [
                  {
                    tableCells: [
                      {
                        content: [
                          { paragraph: { elements: [{ textRun: { content: 'Bob Designer\n' } }] } },
                          { paragraph: { elements: [{ textRun: { content: 'INC Studio\n' } }] } },
                        ],
                      },
                      textCell('Alice Reviewer\n'),
                      textCell('Nov 21, 2026\n'),
                    ],
                  },
                  {
                    tableCells: [
                      textCell('Prepared By\n'),
                      textCell('Reviewed By\n'),
                      textCell('Date\n'),
                    ],
                  },
                ],
              },
            },
          ],
        },
      });
      expect(threeCol).toEqual({
        widgetCount: 3,
        fields: {
          'Prepared By': 'Bob Designer\nINC Studio',
          'Reviewed By': 'Alice Reviewer',
          Date: 'Nov 21, 2026',
        },
      });
    });

    it('falls punctuation-free 2×2 Key/Value tables and Company:/Acme.Inc. tables through to Pattern 4 while ignoring 2×3 top-header summary tables', () => {
      const client = new GoogleDocsClient();

      // 1. Punctuation-free 2×2 Key/Value (Submittal No | 071200-001-1 / Date | 2026-11-21) -> Pattern 4
      const kvNoPunct = client.extractFormData({
        body: {
          content: [
            {
              table: {
                rows: 2,
                columns: 2,
                tableRows: [
                  { tableCells: [textCell('Submittal No\n'), textCell('071200-001-1\n')] },
                  { tableCells: [textCell('Date\n'), textCell('2026-11-21\n')] },
                ],
              },
            },
          ],
        },
      });
      expect(kvNoPunct).toEqual({
        widgetCount: 2,
        fields: {
          'Submittal No': '071200-001-1',
          Date: '2026-11-21',
        },
      });

      // 2. Company: | Acme.Inc. (even paired with a date in Row 0) -> Row 1 has punctuation so Pattern 3 rejects -> Pattern 4
      const kvCompany = client.extractFormData({
        body: {
          content: [
            {
              table: {
                rows: 2,
                columns: 2,
                tableRows: [
                  { tableCells: [textCell('Date:\n'), textCell('2026-11-21\n')] },
                  { tableCells: [textCell('Company:\n'), textCell('Acme.Inc.\n')] },
                ],
              },
            },
          ],
        },
      });
      expect(kvCompany).toEqual({
        widgetCount: 2,
        fields: {
          Date: '2026-11-21',
          Company: 'Acme.Inc.',
        },
      });

      // 3. 2×3 top-header summary tables (both date-containing and non-date) -> ignored (widgetCount: 0)
      const ignoredSummaries = client.extractFormData({
        body: {
          content: [
            {
              table: {
                rows: 2,
                columns: 3,
                tableRows: [
                  { tableCells: [textCell('Date\n'), textCell('Reviewer\n'), textCell('Status\n')] },
                  { tableCells: [textCell('2026-11-21\n'), textCell('Alice\n'), textCell('Open\n')] },
                ],
              },
            },
            {
              table: {
                rows: 2,
                columns: 3,
                tableRows: [
                  { tableCells: [textCell('Reviewer\n'), textCell('Role\n'), textCell('Status\n')] },
                  { tableCells: [textCell('Alice\n'), textCell('Architect\n'), textCell('Open\n')] },
                ],
              },
            },
            // Merged 2×3 table -> ignored
            {
              table: {
                rows: 2,
                columns: 3,
                tableRows: [
                  { tableCells: [textCell('\n', { columnSpan: 2 }), textCell('\n'), textCell('\n')] },
                  { tableCells: [textCell('Prepared By\n'), textCell('Reviewed By\n'), textCell('Date\n')] },
                ],
              },
            },
            // Pure numeric / submittal code in Row 1 -> rejected by Pattern 3 (and 3 cols so not Pattern 4)
            {
              table: {
                rows: 2,
                columns: 3,
                tableRows: [
                  { tableCells: [textCell('\n'), textCell('\n'), textCell('\n')] },
                  { tableCells: [textCell('42\n'), textCell('CG104-A\n'), textCell('Date\n')] },
                ],
              },
            },
          ],
        },
      });
      expect(ignoredSummaries).toEqual({ widgetCount: 0, fields: {} });
    });

    it('extracts full realistic live-template-modeled cover-sheet payloads (unreviewed & stamped Arch/FF&E)', () => {
      const client = new GoogleDocsClient();
      const RESPONSE_LABELS = [
        'NO EXCEPTIONS TAKEN',
        'NO OBJECTIONS AS CORRECTED',
        'REVISE AND RESUBMIT',
        'REJECTED',
        'NOT REVIEWED',
      ];

      const buildLiveTemplateDoc = (options: {
        submittalNo?: string;
        checkedIdx?: number;
        remarks?: string;
        reviewerName?: string;
        dateChip?: Record<string, unknown>;
      }) => ({
        documentId: 'live-template-doc',
        body: null,
        tabs: [
          {
            documentTab: {
              dropdownDefinitions: {
                'kix.cb': {
                  dropdownDefinitionId: 'kix.cb',
                  dropdownDefinitionProperties: {
                    title: 'Checkbox',
                    options: [
                      { optionId: 'opt.off', displayValue: '☐' },
                      { optionId: 'opt.on', displayValue: '☑' },
                    ],
                  },
                },
              },
              body: {
                content: [
                  { sectionBreak: {} },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 1,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            textCell('Submittal No.\n', { columnSpan: 1, rowSpan: 1 }),
                            textCell(`${options.submittalNo ?? ''}\n`, { columnSpan: 1, rowSpan: 1 }),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '––––\n' } }] } },
                  { paragraph: { elements: [{ textRun: { content: 'Submittal Response\n' } }] } },
                  {
                    table: {
                      rows: 6,
                      columns: 3,
                      tableRows: [
                        ...RESPONSE_LABELS.map((label, idx) => {
                          const isChecked = options.checkedIdx === idx;
                          const col2 =
                            idx === 0
                              ? textCell('NET/NOC legend\n', { rowSpan: 2 })
                              : idx === 2
                                ? textCell('RR/REJ legend\n', { rowSpan: 2 })
                                : textCell('\n');
                          return {
                            tableCells: [
                              {
                                tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                content: [
                                  {
                                    paragraph: {
                                      elements: [
                                        {
                                          dropdown: {
                                            dropdownId: `kix.dd.${idx}`,
                                            dropdownProperties: {
                                              dropdownDefinitionId: 'kix.cb',
                                              selectedOptionId: isChecked ? 'opt.on' : 'opt.off',
                                              displayValue: isChecked ? '☑' : '☐',
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                ],
                              },
                              textCell(`${label}\n`, { columnSpan: 1, rowSpan: 1 }),
                              col2,
                            ],
                          };
                        }),
                        {
                          tableCells: [
                            textCell('Disclaimer prose across full table width.\n', {
                              columnSpan: 3,
                              rowSpan: 1,
                            }),
                            textCell('\n'),
                            textCell('\n'),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [textCell('REMARKS\n', { columnSpan: 1, rowSpan: 1 })] },
                        { tableCells: [textCell(`${options.remarks ?? ''}\n`, { columnSpan: 1, rowSpan: 1 })] },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 2,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            options.reviewerName
                              ? {
                                  tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                  content: [
                                    {
                                      paragraph: {
                                        elements: [{ person: { personProperties: { name: options.reviewerName } } }],
                                      },
                                    },
                                  ],
                                }
                              : textCell('\n', { columnSpan: 1, rowSpan: 1 }),
                            options.dateChip
                              ? {
                                  tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                  content: [{ paragraph: { elements: [options.dateChip] } }],
                                }
                              : textCell('\uE907\n', { columnSpan: 1, rowSpan: 1 }),
                          ],
                        },
                        {
                          tableCells: [
                            textCell('Reviewed By\n', { columnSpan: 1, rowSpan: 1 }),
                            textCell('Date\n', { columnSpan: 1, rowSpan: 1 }),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                ],
              },
            },
          },
        ],
      });

      // Unreviewed template -> 5 widgets, 0 populated fields
      expect(client.extractFormData(buildLiveTemplateDoc({}))).toEqual({
        widgetCount: 5,
        fields: {},
      });

      // Stamped Submittal Arch template
      expect(
        client.extractFormData(
          buildLiveTemplateDoc({
            submittalNo: '071200-001-1',
            checkedIdx: 1,
            remarks: 'Provide updated flashing detail.',
            reviewerName: 'Jane Architect',
            dateChip: {
              dateElement: {
                dateElementProperties: {
                  timestamp: '2026-11-21T00:00:00Z',
                  timeZoneId: 'UTC',
                },
              },
            },
          })
        )
      ).toEqual({
        widgetCount: 5,
        fields: {
          'Submittal No': '071200-001-1',
          'Submittal Response': 'NO OBJECTIONS AS CORRECTED',
          REMARKS: 'Provide updated flashing detail.',
          'Reviewed By': 'Jane Architect',
          Date: '2026-11-21',
        },
      });
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

    it('respects custom requestTimeoutMs on constructor, retryOptions.requestTimeoutMs fallback, and per-call options', async () => {
      const mockGet = vi.fn().mockResolvedValue({
        data: { body: { content: [] } },
      });
      const mockDocs = { documents: { get: mockGet } } as unknown as docs_v1.Docs;
      const client = new GoogleDocsClient({
        docs: mockDocs,
        requestTimeoutMs: 4500,
        retryOptions: { requestTimeoutMs: 7000 },
      });

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

      const retryTimeoutClient = new GoogleDocsClient({
        docs: mockDocs,
        retryOptions: { requestTimeoutMs: 6500 },
      });
      await retryTimeoutClient.extractDocumentFormFields('doc-c');
      expect(mockGet).toHaveBeenLastCalledWith(
        expect.objectContaining({ documentId: 'doc-c' }),
        { timeout: 6500 }
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
        .mockResolvedValueOnce({ data: { body: { content: null } } })
        .mockResolvedValueOnce({ data: { tabs: 'not-array' } })
        .mockResolvedValueOnce({ data: null });
      const client = new GoogleDocsClient({
        docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
      });

      await expect(client.extractDocumentFormFields('doc-empty')).rejects.toThrow(GoogleDocsCorruptedError);
      await expect(client.extractDocumentFormFields('doc-bad-content')).rejects.toThrow(GoogleDocsCorruptedError);
      await expect(client.extractDocumentFormFields('doc-null-content')).rejects.toThrow(GoogleDocsCorruptedError);
      await expect(client.extractDocumentFormFields('doc-bad-tabs')).rejects.toThrow(GoogleDocsCorruptedError);
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

  describe('extractDocumentFormFields — Exponential Backoff Retries (429 / 403 Quota)', () => {
    it('retries on HTTP 429 with jittered exponential backoff and succeeds on recovery', async () => {
      const error429 = { status: 429, message: 'Too Many Requests' };
      const mockGet = vi
        .fn()
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({
          data: {
            documentId: 'doc-429-ok',
            body: { content: [] },
          },
        });
      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleDocsClient({
        docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
        retryOptions: {
          maxRetries: 3,
          initialDelayMs: 100,
          backoffFactor: 2,
          sleep: mockSleep,
        },
      });

      const result = await client.extractDocumentFormFields('doc-429-ok');
      expect(result).toEqual({ widgetCount: 0, fields: {} });
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(mockSleep).toHaveBeenCalledTimes(2);

      const delay0 = mockSleep.mock.calls[0]?.[0] as number;
      expect(delay0).toBeGreaterThanOrEqual(75);
      expect(delay0).toBeLessThanOrEqual(125);

      const delay1 = mockSleep.mock.calls[1]?.[0] as number;
      expect(delay1).toBeGreaterThanOrEqual(150);
      expect(delay1).toBeLessThanOrEqual(250);
    });

    it('honors default retry options (maxRetries: 3, initialDelayMs: 1000, backoffFactor: 2) when only sleep is provided', async () => {
      const error429 = { code: '429', message: 'Too Many Requests' };
      const mockGet = vi
        .fn()
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({ data: { body: { content: [] } } });
      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleDocsClient({
        docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
        retryOptions: { sleep: mockSleep },
      });

      const result = await client.extractDocumentFormFields('doc-default-retry');
      expect(result).toEqual({ widgetCount: 0, fields: {} });
      expect(mockGet).toHaveBeenCalledTimes(4);
      expect(mockSleep).toHaveBeenCalledTimes(3);

      const delay0 = mockSleep.mock.calls[0]?.[0] as number;
      expect(delay0).toBeGreaterThanOrEqual(750);
      expect(delay0).toBeLessThanOrEqual(1250);

      const delay1 = mockSleep.mock.calls[1]?.[0] as number;
      expect(delay1).toBeGreaterThanOrEqual(1500);
      expect(delay1).toBeLessThanOrEqual(2500);

      const delay2 = mockSleep.mock.calls[2]?.[0] as number;
      expect(delay2).toBeGreaterThanOrEqual(3000);
      expect(delay2).toBeLessThanOrEqual(5000);
    });

    it.each([
      {
        reason: 'userRateLimitExceeded',
        error: {
          status: 403,
          response: {
            status: 403,
            data: {
              error: {
                errors: [{ reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }],
              },
            },
          },
        },
      },
      {
        reason: 'rateLimitExceeded (string code 403)',
        error: {
          code: '403',
          message: 'rateLimitExceeded: Rate limit exceeded',
        },
      },
      {
        reason: 'quotaExceeded',
        error: {
          code: 403,
          errors: [{ reason: 'quotaExceeded', message: 'Quota exceeded' }],
        },
      },
      {
        reason: 'user rate limit message substring',
        error: {
          status: 403,
          message: 'User rate limit exceeded for Google Docs API',
        },
      },
    ])('retries on HTTP 403 with $reason quota error and recovers', async ({ error }) => {
      const mockGet = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ data: { body: { content: [] } } });
      const mockSleep = vi.fn().mockResolvedValue(undefined);

      const client = new GoogleDocsClient({
        docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
        retryOptions: {
          maxRetries: 2,
          initialDelayMs: 100,
          sleep: mockSleep,
        },
      });

      const result = await client.extractDocumentFormFields('doc-403-quota');
      expect(result).toEqual({ widgetCount: 0, fields: {} });
      expect(mockGet).toHaveBeenCalledTimes(2);
      expect(mockSleep).toHaveBeenCalledTimes(1);
    });

    it('throws wrapped GoogleDocsApiError with statusCode and cause when maxRetries is exhausted on 429 or 403 quota', async () => {
      const error429 = Object.assign(new Error('Too Many Requests'), { code: '429' });
      const mockGet429 = vi.fn().mockRejectedValue(error429);
      const mockSleep429 = vi.fn().mockResolvedValue(undefined);

      const client429 = new GoogleDocsClient({
        docs: { documents: { get: mockGet429 } } as unknown as docs_v1.Docs,
        retryOptions: { maxRetries: 2, initialDelayMs: 10, sleep: mockSleep429 },
      });

      const caught429 = await client429.extractDocumentFormFields('doc-exhausted-429').catch((e: unknown) => e);
      expect(caught429).toBeInstanceOf(GoogleDocsApiError);
      expect((caught429 as GoogleDocsApiError).statusCode).toBe(429);
      expect((caught429 as GoogleDocsApiError).cause).toBe(error429);
      expect(mockGet429).toHaveBeenCalledTimes(3);
      expect(mockSleep429).toHaveBeenCalledTimes(2);

      const error403Quota = Object.assign(new Error('Quota exceeded'), { code: '403' });
      const mockGet403 = vi.fn().mockRejectedValue(error403Quota);
      const mockSleep403 = vi.fn().mockResolvedValue(undefined);

      const client403 = new GoogleDocsClient({
        docs: { documents: { get: mockGet403 } } as unknown as docs_v1.Docs,
        retryOptions: { maxRetries: 1, initialDelayMs: 10, sleep: mockSleep403 },
      });

      const caught403 = await client403.extractDocumentFormFields('doc-exhausted-403').catch((e: unknown) => e);
      expect(caught403).toBeInstanceOf(GoogleDocsApiError);
      expect((caught403 as GoogleDocsApiError).statusCode).toBe(403);
      expect((caught403 as GoogleDocsApiError).cause).toBe(error403Quota);
      expect(mockGet403).toHaveBeenCalledTimes(2);
      expect(mockSleep403).toHaveBeenCalledTimes(1);
    });

    it('fails immediately without retry on non-quota 403, SERVICE_DISABLED, 404, 503, and timeout errors', async () => {
      const nonQuota403 = Object.assign(new Error('The caller does not have permission'), {
        code: '403',
        response: {
          status: 403,
          data: { error: { errors: [{ reason: 'forbidden', message: 'Forbidden' }] } },
        },
      });
      const serviceDisabled403 = {
        status: 403,
        message: 'Google Docs API has not been used in project 123 or it is disabled.',
        response: {
          status: 403,
          data: { error: { details: [{ reason: 'SERVICE_DISABLED' }] } },
        },
      };
      const notFound404 = Object.assign(new Error('Not Found'), { code: '404' });
      const unavailable503 = Object.assign(new Error('Service Unavailable'), { status: 503 });
      const timeoutErr = new Error('ETIMEDOUT');

      for (const [err, ExpectedError, expectedStatus] of [
        [nonQuota403, GoogleDocsApiError, 403],
        [serviceDisabled403, GoogleDocsApiError, 403],
        [notFound404, GoogleDocsNotFoundError, 404],
        [unavailable503, GoogleDocsApiError, 503],
        [timeoutErr, GoogleDocsApiError, undefined],
      ] as const) {
        const mockGet = vi.fn().mockRejectedValue(err);
        const mockSleep = vi.fn().mockResolvedValue(undefined);
        const client = new GoogleDocsClient({
          docs: { documents: { get: mockGet } } as unknown as docs_v1.Docs,
          retryOptions: { maxRetries: 3, initialDelayMs: 10, sleep: mockSleep },
        });

        const caught = await client.extractDocumentFormFields('doc-perm-fail').catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(ExpectedError);
        expect((caught as GoogleDocsApiError).statusCode).toBe(expectedStatus);
        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(mockSleep).not.toHaveBeenCalled();
      }
    });
  });
});

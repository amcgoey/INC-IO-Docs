import { describe, it, expect } from 'vitest';
import {
  buildRowKeyExtractor,
  computeTargetRowKeys,
  enrichDocumentData,
  formatFileLinkFormula,
  mapDocumentToLogRow,
} from './row-mapper';
import type {
  DocumentLogSchema,
  LogTargetDocumentSchema,
} from './ports';
import { HandlebarsAdapter } from '../../infrastructure/template-engine/handlebars-adapter';

describe('document-log row-mapper', () => {
  const evaluator = new HandlebarsAdapter();

  const targetSchema: LogTargetDocumentSchema = {
    fields: [
      {
        key: 'status',
        name: 'Status',
        type: 'string',
        required: true,
        options: { source: 'statuses', key: 'key' },
      },
      { key: 'section', name: 'Section', type: 'string', required: true },
      { key: 'number', name: 'Number', type: 'string', required: true },
      { key: 'revision', name: 'Revision', type: 'string', required: true },
      { key: 'title', name: 'Title', type: 'string', required: true },
      { key: 'date', name: 'Date', type: 'string', required: true },
      {
        key: 'contact',
        name: 'Contact',
        type: 'string',
        required: true,
        options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
      },
      {
        key: 'action',
        name: 'Action',
        type: 'string',
        required: true,
        options: { source: 'actions', key: 'key', name: 'name' },
      },
      { key: 'notes', name: 'Notes', type: 'string', required: false },
      {
        key: 'relatedTag',
        name: 'Related Tag',
        type: 'string',
        required: false,
        options: { source: 'statuses', key: 'key', allowUserInput: true },
      },
      {
        key: 'specTitle',
        name: 'Spec Title',
        type: 'string',
        required: false,
        linkedField: { sourceField: 'action', sourceProperty: 'name' },
      },
    ],
    options: {
      statuses: [{ key: 'Open' }, { key: 'Closed' }],
      actions: [
        { key: 'REC', name: 'Received', order: '1' },
        { key: 'REF', name: 'Referred', order: '2' },
        { key: 'NOC', name: 'No Objections As Corrected', order: '6' },
      ],
      contacts: [{ key: 'PMG', name: 'Pavarini McGovern', type: 'Contractor' }],
    },
    identity: {
      idGroup: '{{section}}-{{number}}',
      idDocument: '{{section}}-{{number}}-{{revision}}',
      id: '{{section}}-{{number}}-{{revision}}-{{date}}-{{action.order}}',
    },
  };

  const logSchema: DocumentLogSchema = {
    provider: 'google_sheets',
    target: {
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      extentMarker: '<--->',
      groupDividerMarker: '---',
    },
    grouping: {
      groupBy: 'idGroup',
      sortBy: 'id',
      groupSortOrder: 'asc',
      rowSortOrder: 'asc',
      duplicatePolicy: 'insert',
    },
    columns: {
      Status: { template: '{{status.key}}' },
      Section: { template: '{{section}}' },
      Number: { template: '{{number}}' },
      Revision: { template: '{{revision}}' },
      Title: { template: '{{title}}' },
      Date: { template: '{{date}}' },
      Contact: { template: '{{contact.key}}' },
      Action: { template: '{{action.name}}' },
      Notes: { template: '{{notes}}' },
      'Spec Title': { template: '{{specTitle}}', readOnly: true },
      'Calc Link': { source: 'fileLink', label: 'Link' },
    },
  };

  it('enriches raw LookupField string values (both key and name, plus allowUserInput fallback) consistently with DocumentService', () => {
    const enriched = enrichDocumentData(
      {
        status: 'Open',
        section: '071200',
        number: '001',
        revision: '0',
        title: 'Waterproofing',
        date: '260204',
        contact: 'Custom Consultant Co',
        action: 'NOC',
        notes: '',
        relatedTag: '',
      },
      targetSchema
    );

    expect(enriched.status).toEqual({ key: 'Open' });
    expect(enriched.action).toEqual({
      key: 'NOC',
      name: 'No Objections As Corrected',
      order: '6',
    });
    expect(enriched.contact).toEqual({
      key: 'Custom Consultant Co',
      name: 'Custom Consultant Co',
    });
    expect(enriched.notes).toBe('');
    expect(enriched.relatedTag).toBeUndefined();
  });

  it('dehydrates enriched Document, maps empty optional strings to null, skips readOnly columns, and formats fileLink hyperlink', () => {
    const mapped = mapDocumentToLogRow({
      document: {
        type: 'submittal-arch',
        data: {
          status: { key: 'Open' },
          section: '071200',
          number: '001',
          revision: '0',
          title: 'Fluid-Applied Waterproofing & Sealing',
          date: '260204',
          contact: { key: 'PMG', name: 'Pavarini McGovern' },
          action: { key: 'REC', name: 'Received', order: '1' },
          specTitle: 'SHOULD_BE_SKIPPED',
        },
      },
      logSchema,
      targetSchema,
      templateEvaluator: evaluator,
      fileUri: 'https://drive.google.com/file/d/file-123/view',
    });

    expect(mapped.readOnlyColumns).toEqual(['Spec Title']);
    expect(mapped.rowData).toEqual({
      Status: 'Open',
      Section: '071200',
      Number: '001',
      Revision: '0',
      Title: 'Fluid-Applied Waterproofing & Sealing',
      Date: '260204',
      Contact: 'PMG',
      Action: 'Received',
      Notes: null,
      'Calc Link': {
        formula: '=HYPERLINK("https://drive.google.com/file/d/file-123/view", "Link")',
      },
    });
    expect('Spec Title' in mapped.rowData).toBe(false);
  });

  it('preserves user strings starting with =, +, -, @ strictly as literal strings (zero formula injection)', () => {
    const mapped = mapDocumentToLogRow({
      document: {
        type: 'submittal-arch',
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '0',
          title: '=1+1',
          date: '260204',
          contact: '+CMD',
          action: 'REC',
          notes: '@SUM(A1)',
        },
      },
      logSchema,
      targetSchema,
      templateEvaluator: evaluator,
    });

    expect(mapped.rowData.Title).toBe('=1+1');
    expect(typeof mapped.rowData.Title).toBe('string');
    expect(mapped.rowData.Contact).toBe('+CMD');
    expect(typeof mapped.rowData.Contact).toBe('string');
    expect(mapped.rowData.Notes).toBe('@SUM(A1)');
    expect(typeof mapped.rowData.Notes).toBe('string');
    expect(mapped.rowData['Calc Link']).toBeNull();
  });

  it('formats fileLink strictly for http:// and https:// URLs, escapes double quotes as "", and returns null otherwise', () => {
    expect(formatFileLinkFormula('http://example.com/a?q="test"', 'Open "Doc"')).toEqual({
      formula: '=HYPERLINK("http://example.com/a?q=""test""", "Open ""Doc""")',
    });
    expect(formatFileLinkFormula('https://drive.google.com/file/d/abc/view')).toEqual({
      formula: '=HYPERLINK("https://drive.google.com/file/d/abc/view", "Link")',
    });
    expect(formatFileLinkFormula(undefined)).toBeNull();
    expect(formatFileLinkFormula('')).toBeNull();
    expect(formatFileLinkFormula('   ')).toBeNull();
    expect(formatFileLinkFormula('javascript:alert(1)')).toBeNull();
    expect(formatFileLinkFormula('file:///etc/passwd')).toBeNull();
    expect(formatFileLinkFormula('=HYPERLINK("https://evil.com","Click")')).toBeNull();
  });

  describe('buildRowKeyExtractor', () => {
    it('reverse-maps sheet cells including case-insensitive LookupField resolution and evaluates identity keys', () => {
      const extractKeys = buildRowKeyExtractor({
        logSchema,
        targetSchema,
        templateEvaluator: evaluator,
      });

      expect(
        extractKeys({
          Status: 'open',
          Section: '071200',
          Number: '001',
          Revision: '0',
          Title: 'Waterproofing',
          Date: '260204',
          Contact: 'pmg',
          Action: 'received',
          Notes: '',
          'Calc Link': 'Link',
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-0-260204-1',
      });
    });

    it('synthesizes allowUserInput fallback tuples for unmapped custom LookupField values and supports custom sortBy/groupBy templates', () => {
      const customTargetSchema: LogTargetDocumentSchema = {
        fields: [
          {
            key: 'specTag',
            name: 'Spec Tag',
            type: 'string',
            required: true,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          {
            key: 'contact',
            name: 'Contact',
            type: 'string',
            required: true,
            options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
          },
          { key: 'date', name: 'Date', type: 'string', required: true },
        ],
        options: {
          specs: [{ key: 'CG104', name: 'BED - KING' }],
          contacts: [{ key: 'HPG', name: 'Harbor Procurement Group' }],
        },
        identity: {
          idGroup: '{{specTag.key}}',
          id: '{{specTag.key}}-{{date}}-{{contact.name}}',
        },
      };

      const customLogSchema: DocumentLogSchema = {
        ...logSchema,
        columns: {
          'Spec Tag': { template: '{{specTag.key}}' },
          Contact: { template: '{{contact.key}}' },
          Date: { template: '{{date}}' },
        },
      };

      const extractKeys = buildRowKeyExtractor({
        logSchema: customLogSchema,
        targetSchema: customTargetSchema,
        templateEvaluator: evaluator,
      });

      expect(
        extractKeys({
          'Spec Tag': 'CUSTOM-99',
          Contact: 'LMD',
          Date: '260215',
        })
      ).toEqual({
        groupKey: 'CUSTOM-99',
        sortKey: 'CUSTOM-99-260215-LMD',
      });
    });

    it('returns null when all DocumentField tokens referenced by grouping.groupBy are missing/blank instead of literal separators', () => {
      const extractKeys = buildRowKeyExtractor({
        logSchema,
        targetSchema,
        templateEvaluator: evaluator,
      });

      expect(
        extractKeys({
          Status: 'Open',
          Section: '',
          Number: '   ',
          Revision: '0',
          Title: 'Hand-edited malformed row without section or number',
          Date: '260220',
          Contact: 'PMG',
          Action: 'Received',
        })
      ).toBeNull();
    });

    it('extracts best-effort groupKey when at least one groupBy token is present on a hand-edited row', () => {
      const extractKeys = buildRowKeyExtractor({
        logSchema,
        targetSchema,
        templateEvaluator: evaluator,
      });

      // Unknown Action ("Approved") with no allowUserInput still produces best-effort idGroup & sortKey
      expect(
        extractKeys({
          Status: 'Open',
          Section: '071200',
          Number: '001',
          Revision: '1',
          Title: 'Waterproofing',
          Date: '260226',
          Contact: 'PMG',
          Action: 'Approved',
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-1-260226-',
      });
    });
  });

  describe('computeTargetRowKeys', () => {
    it('evaluates grouping.groupBy and grouping.sortBy from enriched document.data and returns null when groupBy tokens are blank', () => {
      expect(
        computeTargetRowKeys({
          document: {
            type: 'submittal-arch',
            data: {
              status: 'Open',
              section: '071200',
              number: '001',
              revision: '0',
              title: 'Waterproofing',
              date: '260205',
              contact: 'MB',
              action: 'REF',
            },
          },
          logSchema,
          targetSchema,
          templateEvaluator: evaluator,
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-0-260205-2',
      });

      expect(
        computeTargetRowKeys({
          document: {
            type: 'submittal-arch',
            data: {
              status: 'Open',
              section: '',
              number: '',
            },
          },
          logSchema,
          targetSchema,
          templateEvaluator: evaluator,
        })
      ).toBeNull();
    });
  });
});

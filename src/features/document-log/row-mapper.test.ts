import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildLogRowHydrator,
  buildRowKeyExtractor,
  computeTargetRowKeys,
  enrichDocumentData,
  formatFileLinkFormula,
  mapDocumentToLogRow,
  mapLogRowToDocument,
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

  it('honors pre-enriched enrichedData in mapDocumentToLogRow without re-enriching document.data', () => {
    const mapped = mapDocumentToLogRow({
      document: {
        type: 'submittal-arch',
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '0',
          title: 'Raw Title',
          date: '260204',
          contact: 'MB',
          action: 'REC',
        },
      },
      logSchema,
      targetSchema,
      templateEvaluator: evaluator,
      enrichedData: {
        status: { key: 'PreEnrichedStatus' },
        section: '999999',
        number: '999',
        revision: '9',
        title: 'PreEnriched Title',
        date: '260204',
        contact: { key: 'PRE', name: 'PreEnriched Contact' },
        action: { key: 'PRE', name: 'PreEnriched Action', order: '9' },
      },
    });

    expect(mapped.rowData.Status).toBe('PreEnrichedStatus');
    expect(mapped.rowData.Section).toBe('999999');
    expect(mapped.rowData.Title).toBe('PreEnriched Title');
    expect(mapped.rowData.Contact).toBe('PRE');
    expect(mapped.rowData.Action).toBe('PreEnriched Action');
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

    it('resolves hand-edited LookupField values entered by alternate key/name property and trims whitespace in key fields', () => {
      const extractKeys = buildRowKeyExtractor({
        logSchema,
        targetSchema,
        templateEvaluator: evaluator,
      });

      // Human typed Action key "REC" instead of name "Received", and left spaces around Section/Number
      expect(
        extractKeys({
          Status: 'Open',
          Section: ' 071200 ',
          Number: ' 001 ',
          Revision: ' 0 ',
          Date: ' 260204 ',
          Contact: 'Pavarini McGovern',
          Action: 'rec',
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-0-260204-1',
      });
    });

    it('extracts best-effort keys for malformed partialHydrationRows and returns null when groupBy fields are empty', () => {
      const extractArchKeys = buildRowKeyExtractor({
        logSchema,
        targetSchema,
        templateEvaluator: evaluator,
      });

      // Short 4-digit section, missing date, and unkeyable note-only row
      expect(
        extractArchKeys({
          Status: 'Open',
          Section: '7120',
          Number: '001',
          Revision: '0',
          Date: '260225',
          Contact: 'MB',
          Action: 'Received',
        })
      ).toEqual({
        groupKey: '7120-001',
        sortKey: '7120-001-0-260225-1',
      });

      expect(
        extractArchKeys({
          Status: 'Waiting',
          Section: '071200',
          Number: '001',
          Revision: '1',
          Date: '',
          Contact: 'PST',
          Action: 'Referred',
        })
      ).toEqual({
        groupKey: '071200-001',
        sortKey: '071200-001-1--2',
      });

      expect(
        extractArchKeys({
          Status: 'Open',
          Section: '',
          Number: '',
          Revision: '',
          Title: 'Human note row without submittal identity',
          Date: '',
          Contact: '',
          Action: '',
          Notes: 'Check owner allowance',
        })
      ).toBeNull();
    });

    it('extracts best-effort keys for submittalFfe partialHydrationRows (allowUserInput specTag) and returns null when Spec Tag is blank', () => {
      const ffeTargetSchema: LogTargetDocumentSchema = {
        fields: [
          {
            key: 'status',
            name: 'Status',
            type: 'string',
            required: true,
            options: { source: 'statuses', key: 'key' },
          },
          {
            key: 'specTag',
            name: 'Spec Tag',
            type: 'string',
            required: true,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          {
            key: 'relatedTag',
            name: 'Related Tag',
            type: 'string',
            required: false,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          { key: 'revision', name: 'Revision', type: 'string', required: true },
          {
            key: 'specTitle',
            name: 'Spec Title',
            type: 'string',
            required: false,
            linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
          },
          {
            key: 'vendor',
            name: 'Vendor',
            type: 'string',
            required: true,
            options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true },
          },
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
        ],
        options: {
          statuses: [{ key: 'Open' }, { key: 'Closed' }],
          specs: [{ key: 'CG104', name: 'BED - KING' }],
          vendors: [{ key: 'KC', name: 'Keystone Casegoods' }],
          contacts: [
            { key: 'HPG', name: 'Harbor Procurement Group' },
            { key: 'ARC', name: 'Apex Architecture Studio' },
          ],
          actions: [
            { key: 'REC', name: 'Received', order: '1' },
            { key: 'REF', name: 'Referred', order: '2' },
          ],
        },
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
        },
      };

      const ffeLogSchema: DocumentLogSchema = {
        ...logSchema,
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
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
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Vendor: { template: '{{vendor.name}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
        },
      };

      const extractFfeKeys = buildRowKeyExtractor({
        logSchema: ffeLogSchema,
        targetSchema: ffeTargetSchema,
        templateEvaluator: evaluator,
      });

      // invalidStatusAndMissingVendor
      expect(
        extractFfeKeys({
          Status: 'In Review',
          'Spec Tag': 'LT108',
          'Related Tag': '',
          Revision: '0',
          'Spec Title': 'SCONCE',
          Vendor: '',
          Date: '260216',
          Contact: 'HPG',
          Action: 'Received',
        })
      ).toEqual({
        groupKey: 'LT108',
        sortKey: 'LT108-0-260216-1',
      });

      // missingRevisionAndRawUrl
      expect(
        extractFfeKeys({
          Status: 'Open',
          'Spec Tag': 'CG104',
          'Related Tag': 'FB127',
          Revision: '',
          'Spec Title': 'BED - KING',
          Vendor: 'Keystone Casegoods',
          Date: '260211',
          Contact: 'ARC',
          Action: 'Referred',
        })
      ).toEqual({
        groupKey: 'CG104',
        sortKey: 'CG104--260211-2',
      });

      // Completely blank/unkeyable Spec Tag row
      expect(
        extractFfeKeys({
          Status: 'Open',
          'Spec Tag': '  ',
          Title: 'Hand-edited note',
        })
      ).toBeNull();
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

  describe('Submittal FF&E LinkedField, readOnly, and optional relatedTag handling', () => {
    const ffeTargetSchema: LogTargetDocumentSchema = {
      fields: [
        {
          key: 'status',
          name: 'Status',
          type: 'string',
          required: true,
          options: { source: 'statuses', key: 'key' },
        },
        {
          key: 'specTag',
          name: 'Spec Tag',
          type: 'string',
          required: true,
          options: { source: 'specs', key: 'key', allowUserInput: true },
        },
        {
          key: 'relatedTag',
          name: 'Related Tag',
          type: 'string',
          required: false,
          options: { source: 'specs', key: 'key', allowUserInput: true },
        },
        { key: 'revision', name: 'Revision', type: 'string', required: true },
        {
          key: 'specTitle',
          name: 'Spec Title',
          type: 'string',
          required: true,
          linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
        },
        {
          key: 'vendor',
          name: 'Vendor',
          type: 'string',
          required: true,
          options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true },
        },
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
      ],
      options: {
        statuses: [{ key: 'Open' }, { key: 'Closed' }],
        specs: [
          { key: 'CG104', name: 'BED - KING' },
          { key: 'FB127', name: 'FABRIC - LEATHER' },
        ],
        vendors: [{ key: 'FDT', name: 'Fil Doux Textiles', type: 'Fabric' }],
        contacts: [{ key: 'BW', name: 'Benjamin West', type: 'Procurement' }],
        actions: [
          { key: 'REC', name: 'Received', order: '1' },
          { key: 'REF', name: 'Referred', order: '2' },
        ],
      },
      identity: {
        idGroup: '{{specTag.key}}',
        idDocument: '{{specTag.key}}-{{revision}}',
        id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
      },
    };

    const ffeLogSchema: DocumentLogSchema = {
      provider: 'google_sheets',
      target: {
        sheetName: 'Submittal FF&E',
        rangeName: 'Log_Submittal_FFE',
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
        'Spec Tag': { template: '{{specTag.key}}' },
        'Related Tag': { template: '{{relatedTag.key}}' },
        Revision: { template: '{{revision}}' },
        'Spec Title': { template: '{{specTitle}}', readOnly: true },
        Vendor: { template: '{{vendor.name}}' },
        Date: { template: '{{date}}' },
        Contact: { template: '{{contact.key}}' },
        Action: { template: '{{action.name}}' },
        Notes: { template: '{{notes}}' },
        'Calc Link': { source: 'fileLink', label: 'Link' },
      },
    };

    it('skips readOnly Spec Title, returns readOnlyColumns, and maps blank vs populated optional relatedTag', () => {
      const baseData = {
        status: 'Open',
        specTag: 'CG104',
        revision: '0',
        specTitle: 'BED - KING',
        vendor: 'FDT',
        date: '260120',
        contact: 'BW',
        action: 'REC',
        notes: '',
      };

      const withBlankRelatedTag = mapDocumentToLogRow({
        document: {
          type: 'submittal-ffe',
          data: { ...baseData, relatedTag: '' },
        },
        logSchema: ffeLogSchema,
        targetSchema: ffeTargetSchema,
        templateEvaluator: evaluator,
        fileUri: 'https://drive.google.com/file/d/ffe-1/view',
      });

      expect(withBlankRelatedTag.readOnlyColumns).toEqual(['Spec Title']);
      expect('Spec Title' in withBlankRelatedTag.rowData).toBe(false);
      expect(withBlankRelatedTag.rowData).toEqual({
        Status: 'Open',
        'Spec Tag': 'CG104',
        'Related Tag': null,
        Revision: '0',
        Vendor: 'Fil Doux Textiles',
        Date: '260120',
        Contact: 'BW',
        Action: 'Received',
        Notes: null,
        'Calc Link': {
          formula: '=HYPERLINK("https://drive.google.com/file/d/ffe-1/view", "Link")',
        },
      });

      const withPopulatedRelatedTag = mapDocumentToLogRow({
        document: {
          type: 'submittal-ffe',
          data: { ...baseData, relatedTag: 'FB127' },
        },
        logSchema: ffeLogSchema,
        targetSchema: ffeTargetSchema,
        templateEvaluator: evaluator,
      });

      expect(withPopulatedRelatedTag.readOnlyColumns).toEqual(['Spec Title']);
      expect('Spec Title' in withPopulatedRelatedTag.rowData).toBe(false);
      expect(withPopulatedRelatedTag.rowData['Related Tag']).toBe('FB127');
    });

    it('reverse-maps Submittal FF&E sheet rows with case-insensitive Action and returns null when Spec Tag is blank', () => {
      const extractKeys = buildRowKeyExtractor({
        logSchema: ffeLogSchema,
        targetSchema: ffeTargetSchema,
        templateEvaluator: evaluator,
      });

      expect(
        extractKeys({
          Status: 'open',
          'Spec Tag': 'CG104',
          'Related Tag': '',
          Revision: '0',
          'Spec Title': 'BED - KING',
          Vendor: 'Fil Doux Textiles',
          Date: '260120',
          Contact: 'bw',
          Action: 'received',
          Notes: '',
        })
      ).toEqual({
        groupKey: 'CG104',
        sortKey: 'CG104-0-260120-1',
      });

      expect(
        extractKeys({
          Status: 'Open',
          'Spec Tag': '   ',
          Revision: '0',
          Date: '260120',
          Action: 'Received',
        })
      ).toBeNull();
    });
  });

  describe('mapLogRowToDocument / buildLogRowHydrator (bidirectional hydration)', () => {
    it('hydrates valid Submittal Arch and Submittal FF&E rows (including readOnly Spec Title), omits blank cells and calculated, computes Identity, and attaches fileUri & rowNumber', () => {
      const archHydrated = mapLogRowToDocument({
        rowNumber: 6,
        values: {
          Status: ' open ',
          Section: ' 071200 ',
          Number: ' 001 ',
          Revision: '0',
          Title: 'Fluid-Applied Waterproofing',
          Date: '260204',
          Contact: 'Pavarini McGovern',
          Action: 'received',
          Notes: '   ',
          'Calc Link': 'Link',
        },
        links: {
          'Calc Link': 'https://drive.google.com/file/d/arch-row-6/view',
        },
        documentTypeKey: 'submittal-arch',
        logSchema,
        targetSchema,
        templateEvaluator: evaluator,
      });

      expect(archHydrated.warnings).toEqual([]);
      expect(archHydrated.entry).toEqual({
        rowNumber: 6,
        valid: true,
        fileUri: 'https://drive.google.com/file/d/arch-row-6/view',
        document: {
          id: '071200-001-0-260204-1',
          idDocument: '071200-001-0',
          idGroup: '071200-001',
          type: 'submittal-arch',
          data: {
            status: { key: 'Open' },
            section: '071200',
            number: '001',
            revision: '0',
            title: 'Fluid-Applied Waterproofing',
            date: '260204',
            contact: { key: 'PMG', name: 'Pavarini McGovern', type: 'Contractor' },
            action: { key: 'REC', name: 'Received', order: '1' },
          },
        },
      });
      expect('notes' in archHydrated.entry.document.data).toBe(false);
      expect('calculated' in archHydrated.entry.document).toBe(false);

      const ffeTarget: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true, options: { source: 'statuses', key: 'key' } },
          { key: 'specTag', name: 'Spec Tag', type: 'string', required: true, options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'relatedTag', name: 'Related Tag', type: 'string', required: false, minLength: 3, pattern: '^[A-Z]{2}\\d{3}', options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'revision', name: 'Revision', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$' },
          { key: 'specTitle', name: 'Spec Title', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$', linkedField: { sourceField: 'specTag', sourceProperty: 'name' } },
          { key: 'vendor', name: 'Vendor', type: 'string', required: true, options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true, options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
          { key: 'notes', name: 'Notes', type: 'string', required: false, minLength: 2, pattern: '^.*\\S+.*$' },
        ],
        options: {
          statuses: [{ key: 'Open' }],
          specs: [{ key: 'CG104', name: 'BED - KING' }],
          vendors: [{ key: 'FDT', name: 'Fil Doux Textiles', type: 'Fabric' }],
          contacts: [{ key: 'BW', name: 'Benjamin West', type: 'Procurement' }],
          actions: [{ key: 'REC', name: 'Received', order: '1' }],
        },
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
        },
      };

      const ffeLog: DocumentLogSchema = {
        ...logSchema,
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        columns: {
          Status: { template: '{{status.key}}' },
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Vendor: { template: '{{vendor.name}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
          Notes: { template: '{{notes}}' },
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
      };

      const hydrateFfe = buildLogRowHydrator({
        documentTypeKey: 'submittal-ffe',
        logSchema: ffeLog,
        targetSchema: ffeTarget,
        templateEvaluator: evaluator,
      });

      const ffeHydrated = hydrateFfe({
        rowNumber: 9,
        values: {
          Status: 'Open',
          'Spec Tag': 'cg104',
          'Related Tag': '',
          Revision: '0',
          'Spec Title': 'BED - KING',
          Vendor: 'Fil Doux Textiles',
          Date: '260120',
          Contact: 'bw',
          Action: 'REC',
          Notes: '',
          'Calc Link': '',
        },
        links: { 'Calc Link': null },
      });

      expect(ffeHydrated.warnings).toEqual([]);
      expect(ffeHydrated.entry).toEqual({
        rowNumber: 9,
        valid: true,
        document: {
          id: 'CG104-0-260120-1',
          idDocument: 'CG104-0',
          idGroup: 'CG104',
          type: 'submittal-ffe',
          data: {
            status: { key: 'Open' },
            specTag: { key: 'CG104', name: 'BED - KING' },
            revision: '0',
            specTitle: 'BED - KING',
            vendor: { key: 'FDT', name: 'Fil Doux Textiles', type: 'Fabric' },
            date: '260120',
            contact: { key: 'BW', name: 'Benjamin West', type: 'Procurement' },
            action: { key: 'REC', name: 'Received', order: '1' },
          },
        },
      });
      expect('fileUri' in ffeHydrated.entry).toBe(false);
      expect('relatedTag' in ffeHydrated.entry.document.data).toBe(false);
      expect('notes' in ffeHydrated.entry.document.data).toBe(false);
    });

    it('resiliently hydrates all 5 partialHydrationRows from document-log-sample-data.json with best-effort LookupField fallback tuples, single required errors without minLength/pattern noise, and multi-field error collection', () => {
      interface FixturePartialRow {
        scenario: string;
        rowCells: Record<string, string>;
        linkFormula: string;
        expectedIssues: string[];
      }
      const fixture = JSON.parse(
        fs.readFileSync(
          path.resolve(__dirname, '../../../test/fixtures/document-log-sample-data.json'),
          'utf-8'
        )
      ) as {
        anonymizedEntities: {
          contacts: Array<{ key: string; name: string; type: string }>;
          vendors: Array<{ key: string; name: string; type: string }>;
        };
        submittalArch: { partialHydrationRows: FixturePartialRow[] };
        submittalFfe: { partialHydrationRows: FixturePartialRow[] };
      };

      const archFullTarget: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true, options: { source: 'statuses', key: 'key' } },
          { key: 'section', name: 'Section', type: 'string', required: true, pattern: '^\\d{6}$' },
          { key: 'number', name: 'Number', type: 'string', required: true, pattern: '^\\d{3,}$' },
          { key: 'revision', name: 'Revision', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$' },
          { key: 'title', name: 'Title', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$' },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$', options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
          { key: 'notes', name: 'Notes', type: 'string', required: false },
        ],
        options: {
          statuses: [{ key: 'Open' }, { key: 'Closed' }, { key: 'Waiting' }],
          actions: [
            { key: 'REC', name: 'Received', order: '1' },
            { key: 'REF', name: 'Referred', order: '2' },
          ],
          contacts: fixture.anonymizedEntities.contacts,
        },
        identity: {
          idGroup: '{{section}}-{{number}}',
          idDocument: '{{section}}-{{number}}-{{revision}}',
          id: '{{section}}-{{number}}-{{revision}}-{{date}}-{{action.order}}',
        },
      };

      const hydrateArch = buildLogRowHydrator({
        documentTypeKey: 'submittal-arch',
        logSchema,
        targetSchema: archFullTarget,
        templateEvaluator: evaluator,
      });

      const extractFixtureUri = (formula: string): string | undefined => {
        const hyper = /^=HYPERLINK\("([^"]+)"/.exec(formula);
        if (hyper) return hyper[1];
        return formula.startsWith('http') ? formula : undefined;
      };

      // 1) invalidSectionPattern
      const archRow0 = fixture.submittalArch.partialHydrationRows[0];
      const resArch0 = hydrateArch({
        rowNumber: 10,
        values: archRow0.rowCells,
        links: { 'Calc Link': extractFixtureUri(archRow0.linkFormula) ?? null },
      });
      expect(resArch0.entry.valid).toBe(false);
      expect(resArch0.entry.fileUri).toBe('https://drive.google.com/file/d/fixture-arch-partial-sec/view');
      expect(resArch0.entry.document.idGroup).toBe('7120-001');
      expect(resArch0.entry.document.data.section).toBe('7120');
      expect(resArch0.warnings.map((w) => w.field)).toEqual(archRow0.expectedIssues);
      expect(resArch0.entry.validationErrors).toHaveLength(1);

      // 2) unknownActionAndRawUrl
      const archRow1 = fixture.submittalArch.partialHydrationRows[1];
      const resArch1 = hydrateArch({
        rowNumber: 11,
        values: archRow1.rowCells,
        links: { 'Calc Link': extractFixtureUri(archRow1.linkFormula) ?? null },
      });
      expect(resArch1.entry.valid).toBe(false);
      expect(resArch1.entry.fileUri).toBe('https://drive.google.com/file/d/fixture-arch-raw-url/view');
      expect(resArch1.entry.document.data.action).toEqual({ key: 'Approved', name: 'Approved' });
      expect(resArch1.entry.document.idGroup).toBe('071200-001');
      expect(resArch1.warnings.map((w) => w.field)).toEqual(archRow1.expectedIssues);
      expect(resArch1.entry.validationErrors).toHaveLength(1);

      // 3) missingRequiredDate
      const archRow2 = fixture.submittalArch.partialHydrationRows[2];
      const resArch2 = hydrateArch({
        rowNumber: 12,
        values: archRow2.rowCells,
        links: { 'Calc Link': extractFixtureUri(archRow2.linkFormula) ?? null },
      });
      expect(resArch2.entry.valid).toBe(false);
      expect('fileUri' in resArch2.entry).toBe(false);
      expect('date' in resArch2.entry.document.data).toBe(false);
      expect(resArch2.entry.document.idGroup).toBe('071200-001');
      expect(resArch2.warnings.map((w) => w.field)).toEqual(archRow2.expectedIssues);
      expect(resArch2.entry.validationErrors).toHaveLength(1);

      // Submittal FF&E partialHydrationRows
      const ffeFullTarget: LogTargetDocumentSchema = {
        fields: [
          { key: 'status', name: 'Status', type: 'string', required: true, options: { source: 'statuses', key: 'key' } },
          { key: 'specTag', name: 'Spec Tag', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$', options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'relatedTag', name: 'Related Tag', type: 'string', required: false, options: { source: 'specs', key: 'key', allowUserInput: true } },
          { key: 'revision', name: 'Revision', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$' },
          { key: 'specTitle', name: 'Spec Title', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$', linkedField: { sourceField: 'specTag', sourceProperty: 'name' } },
          { key: 'vendor', name: 'Vendor', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$', options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'date', name: 'Date', type: 'string', required: true },
          { key: 'contact', name: 'Contact', type: 'string', required: true, minLength: 1, pattern: '^.*\\S+.*$', options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
          { key: 'notes', name: 'Notes', type: 'string', required: false },
        ],
        options: {
          statuses: [{ key: 'Open' }, { key: 'Closed' }, { key: 'Waiting' }],
          specs: [
            { key: 'CG104', name: 'BED - KING' },
            { key: 'LT108', name: 'SCONCE' },
          ],
          vendors: fixture.anonymizedEntities.vendors,
          contacts: fixture.anonymizedEntities.contacts,
          actions: [
            { key: 'REC', name: 'Received', order: '1' },
            { key: 'REF', name: 'Referred', order: '2' },
          ],
        },
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
        },
      };

      const ffeLog: DocumentLogSchema = {
        ...logSchema,
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        columns: {
          Status: { template: '{{status.key}}' },
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Vendor: { template: '{{vendor.name}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
          Notes: { template: '{{notes}}' },
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
      };

      const hydrateFfe = buildLogRowHydrator({
        documentTypeKey: 'submittal-ffe',
        logSchema: ffeLog,
        targetSchema: ffeFullTarget,
        templateEvaluator: evaluator,
      });

      // 4) invalidStatusAndMissingVendor
      const ffeRow0 = fixture.submittalFfe.partialHydrationRows[0];
      const resFfe0 = hydrateFfe({
        rowNumber: 13,
        values: ffeRow0.rowCells,
        links: { 'Calc Link': extractFixtureUri(ffeRow0.linkFormula) ?? null },
      });
      expect(resFfe0.entry.valid).toBe(false);
      expect(resFfe0.entry.fileUri).toBe('https://drive.google.com/file/d/fixture-ffe-partial-vendor/view');
      expect(resFfe0.entry.document.data.status).toEqual({ key: 'In Review' });
      expect('vendor' in resFfe0.entry.document.data).toBe(false);
      expect(resFfe0.entry.document.data.specTitle).toBe('SCONCE');
      expect(resFfe0.warnings.map((w) => w.field)).toEqual(ffeRow0.expectedIssues);
      // Vendor emits 1 required error only (no minLength / pattern noise)
      expect(resFfe0.entry.validationErrors).toHaveLength(2);

      // 5) missingRevisionAndRawUrl
      const ffeRow1 = fixture.submittalFfe.partialHydrationRows[1];
      const resFfe1 = hydrateFfe({
        rowNumber: 14,
        values: ffeRow1.rowCells,
        links: { 'Calc Link': extractFixtureUri(ffeRow1.linkFormula) ?? null },
      });
      expect(resFfe1.entry.valid).toBe(false);
      expect(resFfe1.entry.fileUri).toBe('https://drive.google.com/file/d/fixture-ffe-raw-url/view');
      expect('revision' in resFfe1.entry.document.data).toBe(false);
      expect(resFfe1.warnings.map((w) => w.field)).toEqual(ffeRow1.expectedIssues);
      expect(resFfe1.entry.validationErrors).toHaveLength(1);
    });

    it('validates non-blank minLength and pattern (including allowUserInput LookupFields), leaves unkeyable row identities undefined, and lets canonical multi-column matches win', () => {
      const customTarget: LogTargetDocumentSchema = {
        fields: [
          { key: 'code', name: 'Code', type: 'string', required: true, minLength: 4, pattern: '^[A-Z0-9]+$' },
          { key: 'optionalCode', name: 'Optional Code', type: 'string', required: false, minLength: 4, pattern: '^[A-Z]+$' },
          { key: 'contact', name: 'Contact', type: 'string', required: true, minLength: 2, options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'action', name: 'Action', type: 'string', required: true, options: { source: 'actions', key: 'key', name: 'name' } },
        ],
        options: {
          contacts: [{ key: 'MB', name: 'Meridian Builders' }],
          actions: [{ key: 'REC', name: 'Received', order: '1' }],
        },
        identity: {
          idGroup: '{{code}}-{{contact.key}}',
          idDocument: '{{code}}-{{action.order}}',
          id: '{{code}}-{{contact.key}}-{{action.order}}',
        },
      };

      const customLog: DocumentLogSchema = {
        ...logSchema,
        columns: {
          Code: { template: '{{code}}' },
          'Optional Code': { template: '{{optionalCode}}' },
          Contact: { template: '{{contact.key}}' },
          'Action Key': { template: '{{action.key}}' },
          'Action Name': { template: '{{action.name}}' },
        },
      };

      const hydrate = buildLogRowHydrator({
        documentTypeKey: 'custom-type',
        logSchema: customLog,
        targetSchema: customTarget,
        templateEvaluator: evaluator,
      });

      // Unkeyable note row: all identity tokens blank -> idGroup, idDocument, id all undefined (never '-')
      const unkeyable = hydrate({
        rowNumber: 7,
        values: {
          Code: '',
          'Optional Code': '',
          Contact: '',
          'Action Key': '',
          'Action Name': '',
        },
      });
      expect(unkeyable.entry.valid).toBe(false);
      expect(unkeyable.entry.document.idGroup).toBeUndefined();
      expect(unkeyable.entry.document.idDocument).toBeUndefined();
      expect(unkeyable.entry.document.id).toBeUndefined();
      expect('idGroup' in unkeyable.entry.document).toBe(false);
      expect(unkeyable.warnings.map((w) => w.field)).toEqual(['code', 'contact', 'action']);

      // Non-blank minLength/pattern failures + allowUserInput minLength failure + blank optionalCode omitted safely
      const invalidLengths = hydrate({
        rowNumber: 8,
        values: {
          Code: 'ab',
          'Optional Code': '',
          Contact: 'X',
          'Action Key': 'BAD',
          'Action Name': 'Received', // canonical match in second column overrides invalid 'BAD' in first column!
        },
      });
      expect(invalidLengths.entry.valid).toBe(false);
      expect(invalidLengths.warnings.map((w) => w.field)).toEqual(['code', 'contact']);
      expect(invalidLengths.entry.validationErrors?.[0]).toContain('length >= 4');
      expect(invalidLengths.entry.validationErrors?.[0]).toContain('pattern');
      expect(invalidLengths.entry.validationErrors?.[1]).toContain('length >= 2');
      expect(invalidLengths.entry.document.data.action).toEqual({
        key: 'REC',
        name: 'Received',
        order: '1',
      });
    });
  });
});

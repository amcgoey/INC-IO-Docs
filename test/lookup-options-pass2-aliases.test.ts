import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { PDFDocument } from 'pdf-lib';
import { createApp, type AppInstance } from '../src/app/server';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { GoogleGmailClient } from '../src/infrastructure/gmail';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceCard,
  GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';

const DRIVE_ID = 'drive-360-proj';
const SPACE_NAME = 'Active Projects';
const LOG_ID = 'sheet-360-log';

function createAuthVerifier(): WorkspaceAuthVerifierPort {
  return {
    verifyToken: vi.fn().mockImplementation(async (header?: string) => {
      if (header?.startsWith('Bearer valid-')) {
        return { isValid: true, payload: { email: 'pm@inc.nyc', sub: 'user-360' } };
      }
      return { isValid: false, error: 'Unauthorized' };
    }),
  };
}

function getCard(payload: string, kind: 'pushCard' | 'updateCard'): GoogleWorkspaceCard {
  const body = JSON.parse(payload) as GoogleWorkspaceActionResponse;
  const nav = body.action?.navigations?.[0];
  const card = kind === 'pushCard' ? nav?.pushCard : nav?.updateCard;
  expect(card).toBeDefined();
  return card!;
}

function findSection(card: GoogleWorkspaceCard, header: string): GoogleWorkspaceSection | undefined {
  return card.sections.find((s) => s.header === header);
}

function findTextInputValue(
  section: GoogleWorkspaceSection | undefined,
  fieldKey: string,
  docTypeKey: string
): string | undefined {
  const widgetName = getDocumentInfoWidgetName(fieldKey, docTypeKey);
  return section?.widgets.find((w) => w.textInput?.name === widgetName)?.textInput?.value;
}

function findDecoratedTextValue(
  section: GoogleWorkspaceSection | undefined,
  topLabel: string
): string | undefined {
  return section?.widgets.find((w) => w.decoratedText?.topLabel === topLabel)?.decoratedText?.text;
}

function findSelectedValue(
  section: GoogleWorkspaceSection | undefined,
  fieldKey: string,
  docTypeKey: string
): string | undefined {
  const widgetName = getDocumentInfoWidgetName(fieldKey, docTypeKey);
  return section?.widgets
    .find((w) => w.selectionInput?.name === widgetName)
    ?.selectionInput?.items.find((i) => i.selected)?.value;
}

function mockDriveSpacesAndLogDiscovery(): void {
  nock('https://www.googleapis.com')
    .get('/drive/v3/drives')
    .query(true)
    .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === DRIVE_ID)
    .reply(200, {
      files: [
        {
          id: LOG_ID,
          name: `${SPACE_NAME} Document Log`,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: [DRIVE_ID],
          webViewLink: `https://docs.google.com/spreadsheets/d/${LOG_ID}/edit`,
        },
      ],
    });
}

function mockSheetsOptionTables(options?: {
  vendorsRows?: string[][];
}): void {
  const vendorsRows = options?.vendorsRows ?? [
    ['Vendor', 'Name', 'Aliases'],
    ['CARN', 'Carnegie Fabrics', ''],
    ['CUSTV', 'Custom Millwork Corp', '"Custom ""Design"", LLC", Custom Design'],
    ['---', '', ''],
  ];

  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${LOG_ID}`)
    .query(true)
    .reply(200, {
      spreadsheetId: LOG_ID,
      sheets: [
        { properties: { sheetId: 102, title: 'Submittal FF&E' } },
        { properties: { sheetId: 104, title: '_Config Submittal FFE' } },
      ],
      namedRanges: [
        {
          namedRangeId: 'nr-ffe-log',
          name: 'Log_Submittal_FFE',
          range: { sheetId: 102, startRowIndex: 2, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 11 },
        },
        {
          namedRangeId: 'nr-statuses',
          name: 'Options_FFE_Statuses',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
        },
        {
          namedRangeId: 'nr-actions',
          name: 'Options_FFE_Actions',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 6 },
        },
        {
          namedRangeId: 'nr-contacts',
          name: 'Options_FFE_Contacts',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 10 },
        },
        {
          namedRangeId: 'nr-vendors',
          name: 'Options_FFE_Vendors',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: vendorsRows.length, startColumnIndex: 11, endColumnIndex: 14 },
        },
        {
          namedRangeId: 'nr-specs',
          name: 'Options_FFE_Specs',
          range: { sheetId: 104, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 15, endColumnIndex: 17 },
        },
      ],
    });

  // Assert exactly 1 batched values:batchGet per HTTP request (memoized across SourceParser + SchemaDrivenUi)
  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${LOG_ID}/values:batchGet`)
    .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
    .reply(200, (uri) => {
      const requestedRanges = new URL(uri, 'https://sheets.googleapis.com').searchParams.getAll('ranges');
      return {
        spreadsheetId: LOG_ID,
        valueRanges: requestedRanges.map((range) => {
          if (range.includes('A1:A3')) {
            return { range, values: [['Status'], ['Open'], ['---']] };
          }
          if (range.includes('C1:F3')) {
            return {
              range,
              values: [
                ['Action', 'Name', 'Suffix', 'Order'],
                ['REC', 'Received', '', '1'],
                ['---', '', '', ''],
              ],
            };
          }
          if (range.includes('H1:J3')) {
            return {
              range,
              values: [
                ['Contact', 'Name', 'Aliases'],
                ['CUST', 'Custom Studio', '"Custom ""Studio"", Inc.", @custom-studio.com'],
                ['---', '', ''],
              ],
            };
          }
          if (range.includes('L1:N')) {
            return { range, values: vendorsRows };
          }
          if (range.includes('P1:Q3')) {
            // Intentionally omits Aliases column header to verify silent ignore end-to-end
            return {
              range,
              values: [
                ['Spec Tag', 'Spec Title'],
                ['CG104', 'BED - KING'],
                ['---', ''],
              ],
            };
          }
          return { range, values: [] };
        }),
      };
    });
}

describe('SourceParser Pass 2 Live DocumentLog Options & Alias Integration at Workspace Addon Seam (Ticket #360)', () => {
  let tempDir: string;
  let app: AppInstance;
  let gmailClient: GoogleGmailClient;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inc-io-360-'));
    const assetsDir = path.resolve(__dirname, '../assets');
    const rawFfe = JSON.parse(
      await fs.readFile(path.join(assetsDir, 'document-types/submittal-ffe.json'), 'utf8')
    ) as Record<string, unknown>;

    const docSchema = rawFfe.documentSchema as {
      options?: Record<string, unknown>;
      optionSources?: Record<string, unknown>;
    };
    delete docSchema.options;
    docSchema.optionSources = {
      statuses: { provider: 'document_log', properties: ['key'] },
      actions: { provider: 'document_log', properties: ['key', 'name', 'suffix', 'order'] },
      contacts: { provider: 'document_log', properties: ['key', 'name'] },
      vendors: { provider: 'document_log', properties: ['key', 'name'] },
      specs: { provider: 'document_log', properties: ['key', 'name'] },
    };

    const logSchema = rawFfe.documentLogSchema as {
      optionBindings?: Record<string, unknown>;
    };
    logSchema.optionBindings = {
      statuses: {
        sheetName: '_Config Submittal FFE',
        rangeName: 'Options_FFE_Statuses',
        endMarker: '---',
        columns: { Status: 'key' },
      },
      actions: {
        sheetName: '_Config Submittal FFE',
        rangeName: 'Options_FFE_Actions',
        endMarker: '---',
        columns: { Action: 'key', Name: 'name', Suffix: 'suffix', Order: 'order' },
      },
      contacts: {
        sheetName: '_Config Submittal FFE',
        rangeName: 'Options_FFE_Contacts',
        endMarker: '---',
        columns: { Contact: 'key', Name: 'name' },
        aliasesColumn: 'Aliases',
      },
      vendors: {
        sheetName: '_Config Submittal FFE',
        rangeName: 'Options_FFE_Vendors',
        endMarker: '---',
        columns: { Vendor: 'key', Name: 'name' },
        aliasesColumn: 'Aliases',
      },
      specs: {
        sheetName: '_Config Submittal FFE',
        rangeName: 'Options_FFE_Specs',
        endMarker: '---',
        columns: { 'Spec Tag': 'key', 'Spec Title': 'name' },
        aliasesColumn: 'Aliases',
      },
    };

    await fs.mkdir(path.join(tempDir, 'document-types'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'aliases'), { recursive: true });

    await fs.writeFile(
      path.join(tempDir, 'manifest.json'),
      JSON.stringify({
        documentTypes: ['./document-types/submittal-ffe.json'],
        configuration: {
          workspace: {
            defaultDocumentSpaceType: 'projects',
            defaultDocumentType: 'submittal-ffe',
            timeZone: 'America/New_York',
          },
          drive: { pageSize: 100 },
          templates: {
            submittalCoverSheet: 'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
          },
          documentLog: {
            preferredFolderPath: '1 Admin',
            fileNameContains: 'Document Log',
            excludePrefixes: ['Copy of '],
            excludeSubstrings: ['Template'],
            templateSpreadsheetId: 'template-360',
            copyNameTemplate: '{{DocumentSpace.name}} Document Log',
          },
        },
        DocumentSpaceTypes: [
          {
            id: 'projects',
            displayName: 'Projects',
            storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives', paginationLimit: 500 },
            spaceSchema: {
              defaultDocumentType: 'submittal-ffe',
              allowedDocumentTypes: ['submittal-ffe'],
            },
          },
        ],
        aliases: {
          contacts: './aliases/contacts.json',
          vendors: './aliases/vendors.json',
        },
      }),
      'utf8'
    );

    await fs.writeFile(
      path.join(tempDir, 'document-types/submittal-ffe.json'),
      JSON.stringify(rawFfe),
      'utf8'
    );
    await fs.writeFile(
      path.join(tempDir, 'aliases/contacts.json'),
      JSON.stringify({
        source: 'contacts',
        mappings: {
          ' PMG ': ['@pavarini.com', 'Pavarini McGovern'],
        },
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(tempDir, 'aliases/vendors.json'),
      JSON.stringify({
        source: 'vendors',
        mappings: {
          ' Carn ': ['@carnegiefabrics.com', 'Carnegie Fabrics', 'Carnegie'],
        },
      }),
      'utf8'
    );

    const manifestPath = path.join(tempDir, 'manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    gmailClient = new GoogleGmailClient();

    app = createApp({
      manifestProvider,
      authVerifier: createAuthVerifier(),
      gmailClient,
      skipSpaceValidation: true,
    });
    await app.initialize();
    nock.disableNetConnect();
  });

  afterEach(async () => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('pre-populates Gmail card via SourceParser Pass 2 combining Tier 2 _Config RFC 4180 aliases[] and normalized Tier 3 AliasDictionary against live DocumentLog options', async () => {
    vi.spyOn(gmailClient, 'getThread').mockResolvedValueOnce({
      id: 'th-360-gmail',
      messages: [
        {
          id: 'msg-360-gmail',
          threadId: 'th-360-gmail',
          subject: 'CG104-A Submittal',
          from: 'Custom Studio <designer@custom-studio.com>',
          to: 'Designer <designer@inc.nyc>',
          date: 'Tue, 17 Nov 2026 10:00:00 -0500',
          labels: ['INBOX', SPACE_NAME],
          plainTextBody: 'Please review.',
          inlineImages: [],
          attachments: [
            {
              partId: 'part-1',
              attachmentId: 'att-1',
              filename: 'CG104-A_Carnegie_CutSheet.pdf',
              mimeType: 'application/pdf',
              size: 1024,
            },
          ],
        },
      ],
    });

    mockDriveSpacesAndLogDiscovery();
    mockSheetsOptionTables();

    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        gmail: {
          messageId: 'msg-360-gmail',
          threadId: 'th-360-gmail',
          accessToken: 'ya29.token',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const card = getCard(res.payload, 'pushCard');
    const docData = findSection(card, 'Document Data');

    expect(findTextInputValue(docData, 'contact', 'submittal-ffe')).toBe('CUST');
    expect(findTextInputValue(docData, 'vendor', 'submittal-ffe')).toBe('CARN');
    expect(findTextInputValue(docData, 'specTag', 'submittal-ffe')).toBe('CG104');
    expect(findDecoratedTextValue(docData, 'Spec Title')).toBe('BED - KING');
    expect(findTextInputValue(docData, 'specTitle', 'submittal-ffe')).toBeUndefined();
    expect(findTextInputValue(docData, 'revision', 'submittal-ffe')).toBe('A');
    expect(findSelectedValue(docData, 'action', 'submittal-ffe')).toBe('REC');
    expect(findSelectedValue(docData, 'status', 'submittal-ffe')).toBe('Open');
    expect(nock.isDone()).toBe(true);

    // Also verify RFC 4180 "" escaped-quote alias (`Custom "Studio", Inc.`) matches exact displayName when domain is unknown
    vi.spyOn(gmailClient, 'getThread').mockResolvedValueOnce({
      id: 'th-360-gmail-quoted',
      messages: [
        {
          id: 'msg-360-gmail-quoted',
          threadId: 'th-360-gmail-quoted',
          subject: 'CG104-A Submittal',
          from: 'Custom "Studio", Inc. <noreply@generic-relay.net>',
          to: 'Designer <designer@inc.nyc>',
          date: 'Tue, 17 Nov 2026 10:00:00 -0500',
          labels: ['INBOX', SPACE_NAME],
          plainTextBody: 'Please review.',
          inlineImages: [],
          attachments: [],
        },
      ],
    });

    mockDriveSpacesAndLogDiscovery();
    mockSheetsOptionTables();

    const quotedRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        gmail: {
          messageId: 'msg-360-gmail-quoted',
          threadId: 'th-360-gmail-quoted',
          accessToken: 'ya29.token',
        },
      },
    });

    expect(quotedRes.statusCode).toBe(200);
    const quotedCard = getCard(quotedRes.payload, 'pushCard');
    const quotedDocData = findSection(quotedCard, 'Document Data');
    expect(findTextInputValue(quotedDocData, 'contact', 'submittal-ffe')).toBe('CUST');
    expect(nock.isDone()).toBe(true);
  });

  it('pre-populates Drive card via SourceParser Pass 2 matching Drive filenames against Tier 2 _Config RFC 4180 aliases[] and normalized Tier 3 AliasDictionary', async () => {
    const flatPdfBuffer = Buffer.from(await (await PDFDocument.create()).save());

    // 1. Tier 2 _Config RFC 4180 alias match ("Custom Design") from Drive filename
    mockDriveSpacesAndLogDiscovery();
    mockSheetsOptionTables();
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/file-360-tier2')
      .query((q) => q.alt !== 'media')
      .reply(200, {
        id: 'file-360-tier2',
        name: 'CG104-A_Custom_Design_CutSheet.pdf',
        mimeType: 'application/pdf',
        parents: [DRIVE_ID],
        driveId: DRIVE_ID,
        modifiedTime: '2026-11-18T15:00:00Z',
      });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/file-360-tier2')
      .query((q) => q.alt === 'media')
      .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

    const tier2Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [{ id: 'file-360-tier2', title: 'CG104-A_Custom_Design_CutSheet.pdf' }],
        },
      },
    });

    expect(tier2Res.statusCode).toBe(200);
    const tier2Card = getCard(tier2Res.payload, 'pushCard');
    const tier2DocData = findSection(tier2Card, 'Document Data');

    expect(findTextInputValue(tier2DocData, 'vendor', 'submittal-ffe')).toBe('CUSTV');
    expect(findTextInputValue(tier2DocData, 'specTag', 'submittal-ffe')).toBe('CG104');
    expect(findDecoratedTextValue(tier2DocData, 'Spec Title')).toBe('BED - KING');
    expect(findTextInputValue(tier2DocData, 'specTitle', 'submittal-ffe')).toBeUndefined();
    expect(findTextInputValue(tier2DocData, 'revision', 'submittal-ffe')).toBe('A');
    expect(nock.isDone()).toBe(true);

    // 2. Tier 3 Manifest AliasDictionary match ("Carnegie" under ' Carn ' -> 'CARN') when _Config Vendors omits Aliases header
    mockDriveSpacesAndLogDiscovery();
    mockSheetsOptionTables({
      vendorsRows: [
        ['Vendor', 'Name'],
        ['CARN', 'Carnegie Fabrics'],
        ['---', ''],
      ],
    });
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/file-360-tier3')
      .query((q) => q.alt !== 'media')
      .reply(200, {
        id: 'file-360-tier3',
        name: 'CG104-A_Carnegie_CutSheet.pdf',
        mimeType: 'application/pdf',
        parents: [DRIVE_ID],
        driveId: DRIVE_ID,
        modifiedTime: '2026-11-18T15:00:00Z',
      });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/file-360-tier3')
      .query((q) => q.alt === 'media')
      .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

    const tier3Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [{ id: 'file-360-tier3', title: 'CG104-A_Carnegie_CutSheet.pdf' }],
        },
      },
    });

    expect(tier3Res.statusCode).toBe(200);
    const tier3Card = getCard(tier3Res.payload, 'pushCard');
    const tier3DocData = findSection(tier3Card, 'Document Data');

    expect(findTextInputValue(tier3DocData, 'vendor', 'submittal-ffe')).toBe('CARN');
    expect(findTextInputValue(tier3DocData, 'specTag', 'submittal-ffe')).toBe('CG104');
    expect(findDecoratedTextValue(tier3DocData, 'Spec Title')).toBe('BED - KING');
    expect(findTextInputValue(tier3DocData, 'specTitle', 'submittal-ffe')).toBeUndefined();
    expect(nock.isDone()).toBe(true);
  });
});

describe('Unmodified production manifest _Config Aliases Pass 2 integration', () => {
  let app: AppInstance;
  let gmailClient: GoogleGmailClient;

  beforeEach(async () => {
    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    gmailClient = new GoogleGmailClient();

    app = createApp({
      manifestProvider,
      authVerifier: createAuthVerifier(),
      gmailClient,
      skipSpaceValidation: true,
    });
    await app.initialize();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  function mockProductionSheetsTables(): void {
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${LOG_ID}`)
      .query(true)
      .reply(200, {
        spreadsheetId: LOG_ID,
        sheets: [
          { properties: { sheetId: 101, title: 'Submittal Arch' } },
          { properties: { sheetId: 102, title: 'Submittal FF&E' } },
          { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
          { properties: { sheetId: 104, title: '_Config Submittal FF&E' } },
        ],
        namedRanges: [
          {
            namedRangeId: 'nr-arch-statuses',
            name: 'Options_Submittal_Arch_Statuses',
            range: { sheetId: 103, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 1 },
          },
          {
            namedRangeId: 'nr-arch-actions',
            name: 'Options_Submittal_Arch_Actions',
            range: { sheetId: 103, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 2, endColumnIndex: 6 },
          },
          {
            namedRangeId: 'nr-arch-contacts',
            name: 'Options_Submittal_Arch_Contacts',
            range: { sheetId: 103, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 7, endColumnIndex: 11 },
          },
          {
            namedRangeId: 'nr-ffe-statuses',
            name: 'Options_Submittal_FFE_Statuses',
            range: { sheetId: 104, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 0, endColumnIndex: 1 },
          },
          {
            namedRangeId: 'nr-ffe-actions',
            name: 'Options_Submittal_FFE_Actions',
            range: { sheetId: 104, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 2, endColumnIndex: 6 },
          },
          {
            namedRangeId: 'nr-ffe-contacts',
            name: 'Options_Submittal_FFE_Contacts',
            range: { sheetId: 104, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 7, endColumnIndex: 11 },
          },
          {
            namedRangeId: 'nr-ffe-vendors',
            name: 'Options_Submittal_FFE_Vendors',
            range: { sheetId: 104, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 11, endColumnIndex: 15 },
          },
          {
            namedRangeId: 'nr-ffe-specs',
            name: 'Options_Submittal_FFE_Specs',
            range: { sheetId: 104, startRowIndex: 2, endRowIndex: 5, startColumnIndex: 15, endColumnIndex: 18 },
          },
        ],
      });

    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${LOG_ID}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
      .reply(200, (uri) => {
        const requestedRanges = new URL(uri, 'https://sheets.googleapis.com').searchParams.getAll('ranges');
        return {
          spreadsheetId: LOG_ID,
          valueRanges: requestedRanges.map((range) => {
            if (range.includes('A3:A5')) {
              return { range, values: [['Status'], ['Open'], ['---']] };
            }
            if (range.includes('C3:F5')) {
              return {
                range,
                values: [
                  ['Key', 'Name', 'Suffix', 'Order'],
                  ['REC', 'Received', '', '1'],
                  ['---', '', '', ''],
                ],
              };
            }
            if (range.includes('H3:K5')) {
              return {
                range,
                values: [
                  ['Type', 'Key', 'Name', 'Aliases'],
                  ['', 'CUST', 'Custom Studio', '"Custom ""Studio"", Inc.", @custom-studio.com'],
                  ['', '---', '', ''],
                ],
              };
            }
            if (range.includes('L3:O5')) {
              return {
                range,
                values: [
                  ['Type', 'Key', 'Name', 'Aliases'],
                  ['', 'CUSTV', 'Custom Millwork Corp', '"Custom ""Design"", LLC", Custom Design'],
                  ['', '---', '', ''],
                ],
              };
            }
            if (range.includes('P3:R5')) {
              return {
                range,
                values: [
                  ['Tag', 'Title', 'Aliases'],
                  ['CG104', 'BED - KING', 'XY999, CG-104X'],
                  ['---', '', ''],
                ],
              };
            }
            return { range, values: [] };
          }),
        };
      });
  }

  it('resolves _Config Aliases CSV entries across unmodified submittal-arch (contacts) and submittal-ffe (contacts, vendors, specs) in SourceParser Pass 2', async () => {
    vi.spyOn(gmailClient, 'getThread').mockResolvedValue({
      id: 'th-prod-aliases',
      messages: [
        {
          id: 'msg-prod-aliases',
          threadId: 'th-prod-aliases',
          subject: '071200-001 Waterproofing / XY999-A Submittal',
          from: 'Custom Studio <designer@custom-studio.com>',
          to: 'Designer <designer@inc.nyc>',
          date: 'Tue, 17 Nov 2026 10:00:00 -0500',
          labels: ['INBOX', SPACE_NAME],
          plainTextBody: 'Please review.',
          inlineImages: [],
          attachments: [
            {
              partId: 'part-1',
              attachmentId: 'att-1',
              filename: 'XY999-A_Custom_Design_CutSheet.pdf',
              mimeType: 'application/pdf',
              size: 1024,
            },
          ],
        },
      ],
    });

    // 1. Submittal Arch via unmodified production schema: resolves contact via _Config Aliases (@custom-studio.com -> CUST)
    mockDriveSpacesAndLogDiscovery();
    mockProductionSheetsTables();

    const archRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-prod-aliases',
          threadId: 'th-prod-aliases',
          accessToken: 'ya29.token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onDocumentTypeChange',
            previousSpaceId: DRIVE_ID,
            previousMessageId: 'msg-prod-aliases',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-prod-aliases'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-1'] } },
          },
        },
      },
    });

    expect(archRes.statusCode).toBe(200);
    const archCard = getCard(archRes.payload, 'updateCard');
    const archDocData = findSection(archCard, 'Document Data');
    expect(findTextInputValue(archDocData, 'contact', 'submittal-arch')).toBe('CUST');
    expect(nock.isDone()).toBe(true);

    // 2. Submittal FF&E via unmodified production schema: resolves contact, vendor, and specs via _Config Aliases
    mockDriveSpacesAndLogDiscovery();
    mockProductionSheetsTables();

    const ffeRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-prod-aliases',
          threadId: 'th-prod-aliases',
          accessToken: 'ya29.token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onDocumentTypeChange',
            previousSpaceId: DRIVE_ID,
            previousMessageId: 'msg-prod-aliases',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-prod-aliases'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-1'] } },
          },
        },
      },
    });

    expect(ffeRes.statusCode).toBe(200);
    const ffeCard = getCard(ffeRes.payload, 'updateCard');
    const ffeDocData = findSection(ffeCard, 'Document Data');
    expect(findTextInputValue(ffeDocData, 'contact', 'submittal-ffe')).toBe('CUST');
    expect(findTextInputValue(ffeDocData, 'vendor', 'submittal-ffe')).toBe('CUSTV');
    expect(findTextInputValue(ffeDocData, 'specTag', 'submittal-ffe')).toBe('CG104');
    expect(findDecoratedTextValue(ffeDocData, 'Spec Title')).toBe('BED - KING');
    expect(nock.isDone()).toBe(true);
  });
});

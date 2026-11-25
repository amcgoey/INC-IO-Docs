import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { GoogleSheetsClient, type GoogleSheetsClientOptions } from '../src/infrastructure/sheets';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceCard,
  GoogleWorkspaceSection,
  GoogleWorkspaceSelectionInput,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { SELECT_DOCUMENT_LOG_KEY } from '../src/features/schema-driven-ui/blocks/document-log';

const DRIVE_ID = 'drive-358-arch';
const SPACE_NAME = 'Civic Library';
const FILE_ID = 'file-arch-358';
const FILE_NAME = '071200-001-0_Waterproofing.pdf';
const MANIFEST_PATH = path.resolve(__dirname, '../assets/manifest.json');

function createAuthVerifier(): WorkspaceAuthVerifierPort {
  return {
    verifyToken: vi.fn().mockImplementation(async (header?: string) => {
      if (header?.startsWith('Bearer valid-')) {
        return { isValid: true, payload: { email: 'pm@inc.nyc', sub: 'user-358' } };
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

function findSelectionInput(
  section: GoogleWorkspaceSection | undefined,
  fieldKey: string
): GoogleWorkspaceSelectionInput | undefined {
  const widgetName = getDocumentInfoWidgetName(fieldKey, 'submittal-arch');
  return section?.widgets.find((w) => w.selectionInput?.name === widgetName)?.selectionInput;
}

function findCardText(card: GoogleWorkspaceCard, needle: string): string | undefined {
  for (const section of card.sections) {
    for (const widget of section.widgets) {
      if (typeof widget.textParagraph?.text === 'string' && widget.textParagraph.text.includes(needle)) {
        return widget.textParagraph.text;
      }
    }
  }
  return undefined;
}

function mockDriveSelectionAndSpaces(
  logFiles: Array<{ id: string; name: string; parents?: string[] }>,
  options?: { times?: number }
): void {
  const repeat = options?.times ?? 1;
  nock('https://www.googleapis.com')
    .get('/drive/v3/drives')
    .query(true)
    .times(repeat)
    .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === DRIVE_ID)
    .times(repeat)
    .reply(200, {
      files: logFiles.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: f.parents ?? [DRIVE_ID],
        webViewLink: `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
      })),
    });

  if (logFiles.length > 1) {
    // resolvePreferredFolderId ("1 Admin") + parent name resolution for ambiguous candidates
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name = '1 Admin'"))
      .times(repeat)
      .reply(200, { files: [] });
  }
}

function mockSpreadsheetReadsForConfig(
  spreadsheetId: string,
  config: {
    namedRanges?: Array<{
      namedRangeId: string;
      name: string;
      range: { sheetId: number; startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number };
    }>;
    statusesRows?: string[][];
    actionsRows?: string[][];
    contactsRows?: string[][];
    includeHistoryRead?: boolean;
  }
): void {
  const contactsRows = config.contactsRows ?? [
    ['Contact', 'Name', 'Contact Type'],
    ['INC', 'INC Architecture and Design', 'INC'],
    ['PMG', 'Pavarini McGovern', 'Contractor'],
    ['---', '', ''],
  ];
  const defaultNamedRanges = [
    {
      namedRangeId: 'nr-log',
      name: 'Log_Submittal_Arch',
      range: { sheetId: 101, startRowIndex: 2, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: 10 },
    },
    ...(config.statusesRows
      ? [
          {
            namedRangeId: 'nr-statuses',
            name: 'Options_Submittal_Arch_Statuses',
            range: {
              sheetId: 103,
              startRowIndex: 0,
              endRowIndex: config.statusesRows.length,
              startColumnIndex: 0,
              endColumnIndex: 3,
            },
          },
        ]
      : []),
    ...(config.actionsRows
      ? [
          {
            namedRangeId: 'nr-actions',
            name: 'Options_Submittal_Arch_Actions',
            range: {
              sheetId: 103,
              startRowIndex: 0,
              endRowIndex: config.actionsRows.length,
              startColumnIndex: 4,
              endColumnIndex: 10,
            },
          },
        ]
      : []),
    {
      namedRangeId: 'nr-contacts',
      name: 'Options_Submittal_Arch_Contacts',
      range: {
        sheetId: 103,
        startRowIndex: 0,
        endRowIndex: contactsRows.length,
        startColumnIndex: 11,
        endColumnIndex: 14,
      },
    },
  ];

  // When idGroup is blank, only readOptionTables calls GET /v4/spreadsheets/:id (once);
  // when idGroup is present, queryUiContext ALSO reads log history (+1).
  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${spreadsheetId}`)
    .query(true)
    .times(config.includeHistoryRead ? 2 : 1)
    .reply(200, {
      spreadsheetId,
      sheets: [
        { properties: { sheetId: 101, title: 'Submittal Arch' } },
        { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
      ],
      namedRanges: config.namedRanges ?? defaultNamedRanges,
    });

  if (config.includeHistoryRead) {
    nock('https://sheets.googleapis.com')
      .get(new RegExp(`/v4/spreadsheets/${spreadsheetId}/values/.*`))
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
      .reply(200, {
        values: [
          ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
          ['Formula Row'],
          ['<--->'],
          [],
          ['<--->'],
        ],
      });

    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMULA')
      .reply(200, {
        valueRanges: [{ values: [['Formula Row']] }],
      });
  }

  // Batched option table read (exact single values:batchGet FORMATTED_VALUE)
  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
    .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
    .reply(200, (uri) => {
      const url = new URL(uri, 'https://sheets.googleapis.com');
      const ranges = url.searchParams.getAll('ranges');
      return {
        spreadsheetId,
        valueRanges: ranges.map((r) => ({
          range: r,
          values: r.includes('A1:')
            ? (config.statusesRows ?? [])
            : r.includes('E1:')
              ? (config.actionsRows ?? [])
              : contactsRows,
        })),
      };
    });
}

describe('Ticket #358 Workspace Addon E2E: Submittal Arch live _Config option tables', () => {
  let app: AppInstance;

  beforeEach(async () => {
    app = createApp({
      manifestProvider: new AppManifestProvider({ manifestPath: MANIFEST_PATH }),
      authVerifier: createAuthVerifier(),
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

  it('loads order-independent, blank-skipped, case-insensitive deduplicated statuses & actions via 1 batched Sheets read and submits enriched tuple', async () => {
    const logId = 'sheet-358-live';
    const statusesRows = [
      ['Extra Status Note', 'Status', 'Color Tag'],
      ['', '   ', ''],
      ['First active state', 'Open', 'green'],
      ['Duplicate lowercase ignored', ' open ', 'red'],
      ['', 'Closed', 'gray'],
      ['', '---', ''],
      ['Ignored after terminator', 'PostEndStatus', 'blue'],
    ];
    const actionsRows = [
      ['Name', 'Extra Hint', 'Order', 'Action', 'Suffix'],
      ['', '', '', '', ''],
      ['Received', 'Initial receipt', '1', 'REC', ''],
      ['Duplicate Rec Ignored', 'Dup row', '9', ' rec ', '_DUP'],
      ['No Objections As Corrected', 'Reviewed', '6', 'NOC', '_NOC'],
      ['', '---', '', '---', ''],
      ['Ignored Post End', '', '99', 'POST', '_POST'],
    ];

    const contactsRows = [
      ['Contact Type', 'Name', 'Contact'],
      ['', '', ''],
      ['INC', 'INC Architecture and Design', 'INC'],
      ['Contractor', 'Pavarini McGovern', 'PMG'],
      ['Contractor Dup Ignored', 'Pavarini Dup', ' pmg '],
      ['---', '', '---'],
      ['Post End', 'Ignored Contact', 'POST'],
    ];

    mockDriveSelectionAndSpaces([{ id: logId, name: `${SPACE_NAME} Document Log` }]);
    mockSpreadsheetReadsForConfig(logId, { statusesRows, actionsRows, contactsRows });

    const renderRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: { selectedItems: [{ id: FILE_ID, title: FILE_NAME }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: [FILE_ID] } },
          },
        },
      },
    });

    expect(renderRes.statusCode).toBe(200);
    const card = getCard(renderRes.payload, 'updateCard');
    const docData = findSection(card, 'Document Data');

    const statusItems = findSelectionInput(docData, 'status')?.items.map((i) => ({
      text: i.text,
      value: i.value,
    }));
    expect(statusItems).toEqual([
      { text: 'Open', value: 'Open' },
      { text: 'Closed', value: 'Closed' },
    ]);

    const actionItems = findSelectionInput(docData, 'action')?.items.map((i) => ({
      text: i.text,
      value: i.value,
    }));
    expect(actionItems).toEqual([
      { text: 'Received', value: 'REC' },
      { text: 'No Objections As Corrected', value: 'NOC' },
    ]);

    // Live _Config contacts remain populated alongside live _Config dropdowns (GoogleWorkspaceTextInput.initialSuggestions)
    const contactInput = docData?.widgets.find(
      (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch')
    )?.textInput;
    expect(
      contactInput?.initialSuggestions?.items.some((i) => i.text === 'Pavarini McGovern')
    ).toBe(true);
    expect(nock.isDone()).toBe(true);

    // Submit with selected action NOC and verify MOVE_FILE + WRITE_LOG succeed using live _Config
    mockDriveSelectionAndSpaces([{ id: logId, name: `${SPACE_NAME} Document Log` }]);
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name = '6 Construction'"))
      .reply(200, { files: [{ id: 'folder-6c', name: '6 Construction', parents: [DRIVE_ID] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name = 'Submittals'"))
      .reply(200, { files: [{ id: 'folder-subs', name: 'Submittals', parents: ['folder-6c'] }] });
    nock('https://www.googleapis.com')
      .get(`/drive/v3/files/${FILE_ID}`)
      .query(true)
      .reply(200, {
        id: FILE_ID,
        name: FILE_NAME,
        mimeType: 'application/pdf',
        parents: ['unfiled-folder'],
      });
    nock('https://www.googleapis.com')
      .patch(`/drive/v3/files/${FILE_ID}`)
      .query(true)
      .reply(200, {
        id: FILE_ID,
        name: '071200-001-0 Waterproofing & Drainage - 261120 PMG_NOC.pdf',
        webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
      });

    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${logId}`)
      .query(true)
      .times(2)
      .reply(200, {
        spreadsheetId: logId,
        sheets: [
          { properties: { sheetId: 101, title: 'Submittal Arch' } },
          { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
        ],
        namedRanges: [
          {
            namedRangeId: 'nr-log',
            name: 'Log_Submittal_Arch',
            range: { sheetId: 101, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 10 },
          },
          {
            namedRangeId: 'nr-statuses',
            name: 'Options_Submittal_Arch_Statuses',
            range: { sheetId: 103, startRowIndex: 0, endRowIndex: statusesRows.length, startColumnIndex: 0, endColumnIndex: 3 },
          },
          {
            namedRangeId: 'nr-actions',
            name: 'Options_Submittal_Arch_Actions',
            range: { sheetId: 103, startRowIndex: 0, endRowIndex: actionsRows.length, startColumnIndex: 4, endColumnIndex: 10 },
          },
          {
            namedRangeId: 'nr-contacts',
            name: 'Options_Submittal_Arch_Contacts',
            range: { sheetId: 103, startRowIndex: 0, endRowIndex: contactsRows.length, startColumnIndex: 11, endColumnIndex: 14 },
          },
        ],
      });
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${logId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
      .reply(200, (uri) => {
        const url = new URL(uri, 'https://sheets.googleapis.com');
        const ranges = url.searchParams.getAll('ranges');
        return {
          spreadsheetId: logId,
          valueRanges: ranges.map((r) => ({
            range: r,
            values: r.includes('A1:')
              ? statusesRows
              : r.includes('E1:')
                ? actionsRows
                : contactsRows,
          })),
        };
      });
    nock('https://sheets.googleapis.com')
      .get(new RegExp(`/v4/spreadsheets/${logId}/values/.*`))
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
      .reply(200, {
        values: [
          ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
          ['Formula Row'],
          ['<--->'],
          [],
          ['<--->'],
        ],
      });
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${logId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMULA')
      .reply(200, { valueRanges: [{ values: [['Formula Row']] }] });
    nock('https://sheets.googleapis.com')
      .post(`/v4/spreadsheets/${logId}:batchUpdate`)
      .reply(200, {});

    const submitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: { selectedItems: [{ id: FILE_ID, title: FILE_NAME }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: [FILE_ID] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing & Drainage'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261120'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['NOC'] } },
            [getDocumentInfoWidgetName('notes', 'submittal-arch')]: { stringInputs: { value: ['Use / confirm raw "notes"'] } },
          },
        },
      },
    });

    expect(submitRes.statusCode).toBe(200);
    const submitBody = JSON.parse(submitRes.payload) as GoogleWorkspaceActionResponse;
    expect(submitBody.action?.notification?.text).toBe('Document processed successfully');
    expect(nock.isDone()).toBe(true);
  });

  it('resolves options from candidates[0] on ambiguous space when SelectDocumentLog is omitted or stale', async () => {
    const candidate0 = 'log-ambig-cand-0';
    const candidate1 = 'log-ambig-cand-1';

    mockDriveSelectionAndSpaces([
      { id: candidate0, name: `${SPACE_NAME} Document Log` },
      { id: candidate1, name: `${SPACE_NAME} Document Log Copy` },
    ]);
    mockSpreadsheetReadsForConfig(candidate0, {
      statusesRows: [['Status'], ['Cand0Status'], ['---']],
      actionsRows: [['Action', 'Name', 'Suffix', 'Order'], ['REC', 'Candidate Zero Action', '', '1'], ['---', '', '', '']],
    });

    // Stale SelectDocumentLog ID should cleanly fall back to candidates[0]
    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: { selectedItems: [{ id: FILE_ID, title: FILE_NAME }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: [FILE_ID] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: ['stale-nonexistent-log-id'] } },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const card = getCard(res.payload, 'updateCard');
    const docData = findSection(card, 'Document Data');

    expect(findSelectionInput(docData, 'status')?.items.map((i) => i.value)).toEqual(['Cand0Status']);
    expect(findSelectionInput(docData, 'action')?.items).toEqual([
      { text: 'Candidate Zero Action', value: 'REC', selected: true },
    ]);
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('shows Copy Log prompt on missing DocumentLog and per-source config_error while keeping healthy sibling dropdowns active', async () => {
    // 1. Missing DocumentLog -> Copy Document Log prompt on status and action
    mockDriveSelectionAndSpaces([]);

    const missingRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: { selectedItems: [{ id: FILE_ID, title: FILE_NAME }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: [FILE_ID] } },
          },
        },
      },
    });

    expect(missingRes.statusCode).toBe(200);
    const missingCard = getCard(missingRes.payload, 'updateCard');
    const missingDocData = findSection(missingCard, 'Document Data');

    expect(findSelectionInput(missingDocData, 'status')?.items).toEqual([
      { text: 'Copy Document Log to load options', value: '', selected: false },
    ]);
    expect(findSelectionInput(missingDocData, 'action')?.items).toEqual([
      { text: 'Copy Document Log to load options', value: '', selected: false },
    ]);
    expect(findCardText(missingCard, 'Click Copy Log to create one')).toBeDefined();
    expect(nock.isDone()).toBe(true);

    // 2. Per-source config_error: statuses healthy, actions missing "---" terminator
    const badConfigLogId = 'sheet-358-bad-config';
    mockDriveSelectionAndSpaces([{ id: badConfigLogId, name: `${SPACE_NAME} Document Log` }]);
    mockSpreadsheetReadsForConfig(badConfigLogId, {
      statusesRows: [['Status'], ['Open'], ['---']],
      actionsRows: [['Action', 'Name', 'Suffix', 'Order'], ['REC', 'Received', '', '1']], // missing "---"
    });

    const cfgErrRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: { selectedItems: [{ id: FILE_ID, title: FILE_NAME }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: [FILE_ID] } },
          },
        },
      },
    });

    expect(cfgErrRes.statusCode).toBe(200);
    const cfgErrCard = getCard(cfgErrRes.payload, 'updateCard');
    const cfgErrDocData = findSection(cfgErrCard, 'Document Data');

    expect(findSelectionInput(cfgErrDocData, 'status')?.items.map((i) => i.value)).toEqual(['Open']);
    const actionPlaceholder = findSelectionInput(cfgErrDocData, 'action')?.items[0]?.text ?? '';
    expect(actionPlaceholder).toContain('actions');
    expect(actionPlaceholder).toContain('---');
    expect(actionPlaceholder.toLowerCase()).not.toContain('folder "root"');
    expect(nock.isDone()).toBe(true);
  });

  it('surfaces timeout hint on Workspace Addon dropdown when document_log option table read times out', async () => {
    const delayedApp = createApp({
      manifestProvider: new AppManifestProvider({ manifestPath: MANIFEST_PATH }),
      authVerifier: createAuthVerifier(),
      skipSpaceValidation: true,
      lookupTimeoutMs: 30,
      sheetsClient: new GoogleSheetsClient({
        sheets: {
          spreadsheets: {
            get: vi.fn().mockImplementation(async () => {
              await new Promise((resolve) => setTimeout(resolve, 120));
              return { data: { spreadsheetId: 'slow-sheet', sheets: [], namedRanges: [] } };
            }),
            batchUpdate: vi.fn(),
            values: { get: vi.fn().mockResolvedValue({ data: { values: [] } }), batchGet: vi.fn(), update: vi.fn() },
          },
        } as unknown as NonNullable<GoogleSheetsClientOptions['sheets']>,
        configProvider: new AppManifestProvider({ manifestPath: MANIFEST_PATH }),
      }),
    });
    await delayedApp.initialize();

    mockDriveSelectionAndSpaces([{ id: 'slow-sheet', name: `${SPACE_NAME} Document Log` }]);

    const timeoutRes = await delayedApp.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: { selectedItems: [{ id: FILE_ID, title: FILE_NAME }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: [FILE_ID] } },
          },
        },
      },
    });

    expect(timeoutRes.statusCode).toBe(200);
    const card = getCard(timeoutRes.payload, 'updateCard');
    const docData = findSection(card, 'Document Data');

    const statusText = findSelectionInput(docData, 'status')?.items[0]?.text ?? '';
    expect(statusText).toContain('statuses');
    expect(statusText.toLowerCase()).toContain('timed out');
    expect(statusText.toLowerCase()).not.toContain('folder "root"');
    // Contacts also read from _Config document_log, so timeout surfaces on contact hintText too
    const contactInput = docData?.widgets.find(
      (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch')
    )?.textInput;
    expect(contactInput?.hintText ?? '').toContain('contacts');
    expect((contactInput?.hintText ?? '').toLowerCase()).toContain('timed out');
    expect(contactInput?.initialSuggestions?.items ?? []).toHaveLength(0);
  });
});

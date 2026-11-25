import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { GoogleSheetsClient, type GoogleSheetsClientOptions } from '../src/infrastructure/sheets';
import type { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
import type { GmailThreadDetails } from '../src/infrastructure/gmail/types';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceButton,
  GoogleWorkspaceCard,
  GoogleWorkspaceDecoratedText,
  GoogleWorkspaceSection,
  GoogleWorkspaceSelectionInput,
  GoogleWorkspaceTextInput,
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
    includeHistoryRead?: boolean;
    historyRows?: Array<{ cells: string[]; linkFormula?: string }>;
  }
): void {
  const historyRows = config.historyRows ?? [];
  const defaultNamedRanges = [
    {
      namedRangeId: 'nr-log',
      name: 'Log_Submittal_Arch',
      range: {
        sheetId: 101,
        startRowIndex: 2,
        endRowIndex: 8 + historyRows.length,
        startColumnIndex: 0,
        endColumnIndex: 10,
      },
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
          ...(historyRows.length > 0 ? historyRows.map((r) => r.cells) : [[]]),
          ['<--->'],
        ],
      });

    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMULA')
      .reply(200, {
        valueRanges: [
          { values: [['Formula Row']] },
          ...(historyRows.length > 0
            ? [
                {
                  values: historyRows.map((r) => (r.linkFormula ? [r.linkFormula] : [])),
                },
              ]
            : []),
        ],
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
          values: r.includes('A1:') ? (config.statusesRows ?? []) : (config.actionsRows ?? []),
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

    mockDriveSelectionAndSpaces([{ id: logId, name: `${SPACE_NAME} Document Log` }]);
    mockSpreadsheetReadsForConfig(logId, { statusesRows, actionsRows });

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

    // Static contacts remain populated alongside live _Config dropdowns (GoogleWorkspaceTextInput.initialSuggestions)
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
        ],
      });
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${logId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
      .reply(200, {
        spreadsheetId: logId,
        valueRanges: [{ values: statusesRows }, { values: actionsRows }],
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
    // Static contacts still load despite document_log timeout
    const contactInput = docData?.widgets.find(
      (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch')
    )?.textInput;
    expect((contactInput?.initialSuggestions?.items ?? []).length).toBeGreaterThan(0);
  });
});

const TEMPLATE_SPREADSHEET_ID_359 = '1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I';

function findButtonInCard(card: GoogleWorkspaceCard, label: string): GoogleWorkspaceButton | undefined {
  for (const section of card.sections) {
    for (const widget of section.widgets) {
      const btn = widget.buttonList?.buttons.find((b) => b.text === label);
      if (btn) {
        return btn;
      }
    }
  }
  return undefined;
}

function findDocInfoTextInput(
  section: GoogleWorkspaceSection | undefined,
  fieldKey: string
): GoogleWorkspaceTextInput | undefined {
  const widgetName = getDocumentInfoWidgetName(fieldKey, 'submittal-arch');
  return section?.widgets.find((w) => w.textInput?.name === widgetName)?.textInput;
}

function getDecoratedOpenUrl(decorated?: GoogleWorkspaceDecoratedText): string | undefined {
  if (!decorated?.button?.onClick || !('openLink' in decorated.button.onClick)) {
    return undefined;
  }
  return decorated.button.onClick.openLink.url;
}

describe('Ticket #359 Workspace Addon Seam: Copy Log Invalidation & SelectDocumentLog Live Reload', () => {
  let app: AppInstance;
  let mockGmailClient: Partial<GoogleGmailClient>;

  beforeEach(async () => {
    nock.disableNetConnect();
    mockGmailClient = {
      getThread: vi.fn().mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => ({
        id: threadId,
        messages: [
          {
            id: 'msg-359',
            threadId,
            subject: 'Submittal 071200-001 Waterproofing',
            from: 'James McGovern <jmcgovern@pavarini.com>',
            to: 'PM <pm@inc.nyc>',
            date: 'Wed, 25 Nov 2026 14:00:00 -0500',
            labels: ['INBOX', SPACE_NAME],
            plainTextBody: 'Please review submittal.',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-359-1',
                attachmentId: 'att-359-1',
                filename: FILE_NAME,
                mimeType: 'application/pdf',
                size: 1024,
              },
            ],
          },
        ],
      })),
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-359',
        messageId: 'msg-359',
        inlineImages: [],
        attachments: [
          {
            partId: 'part-359-1',
            attachmentId: 'att-359-1',
            filename: FILE_NAME,
            mimeType: 'application/pdf',
            size: 1024,
          },
        ],
      }),
      getAttachment: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    };

    app = createApp({
      manifestProvider: new AppManifestProvider({ manifestPath: MANIFEST_PATH }),
      authVerifier: createAuthVerifier(),
      skipSpaceValidation: true,
      gmailClient: mockGmailClient as GoogleGmailClient,
    });
    await app.initialize();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  function buildHostPayload(params: {
    host: 'DRIVE' | 'GMAIL';
    action: string;
    token: string;
    extraFormInputs?: Record<string, { stringInputs: { value: string[] } }> | undefined;
    extraParameters?: Record<string, string> | undefined;
  }): Record<string, unknown> {
    const baseFormInputs: Record<string, { stringInputs: { value: string[] } }> = {
      SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
      [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
      [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
      ...(params.host === 'DRIVE'
        ? { SelectFiles: { stringInputs: { value: [FILE_ID] } } }
        : {
            SelectEmailMessage: { stringInputs: { value: ['msg-359'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-359-1'] } },
          }),
      ...(params.extraFormInputs ?? {}),
    };

    if (params.host === 'DRIVE') {
      return {
        authorizationEventObject: { userOAuthToken: params.token },
        drive: { selectedItems: [{ id: FILE_ID, title: FILE_NAME }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: {
            action: params.action,
            previousSpaceId: DRIVE_ID,
            ...(params.extraParameters ?? {}),
          },
          formInputs: baseFormInputs,
        },
      };
    }

    return {
      hostApp: 'GMAIL',
      gmail: {
        messageId: 'msg-359',
        threadId: 'th-359',
        accessToken: params.token,
      },
      commonEventObject: {
        hostApp: 'GMAIL',
        parameters: {
          action: params.action,
          previousSpaceId: DRIVE_ID,
          previousMessageId: 'msg-359',
          ...(params.extraParameters ?? {}),
        },
        formInputs: baseFormInputs,
      },
    };
  }

  it.each(['DRIVE', 'GMAIL'] as const)(
    'invalidates per-request LookupOptions on copyDocumentLog in missing DocumentSpace and immediately loads live _Config dropdowns (%s)',
    async (host) => {
      const oauthCredential = host === 'DRIVE' ? 'ya29.drive-copy-359' : 'ya29.gmail-copy-359';
      const createdFolderId = 'folder-1-admin-359';
      const createdSheetId = 'sheet-created-359';
      const createdSheetName = `${SPACE_NAME} Document Log`;
      const createdWebViewLink = `https://docs.google.com/spreadsheets/d/${createdSheetId}/edit`;

      const typedInputs = {
        [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
        [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
        [getDocumentInfoWidgetName('title', 'submittal-arch')]: {
          stringInputs: { value: ['Waterproofing & Drainage'] },
        },
        [getDocumentInfoWidgetName('notes', 'submittal-arch')]: {
          stringInputs: { value: ['Preserved notes across Copy Log'] },
        },
      };

      // 1. Initial render in missing state
      mockDriveSelectionAndSpaces([]);
      const missingRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt' },
        payload: buildHostPayload({
          host,
          action: 'onFormChange',
          token: oauthCredential,
          extraFormInputs: typedInputs,
        }),
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
      expect(findButtonInCard(missingCard, 'Copy Log')).toBeDefined();
      expect(findButtonInCard(missingCard, 'Process Document')?.disabled).toBe(true);
      expect(nock.isDone()).toBe(true);

      // 2. Click Copy Log -> creates "1 Admin", copies template, invalidates cache, and populates live _Config dropdowns
      nock('https://www.googleapis.com', { reqheaders: { authorization: `Bearer ${oauthCredential}` } })
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
      nock('https://www.googleapis.com', { reqheaders: { authorization: `Bearer ${oauthCredential}` } })
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === DRIVE_ID)
        .reply(200, { files: [] });
      nock('https://www.googleapis.com', { reqheaders: { authorization: `Bearer ${oauthCredential}` } })
        .get('/drive/v3/files')
        .query(
          (q) =>
            typeof q.q === 'string' &&
            q.q.includes(`'${DRIVE_ID}' in parents`) &&
            q.q.includes("name = '1 Admin'") &&
            q.supportsAllDrives === 'true'
        )
        .reply(200, { files: [] });
      nock('https://www.googleapis.com', { reqheaders: { authorization: `Bearer ${oauthCredential}` } })
        .post('/drive/v3/files', (body: Record<string, unknown>) => {
          return (
            body.name === '1 Admin' &&
            body.mimeType === 'application/vnd.google-apps.folder' &&
            Array.isArray(body.parents) &&
            body.parents[0] === DRIVE_ID
          );
        })
        .query((q) => q.supportsAllDrives === 'true')
        .reply(200, {
          id: createdFolderId,
          name: '1 Admin',
          parents: [DRIVE_ID],
          mimeType: 'application/vnd.google-apps.folder',
        });
      nock('https://www.googleapis.com', { reqheaders: { authorization: `Bearer ${oauthCredential}` } })
        .post(`/drive/v3/files/${TEMPLATE_SPREADSHEET_ID_359}/copy`, (body: Record<string, unknown>) => {
          return (
            body.name === createdSheetName &&
            Array.isArray(body.parents) &&
            body.parents[0] === createdFolderId
          );
        })
        .query((q) => q.supportsAllDrives === 'true')
        .reply(200, {
          id: createdSheetId,
          name: createdSheetName,
          parents: [createdFolderId],
          mimeType: 'application/vnd.google-apps.spreadsheet',
          webViewLink: createdWebViewLink,
        });
      // Post-copy re-render resolves the newly copied spreadsheet
      nock('https://www.googleapis.com', { reqheaders: { authorization: `Bearer ${oauthCredential}` } })
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === DRIVE_ID)
        .reply(200, {
          files: [
            {
              id: createdSheetId,
              name: createdSheetName,
              parents: [createdFolderId],
              mimeType: 'application/vnd.google-apps.spreadsheet',
              webViewLink: createdWebViewLink,
            },
          ],
        });

      mockSpreadsheetReadsForConfig(createdSheetId, {
        statusesRows: [['Status'], ['Open'], ['In Review'], ['---']],
        actionsRows: [
          ['Action', 'Name', 'Suffix', 'Order'],
          ['REC', 'Received', '', '1'],
          ['NOC', 'No Objections As Corrected', '_NOC', '6'],
          ['---', '', '', ''],
        ],
        includeHistoryRead: true,
      });

      const copyRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt' },
        payload: buildHostPayload({
          host,
          action: 'copyDocumentLog',
          token: oauthCredential,
          extraFormInputs: typedInputs,
          extraParameters:
            host === 'GMAIL'
              ? {
                  previousAttachments: JSON.stringify(['part-359-1']),
                  previousDriveUrl: '',
                }
              : undefined,
        }),
      });

      expect(copyRes.statusCode).toBe(200);
      const updatedCard = getCard(copyRes.payload, 'updateCard');
      const updatedDocData = findSection(updatedCard, 'Document Data');

      expect(
        findSelectionInput(updatedDocData, 'status')?.items.map((i) => ({ text: i.text, value: i.value }))
      ).toEqual([
        { text: 'Open', value: 'Open' },
        { text: 'In Review', value: 'In Review' },
      ]);
      expect(
        findSelectionInput(updatedDocData, 'action')?.items.map((i) => ({ text: i.text, value: i.value }))
      ).toEqual([
        { text: 'Received', value: 'REC' },
        { text: 'No Objections As Corrected', value: 'NOC' },
      ]);

      expect(findCardText(updatedCard, 'Copy Document Log to load options')).toBeUndefined();
      expect(findCardText(updatedCard, 'Click Copy Log to create one')).toBeUndefined();
      expect(findButtonInCard(updatedCard, 'Copy Log')).toBeUndefined();
      expect(findButtonInCard(updatedCard, 'Process Document')?.disabled).not.toBe(true);

      expect(findDocInfoTextInput(updatedDocData, 'section')?.value).toBe('071200');
      expect(findDocInfoTextInput(updatedDocData, 'number')?.value).toBe('001');
      expect(findDocInfoTextInput(updatedDocData, 'title')?.value).toBe('Waterproofing & Drainage');
      expect(findDocInfoTextInput(updatedDocData, 'notes')?.value).toBe('Preserved notes across Copy Log');
      expect(nock.isDone()).toBe(true);
    }
  );

  it.each(['DRIVE', 'GMAIL'] as const)(
    'reloads _Config dropdowns and history hydration (flagging partial read against new _Config) while preserving all user inputs when switching SelectDocumentLog (%s)',
    async (host) => {
      const oauthCredential = host === 'DRIVE' ? 'ya29.drive-switch-359' : 'ya29.gmail-switch-359';
      const candidates = [
        { id: 'log-1', name: `${SPACE_NAME} Document Log` },
        { id: 'log-2', name: `${SPACE_NAME} Document Log Archive` },
      ];
      const userInputs = {
        [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
        [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
        [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['1'] } },
        [getDocumentInfoWidgetName('title', 'submittal-arch')]: {
          stringInputs: { value: ['User Custom Title'] },
        },
        [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261125'] } },
        [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
        [getDocumentInfoWidgetName('notes', 'submittal-arch')]: {
          stringInputs: { value: ['Preserved notes across switch'] },
        },
      };

      // 1. Initial load on log-1: options & history load cleanly with zero partial read warnings
      mockDriveSelectionAndSpaces(candidates);
      mockSpreadsheetReadsForConfig('log-1', {
        statusesRows: [['Status'], ['Open'], ['Closed'], ['---']],
        actionsRows: [
          ['Action', 'Name', 'Suffix', 'Order'],
          ['REC', 'Received', '', '1'],
          ['---', '', '', ''],
        ],
        includeHistoryRead: true,
        historyRows: [
          {
            cells: ['Open', '071200', '001', '0', 'Log 1 Prior Entry', '261120', 'PMG', 'Received', '', 'Link'],
            linkFormula: '=HYPERLINK("https://drive.google.com/file/d/log1-entry/view", "Link")',
          },
        ],
      });

      const log1Res = await app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt' },
        payload: buildHostPayload({
          host,
          action: 'onFormChange',
          token: oauthCredential,
          extraFormInputs: userInputs,
        }),
      });

      expect(log1Res.statusCode).toBe(200);
      const log1Card = getCard(log1Res.payload, 'updateCard');
      const log1DocData = findSection(log1Card, 'Document Data');
      expect(
        findSelectionInput(log1DocData, 'status')?.items.map((i) => ({ text: i.text, value: i.value }))
      ).toEqual([
        { text: 'Open', value: 'Open' },
        { text: 'Closed', value: 'Closed' },
      ]);
      expect(
        findSelectionInput(log1DocData, 'action')?.items.map((i) => ({ text: i.text, value: i.value }))
      ).toEqual([{ text: 'Received', value: 'REC' }]);
      expect(findCardText(log1Card, 'Partial read')).toBeUndefined();
      const log1Section = findSection(log1Card, 'Document Log');
      expect(getDecoratedOpenUrl(log1Section?.widgets[1].decoratedText)).toBe(
        'https://docs.google.com/spreadsheets/d/log-1/edit'
      );
      expect(log1Section?.widgets[2].decoratedText?.bottomLabel).toBe('Log 1 Prior Entry');
      expect(nock.isDone()).toBe(true);

      // 2. Switch SelectDocumentLog -> log-2: reloads log-2 _Config, flags Open as invalid in log-2 (1 warning), preserves all user inputs
      mockDriveSelectionAndSpaces(candidates);
      mockSpreadsheetReadsForConfig('log-2', {
        statusesRows: [['Status'], ['Draft'], ['Issued'], ['---']],
        actionsRows: [
          ['Action', 'Name', 'Suffix', 'Order'],
          ['NOC', 'No Objections As Corrected', '_NOC', '6'],
          ['---', '', '', ''],
        ],
        includeHistoryRead: true,
        historyRows: [
          {
            cells: [
              'Open',
              '071200',
              '001',
              '0',
              'Log 2 Prior Entry',
              '261121',
              'FXC',
              'No Objections As Corrected',
              '',
              'Link',
            ],
            linkFormula: '=HYPERLINK("https://drive.google.com/file/d/log2-entry/view", "Link")',
          },
        ],
      });

      const log2Res = await app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt' },
        payload: buildHostPayload({
          host,
          action: 'onFormChange',
          token: oauthCredential,
          extraParameters: { previousSelectedLogId: 'log-1' },
          extraFormInputs: {
            ...userInputs,
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: ['log-2'] } },
          },
        }),
      });

      expect(log2Res.statusCode).toBe(200);
      const log2Card = getCard(log2Res.payload, 'updateCard');
      const log2DocData = findSection(log2Card, 'Document Data');

      expect(
        findSelectionInput(log2DocData, 'status')?.items.map((i) => ({ text: i.text, value: i.value }))
      ).toEqual([
        { text: 'Draft', value: 'Draft' },
        { text: 'Issued', value: 'Issued' },
      ]);
      expect(
        findSelectionInput(log2DocData, 'action')?.items.map((i) => ({ text: i.text, value: i.value }))
      ).toEqual([{ text: 'No Objections As Corrected', value: 'NOC' }]);

      const log2Section = findSection(log2Card, 'Document Log');
      expect(getDecoratedOpenUrl(log2Section?.widgets[1].decoratedText)).toBe(
        'https://docs.google.com/spreadsheets/d/log-2/edit'
      );
      expect(findCardText(log2Card, 'Partial read (1 warning)')).toBeDefined();
      expect(log2Section?.widgets[3].decoratedText?.bottomLabel).toBe('Log 2 Prior Entry');

      expect(findDocInfoTextInput(log2DocData, 'section')?.value).toBe('071200');
      expect(findDocInfoTextInput(log2DocData, 'number')?.value).toBe('001');
      expect(findDocInfoTextInput(log2DocData, 'revision')?.value).toBe('1');
      expect(findDocInfoTextInput(log2DocData, 'title')?.value).toBe('User Custom Title');
      expect(findDocInfoTextInput(log2DocData, 'date')?.value).toBe('261125');
      expect(findDocInfoTextInput(log2DocData, 'contact')?.value).toBe('PMG');
      expect(findDocInfoTextInput(log2DocData, 'notes')?.value).toBe('Preserved notes across switch');
      expect(nock.isDone()).toBe(true);
    }
  );
});

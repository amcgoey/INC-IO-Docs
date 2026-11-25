import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { PDFDocument } from 'pdf-lib';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
import type { GmailThreadDetails } from '../src/infrastructure/gmail/types';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceButton,
  GoogleWorkspaceCard,
  GoogleWorkspaceDecoratedText,
  GoogleWorkspaceSection,
  GoogleWorkspaceTextInput,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { SELECT_DOCUMENT_LOG_KEY } from '../src/features/schema-driven-ui/blocks/document-log';

interface FixtureSeedEntry {
  documentData: Record<string, string>;
  actionName: string;
  fileUri: string | null;
}

interface FixturePartialRow {
  scenario: string;
  rowCells: Record<string, string>;
  linkFormula: string;
  expectedIssues: string[];
}

interface DocumentLogSampleFixture {
  submittalArch: {
    headers: string[];
    seedEntries: FixtureSeedEntry[];
    partialHydrationRows: FixturePartialRow[];
  };
  submittalFfe: {
    headers: string[];
    seedEntries: FixtureSeedEntry[];
    partialHydrationRows: FixturePartialRow[];
  };
}

const SAMPLE_FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './fixtures/document-log-sample-data.json'), 'utf-8')
) as DocumentLogSampleFixture;

const DRIVE_ID = 'drive-history-352';
const SPACE_NAME = 'A & B Tower';
const LOG_PRIMARY_ID = 'sheet-hist-primary';
const LOG_ALT_ID = 'sheet-hist-alt';
const LOG_PRIMARY_URL = `https://docs.google.com/spreadsheets/d/${LOG_PRIMARY_ID}/edit`;
const LOG_ALT_URL = `https://docs.google.com/spreadsheets/d/${LOG_ALT_ID}/edit`;

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

function findProcessButton(card: GoogleWorkspaceCard): GoogleWorkspaceButton | undefined {
  for (const section of card.sections) {
    for (const widget of section.widgets) {
      const btn = widget.buttonList?.buttons.find((b) => b.text === 'Process Document');
      if (btn) {
        return btn;
      }
    }
  }
  return undefined;
}

function findTextInput(card: GoogleWorkspaceCard, name: string): GoogleWorkspaceTextInput | undefined {
  for (const section of card.sections) {
    for (const widget of section.widgets) {
      if (widget.textInput?.name === name) {
        return widget.textInput;
      }
    }
  }
  return undefined;
}

function getOpenLinkUrl(decorated?: GoogleWorkspaceDecoratedText): string | undefined {
  if (!decorated?.button?.onClick || !('openLink' in decorated.button.onClick)) {
    return undefined;
  }
  return decorated.button.onClick.openLink.url;
}

function buildArchSheetRow(entry: FixtureSeedEntry): { cells: string[]; linkFormula: string } {
  const d = entry.documentData;
  const linkFormula = entry.fileUri ? `=HYPERLINK("${entry.fileUri}", "Link")` : '';
  return {
    cells: [
      d.status ?? '',
      d.section ?? '',
      d.number ?? '',
      d.revision ?? '',
      d.title ?? '',
      d.date ?? '',
      d.contact ?? '',
      entry.actionName,
      d.notes ?? '',
      entry.fileUri ? 'Link' : '',
    ],
    linkFormula,
  };
}

function buildFfeSheetRow(entry: FixtureSeedEntry): { cells: string[]; linkFormula: string } {
  const d = entry.documentData;
  const linkFormula = entry.fileUri ? `=HYPERLINK("${entry.fileUri}", "Link")` : '';
  return {
    cells: [
      d.status ?? '',
      d.specTag ?? '',
      d.relatedTag ?? '',
      d.revision ?? '',
      d.specTitle ?? '',
      d.vendor ?? '',
      d.date ?? '',
      d.contact ?? '',
      entry.actionName,
      d.notes ?? '',
      entry.fileUri ? 'Link' : '',
    ],
    linkFormula,
  };
}

function buildRowFromRecord(headers: string[], cells: Record<string, string>): string[] {
  return headers.map((h) => cells[h] ?? '');
}

function mockPositiveTableRead(options: {
  spreadsheetId: string;
  sheetName: 'Submittal Arch' | 'Submittal FF&E';
  rangeName: 'Log_Submittal_Arch' | 'Log_Submittal_FFE';
  headers: string[];
  rows: Array<{ cells: string[]; linkFormula: string }>;
  formulaRow?: string[];
}) {
  const sheetId = options.sheetName === 'Submittal Arch' ? 101 : 102;
  const formulaRow = options.formulaRow ?? ['Formula Row'];
  const totalRows = 4 + Math.max(1, options.rows.length);
  const formattedValues: string[][] = [
    options.headers,
    formulaRow,
    ['<--->'],
    ...(options.rows.length > 0 ? options.rows.map((r) => r.cells) : [[]]),
    ['<--->'],
  ];

  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${options.spreadsheetId}`)
    .query(true)
    .reply(200, {
      spreadsheetId: options.spreadsheetId,
      sheets: [{ properties: { sheetId, title: options.sheetName } }],
      namedRanges: [
        {
          namedRangeId: `nr-${sheetId}`,
          name: options.rangeName,
          range: {
            sheetId,
            startRowIndex: 2,
            endRowIndex: 2 + totalRows + 2,
            startColumnIndex: 0,
            endColumnIndex: options.headers.length,
          },
        },
      ],
    });

  nock('https://sheets.googleapis.com')
    .get(new RegExp(`/v4/spreadsheets/${options.spreadsheetId}/values/.*`))
    .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
    .reply(200, { values: formattedValues });

  const valueRanges: Array<{ values: string[][] }> = [{ values: [formulaRow] }];
  if (options.rows.length > 0) {
    valueRanges.push({
      values: options.rows.map((r) => (r.linkFormula ? [r.linkFormula] : [])),
    });
  }

  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${options.spreadsheetId}/values:batchGet`)
    .query((q) => q.valueRenderOption === 'FORMULA')
    .reply(200, { valueRanges });
}

function mockSingleLogDriveDiscovery(options?: {
  driveId?: string;
  spaceName?: string;
  spreadsheetId?: string;
  spreadsheetName?: string;
  webViewLink?: string;
}) {
  const driveId = options?.driveId ?? DRIVE_ID;
  const spaceName = options?.spaceName ?? SPACE_NAME;
  const spreadsheetId = options?.spreadsheetId ?? LOG_PRIMARY_ID;
  const spreadsheetName = options?.spreadsheetName ?? `${spaceName} Document Log`;

  nock('https://www.googleapis.com')
    .get('/drive/v3/drives')
    .query(true)
    .reply(200, { drives: [{ id: driveId, name: spaceName }] });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("name contains 'Document Log'") &&
        q.driveId === driveId
    )
    .reply(200, {
      files: [
        {
          id: spreadsheetId,
          name: spreadsheetName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          webViewLink: options?.webViewLink ?? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
        },
      ],
    });
}

describe('Ticket #352 CQRS Integration: Collapsible idGroup History, Declarative historyDisplay, Resilient Read States & Submittal Rollout', () => {
  let app: AppInstance;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockGmailClient: Partial<GoogleGmailClient>;
  let flatPdfBytes: Uint8Array;

  beforeEach(async () => {
    nock.disableNetConnect();
    flatPdfBytes = await (await PDFDocument.create()).save();

    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return { isValid: true, payload: { email: 'user@inc.nyc', sub: 'user-352' } };
        }
        return { isValid: false, error: 'Unauthorized' };
      }),
    };

    mockGmailClient = {
      getThread: vi.fn().mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => ({
        id: threadId,
        messages: [
          {
            id: 'msg-352',
            threadId,
            subject: 'Submittal 071200-001 Waterproofing',
            from: 'Meridian Builders <mb@example.com>',
            to: 'PM <pm@inc.nyc>',
            date: 'Tue, 24 Nov 2026 10:00:00 -0500',
            labels: ['INBOX', SPACE_NAME],
            plainTextBody: 'Attached submittal.',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-1',
                attachmentId: 'att-1',
                filename: '071200-001_Waterproofing.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
            ],
          },
        ],
      })),
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-352',
        messageId: 'msg-352',
        inlineImages: [],
        attachments: [
          {
            partId: 'part-1',
            attachmentId: 'att-1',
            filename: '071200-001_Waterproofing.pdf',
            mimeType: 'application/pdf',
            size: 1024,
          },
        ],
      }),
      getAttachment: vi.fn().mockResolvedValue(new Uint8Array(flatPdfBytes)),
    };

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
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

  it('Drive + Gmail reactive onFormChange on trimmed section/number (Submittal Arch) and trimmed/lowercase specTag (Submittal FF&E) renders newest-first HTML-escaped historyDisplay with collapsible invariants and optional Open buttons', async () => {
    // Prepare Arch rows for 071200-001 including HTML-special chars ("Revise & Resubmit", "A & B Tower", "Pipe <2\"") and 1 row without fileUri
    const archRows = [
      buildArchSheetRow({
        documentData: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '0',
          title: 'Pipe <2" at A & B Tower',
          date: '260204',
          contact: 'MB',
          action: 'REC',
          notes: '',
        },
        actionName: 'Received',
        fileUri: null,
      }),
      buildArchSheetRow({
        documentData: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '0',
          title: 'Pipe <2" at A & B Tower',
          date: '260212',
          contact: 'ARC',
          action: 'RR',
          notes: '',
        },
        actionName: 'Revise & Resubmit',
        fileUri: 'https://drive.google.com/file/d/fixture-arch-071200-001-0-rr/view',
      }),
      buildArchSheetRow({
        documentData: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '1',
          title: 'Pipe <2" at A & B Tower',
          date: '260224',
          contact: 'ARC',
          action: 'NOC',
          notes: '',
        },
        actionName: 'No Objections As Corrected',
        fileUri: 'https://drive.google.com/file/d/fixture-arch-071200-001-1-noc/view',
      }),
    ];

    // 1. Drive Submittal Arch onFormChange with untrimmed section/number
    mockSingleLogDriveDiscovery();
    mockPositiveTableRead({
      spreadsheetId: LOG_PRIMARY_ID,
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      headers: SAMPLE_FIXTURE.submittalArch.headers,
      rows: archRows,
    });

    const driveArchRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-352', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-352'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: [' 071200 '] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: [' 001 '] } },
          },
        },
      },
    });
    expect(driveArchRes.statusCode).toBe(200);
    const driveArchCard = getCard(driveArchRes.payload, 'updateCard');

    // Verify section & number have reactive onChange: true wired to /workspace/on-form-change
    expect(
      findTextInput(driveArchCard, getDocumentInfoWidgetName('section', 'submittal-arch'))?.onChangeAction?.function
    ).toContain('/workspace/on-form-change');
    expect(
      findTextInput(driveArchCard, getDocumentInfoWidgetName('number', 'submittal-arch'))?.onChangeAction?.function
    ).toContain('/workspace/on-form-change');

    // 2. Gmail Submittal Arch onFormChange with untrimmed section/number
    mockSingleLogDriveDiscovery();
    mockPositiveTableRead({
      spreadsheetId: LOG_PRIMARY_ID,
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      headers: SAMPLE_FIXTURE.submittalArch.headers,
      rows: archRows,
    });

    const gmailArchRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-352', threadId: 'th-352', accessToken: 'ya29.gmail-token' },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID, previousMessageId: 'msg-352' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-352'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-1'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: [' 071200 '] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: [' 001 '] } },
          },
        },
      },
    });
    expect(gmailArchRes.statusCode).toBe(200);
    const gmailArchCard = getCard(gmailArchRes.payload, 'updateCard');

    for (const card of [driveArchCard, gmailArchCard]) {
      const logSec = findSection(card, 'Document Log')!;
      expect(logSec.collapsible).toBe(true);
      expect(logSec.uncollapsibleWidgetsCount).toBe(1);
      expect(logSec.widgets).toHaveLength(4); // 1 active bar + 3 newest-first history rows

      // Active bar escapes A & B Tower in text, keeps plain text in topLabel
      expect(logSec.widgets[0].decoratedText?.topLabel).toBe(`Active Document Log · ${SPACE_NAME}`);
      expect(logSec.widgets[0].decoratedText?.text).toBe('<b>A &amp; B Tower Document Log</b>');
      expect(getOpenLinkUrl(logSec.widgets[0].decoratedText)).toBe(LOG_PRIMARY_URL);

      // Row 0 (newest): Rev 1 NOC with Open button
      const newest = logSec.widgets[1].decoratedText!;
      expect(newest.topLabel).toBe('Rev 1 • 071200-001 • Open');
      expect(newest.text).toBe('<b>No Objections As Corrected</b> 260224 (ARC)');
      expect(newest.wrapText).toBe(true);
      expect(newest.bottomLabel).toBe('Pipe <2" at A & B Tower');
      expect(newest.button?.text).toBe('Open');
      expect(getOpenLinkUrl(newest)).toBe('https://drive.google.com/file/d/fixture-arch-071200-001-1-noc/view');

      // Row 1 (middle): Rev 0 Revise & Resubmit -> HTML-escaped '&amp;' in text, unescaped plain labels
      const middle = logSec.widgets[2].decoratedText!;
      expect(middle.topLabel).toBe('Rev 0 • 071200-001 • Open');
      expect(middle.text).toBe('<b>Revise &amp; Resubmit</b> 260212 (ARC)');
      expect(middle.bottomLabel).toBe('Pipe <2" at A & B Tower');
      expect(middle.button?.text).toBe('Open');

      // Row 2 (oldest): Rev 0 Received with NO fileUri -> trailing Open button omitted
      const oldest = logSec.widgets[3].decoratedText!;
      expect(oldest.text).toBe('<b>Received</b> 260204 (MB)');
      expect(oldest.button).toBeUndefined();

      expect(findProcessButton(card)?.disabled).not.toBe(true);
    }

    // 3. Drive + Gmail Submittal FF&E onFormChange with trimmed + lowercase ' cg104 '
    const ffeCg104Rows = SAMPLE_FIXTURE.submittalFfe.seedEntries
      .filter((e) => e.documentData.specTag === 'CG104')
      .map(buildFfeSheetRow);

    for (const host of ['DRIVE', 'GMAIL'] as const) {
      mockSingleLogDriveDiscovery();
      mockPositiveTableRead({
        spreadsheetId: LOG_PRIMARY_ID,
        sheetName: 'Submittal FF&E',
        rangeName: 'Log_Submittal_FFE',
        headers: SAMPLE_FIXTURE.submittalFfe.headers,
        rows: ffeCg104Rows,
        formulaRow: ['', '', '', '', '=ARRAYFORMULA(VLOOKUP(B6:B, _Config!A:B, 2, FALSE))'],
      });

      const res = await app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload:
          host === 'DRIVE'
            ? {
                authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
                drive: { selectedItems: [{ id: 'file-ffe', title: 'CG104-0_Bed.pdf' }] },
                commonEventObject: {
                  hostApp: 'DRIVE',
                  parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
                  formInputs: {
                    SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                    [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
                    [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
                    SelectFiles: { stringInputs: { value: ['file-ffe'] } },
                    [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: {
                      stringInputs: { value: [' cg104 '] },
                    },
                  },
                },
              }
            : {
                hostApp: 'GMAIL',
                gmail: { messageId: 'msg-352', threadId: 'th-352', accessToken: 'ya29.gmail-token' },
                commonEventObject: {
                  hostApp: 'GMAIL',
                  parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID, previousMessageId: 'msg-352' },
                  formInputs: {
                    SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                    [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
                    [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
                    SelectEmailMessage: { stringInputs: { value: ['msg-352'] } },
                    SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                    SelectAttachments: { stringInputs: { value: ['part-1'] } },
                    [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: {
                      stringInputs: { value: [' cg104 '] },
                    },
                  },
                },
              },
      });

      expect(res.statusCode).toBe(200);
      const card = getCard(res.payload, 'updateCard');
      expect(
        findTextInput(card, getDocumentInfoWidgetName('specTag', 'submittal-ffe'))?.onChangeAction?.function
      ).toContain('/workspace/on-form-change');

      const logSec = findSection(card, 'Document Log')!;
      expect(logSec.collapsible).toBe(true);
      expect(logSec.uncollapsibleWidgetsCount).toBe(1);
      expect(logSec.widgets).toHaveLength(4); // 1 active bar + 3 CG104 rows newest-first

      expect(logSec.widgets[1].decoratedText?.topLabel).toBe('Rev 1 • CG104 • Open');
      expect(logSec.widgets[1].decoratedText?.text).toBe('<b>No Objections As Corrected</b> 260210 (ARC)');
      expect(logSec.widgets[1].decoratedText?.bottomLabel).toBe('BED - KING — Keystone Casegoods');
      expect(logSec.widgets[2].decoratedText?.text).toBe('<b>Revise &amp; Resubmit</b> 260128 (ARC)');
      expect(logSec.widgets[3].decoratedText?.text).toBe('<b>Received</b> 260120 (HPG)');
    }

    expect(nock.isDone()).toBe(true);
  });

  it('switching SelectDocumentLog in ambiguous spaces reloads history from the chosen spreadsheet with uncollapsibleWidgetsCount: 2 (Drive + Gmail)', async () => {
    const mockAmbiguousDiscovery = () => {
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
              id: LOG_PRIMARY_ID,
              name: `${SPACE_NAME} Document Log`,
              mimeType: 'application/vnd.google-apps.spreadsheet',
              parents: ['folder-admin'],
              modifiedTime: '2026-10-19T12:00:00Z',
              webViewLink: LOG_PRIMARY_URL,
            },
            {
              id: LOG_ALT_ID,
              name: `${SPACE_NAME} Document Log`,
              mimeType: 'application/vnd.google-apps.spreadsheet',
              parents: ['folder-const'],
              modifiedTime: '2026-10-12T12:00:00Z',
              webViewLink: LOG_ALT_URL,
            },
          ],
        });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes("name = '1 Admin'"))
        .reply(200, { files: [{ id: 'folder-admin', name: '1 Admin', parents: [DRIVE_ID] }] });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-admin')
        .query(true)
        .reply(200, { id: 'folder-admin', name: '1 Admin', parents: [DRIVE_ID] });
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/folder-const')
        .query(true)
        .reply(200, { id: 'folder-const', name: '6 Construction', parents: [DRIVE_ID] });
    };

    const primaryRows = [
      buildArchSheetRow({
        documentData: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '0',
          title: 'Primary Spreadsheet Entry',
          date: '260204',
          contact: 'MB',
          action: 'REC',
          notes: '',
        },
        actionName: 'Received',
        fileUri: 'https://drive.google.com/file/d/primary-entry/view',
      }),
    ];
    const altRows = [
      buildArchSheetRow({
        documentData: {
          status: 'Closed',
          section: '071200',
          number: '001',
          revision: '2',
          title: 'Alternate Spreadsheet Entry',
          date: '260228',
          contact: 'ARC',
          action: 'NET',
          notes: '',
        },
        actionName: 'No Exceptions Taken',
        fileUri: 'https://drive.google.com/file/d/alt-entry/view',
      }),
    ];

    // Step 1 (Drive): default active candidate is LOG_PRIMARY_ID
    mockAmbiguousDiscovery();
    mockPositiveTableRead({
      spreadsheetId: LOG_PRIMARY_ID,
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      headers: SAMPLE_FIXTURE.submittalArch.headers,
      rows: primaryRows,
    });

    const step1 = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-352', title: '071200-001.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-352'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
          },
        },
      },
    });
    expect(step1.statusCode).toBe(200);
    const card1 = getCard(step1.payload, 'updateCard');
    const sec1 = findSection(card1, 'Document Log')!;
    expect(sec1.collapsible).toBe(true);
    expect(sec1.uncollapsibleWidgetsCount).toBe(2);
    expect(sec1.widgets[2].decoratedText?.bottomLabel).toBe('Primary Spreadsheet Entry');
    expect(getOpenLinkUrl(sec1.widgets[1].decoratedText)).toBe(LOG_PRIMARY_URL);

    // Step 2 (Gmail): switch SelectDocumentLog -> LOG_ALT_ID reloads history from LOG_ALT_ID
    mockAmbiguousDiscovery();
    mockPositiveTableRead({
      spreadsheetId: LOG_ALT_ID,
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      headers: SAMPLE_FIXTURE.submittalArch.headers,
      rows: altRows,
    });

    const step2 = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-352', threadId: 'th-352', accessToken: 'ya29.gmail-token' },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID, previousMessageId: 'msg-352' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-352'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-1'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_ALT_ID] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
          },
        },
      },
    });
    expect(step2.statusCode).toBe(200);
    const card2 = getCard(step2.payload, 'updateCard');
    const sec2 = findSection(card2, 'Document Log')!;
    expect(sec2.collapsible).toBe(true);
    expect(sec2.uncollapsibleWidgetsCount).toBe(2);
    expect(getOpenLinkUrl(sec2.widgets[1].decoratedText)).toBe(LOG_ALT_URL);
    expect(sec2.widgets[2].decoratedText?.topLabel).toBe('Rev 2 • 071200-001 • Closed');
    expect(sec2.widgets[2].decoratedText?.text).toBe('<b>No Exceptions Taken</b> 260228 (ARC)');
    expect(sec2.widgets[2].decoratedText?.bottomLabel).toBe('Alternate Spreadsheet Entry');
    expect(getOpenLinkUrl(sec2.widgets[2].decoratedText)).toBe('https://drive.google.com/file/d/alt-entry/view');
    expect(nock.isDone()).toBe(true);
  });

  it('skips Google Sheets completely on idle_incomplete_id, renders guidance, and omits collapsible properties (Drive + Gmail)', async () => {
    // Zero Sheets mocks registered; nock.disableNetConnect() guarantees Sheets is NOT called!
    mockSingleLogDriveDiscovery();
    const driveIncomplete = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-352', title: 'Draft.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-352'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['   '] } },
          },
        },
      },
    });
    expect(driveIncomplete.statusCode).toBe(200);
    const driveCard = getCard(driveIncomplete.payload, 'updateCard');
    const driveLogSec = findSection(driveCard, 'Document Log')!;
    expect(driveLogSec.collapsible).toBeUndefined();
    expect(driveLogSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(driveLogSec.widgets[1].textParagraph?.text).toContain('<b>Number</b>');

    mockSingleLogDriveDiscovery();
    const gmailIncomplete = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-352', threadId: 'th-352', accessToken: 'ya29.gmail-token' },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID, previousMessageId: 'msg-352' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-352'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-1'] } },
            [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: ['   '] } },
          },
        },
      },
    });
    expect(gmailIncomplete.statusCode).toBe(200);
    const gmailCard = getCard(gmailIncomplete.payload, 'updateCard');
    const gmailLogSec = findSection(gmailCard, 'Document Log')!;
    expect(gmailLogSec.collapsible).toBeUndefined();
    expect(gmailLogSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(gmailLogSec.widgets[1].textParagraph?.text).toContain('<b>Spec Tag</b>');
    expect(nock.isDone()).toBe(true);
  });

  it('renders partial_hydration warning banner and visible best-effort rows from document-log-sample-data.json partialHydrationRows with uncollapsibleWidgetsCount: 2 (resolved) and 3 (ambiguous) while keeping Process Document enabled', async () => {
    const archPartials = SAMPLE_FIXTURE.submittalArch.partialHydrationRows;
    const partialRows = archPartials.map((p) => ({
      cells: buildRowFromRecord(SAMPLE_FIXTURE.submittalArch.headers, p.rowCells),
      linkFormula: p.linkFormula,
    }));

    // 1. Resolved + Submittal Arch partialHydrationRows (filters to 071200-001 -> matches row 1 & row 2, ignores unrelated 7120-001 row 0)
    mockSingleLogDriveDiscovery();
    mockPositiveTableRead({
      spreadsheetId: LOG_PRIMARY_ID,
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      headers: SAMPLE_FIXTURE.submittalArch.headers,
      rows: partialRows,
    });

    const resolvedPartialRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-352', title: '071200-001.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-352'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
          },
        },
      },
    });
    expect(resolvedPartialRes.statusCode).toBe(200);
    const resolvedCard = getCard(resolvedPartialRes.payload, 'updateCard');
    const resolvedLogSec = findSection(resolvedCard, 'Document Log')!;
    expect(resolvedLogSec.collapsible).toBe(true);
    expect(resolvedLogSec.uncollapsibleWidgetsCount).toBe(2); // active bar + warning banner
    expect(resolvedLogSec.widgets).toHaveLength(4); // active bar + warning + 2 matched partial rows
    expect(resolvedLogSec.widgets[1].textParagraph?.text).toContain('Partial read (2 warnings)');
    expect(resolvedLogSec.widgets[1].textParagraph?.text).not.toContain('7120'); // unrelated row warning excluded!

    // Newest matched row: missingRequiredDate (no Open button)
    expect(resolvedLogSec.widgets[2].decoratedText?.text).toBe('<b>Referred</b>  (PST)');
    expect(resolvedLogSec.widgets[2].decoratedText?.button).toBeUndefined();
    // Second matched row: unknownActionAndRawUrl ("Approved" visible via fallback lookup tuple, raw URL Open button!)
    expect(resolvedLogSec.widgets[3].decoratedText?.text).toBe('<b>Approved</b> 260226 (ARC)');
    expect(getOpenLinkUrl(resolvedLogSec.widgets[3].decoratedText)).toBe(
      'https://drive.google.com/file/d/fixture-arch-raw-url/view'
    );
    expect(findProcessButton(resolvedCard)?.disabled).not.toBe(true);

    // 2. Ambiguous + Gmail + Submittal FF&E partialHydrationRows -> uncollapsibleWidgetsCount: 3
    const ffePartials = SAMPLE_FIXTURE.submittalFfe.partialHydrationRows.map((p) => ({
      cells: buildRowFromRecord(SAMPLE_FIXTURE.submittalFfe.headers, p.rowCells),
      linkFormula: p.linkFormula,
    }));

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
            id: LOG_PRIMARY_ID,
            name: `${SPACE_NAME} Document Log`,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: [DRIVE_ID],
            modifiedTime: '2026-10-19T12:00:00Z',
          },
          {
            id: LOG_ALT_ID,
            name: `${SPACE_NAME} Document Log Backup`,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: [DRIVE_ID],
            modifiedTime: '2026-10-10T12:00:00Z',
          },
        ],
      });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name = '1 Admin'"))
      .reply(200, { files: [] });

    mockPositiveTableRead({
      spreadsheetId: LOG_PRIMARY_ID,
      sheetName: 'Submittal FF&E',
      rangeName: 'Log_Submittal_FFE',
      headers: SAMPLE_FIXTURE.submittalFfe.headers,
      rows: ffePartials,
      formulaRow: ['', '', '', '', '=ARRAYFORMULA(VLOOKUP(B6:B, _Config!A:B, 2, FALSE))'],
    });

    const ambigPartialRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-352', threadId: 'th-352', accessToken: 'ya29.gmail-token' },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID, previousMessageId: 'msg-352' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-352'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-1'] } },
            [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: [' lt108 '] } },
          },
        },
      },
    });
    expect(ambigPartialRes.statusCode).toBe(200);
    const ambigCard = getCard(ambigPartialRes.payload, 'updateCard');
    const ambigLogSec = findSection(ambigCard, 'Document Log')!;
    expect(ambigLogSec.collapsible).toBe(true);
    expect(ambigLogSec.uncollapsibleWidgetsCount).toBe(3); // dropdown + active bar + warning banner
    expect(ambigLogSec.widgets[2].textParagraph?.text).toContain('Partial read (2 warnings)');
    expect(ambigLogSec.widgets[3].decoratedText?.topLabel).toBe('Rev 0 • LT108 • In Review');
    expect(ambigLogSec.widgets[3].decoratedText?.bottomLabel).toBe('SCONCE —');
    expect(findProcessButton(ambigCard)?.disabled).not.toBe(true);
    expect(nock.isDone()).toBe(true);
  });

  it('degrades gracefully on Sheets read_error without leaking Sheets error names or disabling Process Document, and enforces 20-row overflow notice with <= 100 card widgets', async () => {
    // 1. read_error: missing Named Range (structural error) -> non-blocking banner, Process Document enabled, no collapsible
    mockSingleLogDriveDiscovery();
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${LOG_PRIMARY_ID}`)
      .query(true)
      .reply(200, {
        spreadsheetId: LOG_PRIMARY_ID,
        sheets: [{ properties: { sheetId: 101, title: 'Submittal Arch' } }],
        namedRanges: [],
      });

    const errRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-352', title: '071200-001.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-352'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Preserved Title'] } },
          },
        },
      },
    });
    expect(errRes.statusCode).toBe(200);
    const errCard = getCard(errRes.payload, 'updateCard');
    const errLogSec = findSection(errCard, 'Document Log')!;
    expect(errLogSec.collapsible).toBeUndefined();
    expect(errLogSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(errLogSec.widgets[1].textParagraph?.text).toContain('Document Log history unavailable');
    expect(errLogSec.widgets[1].textParagraph?.text).toContain('Log_Submittal_Arch');
    expect(JSON.stringify(errCard)).not.toContain('GoogleSheetsNamedRangeNotFoundError');
    expect(findProcessButton(errCard)?.disabled).not.toBe(true);
    expect(
      findTextInput(errCard, getDocumentInfoWidgetName('title', 'submittal-arch'))?.value
    ).toBe('Preserved Title');

    // 1b. Gmail read_error (HTTP 503) & empty history (ready with 0 matching rows)
    mockSingleLogDriveDiscovery();
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${LOG_PRIMARY_ID}`)
      .query(true)
      .times(4) // initial + gaxios retry attempts on 503
      .optionally()
      .reply(503, { error: { code: 503, message: 'Sheets temporarily unavailable <503>' } });

    const gmailErrRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: { messageId: 'msg-352', threadId: 'th-352', accessToken: 'ya29.gmail-token' },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID, previousMessageId: 'msg-352' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-352'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-1'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
          },
        },
      },
    });
    expect(gmailErrRes.statusCode).toBe(200);
    const gmailErrCard = getCard(gmailErrRes.payload, 'updateCard');
    const gmailErrSec = findSection(gmailErrCard, 'Document Log')!;
    expect(gmailErrSec.collapsible).toBeUndefined();
    expect(gmailErrSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(gmailErrSec.widgets[1].textParagraph?.text).toContain('Document Log history unavailable');
    expect(gmailErrSec.widgets[1].textParagraph?.text).toContain('&lt;503&gt;');
    expect(JSON.stringify(gmailErrCard)).not.toContain('GoogleSheetsApiError');
    expect(findProcessButton(gmailErrCard)?.disabled).not.toBe(true);

    // 1c. Empty history (ready with 0 matching rows) omits collapsible and shows empty-history indicator
    mockSingleLogDriveDiscovery();
    mockPositiveTableRead({
      spreadsheetId: LOG_PRIMARY_ID,
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      headers: SAMPLE_FIXTURE.submittalArch.headers,
      rows: [],
    });

    const emptyRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-352', title: '099999-001.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-352'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['099999'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
          },
        },
      },
    });
    expect(emptyRes.statusCode).toBe(200);
    const emptyCard = getCard(emptyRes.payload, 'updateCard');
    const emptyLogSec = findSection(emptyCard, 'Document Log')!;
    expect(emptyLogSec.collapsible).toBeUndefined();
    expect(emptyLogSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(emptyLogSec.widgets[1].textParagraph?.text).toContain('099999-001');
    expect(emptyLogSec.widgets[1].textParagraph?.text).toContain('No prior Document Log entries found');
    expect(findProcessButton(emptyCard)?.disabled).not.toBe(true);

    // 2. 22 entries -> capped at 20 history rows + 1 overflow notice with Open Log button, total widgets <= 100
    const manyRows = Array.from({ length: 22 }, (_, i) =>
      buildArchSheetRow({
        documentData: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: String(i),
          title: `Revision ${i}`,
          date: `2602${String((i % 28) + 1).padStart(2, '0')}`,
          contact: 'ARC',
          action: 'REC',
          notes: '',
        },
        actionName: 'Received',
        fileUri: `https://drive.google.com/file/d/many-${i}/view`,
      })
    );
    mockSingleLogDriveDiscovery();
    mockPositiveTableRead({
      spreadsheetId: LOG_PRIMARY_ID,
      sheetName: 'Submittal Arch',
      rangeName: 'Log_Submittal_Arch',
      headers: SAMPLE_FIXTURE.submittalArch.headers,
      rows: manyRows,
    });

    const capRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-352', title: '071200-001.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-352'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
          },
        },
      },
    });
    expect(capRes.statusCode).toBe(200);
    const capCard = getCard(capRes.payload, 'updateCard');
    const totalCardWidgets = capCard.sections.reduce((sum, s) => sum + s.widgets.length, 0);
    expect(totalCardWidgets).toBeLessThanOrEqual(100);

    const capLogSec = findSection(capCard, 'Document Log')!;
    expect(capLogSec.collapsible).toBe(true);
    expect(capLogSec.uncollapsibleWidgetsCount).toBe(1);
    expect(capLogSec.widgets).toHaveLength(22); // 1 active bar + 20 rows + 1 overflow notice
    expect(capLogSec.widgets[1].decoratedText?.topLabel).toBe('Rev 21 • 071200-001 • Open');
    const overflow = capLogSec.widgets[21].decoratedText!;
    expect(overflow.text).toBe('Showing 20 of 22 entries');
    expect(overflow.button?.text).toBe('Open Log');
    expect(getOpenLinkUrl(overflow)).toBe(LOG_PRIMARY_URL);
    expect(nock.isDone()).toBe(true);
  }, 15000);
});

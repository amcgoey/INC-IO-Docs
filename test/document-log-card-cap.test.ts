import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { Value } from '@sinclair/typebox/value';
import { createApp, type AppInstance, type CompositeManifestProvider } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
import type { GmailThreadDetails } from '../src/infrastructure/gmail/types';
import {
  GoogleWorkspaceActionResponseSchema,
  type GoogleWorkspaceActionResponse,
  type GoogleWorkspaceButton,
  type GoogleWorkspaceCard,
  type GoogleWorkspaceDecoratedText,
  type GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { SELECT_DOCUMENT_LOG_KEY } from '../src/features/schema-driven-ui/blocks/document-log';

interface SubmittalArchJson {
  key: string;
  name: string;
  documentSchema: {
    fields: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  documentUiSchema: {
    layout: string[];
    fields: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const ASSETS_DIR = path.resolve(__dirname, '../assets');
const MANIFEST_PATH = path.resolve(ASSETS_DIR, 'manifest.json');
const SUBMITTAL_ARCH_PATH = path.resolve(ASSETS_DIR, 'document-types/submittal-arch.json');
const SAMPLE_FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, './fixtures/document-log-sample-data.json'), 'utf-8')
) as {
  submittalArch: {
    headers: string[];
  };
};

const DRIVE_ID = 'drive-cap-353';
const SPACE_NAME = 'A & B Tower';
const LOG_PRIMARY_ID = 'sheet-cap-primary';
const LOG_ALT_ID = 'sheet-cap-alt';
const LOG_PRIMARY_URL = `https://docs.google.com/spreadsheets/d/${LOG_PRIMARY_ID}/edit`;
const LOG_ALT_URL = `https://docs.google.com/spreadsheets/d/${LOG_ALT_ID}/edit`;

const BASE_SUBMITTAL_ARCH_FIELD_COUNT = 9;
const DOC_DATA_FIXED_BUTTON_COUNT = 1;

function createCustomManifestProvider(extraFieldCount: number): CompositeManifestProvider {
  // Load real manifest.json and submittal-arch.json from disk as required.
  const rawManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as Record<string, unknown>;
  const baseSubmittalArch = JSON.parse(
    fs.readFileSync(SUBMITTAL_ARCH_PATH, 'utf-8')
  ) as SubmittalArchJson;

  const extraFields = Array.from({ length: extraFieldCount }, (_, idx) => {
    const n = idx + 1;
    return {
      key: `extraField${n}`,
      name: `Extra Field ${n}`,
      type: 'string',
      required: false,
    };
  });
  const extraLayoutKeys = Array.from({ length: extraFieldCount }, (_, idx) => `extraField${idx + 1}`);

  const clonedSubmittalArch: SubmittalArchJson = {
    ...baseSubmittalArch,
    documentSchema: {
      ...baseSubmittalArch.documentSchema,
      fields: [...baseSubmittalArch.documentSchema.fields, ...extraFields],
    },
    documentUiSchema: {
      ...baseSubmittalArch.documentUiSchema,
      layout: [...baseSubmittalArch.documentUiSchema.layout, ...extraLayoutKeys],
    },
  };

  const baseProvider = new AppManifestProvider({ manifestPath: MANIFEST_PATH });

  return {
    getDriveConfig: () => baseProvider.getDriveConfig(),
    getWorkspaceConfig: () => baseProvider.getWorkspaceConfig(),
    getSheetsConfig: () => baseProvider.getSheetsConfig(),
    getRawManifest: async () => structuredClone(rawManifest),
    readParsedSchema: async (relPath: string) => {
      const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (normalized === 'document-types/submittal-arch.json') {
        return structuredClone(clonedSubmittalArch);
      }
      return baseProvider.readParsedSchema(relPath);
    },
  };
}

function createMockAuthVerifier(): WorkspaceAuthVerifierPort {
  return {
    verifyToken: vi.fn().mockImplementation(async (header?: string) => {
      if (header && header.startsWith('Bearer valid-')) {
        return { isValid: true, payload: { email: 'user@inc.nyc', sub: 'user-353' } };
      }
      return { isValid: false, error: 'Unauthorized' };
    }),
  };
}

function createMockGmailClient(): Partial<GoogleGmailClient> {
  return {
    getThread: vi.fn().mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => ({
      id: threadId,
      messages: [
        {
          id: 'msg-353',
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
      id: 'msg-353',
      messageId: 'msg-353',
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
    getAttachment: vi.fn().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
  };
}

async function createAppWithCustomFieldCount(extraFieldCount: number): Promise<AppInstance> {
  const manifestProvider = createCustomManifestProvider(extraFieldCount);
  const app = createApp({
    manifestProvider,
    authVerifier: createMockAuthVerifier(),
    skipSpaceValidation: true,
    gmailClient: createMockGmailClient() as GoogleGmailClient,
  });
  await app.initialize();
  return app;
}

function buildArchSheetRows(
  count: number,
  options?: { invalidActionAtIndex?: number | undefined }
): Array<{ cells: string[]; linkFormula: string }> {
  return Array.from({ length: count }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    const isInvalidAction = options?.invalidActionAtIndex === i;
    const actionLabel = isInvalidAction ? 'Approved' : 'Received';
    const fileUri = `https://drive.google.com/file/d/cap-entry-${i}/view`;
    return {
      cells: [
        'Open',
        '071200',
        '001',
        String(i),
        `Waterproofing Revision ${i}`,
        `2602${day}`,
        'ARC',
        actionLabel,
        '',
        'Link',
      ],
      linkFormula: `=HYPERLINK("${fileUri}", "Link")`,
    };
  });
}

function mockPositiveTableRead(
  spreadsheetId: string,
  rows: Array<{ cells: string[]; linkFormula: string }>
): void {
  const headers = SAMPLE_FIXTURE.submittalArch.headers;
  const sheetId = 101;
  const formulaRow = ['Formula Row'];
  const totalRows = 4 + Math.max(1, rows.length);
  const formattedValues: string[][] = [
    headers,
    formulaRow,
    ['<--->'],
    ...(rows.length > 0 ? rows.map((r) => r.cells) : [[]]),
    ['<--->'],
  ];

  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${spreadsheetId}`)
    .query(true)
    .reply(200, {
      spreadsheetId,
      sheets: [{ properties: { sheetId, title: 'Submittal Arch' } }],
      namedRanges: [
        {
          namedRangeId: `nr-${sheetId}`,
          name: 'Log_Submittal_Arch',
          range: {
            sheetId,
            startRowIndex: 2,
            endRowIndex: 2 + totalRows + 2,
            startColumnIndex: 0,
            endColumnIndex: headers.length,
          },
        },
      ],
    });

  nock('https://sheets.googleapis.com')
    .get(new RegExp(`/v4/spreadsheets/${spreadsheetId}/values/.*`))
    .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
    .reply(200, { values: formattedValues });

  const valueRanges: Array<{ values: string[][] }> = [{ values: [formulaRow] }];
  if (rows.length > 0) {
    valueRanges.push({
      values: rows.map((r) => (r.linkFormula ? [r.linkFormula] : [])),
    });
  }

  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
    .query((q) => q.valueRenderOption === 'FORMULA')
    .reply(200, { valueRanges });
}

function mockSingleLogDriveDiscovery(): void {
  nock('https://www.googleapis.com')
    .get('/drive/v3/drives')
    .query(true)
    .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("name contains 'Document Log'") &&
        q.driveId === DRIVE_ID
    )
    .reply(200, {
      files: [
        {
          id: LOG_PRIMARY_ID,
          name: `${SPACE_NAME} Document Log`,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          webViewLink: LOG_PRIMARY_URL,
        },
      ],
    });
}

function mockMissingLogDriveDiscovery(): void {
  nock('https://www.googleapis.com')
    .get('/drive/v3/drives')
    .query(true)
    .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("name contains 'Document Log'") &&
        q.driveId === DRIVE_ID
    )
    .reply(200, { files: [] });
}

function mockAmbiguousLogDriveDiscovery(): void {
  nock('https://www.googleapis.com')
    .get('/drive/v3/drives')
    .query(true)
    .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("name contains 'Document Log'") &&
        q.driveId === DRIVE_ID
    )
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
}

async function injectOnFormChange(
  app: AppInstance,
  host: 'DRIVE' | 'GMAIL'
): Promise<{ card: GoogleWorkspaceCard; totalCardWidgets: number }> {
  const res = await app.server.inject({
    method: 'POST',
    url: '/workspace/on-form-change',
    headers: { authorization: 'Bearer valid-jwt-token' },
    payload:
      host === 'DRIVE'
        ? {
            authorizationEventObject: { userOAuthToken: 'ya29.drive-cap' },
            drive: { selectedItems: [{ id: 'file-353', title: '071200-001.pdf' }] },
            commonEventObject: {
              hostApp: 'DRIVE',
              parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
                SelectFiles: { stringInputs: { value: ['file-353'] } },
                [getDocumentInfoWidgetName('section', 'submittal-arch')]: {
                  stringInputs: { value: ['071200'] },
                },
                [getDocumentInfoWidgetName('number', 'submittal-arch')]: {
                  stringInputs: { value: ['001'] },
                },
              },
            },
          }
        : {
            hostApp: 'GMAIL',
            gmail: { messageId: 'msg-353', threadId: 'th-353', accessToken: 'ya29.gmail-cap' },
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFormChange',
                previousSpaceId: DRIVE_ID,
                previousMessageId: 'msg-353',
              },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
                SelectEmailMessage: { stringInputs: { value: ['msg-353'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                SelectAttachments: { stringInputs: { value: ['part-1'] } },
                [getDocumentInfoWidgetName('section', 'submittal-arch')]: {
                  stringInputs: { value: ['071200'] },
                },
                [getDocumentInfoWidgetName('number', 'submittal-arch')]: {
                  stringInputs: { value: ['001'] },
                },
              },
            },
          },
  });

  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
  expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);

  const card = body.action?.navigations?.[0]?.updateCard;
  expect(card).toBeDefined();

  const totalCardWidgets = card!.sections.reduce((sum, s) => sum + s.widgets.length, 0);
  return { card: card!, totalCardWidgets };
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

function getOpenLinkUrl(decorated?: GoogleWorkspaceDecoratedText): string | undefined {
  if (!decorated?.button?.onClick || !('openLink' in decorated.button.onClick)) {
    return undefined;
  }
  return decorated.button.onClick.openLink.url;
}

function assertFixedSectionsIntact(card: GoogleWorkspaceCard, extraFieldCount: number): void {
  const docData = findSection(card, 'Document Data');
  expect(docData).toBeDefined();
  expect(docData!.widgets).toHaveLength(
    BASE_SUBMITTAL_ARCH_FIELD_COUNT + DOC_DATA_FIXED_BUTTON_COUNT + extraFieldCount
  );
  expect(findProcessButton(card)).toBeDefined();

  const admin = findSection(card, 'Admin');
  expect(admin).toBeDefined();
  expect(admin!.widgets).toHaveLength(1);
  const adminButtons = admin!.widgets[0].buttonList?.buttons.map((b) => b.text);
  expect(adminButtons).toEqual(['Refresh Document', 'View Raw JSON']);
}

function assertLogSectionPositionedBetweenFileSelectionAndDocData(card: GoogleWorkspaceCard): void {
  const headers = card.sections.map((s) => s.header);
  const fileIdx = headers.indexOf('File Selection');
  const logIdx = headers.indexOf('Document Log');
  const dataIdx = headers.indexOf('Document Data');
  expect(fileIdx).toBeGreaterThanOrEqual(0);
  expect(logIdx).toBe(fileIdx + 1);
  expect(dataIdx).toBe(logIdx + 1);
}

describe('Ticket #353 CQRS Integration: Google Workspace 100-Widget Card Cap & Overflow Budget', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  it('caps at 19 rows + 1 overflow when remainingHistorySlots === 20 with 21 entries (Drive & Gmail), and renders 20 rows with no overflow for 20 entries', async () => {
    const driveApp = await createAppWithCustomFieldCount(64);
    const gmailApp = await createAppWithCustomFieldCount(61);

    const rows21 = buildArchSheetRows(21);
    const rows20 = buildArchSheetRows(20);

    for (const [host, app, extraFieldCount] of [
      ['DRIVE', driveApp, 64],
      ['GMAIL', gmailApp, 61],
    ] as const) {
      // 21 entries at remainingHistorySlots === 20 -> 19 newest rows + 1 overflow notice, totalCardWidgets === 100
      mockSingleLogDriveDiscovery();
      mockPositiveTableRead(LOG_PRIMARY_ID, rows21);

      const { card: card21, totalCardWidgets: total21 } = await injectOnFormChange(app, host);
      assertFixedSectionsIntact(card21, extraFieldCount);
      assertLogSectionPositionedBetweenFileSelectionAndDocData(card21);
      expect(total21).toBe(100);

      const logSec21 = findSection(card21, 'Document Log')!;
      expect(logSec21.collapsible).toBe(true);
      expect(logSec21.uncollapsibleWidgetsCount).toBe(1);
      expect(logSec21.widgets).toHaveLength(21); // 1 active bar + 19 rows + 1 overflow notice
      expect(logSec21.widgets[1].decoratedText?.topLabel).toBe('Rev 20 • 071200-001 • Open');
      expect(logSec21.widgets[19].decoratedText?.topLabel).toBe('Rev 2 • 071200-001 • Open');

      const overflow = logSec21.widgets[20].decoratedText!;
      expect(overflow.text).toBe('Showing 19 of 21 entries');
      expect(overflow.button?.text).toBe('Open Log');
      expect(getOpenLinkUrl(overflow)).toBe(LOG_PRIMARY_URL);
      expect(findProcessButton(card21)?.disabled).not.toBe(true);

      // 20 entries at remainingHistorySlots === 20 -> 20 newest rows + NO overflow notice, totalCardWidgets === 100
      mockSingleLogDriveDiscovery();
      mockPositiveTableRead(LOG_PRIMARY_ID, rows20);

      const { card: card20, totalCardWidgets: total20 } = await injectOnFormChange(app, host);
      assertFixedSectionsIntact(card20, extraFieldCount);
      assertLogSectionPositionedBetweenFileSelectionAndDocData(card20);
      expect(total20).toBe(100);

      const logSec20 = findSection(card20, 'Document Log')!;
      expect(logSec20.collapsible).toBe(true);
      expect(logSec20.uncollapsibleWidgetsCount).toBe(1);
      expect(logSec20.widgets).toHaveLength(21); // 1 active bar + 20 rows
      expect(logSec20.widgets[1].decoratedText?.topLabel).toBe('Rev 19 • 071200-001 • Open');
      expect(logSec20.widgets[20].decoratedText?.topLabel).toBe('Rev 0 • 071200-001 • Open');
      expect(logSec20.widgets.some((w) => w.decoratedText?.text.includes('Showing'))).toBe(false);
    }

    expect(nock.isDone()).toBe(true);
  });

  it('caps at 20 newest rows + 1 overflow for 25 entries with ample widget budget (Drive & Gmail)', async () => {
    const app = await createAppWithCustomFieldCount(0);
    const rows25 = buildArchSheetRows(25);

    for (const host of ['DRIVE', 'GMAIL'] as const) {
      mockSingleLogDriveDiscovery();
      mockPositiveTableRead(LOG_PRIMARY_ID, rows25);

      const { card, totalCardWidgets } = await injectOnFormChange(app, host);
      assertFixedSectionsIntact(card, 0);
      assertLogSectionPositionedBetweenFileSelectionAndDocData(card);
      expect(totalCardWidgets).toBeLessThanOrEqual(100);
      expect(totalCardWidgets).toBe(host === 'DRIVE' ? 37 : 40);

      const logSec = findSection(card, 'Document Log')!;
      expect(logSec.collapsible).toBe(true);
      expect(logSec.uncollapsibleWidgetsCount).toBe(1);
      expect(logSec.widgets).toHaveLength(22); // 1 active bar + 20 rows + 1 overflow notice
      expect(logSec.widgets[1].decoratedText?.topLabel).toBe('Rev 24 • 071200-001 • Open');
      expect(logSec.widgets[20].decoratedText?.topLabel).toBe('Rev 5 • 071200-001 • Open');

      const overflow = logSec.widgets[21].decoratedText!;
      expect(overflow.text).toBe('Showing 20 of 25 entries');
      expect(overflow.button?.text).toBe('Open Log');
      expect(getOpenLinkUrl(overflow)).toBe(LOG_PRIMARY_URL);
    }

    expect(nock.isDone()).toBe(true);
  });

  it('handles rawBudget === 1 (extraFieldCount = 83, Drive, resolved) with 5 entries (0 rows + overflow) and 1 entry (1 row + no overflow)', async () => {
    const app = await createAppWithCustomFieldCount(83);

    // 5 entries -> 0 rows + 1 overflow notice ("Showing 0 of 5 entries")
    mockSingleLogDriveDiscovery();
    mockPositiveTableRead(LOG_PRIMARY_ID, buildArchSheetRows(5));

    const { card: card5, totalCardWidgets: total5 } = await injectOnFormChange(app, 'DRIVE');
    assertFixedSectionsIntact(card5, 83);
    assertLogSectionPositionedBetweenFileSelectionAndDocData(card5);
    expect(total5).toBe(100);

    const logSec5 = findSection(card5, 'Document Log')!;
    expect(logSec5.widgets).toHaveLength(2); // active bar + overflow notice
    expect(logSec5.collapsible).toBeUndefined();
    expect(logSec5.uncollapsibleWidgetsCount).toBeUndefined();
    expect(logSec5.widgets[1].decoratedText?.text).toBe('Showing 0 of 5 entries');
    expect(logSec5.widgets[1].decoratedText?.button?.text).toBe('Open Log');
    expect(getOpenLinkUrl(logSec5.widgets[1].decoratedText)).toBe(LOG_PRIMARY_URL);

    // 1 entry -> 1 row + NO overflow notice
    mockSingleLogDriveDiscovery();
    mockPositiveTableRead(LOG_PRIMARY_ID, buildArchSheetRows(1));

    const { card: card1, totalCardWidgets: total1 } = await injectOnFormChange(app, 'DRIVE');
    assertFixedSectionsIntact(card1, 83);
    assertLogSectionPositionedBetweenFileSelectionAndDocData(card1);
    expect(total1).toBe(100);

    const logSec1 = findSection(card1, 'Document Log')!;
    expect(logSec1.widgets).toHaveLength(2); // active bar + 1 row
    expect(logSec1.collapsible).toBe(true);
    expect(logSec1.uncollapsibleWidgetsCount).toBe(1);
    expect(logSec1.widgets[1].decoratedText?.topLabel).toBe('Rev 0 • 071200-001 • Open');
    expect(logSec1.widgets[1].decoratedText?.text).toBe('<b>Received</b> 260201 (ARC)');

    expect(nock.isDone()).toBe(true);
  });

  it('handles rawBudget === 0 (extraFieldCount = 84, Drive, resolved) with 5 entries by omitting rows and overflow without negative slice', async () => {
    const app = await createAppWithCustomFieldCount(84);

    mockSingleLogDriveDiscovery();
    mockPositiveTableRead(LOG_PRIMARY_ID, buildArchSheetRows(5));

    const { card, totalCardWidgets } = await injectOnFormChange(app, 'DRIVE');
    assertFixedSectionsIntact(card, 84);
    assertLogSectionPositionedBetweenFileSelectionAndDocData(card);
    expect(totalCardWidgets).toBe(100);

    const logSec = findSection(card, 'Document Log')!;
    expect(logSec.widgets).toHaveLength(1); // active bar only
    expect(logSec.widgets[0].decoratedText?.text).toBe('<b>A &amp; B Tower Document Log</b>');
    expect(logSec.collapsible).toBeUndefined();
    expect(logSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(nock.isDone()).toBe(true);
  });

  it('omits Document Log section completely when maxWidgets <= 0 (Drive maxWidgets = 0, Gmail maxWidgets = 0, Drive maxWidgets = -1)', async () => {
    const driveZeroApp = await createAppWithCustomFieldCount(85);
    const gmailZeroApp = await createAppWithCustomFieldCount(82);
    const driveNegApp = await createAppWithCustomFieldCount(86);

    const rows = buildArchSheetRows(5);

    for (const [host, app, extraFieldCount, expectedTotal] of [
      ['DRIVE', driveZeroApp, 85, 100],
      ['GMAIL', gmailZeroApp, 82, 100],
      ['DRIVE', driveNegApp, 86, 101],
    ] as const) {
      mockSingleLogDriveDiscovery();
      mockPositiveTableRead(LOG_PRIMARY_ID, rows);

      const { card, totalCardWidgets } = await injectOnFormChange(app, host);
      assertFixedSectionsIntact(card, extraFieldCount);
      expect(findSection(card, 'Document Log')).toBeUndefined();
      expect(card.sections.every((s) => s.widgets.length > 0)).toBe(true);
      expect(totalCardWidgets).toBe(expectedTotal);
      expect(findProcessButton(card)?.disabled).not.toBe(true);
    }

    expect(nock.isDone()).toBe(true);
  });

  it('handles ambiguous + partial_hydration + overflow at exact 100-widget cap (extraFieldCount = 62) and clamps when maxWidgets < logFixedWidgets (extraFieldCount = 83)', async () => {
    // 1. Exact 100-widget cap: fixed = 77, maxWidgets = 23, logFixedWidgets = 3 -> rawBudget = 20
    const capApp = await createAppWithCustomFieldCount(62);
    const partialRows21 = buildArchSheetRows(21, { invalidActionAtIndex: 10 });

    mockAmbiguousLogDriveDiscovery();
    mockPositiveTableRead(LOG_PRIMARY_ID, partialRows21);

    const { card: capCard, totalCardWidgets: capTotal } = await injectOnFormChange(capApp, 'DRIVE');
    assertFixedSectionsIntact(capCard, 62);
    assertLogSectionPositionedBetweenFileSelectionAndDocData(capCard);
    expect(capTotal).toBe(100);

    const capLogSec = findSection(capCard, 'Document Log')!;
    expect(capLogSec.collapsible).toBe(true);
    expect(capLogSec.uncollapsibleWidgetsCount).toBe(3);
    expect(capLogSec.widgets).toHaveLength(23); // dropdown + active bar + partial warning + 19 rows + 1 overflow
    expect(capLogSec.widgets[0].selectionInput?.name).toBe(SELECT_DOCUMENT_LOG_KEY);
    expect(capLogSec.widgets[1].decoratedText?.text).toBe('<b>A &amp; B Tower Document Log</b>');
    expect(capLogSec.widgets[2].textParagraph?.text).toContain('Partial read (1 warning)');
    expect(capLogSec.widgets[3].decoratedText?.topLabel).toBe('Rev 20 • 071200-001 • Open');
    expect(capLogSec.widgets[21].decoratedText?.topLabel).toBe('Rev 2 • 071200-001 • Open');

    const overflow = capLogSec.widgets[22].decoratedText!;
    expect(overflow.text).toBe('Showing 19 of 21 entries');
    expect(overflow.button?.text).toBe('Open Log');
    expect(getOpenLinkUrl(overflow)).toBe(LOG_PRIMARY_URL);
    expect(findProcessButton(capCard)?.disabled).not.toBe(true);

    // 2. maxWidgets < logFixedWidgets: fixed = 98, maxWidgets = 2, logFixedWidgets = 3 -> clamped to 2 widgets
    const tightApp = await createAppWithCustomFieldCount(83);
    const partialRows5 = buildArchSheetRows(5, { invalidActionAtIndex: 2 });

    mockAmbiguousLogDriveDiscovery();
    mockPositiveTableRead(LOG_PRIMARY_ID, partialRows5);

    const { card: tightCard, totalCardWidgets: tightTotal } = await injectOnFormChange(tightApp, 'DRIVE');
    assertFixedSectionsIntact(tightCard, 83);
    assertLogSectionPositionedBetweenFileSelectionAndDocData(tightCard);
    expect(tightTotal).toBe(100);

    const tightLogSec = findSection(tightCard, 'Document Log')!;
    expect(tightLogSec.widgets).toHaveLength(2); // clamped to SelectDocumentLog + active bar
    expect(tightLogSec.widgets[0].selectionInput?.name).toBe(SELECT_DOCUMENT_LOG_KEY);
    expect(tightLogSec.widgets[1].decoratedText?.text).toBe('<b>A &amp; B Tower Document Log</b>');
    expect(tightLogSec.collapsible).toBeUndefined();
    expect(tightLogSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(tightLogSec.widgets.some((w) => w.decoratedText?.text.includes('Showing'))).toBe(false);
    expect(findProcessButton(tightCard)?.disabled).not.toBe(true);

    expect(nock.isDone()).toBe(true);
  });

  it('clamps missing status to 1 widget at maxWidgets = 1 (extraFieldCount = 84) while keeping Process Document disabled', async () => {
    const app = await createAppWithCustomFieldCount(84);

    mockMissingLogDriveDiscovery();

    const { card, totalCardWidgets } = await injectOnFormChange(app, 'DRIVE');
    assertFixedSectionsIntact(card, 84);
    assertLogSectionPositionedBetweenFileSelectionAndDocData(card);
    expect(totalCardWidgets).toBe(100);

    const logSec = findSection(card, 'Document Log')!;
    expect(logSec.widgets).toHaveLength(1);
    expect(logSec.widgets[0].decoratedText?.topLabel).toBe('No Document Log in A & B Tower');
    expect(logSec.widgets[0].decoratedText?.text).toBe(
      'Create <b>A &amp; B Tower Document Log</b> in <b>A &amp; B Tower</b>'
    );
    expect(logSec.collapsible).toBeUndefined();
    expect(logSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(findProcessButton(card)?.disabled).toBe(true);
    expect(nock.isDone()).toBe(true);
  });

  it('retains Copy Log on missing status at maxWidgets = 2 (extraFieldCount = 83) while keeping Process Document disabled', async () => {
    const app83 = await createAppWithCustomFieldCount(83);

    mockMissingLogDriveDiscovery();

    const { card, totalCardWidgets } = await injectOnFormChange(app83, 'DRIVE');
    assertFixedSectionsIntact(card, 83);
    assertLogSectionPositionedBetweenFileSelectionAndDocData(card);
    expect(totalCardWidgets).toBe(100);

    const logSec = findSection(card, 'Document Log')!;
    expect(logSec.widgets).toHaveLength(2);
    expect(logSec.widgets[0].decoratedText?.text).toContain(
      'Create <b>A &amp; B Tower Document Log</b>'
    );
    expect(logSec.widgets[1].buttonList?.buttons[0].text).toBe('Copy Log');
    expect(logSec.collapsible).toBeUndefined();
    expect(logSec.uncollapsibleWidgetsCount).toBeUndefined();
    expect(findProcessButton(card)?.disabled).toBe(true);
    expect(nock.isDone()).toBe(true);
  });
});

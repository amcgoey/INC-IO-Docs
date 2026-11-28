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
  GoogleWorkspaceCard,
  GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { PRIMARY_ACTION_BUTTON_COLOR } from '../src/features/schema-driven-ui/blocks/common';
import { createAnonymizedSubmittalCoverSheetPdf } from './fixtures/submittal-cover-sheet.fixture';

let cachedCoverSheetPdfBytes: Uint8Array | undefined;

interface ButtonWidgetShape {
  button?: {
    text?: string;
    color?: { red: number; green: number; blue: number };
    disabled?: boolean;
    onClick?: { openLink?: { url?: string } };
  };
}

function findProcessButton(card: GoogleWorkspaceCard) {
  for (const section of card.sections) {
    for (const widget of section.widgets) {
      const btn = (widget as { buttonList?: { buttons?: Array<NonNullable<ButtonWidgetShape['button']>> } })
        .buttonList?.buttons?.find((b) => b.text === 'Process Document');
      if (btn) {
        return btn;
      }
    }
  }
  return undefined;
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

function mockDriveHierarchyForArchSubmittal(options: {
  fileId: string;
  fileName: string;
  driveId: string;
  driveName: string;
  pdfBytes: Uint8Array;
}) {
  nock('https://www.googleapis.com')
    .get(`/drive/v3/files/${options.fileId}`)
    .query((q) => q.alt !== 'media')
    .reply(200, {
      id: options.fileId,
      name: options.fileName,
      mimeType: 'application/pdf',
      parents: [options.driveId],
      driveId: options.driveId,
      modifiedTime: '2026-11-18T15:00:00Z',
    });

  nock('https://www.googleapis.com')
    .get(`/drive/v3/files/${options.fileId}`)
    .query((q) => q.alt === 'media')
    .reply(200, Buffer.from(options.pdfBytes), { 'content-type': 'application/pdf' });
}

const CONFIG_ARCH_STATUS_VALUES = [
  ['Status'],
  ['Open'],
  ['Closed'],
  ['Waiting'],
  ['Manager'],
  ['---'],
];

const CONFIG_ARCH_ACTION_VALUES = [
  ['Key', 'Name', 'Suffix', 'Order'],
  ['REC', 'Received', '', '1'],
  ['REF', 'Referred', '_REF', '2'],
  ['NR', 'Not Reviewed', '_NR', '3'],
  ['REJ', 'Rejected', '_REJ', '4'],
  ['RR', 'Revise & Resubmit', '_RR', '5'],
  ['NOC', 'No Objections As Corrected', '_NOC', '6'],
  ['NET', 'No Exceptions Taken', '_NET', '7'],
  ['---', '', '', ''],
];

const CONFIG_ARCH_CONTACT_VALUES = [
  ['Type', 'Key', 'Name', 'Aliases'],
  ['INC', 'INC', 'INC Architecture and Design', ''],
  ['Contractor', 'PMG', 'Pavarini McGovern', ''],
  ['', '---', '', ''],
];

const CONFIG_ARCH_CSI_DIVISION_VALUES = [
  ['Division Number', 'Division Folder'],
  ['01', '01 General Requirements'],
  ['03', '03 Concrete'],
  ['07', '07 Thermal and Moisture Protection'],
  ['08', '08 Openings'],
  ['09', '09 Finishes'],
  ['---', ''],
];

function mockConfigSubmittalArchBatchGet(
  spreadsheetId: string,
  applyOpt: <T extends nock.Interceptor>(interceptor: T) => T = (i) => i
) {
  applyOpt(
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
      .query((q) => {
        if (q.valueRenderOption !== 'FORMATTED_VALUE') {
          return false;
        }
        const ranges = Array.isArray(q.ranges)
          ? q.ranges
          : typeof q.ranges === 'string'
            ? q.ranges.split(',')
            : [];
        return ranges.length > 0 && ranges.every((r) => String(r).includes('_Config Submittal Arch'));
      })
  ).reply(200, (uri) => {
    const url = new URL(uri, 'https://sheets.googleapis.com');
    const ranges = url.searchParams.getAll('ranges').flatMap((r) => r.split(','));
    return {
      valueRanges: ranges.map((range) => {
        if (range.includes('A3:A8')) {
          return { range, values: CONFIG_ARCH_STATUS_VALUES };
        }
        if (range.includes('C3:F11')) {
          return { range, values: CONFIG_ARCH_ACTION_VALUES };
        }
        if (range.includes('H3:K')) {
          return { range, values: CONFIG_ARCH_CONTACT_VALUES };
        }
        if (range.includes('M3:N')) {
          return { range, values: CONFIG_ARCH_CSI_DIVISION_VALUES };
        }
        return { range, values: [] };
      }),
    };
  });
}

function mockEmptyDocumentLogSheetsRead(spreadsheetId: string, options?: { optional?: boolean }) {
  const applyOpt = <T extends nock.Interceptor>(interceptor: T): T =>
    options?.optional ? (interceptor.optionally() as T) : interceptor;

  applyOpt(
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}`)
      .query(true)
      .times(2)
  ).reply(200, {
    spreadsheetId,
    sheets: [
      { properties: { sheetId: 101, title: 'Submittal Arch' } },
      { properties: { sheetId: 102, title: 'Submittal FF&E' } },
      { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
    ],
    namedRanges: [
      {
        namedRangeId: 'nr-arch',
        name: 'Log_Submittal_Arch',
        range: { sheetId: 101, startRowIndex: 2, endRowIndex: 21, startColumnIndex: 0, endColumnIndex: 11 },
      },
      {
        namedRangeId: 'nr-ffe',
        name: 'Log_Submittal_FFE',
        range: { sheetId: 102, startRowIndex: 2, endRowIndex: 21, startColumnIndex: 0, endColumnIndex: 12 },
      },
      {
        namedRangeId: 'nr-arch-statuses',
        name: 'Options_Submittal_Arch_Statuses',
        range: { sheetId: 103, startRowIndex: 2, endRowIndex: 8, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-arch-actions',
        name: 'Options_Submittal_Arch_Actions',
        range: { sheetId: 103, startRowIndex: 2, endRowIndex: 11, startColumnIndex: 2, endColumnIndex: 6 },
      },
      {
        namedRangeId: 'nr-arch-contacts',
        name: 'Options_Submittal_Arch_Contacts',
        range: { sheetId: 103, startRowIndex: 2, endRowIndex: 2 + CONFIG_ARCH_CONTACT_VALUES.length, startColumnIndex: 7, endColumnIndex: 11 },
      },
      {
        namedRangeId: 'nr-arch-csi-divisions',
        name: 'Options_Submittal_Arch_CSI_Divisions',
        range: { sheetId: 103, startRowIndex: 2, endRowIndex: 2 + CONFIG_ARCH_CSI_DIVISION_VALUES.length, startColumnIndex: 12, endColumnIndex: 14 },
      },
    ],
  });

  mockConfigSubmittalArchBatchGet(spreadsheetId, applyOpt);

  applyOpt(
    nock('https://sheets.googleapis.com')
      .get(new RegExp(`/v4/spreadsheets/${spreadsheetId}/values/.*`))
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
  ).reply(200, (uri) => {
    const isFfe = decodeURIComponent(uri).includes('Submittal FF&E');
    const headers = isFfe
      ? ['Status', 'Spec Tag', 'Related Tag', 'Revision', 'Spec Title', 'Vendor', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link']
      : ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'];
    return { values: [headers, ['Formula Row'], ['<--->'], [], ['<--->']] };
  });

  applyOpt(
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMULA')
  ).reply(200, {
    valueRanges: [{ values: [['Formula Row']] }],
  });
}

function mockSubmittalArchLogWrite(spreadsheetId: string) {
  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${spreadsheetId}`)
    .query(true)
    .times(2)
    .reply(200, {
      spreadsheetId,
      sheets: [
        { properties: { sheetId: 101, title: 'Submittal Arch' } },
        { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
      ],
      namedRanges: [
        {
          namedRangeId: 'nr-arch',
          name: 'Log_Submittal_Arch',
          range: {
            sheetId: 101,
            startRowIndex: 2,
            endRowIndex: 21,
            startColumnIndex: 0,
            endColumnIndex: 11,
          },
        },
        {
          namedRangeId: 'nr-arch-statuses',
          name: 'Options_Submittal_Arch_Statuses',
          range: {
            sheetId: 103,
            startRowIndex: 2,
            endRowIndex: 8,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
        },
        {
          namedRangeId: 'nr-arch-actions',
          name: 'Options_Submittal_Arch_Actions',
          range: {
            sheetId: 103,
            startRowIndex: 2,
            endRowIndex: 11,
            startColumnIndex: 2,
            endColumnIndex: 6,
          },
        },
        {
          namedRangeId: 'nr-arch-contacts',
          name: 'Options_Submittal_Arch_Contacts',
          range: {
            sheetId: 103,
            startRowIndex: 2,
            endRowIndex: 2 + CONFIG_ARCH_CONTACT_VALUES.length,
            startColumnIndex: 7,
            endColumnIndex: 11,
          },
        },
        {
          namedRangeId: 'nr-arch-csi-divisions',
          name: 'Options_Submittal_Arch_CSI_Divisions',
          range: {
            sheetId: 103,
            startRowIndex: 2,
            endRowIndex: 2 + CONFIG_ARCH_CSI_DIVISION_VALUES.length,
            startColumnIndex: 12,
            endColumnIndex: 14,
          },
        },
      ],
    });

  mockConfigSubmittalArchBatchGet(spreadsheetId);

  nock('https://sheets.googleapis.com')
    .get(new RegExp(`/v4/spreadsheets/${spreadsheetId}/values/.*`))
    .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
    .reply(200, {
      values: [
        [
          'Status',
          'Section',
          'Number',
          'Revision',
          'Title',
          'Date',
          'Contact',
          'Action',
          'Notes',
          'Calc Link',
        ],
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

  const captured: Array<Record<string, unknown>> = [];
  nock('https://sheets.googleapis.com')
    .post(`/v4/spreadsheets/${spreadsheetId}:batchUpdate`, (body) => {
      captured.push(body as Record<string, unknown>);
      return true;
    })
    .reply(200, {});

  return captured;
}

function mockInsertCoverSheetNock(options: {
  copyFileId: string;
  copyFileName: string;
  copyParentId: string;
  pdfBytes: Uint8Array;
}): void {
  const { copyFileId, copyFileName, copyParentId, pdfBytes } = options;

  nock('https://www.googleapis.com')
    .get('/drive/v3/files/test-cover-sheet-tpl')
    .query((q) => q.alt !== 'media')
    .times(2)
    .reply(200, {
      id: 'test-cover-sheet-tpl',
      name: 'Cover Sheet.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
    });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files/test-cover-sheet-tpl')
    .query((q) => q.alt === 'media')
    .reply(200, Buffer.from(pdfBytes));

  nock('https://www.googleapis.com')
    .get(`/drive/v3/files/${copyFileId}`)
    .query((q) => q.alt !== 'media')
    .times(2)
    .reply(200, {
      id: copyFileId,
      name: copyFileName,
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
      parents: [copyParentId],
    });

  nock('https://www.googleapis.com')
    .get(`/drive/v3/files/${copyFileId}`)
    .query((q) => q.alt === 'media')
    .reply(200, Buffer.from(pdfBytes));

  nock('https://www.googleapis.com')
    .patch(`/upload/drive/v3/files/${copyFileId}`)
    .query(true)
    .reply(200, {
      id: copyFileId,
      name: copyFileName,
      mimeType: 'application/pdf',
      parents: [copyParentId],
      webViewLink: `https://drive.google.com/file/d/${copyFileId}/view`,
    });
}

describe('Ticket #349 Tracer Bullet: UiContextQueryPort, Mid-Card Document Log Status Bar, Space Memoization & Pre-Flight Gating', () => {
  let app: AppInstance;
  let manifestProvider: AppManifestProvider;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;
  let mockGmailClient: Partial<GoogleGmailClient>;
  let flatPdfBytes: Uint8Array;

  beforeEach(async () => {
    nock.disableNetConnect();
    flatPdfBytes = await (await PDFDocument.create()).save();

    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return {
            isValid: true,
            payload: { email: 'user@inc.nyc', sub: 'user-349' },
          };
        }
        return { isValid: false, error: 'Unauthorized' };
      }),
    };

    mockGmailClient = {
      getThread: vi.fn().mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-non-logging') {
          return {
            id: threadId,
            messages: [
              {
                id: 'msg-non-logging',
                threadId,
                subject: 'Project Meeting Notes',
                from: 'Alice <alice@example.com>',
                to: 'Bob <pm@inc.nyc>',
                date: 'Tue, 20 Oct 2026 14:00:00 -0400',
                labels: ['INBOX', 'Active Projects'],
                plainTextBody: 'Weekly project notes attached.',
                inlineImages: [],
                attachments: [],
              },
            ],
          };
        }
        if (threadId === 'th-arch-missing-space') {
          return {
            id: threadId,
            messages: [
              {
                id: 'msg-arch-missing-space',
                threadId,
                subject: '071200-001-A Waterproofing Specs',
                from: 'James McGovern <jmcgovern@pavarini.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 20 Oct 2026 14:00:00 -0400',
                labels: ['INBOX'],
                plainTextBody: 'Submittal attached.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-arch-1',
                    attachmentId: 'att-arch-1',
                    filename: '071200-001-A Waterproofing.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return {
          id: threadId,
          messages: [
            {
              id: 'msg-arch-with-space',
              threadId,
              subject: 'Submittal 071200-001-A Waterproofing',
              from: 'James McGovern <jmcgovern@pavarini.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Tue, 20 Oct 2026 14:00:00 -0400',
              labels: ['INBOX', 'Harbor & <Bay> "Hotel" \'Log\''],
              plainTextBody: 'Waterproofing submittal attached.',
              inlineImages: [],
              attachments: [
                {
                  partId: 'part-arch-1',
                  attachmentId: 'att-arch-1',
                  filename: '071200-001-A Waterproofing.pdf',
                  mimeType: 'application/pdf',
                  size: 1024,
                },
              ],
            },
          ],
        };
      }),
      getMessage: vi.fn().mockImplementation(async (messageId: string) => ({
        id: messageId,
        messageId,
        inlineImages: [],
        attachments: [
          {
            partId: 'part-arch-1',
            attachmentId: 'att-arch-1',
            filename: '071200-001-A Waterproofing.pdf',
            mimeType: 'application/pdf',
            size: 1024,
          },
        ],
      })),
      getAttachment: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
    };

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    manifestProvider = new AppManifestProvider({ manifestPath });

    // Intentionally omit storageAdapter so real createDocumentSpaceServiceFactory
    // + WeakMap per-request memoization + Gmail accessToken parity execute end-to-end.
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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('omits Document Log section with zero Drive/Sheets queries on non-logging types and styles Process Document primary blue & enabled (Drive + Gmail)', async () => {
    // 1. Drive non-logging (communication-project): Pass 1 + memoized DocumentSpaceService = 2 /drives calls, 0 Document Log searches
    const driveListDrives = nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(2)
      .reply(200, { drives: [{ id: 'drive-proj-1', name: 'Active Projects' }] });

    nock('https://www.googleapis.com')
      .get('/drive/v3/files/file-comm-1')
      .query((q) => q.alt !== 'media')
      .reply(200, {
        id: 'file-comm-1',
        name: 'Meeting Notes.pdf',
        mimeType: 'application/pdf',
        parents: ['drive-proj-1'],
        driveId: 'drive-proj-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });

    const driveRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-comm-1', title: 'Meeting Notes.pdf' }] },
      },
    });
    expect(driveRes.statusCode).toBe(200);
    const driveCard = getCard(driveRes.payload, 'pushCard');
    expect(findSection(driveCard, 'Document Log')).toBeUndefined();
    const driveBtn = findProcessButton(driveCard);
    expect(driveBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    expect(driveBtn?.disabled).not.toBe(true);
    expect(driveListDrives.isDone()).toBe(true);

    // 2. Gmail non-logging (communication-project)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: 'drive-proj-1', name: 'Active Projects' }] });

    const gmailRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-non-logging',
          threadId: 'th-non-logging',
          accessToken: 'ya29.gmail-only-token',
        },
      },
    });
    expect(gmailRes.statusCode).toBe(200);
    const gmailCard = getCard(gmailRes.payload, 'pushCard');
    expect(findSection(gmailCard, 'Document Log')).toBeUndefined();
    const gmailBtn = findProcessButton(gmailCard);
    expect(gmailBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    expect(gmailBtn?.disabled).not.toBe(true);

    // 3. Gmail non-logging (communication-proposal)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: 'drive-mkt-1', name: 'INC Marketing' }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name = 'Opportunities'"))
      .reply(200, { files: [{ id: 'opp-root', name: 'Opportunities' }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'opp-root' in parents"))
      .reply(200, { files: [{ id: 'prop-space-1', name: 'Hotel Proposal' }] });

    const proposalRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-non-logging',
          threadId: 'th-non-logging',
          accessToken: 'ya29.gmail-only-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'onSpaceTypeChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            [getDocumentSpaceWidgetName('proposals')]: { stringInputs: { value: ['Hotel Proposal'] } },
            [getDocumentTypeWidgetName('proposals')]: { stringInputs: { value: ['communication-proposal'] } },
          },
        },
      },
    });
    expect(proposalRes.statusCode).toBe(200);
    const proposalCard = getCard(proposalRes.payload, 'updateCard');
    expect(findSection(proposalCard, 'Document Log')).toBeUndefined();
    const proposalBtn = findProcessButton(proposalCard);
    expect(proposalBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    expect(proposalBtn?.disabled).not.toBe(true);
    expect(nock.isDone()).toBe(true);
  });

  it('memoizes DocumentSpaceService.getCollection per request for both Drive and Gmail accessToken parity across multiple logging requests', async () => {
    const driveId = 'drive-memo-1';
    const spaceName = 'Harbor & <Bay> "Hotel" \'Log\'';

    // Request 1 (Drive action): listSharedDrives called ONCE even though UiProcessManager + UiContextQueryAdapter both read projects spaces
    const req1Drives = nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/arch-memo-1')
      .query((q) => q.alt === 'media')
      .reply(200, Buffer.from(flatPdfBytes), { 'content-type': 'application/pdf' });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/arch-memo-1')
      .query((q) => q.alt !== 'media')
      .reply(200, {
        id: 'arch-memo-1',
        name: '071200-001_Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: [driveId],
        driveId,
        modifiedTime: '2026-11-18T15:00:00Z',
      });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1)
      .reply(200, { files: [] });

    const r1 = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-memo-1', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: { action: 'onDocumentTypeChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['arch-memo-1'] } },
          },
        },
      },
    });
    expect(r1.statusCode).toBe(200);
    const r1Card = getCard(r1.payload, 'updateCard');
    expect(findSection(r1Card, 'Document Log')).toBeDefined();
    expect(req1Drives.isDone()).toBe(true);

    // Request 2 (Gmail with ONLY gmail.accessToken, NO userOAuthToken): fresh getCollection issues exactly 1 Drive listing
    const req2Drives = nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1)
      .reply(200, { files: [] });

    const r2 = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-arch-with-space',
          threadId: 'th-arch-with-space',
          accessToken: 'ya29.gmail-only-token',
        },
      },
    });
    expect(r2.statusCode).toBe(200);
    expect(req2Drives.isDone()).toBe(true);
    expect(nock.isDone()).toBe(true);
  });

  it('renders identical missing_space Document Log section between File Selection and Document Data and disables Process Document (Drive + Gmail)', async () => {
    // 1. Drive missing_space: unmatched parent folder + CSI filename infers submittal-arch with no space selected
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/arch-no-space')
      .query((q) => q.alt !== 'media')
      .reply(200, {
        id: 'arch-no-space',
        name: '071200-001_Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['unmatched-folder-id'],
        modifiedTime: '2026-11-18T15:00:00Z',
      });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/unmatched-folder-id')
      .query(true)
      .reply(200, {
        id: 'unmatched-folder-id',
        name: 'Random Folder',
        parents: [],
        mimeType: 'application/vnd.google-apps.folder',
      });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/arch-no-space')
      .query((q) => q.alt === 'media')
      .reply(200, Buffer.from(flatPdfBytes), { 'content-type': 'application/pdf' });
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: 'drive-1', name: 'Harbor Hotel' }] });

    const driveRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-no-space', title: '071200-001_Waterproofing.pdf' }] },
      },
    });
    expect(driveRes.statusCode).toBe(200);
    const driveCard = getCard(driveRes.payload, 'pushCard');

    // 2. Gmail missing_space: email without matching space label + CSI attachment infers submittal-arch with no space
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: 'drive-1', name: 'Harbor Hotel' }] });

    const gmailRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-arch-missing-space',
          threadId: 'th-arch-missing-space',
          accessToken: 'ya29.gmail-only-token',
        },
      },
    });
    expect(gmailRes.statusCode).toBe(200);
    const gmailCard = getCard(gmailRes.payload, 'pushCard');

    for (const card of [driveCard, gmailCard]) {
      const headers = card.sections.map((s) => s.header);
      const fileSelIdx = headers.indexOf('File Selection');
      const docLogIdx = headers.indexOf('Document Log');
      const docDataIdx = headers.indexOf('Document Data');
      expect(fileSelIdx).toBeGreaterThanOrEqual(0);
      expect(docLogIdx).toBe(fileSelIdx + 1);
      expect(docDataIdx).toBe(docLogIdx + 1);

      const logSection = findSection(card, 'Document Log')!;
      expect(JSON.stringify(logSection)).toContain('Select a <b>Document Space</b>');
      const btn = findProcessButton(card);
      expect(btn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
      expect(btn?.disabled).toBe(true);
    }

    expect(findSection(driveCard, 'Document Log')).toEqual(findSection(gmailCard, 'Document Log'));
    expect(nock.isDone()).toBe(true);
  });

  it('escapes HTML in missing guidance with Process Document disabled and blocks submission before MOVE_FILE (Drive + Gmail)', async () => {
    const driveId = 'drive-missing-1';
    const rawSpaceName = 'Harbor & <Bay> "Hotel" \'Log\'';

    // Drive initial render -> missing Document Log (Pass 1 + memoized DocumentSpaceService = 2 /drives calls)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(2)
      .reply(200, { drives: [{ id: driveId, name: rawSpaceName }] });
    mockDriveHierarchyForArchSubmittal({
      fileId: 'arch-missing-file',
      fileName: '071200-001_Waterproofing.pdf',
      driveId,
      driveName: rawSpaceName,
      pdfBytes: flatPdfBytes,
    });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .reply(200, { files: [] });

    const renderRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-missing-file', title: '071200-001_Waterproofing.pdf' }] },
      },
    });
    expect(renderRes.statusCode).toBe(200);
    const renderCard = getCard(renderRes.payload, 'pushCard');
    const logSection = findSection(renderCard, 'Document Log')!;
    expect(logSection.widgets).toHaveLength(2);
    const dWidget = logSection.widgets[0].decoratedText!;

    expect(dWidget.text).toContain('Harbor &amp; &lt;Bay&gt; &quot;Hotel&quot; &#39;Log&#39; Document Log');
    expect(dWidget.text).toContain('Harbor &amp; &lt;Bay&gt; &quot;Hotel&quot; &#39;Log&#39;');
    expect(dWidget.topLabel).toBe(`No Document Log in ${rawSpaceName}`);
    expect(dWidget.bottomLabel).toBe('Folder: 1 Admin');
    expect(logSection.widgets[1].buttonList?.buttons[0].text).toBe('Copy Log');
    expect(findProcessButton(renderCard)?.disabled).toBe(true);

    // Drive processDocument submission when log missing -> pre-flight blocks BEFORE MOVE_FILE (zero folder list or PATCH calls!)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: rawSpaceName }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1) // pre-flight resolveLog (memoized for re-render queryUiContext + readOptionTables)
      .reply(200, { files: [] });

    const driveSubmitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-missing-file', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [rawSpaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['arch-missing-file'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261118'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
          },
        },
      },
    });
    expect(driveSubmitRes.statusCode).toBe(200);
    const updatedDriveCard = getCard(driveSubmitRes.payload, 'updateCard');
    expect(JSON.stringify(updatedDriveCard)).toContain('No DocumentLog spreadsheet found');
    expect(
      findSection(updatedDriveCard, 'Document Data')?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch')
      )?.textInput?.value
    ).toBe('Waterproofing');

    // Gmail processDocument submission when log missing -> pre-flight blocks BEFORE MOVE_FILE (zero getAttachment / upload!)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: rawSpaceName }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1)
      .reply(200, { files: [] });

    const gmailSubmitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-arch-with-space',
          threadId: 'th-arch-with-space',
          accessToken: 'ya29.gmail-only-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [rawSpaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            SaveEmailToPdf: { stringInputs: { value: ['false'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Gmail Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261118'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
          },
        },
      },
    });
    expect(gmailSubmitRes.statusCode).toBe(200);
    expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
    const updatedGmailCard = getCard(gmailSubmitRes.payload, 'updateCard');
    expect(JSON.stringify(updatedGmailCard)).toContain('No DocumentLog spreadsheet found');
    expect(
      findSection(updatedGmailCard, 'Document Data')?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch')
      )?.textInput?.value
    ).toBe('Gmail Waterproofing');
    expect(nock.isDone()).toBe(true);
  });

  it('degrades discovery_error non-blockingly during render with escaped error & enabled button, then catches submit pre-flight error as updateCard (Drive + Gmail)', async () => {
    const driveId = 'drive-err-1';
    const spaceName = 'Harbor & <Bay> "Hotel" \'Log\'';

    // Drive render: 403 on Document Log discovery -> graceful discovery_error banner, Process Document ENABLED
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(2)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });
    mockDriveHierarchyForArchSubmittal({
      fileId: 'arch-err-file',
      fileName: '071200-001_Waterproofing.pdf',
      driveId,
      driveName: spaceName,
      pdfBytes: flatPdfBytes,
    });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .reply(403, { error: { code: 403, message: 'Forbidden <alert>' } });

    const driveRenderRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-err-file', title: '071200-001_Waterproofing.pdf' }] },
      },
    });
    expect(driveRenderRes.statusCode).toBe(200);
    const driveRenderCard = getCard(driveRenderRes.payload, 'pushCard');
    const logSec = findSection(driveRenderCard, 'Document Log')!;
    expect(logSec.widgets[0].textParagraph?.text).toContain('Document Log lookup unavailable:');
    expect(logSec.widgets[0].textParagraph?.text).toContain('&lt;alert&gt;');
    const driveBtn = findProcessButton(driveRenderCard);
    expect(driveBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    expect(driveBtn?.disabled).not.toBe(true);

    // Gmail submit: pre-flight 403 returns updateCard error preserving inputs instead of crashing to buildErrorCard
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(2)
      .reply(403, { error: { code: 403, message: 'Forbidden <alert>' } });

    const gmailSubmitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-arch-with-space',
          threadId: 'th-arch-with-space',
          accessToken: 'ya29.gmail-only-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            SaveEmailToPdf: { stringInputs: { value: ['false'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Preserved Title'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261118'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
          },
        },
      },
    });
    expect(gmailSubmitRes.statusCode).toBe(200);
    const updatedCard = getCard(gmailSubmitRes.payload, 'updateCard');
    expect(JSON.stringify(updatedCard)).toContain('&lt;alert&gt;');
    expect(
      findSection(updatedCard, 'Document Data')?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch')
      )?.textInput?.value
    ).toBe('Preserved Title');
    expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
    expect(nock.isDone()).toBe(true);
  });

  it('blocks un-disambiguated or stale ambiguous Document Logs in pre-flight even if SelectDocumentLog is spoofed, deletes stale selection, and rejects MOVE_FILE', async () => {
    const driveId = 'drive-ambig-1';
    const spaceName = 'Harbor Hotel';

    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1)
      .reply(200, {
        files: [
          {
            id: 'log-a',
            name: 'Harbor Hotel Document Log A',
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
          {
            id: 'log-b',
            name: 'Harbor Hotel Document Log B',
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
        ],
      });
    mockEmptyDocumentLogSheetsRead('log-a');

    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-ambig-file', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['arch-ambig-file'] } },
            // Spoofing a non-live/stale SelectDocumentLog must NOT bypass resolveLog or inject selectedLogId into ExecutionContext
            SelectDocumentLog: { stringInputs: { value: ['log-spoofed-stale'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261118'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
          },
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const ambigCard = getCard(res.payload, 'updateCard');
    expect(JSON.stringify(ambigCard)).toContain('Multiple DocumentLog spreadsheets found');
    expect(JSON.stringify(ambigCard)).not.toContain('log-spoofed-stale');
    expect(nock.isDone()).toBe(true);
  });

  it('renders resolved Document Log bar with Open Log URL (webViewLink & fallback) and forwards selectedLogId on submit skipping duplicate Drive search (Drive + Gmail)', async () => {
    vi.stubEnv('SUBMITTAL_COVER_SHEET_TEMPLATE_ID', 'test-cover-sheet-tpl');
    cachedCoverSheetPdfBytes ??= await createAnonymizedSubmittalCoverSheetPdf();
    const coverSheetPdfBytes = cachedCoverSheetPdfBytes;

    const driveId = 'drive-resolved-1';
    const rawSpaceName = 'Harbor & <Bay> Hotel';
    const logId = 'sheet-log-349';

    // 1. Render (omits webViewLink -> verifies fallback URL https://docs.google.com/spreadsheets/d/${logId}/edit)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(2)
      .reply(200, { drives: [{ id: driveId, name: rawSpaceName }] });
    mockDriveHierarchyForArchSubmittal({
      fileId: 'arch-res-file',
      fileName: '071200-001_Waterproofing.pdf',
      driveId,
      driveName: rawSpaceName,
      pdfBytes: flatPdfBytes,
    });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1)
      .reply(200, {
        files: [
          {
            id: logId,
            name: 'Harbor & <Bay> Document Log',
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
        ],
      });
    mockEmptyDocumentLogSheetsRead(logId);

    const renderRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-res-file', title: '071200-001_Waterproofing.pdf' }] },
      },
    });
    expect(renderRes.statusCode).toBe(200);
    const renderCard = getCard(renderRes.payload, 'pushCard');
    const logSec = findSection(renderCard, 'Document Log')!;
    const bar = logSec.widgets[0].decoratedText!;
    expect(bar.topLabel).toBe(`Active Document Log · ${rawSpaceName}`);
    expect(bar.text).toBe('<b>Harbor &amp; &lt;Bay&gt; Document Log</b>');
    expect(bar.button?.text).toBe('Open Log');
    expect((bar.button?.onClick as { openLink?: { url?: string } } | undefined)?.openLink?.url).toBe(
      `https://docs.google.com/spreadsheets/d/${logId}/edit`
    );
    const renderBtn = findProcessButton(renderCard);
    expect(renderBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    expect(renderBtn?.disabled).not.toBe(true);

    // 2. Drive processDocument submission:
    // ONLY ONE Drive "Document Log" search executes (in pre-flight), and WRITE_LOG skips duplicate search via selectedLogId!
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: rawSpaceName }] });
    const driveSearch = nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1)
      .reply(200, {
        files: [
          {
            id: logId,
            name: 'Harbor & <Bay> Document Log',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            webViewLink: `https://docs.google.com/spreadsheets/d/${logId}/edit`,
          },
        ],
      });

    // MOVE_FILE & DUPLICATE_FILE mocks for submittal-arch: ['6 Construction', 'Submittals']
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${driveId}' in parents`) && q.q.includes("name = '6 Construction'"))
      .times(2)
      .reply(200, { files: [{ id: 'folder-6-const', name: '6 Construction', parents: [driveId] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'folder-6-const' in parents") && q.q.includes("name = 'Submittals'"))
      .times(2)
      .reply(200, { files: [{ id: 'folder-submittals', name: 'Submittals', parents: ['folder-6-const'] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'folder-submittals' in parents") && q.q.includes("name = 'Closed'"))
      .reply(200, { files: [{ id: 'folder-closed', name: 'Closed', parents: ['folder-submittals'] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'folder-closed' in parents") && q.q.includes("name = '07 Thermal and Moisture Protection'"))
      .reply(200, { files: [{ id: 'folder-csi-07', name: '07 Thermal and Moisture Protection', parents: ['folder-closed'] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/arch-res-file')
      .query(true)
      .times(2)
      .reply(200, {
        id: 'arch-res-file',
        name: '071200-001_Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['unfiled-folder'],
      });
    nock('https://www.googleapis.com')
      .patch('/drive/v3/files/arch-res-file')
      .query(true)
      .reply(200, {
        id: 'arch-res-file',
        name: '071200-001_Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-csi-07'],
        webViewLink: 'https://drive.google.com/file/d/arch-res-file/view',
      });
    nock('https://www.googleapis.com')
      .post('/drive/v3/files/arch-res-file/copy')
      .query(true)
      .reply(200, (_uri, body) => {
        const reqBody = body as { name?: string; parents?: string[] };
        return {
          id: 'arch-res-file-copy',
          name: reqBody.name ?? '_071200-001_Waterproofing.pdf',
          mimeType: 'application/pdf',
          parents: reqBody.parents ?? ['folder-submittals'],
          webViewLink: 'https://drive.google.com/file/d/arch-res-file-copy/view',
        };
      });
    mockInsertCoverSheetNock({
      copyFileId: 'arch-res-file-copy',
      copyFileName: '_071200-001_Waterproofing.pdf',
      copyParentId: 'folder-submittals',
      pdfBytes: coverSheetPdfBytes,
    });

    const driveCapturedSheets = mockSubmittalArchLogWrite(logId);

    const driveSubmitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'arch-res-file', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [rawSpaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['arch-res-file'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['A'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261118'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
          },
        },
      },
    });
    expect(driveSubmitRes.statusCode).toBe(200);
    const driveSubmitBody = JSON.parse(driveSubmitRes.payload) as GoogleWorkspaceActionResponse;
    expect(driveSubmitBody.action?.notification).toBeUndefined();
    expect(driveSubmitBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe(
      'Submittal Arch Filed'
    );
    expect(driveSearch.isDone()).toBe(true);
    expect(driveCapturedSheets).toHaveLength(1);
    expect(JSON.stringify(driveCapturedSheets[0])).toContain('071200');
    expect(nock.isDone()).toBe(true);

    // 3. Gmail processDocument submission (gmail.accessToken parity):
    // Also executes ONLY ONE Drive "Document Log" search and writes into Sheets via selectedLogId pass-through
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: rawSpaceName }] });
    const gmailSearch = nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'") && q.driveId === driveId)
      .times(1)
      .reply(200, {
        files: [
          {
            id: logId,
            name: 'Harbor & <Bay> Document Log',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            webViewLink: `https://docs.google.com/spreadsheets/d/${logId}/edit`,
          },
        ],
      });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes(`'${driveId}' in parents`) && q.q.includes("name = '6 Construction'"))
      .times(2)
      .reply(200, { files: [{ id: 'folder-6-const', name: '6 Construction', parents: [driveId] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'folder-6-const' in parents") && q.q.includes("name = 'Submittals'"))
      .times(2)
      .reply(200, { files: [{ id: 'folder-submittals', name: 'Submittals', parents: ['folder-6-const'] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'folder-submittals' in parents") && q.q.includes("name = 'Closed'"))
      .reply(200, { files: [{ id: 'folder-closed', name: 'Closed', parents: ['folder-submittals'] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'folder-closed' in parents") && q.q.includes("name = '07 Thermal and Moisture Protection'"))
      .reply(200, { files: [{ id: 'folder-csi-07', name: '07 Thermal and Moisture Protection', parents: ['folder-closed'] }] });
    nock('https://www.googleapis.com')
      .post('/upload/drive/v3/files')
      .query(true)
      .reply(200, {
        id: 'drive-saved-gmail-349',
        name: '071200-001-A Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-csi-07'],
        webViewLink: 'https://drive.google.com/file/d/drive-saved-gmail-349/view',
      });
    nock('https://www.googleapis.com')
      .post('/drive/v3/files/drive-saved-gmail-349/copy')
      .query(true)
      .reply(200, (_uri, body) => {
        const reqBody = body as { name?: string; parents?: string[] };
        return {
          id: 'drive-saved-gmail-349-copy',
          name: reqBody.name ?? '_071200-001-A Waterproofing.pdf',
          mimeType: 'application/pdf',
          parents: reqBody.parents ?? ['folder-submittals'],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-gmail-349-copy/view',
        };
      });
    mockInsertCoverSheetNock({
      copyFileId: 'drive-saved-gmail-349-copy',
      copyFileName: '_071200-001-A Waterproofing.pdf',
      copyParentId: 'folder-submittals',
      pdfBytes: coverSheetPdfBytes,
    });

    const gmailCapturedSheets = mockSubmittalArchLogWrite(logId);

    const gmailSubmitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-arch-with-space',
          threadId: 'th-arch-with-space',
          accessToken: 'ya29.gmail-only-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [rawSpaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            SaveEmailToPdf: { stringInputs: { value: ['false'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['A'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261118'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
          },
        },
      },
    });
    expect(gmailSubmitRes.statusCode).toBe(200);
    const gmailSubmitBody = JSON.parse(gmailSubmitRes.payload) as GoogleWorkspaceActionResponse;
    expect(gmailSubmitBody.action?.notification).toBeUndefined();
    expect(gmailSubmitBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe(
      'Submittal Arch Filed'
    );
    expect(gmailSearch.isDone()).toBe(true);
    expect(gmailCapturedSheets).toHaveLength(1);
    expect(JSON.stringify(gmailCapturedSheets[0])).toContain('071200');
    expect(nock.isDone()).toBe(true);
  });
});

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
  GoogleWorkspaceAction,
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceButton,
  GoogleWorkspaceCard,
  GoogleWorkspaceDecoratedText,
  GoogleWorkspaceSection,
  GoogleWorkspaceSelectionInput,
  GoogleWorkspaceTextInput,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { SELECT_DOCUMENT_LOG_KEY } from '../src/features/schema-driven-ui/blocks/document-log';

const DRIVE_ID = 'drive-ambig-351';
const SPACE_NAME = 'Harborview Hotel';
const LOG_ADMIN_ID = 'log-admin';
const LOG_CONST_ID = 'log-const';
const LOG_ROOT_ID = 'log-root';
const ADMIN_CUSTOM_LINK = 'https://docs.google.com/spreadsheets/d/custom-admin-link/edit';
const CONST_FALLBACK_LINK = `https://docs.google.com/spreadsheets/d/${LOG_CONST_ID}/edit`;

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

function findSelectionInput(
  card: GoogleWorkspaceCard,
  name: string
): GoogleWorkspaceSelectionInput | undefined {
  for (const section of card.sections) {
    for (const widget of section.widgets) {
      if (widget.selectionInput?.name === name) {
        return widget.selectionInput;
      }
    }
  }
  return undefined;
}

function findTextInput(
  card: GoogleWorkspaceCard,
  name: string
): GoogleWorkspaceTextInput | undefined {
  for (const section of card.sections) {
    for (const widget of section.widgets) {
      if (widget.textInput?.name === name) {
        return widget.textInput;
      }
    }
  }
  return undefined;
}

function getActionParamsRecord(action?: GoogleWorkspaceAction): Record<string, string> {
  const record: Record<string, string> = {};
  for (const param of action?.parameters ?? []) {
    record[param.key] = param.value;
  }
  return record;
}

function getDecoratedTextOpenUrl(decorated?: GoogleWorkspaceDecoratedText): string | undefined {
  if (!decorated?.button?.onClick || !('openLink' in decorated.button.onClick)) {
    return undefined;
  }
  return decorated.button.onClick.openLink.url;
}

function getButtonAction(button?: GoogleWorkspaceButton): GoogleWorkspaceAction | undefined {
  if (!button?.onClick || !('action' in button.onClick)) {
    return undefined;
  }
  return button.onClick.action;
}

function mockDriveFileRead(options: {
  fileId: string;
  fileName: string;
  driveId: string;
  pdfBytes: Uint8Array;
  includeMedia?: boolean;
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
      modifiedTime: '2026-10-19T15:00:00Z',
    });

  if (options.includeMedia !== false) {
    nock('https://www.googleapis.com')
      .get(`/drive/v3/files/${options.fileId}`)
      .query((q) => q.alt === 'media')
      .reply(200, Buffer.from(options.pdfBytes), { 'content-type': 'application/pdf' });
  }
}

function mockEmptyDocumentLogSheetsRead(spreadsheetId: string, options?: { optional?: boolean }) {
  const applyOpt = <T extends nock.Interceptor>(interceptor: T): T =>
    options?.optional ? (interceptor.optionally() as T) : interceptor;

  applyOpt(
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}`)
      .query(true)
  ).reply(200, {
    spreadsheetId,
    sheets: [
      { properties: { sheetId: 101, title: 'Submittal Arch' } },
      { properties: { sheetId: 102, title: 'Submittal FF&E' } },
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
    ],
  });

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

function mockAmbiguousDocumentLogDiscovery(options: {
  driveId: string;
  spaceName: string;
  times?: number;
  stubSheetsRead?: boolean;
  candidates?: Array<{
    id: string;
    name: string;
    parents: string[];
    modifiedTime: string;
    webViewLink?: string;
  }>;
  folders?: Array<{ id: string; name: string }>;
  adminFolderId?: string;
}) {
  const times = options.times ?? 1;
  const adminFolderId = options.adminFolderId ?? 'folder-admin';
  const candidates = options.candidates ?? [
    {
      id: LOG_ROOT_ID,
      name: `${options.spaceName} Document Log Root`,
      parents: [options.driveId],
      modifiedTime: '2026-10-01T00:00:00Z',
    },
    {
      id: LOG_CONST_ID,
      name: `${options.spaceName} Document Log`,
      parents: ['folder-const'],
      modifiedTime: '2026-10-12T08:00:00Z',
    },
    {
      id: LOG_ADMIN_ID,
      name: `${options.spaceName} Document Log`,
      parents: [adminFolderId],
      modifiedTime: '2026-10-19T14:30:00Z',
      webViewLink: ADMIN_CUSTOM_LINK,
    },
  ];

  const folders = options.folders ?? [
    { id: adminFolderId, name: '1 Admin' },
    { id: 'folder-const', name: '6 Construction' },
  ];

  const searchScope = nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("name contains 'Document Log'") &&
        q.driveId === options.driveId
    )
    .times(times)
    .reply(200, {
      files: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: c.parents,
        modifiedTime: c.modifiedTime,
        ...(c.webViewLink !== undefined ? { webViewLink: c.webViewLink } : {}),
      })),
    });

  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes(`'${options.driveId}' in parents`) &&
        q.q.includes("name = '1 Admin'") &&
        q.q.includes("mimeType = 'application/vnd.google-apps.folder'")
    )
    .times(times)
    .reply(200, {
      files: [{ id: adminFolderId, name: '1 Admin', parents: [options.driveId] }],
    });

  for (const folder of folders) {
    nock('https://www.googleapis.com')
      .get(`/drive/v3/files/${folder.id}`)
      .query((q) => q.alt !== 'media')
      .times(times)
      .reply(200, {
        id: folder.id,
        name: folder.name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [options.driveId],
      });
  }

  if (options.stubSheetsRead !== false) {
    for (const candidate of candidates) {
      for (let i = 0; i < times; i++) {
        mockEmptyDocumentLogSheetsRead(candidate.id, { optional: true });
      }
    }
  }

  return searchScope;
}

function mockSubmittalArchLogWrite(spreadsheetId: string) {
  nock('https://sheets.googleapis.com')
    .get(`/v4/spreadsheets/${spreadsheetId}`)
    .query(true)
    .reply(200, {
      spreadsheetId,
      sheets: [{ properties: { sheetId: 101, title: 'Submittal Arch' } }],
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
      ],
    });

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

function buildSubmittalArchFormInputs(overrides?: Record<string, string>) {
  const values: Record<string, string> = {
    [getDocumentInfoWidgetName('section', 'submittal-arch')]: '071200',
    [getDocumentInfoWidgetName('number', 'submittal-arch')]: '001',
    [getDocumentInfoWidgetName('revision', 'submittal-arch')]: 'A',
    [getDocumentInfoWidgetName('title', 'submittal-arch')]: 'Waterproofing',
    [getDocumentInfoWidgetName('date', 'submittal-arch')]: '261019',
    [getDocumentInfoWidgetName('contact', 'submittal-arch')]: 'PMG',
    [getDocumentInfoWidgetName('action', 'submittal-arch')]: 'REC',
    [getDocumentInfoWidgetName('status', 'submittal-arch')]: 'Open',
    ...overrides,
  };

  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => [k, { stringInputs: { value: [v] } }])
  );
}

describe('Ticket #351 CQRS Integration: Multi-Candidate SelectDocumentLog Disambiguation, Selection Lifecycle & Ambiguous Pre-Flight Guard', () => {
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
            payload: { email: 'user@inc.nyc', sub: 'user-351' },
          };
        }
        return { isValid: false, error: 'Unauthorized' };
      }),
    };

    mockGmailClient = {
      getThread: vi.fn().mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-multi-msg-351') {
          return {
            id: threadId,
            messages: [
              {
                id: 'msg-1',
                threadId,
                subject: 'Submittal 071200-001-A Waterproofing',
                from: 'James McGovern <jmcgovern@pavarini.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Mon, 19 Oct 2026 14:00:00 -0400',
                labels: ['INBOX', SPACE_NAME],
                plainTextBody: 'First submittal.',
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
              {
                id: 'msg-2',
                threadId,
                subject: 'Submittal 088000-002-A Glazing',
                from: 'James McGovern <jmcgovern@pavarini.com>',
                to: 'PM <pm@inc.nyc>',
                date: 'Tue, 20 Oct 2026 10:00:00 -0400',
                labels: ['INBOX', SPACE_NAME],
                plainTextBody: 'Second submittal.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-arch-2',
                    attachmentId: 'att-arch-2',
                    filename: '088000-002-A Glazing.pdf',
                    mimeType: 'application/pdf',
                    size: 2048,
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
              id: 'msg-ambig-351',
              threadId,
              subject: 'Submittal 071200-001-A Waterproofing',
              from: 'James McGovern <jmcgovern@pavarini.com>',
              to: 'PM <pm@inc.nyc>',
              date: 'Mon, 19 Oct 2026 14:00:00 -0400',
              labels: ['INBOX', SPACE_NAME],
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

  it('renders ambiguous SelectDocumentLog dropdown with lazy parentFolderName labels and only 1 active-log bar, and updates active-log bar + Open Log URL in place via updateCard on dropdown switch (Drive + Gmail)', async () => {
    // 1. Drive initial render (pushCard)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(2)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockDriveFileRead({
      fileId: 'file-ambig-351',
      fileName: '071200-001-A Waterproofing.pdf',
      driveId: DRIVE_ID,
      pdfBytes: flatPdfBytes,
    });
    // NOTE: root folder DRIVE_ID is intentionally NOT mocked on /drive/v3/files/drive-ambig-351;
    // nock.disableNetConnect() enforces that getFile(DRIVE_ID) is NEVER called for log-root.
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const driveInitialRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
      },
    });
    expect(driveInitialRes.statusCode).toBe(200);
    const driveInitialCard = getCard(driveInitialRes.payload, 'pushCard');

    // 2. Drive dropdown switch to log-const via /workspace/on-form-change (updateCard)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const driveSwitchRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(driveSwitchRes.statusCode).toBe(200);
    const driveSwitchCard = getCard(driveSwitchRes.payload, 'updateCard');

    // 3. Gmail initial render (pushCard)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const gmailInitialRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
      },
    });
    expect(gmailInitialRes.statusCode).toBe(200);
    const gmailInitialCard = getCard(gmailInitialRes.payload, 'pushCard');

    // Verify initial pushCard assertions for both Drive and Gmail
    const expectedLabels = [
      'Harborview Hotel Document Log (1 Admin · 2026-10-19)',
      'Harborview Hotel Document Log (6 Construction · 2026-10-12)',
      'Harborview Hotel Document Log Root (2026-10-01)',
    ];
    for (const card of [driveInitialCard, gmailInitialCard]) {
      const headers = card.sections.map((s) => s.header);
      const fileSelIdx = headers.indexOf('File Selection');
      const docLogIdx = headers.indexOf('Document Log');
      const docDataIdx = headers.indexOf('Document Data');
      expect(fileSelIdx).toBeGreaterThanOrEqual(0);
      expect(docLogIdx).toBe(fileSelIdx + 1);
      expect(docDataIdx).toBe(docLogIdx + 1);

      const logSection = findSection(card, 'Document Log')!;
      expect(logSection.widgets).toHaveLength(3);
      const dropdown = logSection.widgets[0].selectionInput!;
      expect(dropdown.name).toBe(SELECT_DOCUMENT_LOG_KEY);
      expect(dropdown.type).toBe('DROPDOWN');
      expect(dropdown.label).toBe('Document Log (3 found)');
      expect(dropdown.items.map((item) => item.text)).toEqual(expectedLabels);
      expect(dropdown.items.map((item) => Boolean(item.selected))).toEqual([true, false, false]);

      const decoratedBars = logSection.widgets.filter((w) => w.decoratedText !== undefined);
      expect(decoratedBars).toHaveLength(1);
      expect(getDecoratedTextOpenUrl(decoratedBars[0].decoratedText)).toBe(ADMIN_CUSTOM_LINK);
    }

    // 4. Gmail dropdown switch to log-const via /workspace/on-form-change (updateCard)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const gmailSwitchRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFormChange',
            previousSpaceId: DRIVE_ID,
            previousMessageId: 'msg-ambig-351',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(gmailSwitchRes.statusCode).toBe(200);
    const gmailSwitchCard = getCard(gmailSwitchRes.payload, 'updateCard');

    // Verify switch updateCard assertions for Drive and Gmail (Email Attachments mode)
    for (const card of [driveSwitchCard, gmailSwitchCard]) {
      const logSection = findSection(card, 'Document Log')!;
      expect(logSection.widgets).toHaveLength(3);
      const dropdown = logSection.widgets[0].selectionInput!;
      expect(dropdown.items.find((i) => i.value === LOG_CONST_ID)?.selected).toBe(true);
      expect(dropdown.items.find((i) => i.value === LOG_ADMIN_ID)?.selected).toBe(false);

      const bar = logSection.widgets[1].decoratedText!;
      expect(getDecoratedTextOpenUrl(bar)).toBe(CONST_FALLBACK_LINK);

      const docTypeParams = getActionParamsRecord(
        findSelectionInput(card, getDocumentTypeWidgetName('projects'))?.onChangeAction
      );
      expect(docTypeParams.previousSpaceId).toBe(DRIVE_ID);
      expect(docTypeParams.previousSelectedLogId).toBe(LOG_CONST_ID);

      const logParams = getActionParamsRecord(dropdown.onChangeAction);
      expect(logParams.previousSpaceId).toBe(DRIVE_ID);
      expect(logParams.previousSelectedLogId).toBe(LOG_CONST_ID);
    }

    // Gmail Email Attachments mode: SelectEmailMessage & SelectFileSource carry previousSpaceId + previousSelectedLogId alongside Gmail parameters
    for (const widgetName of ['SelectEmailMessage', 'SelectFileSource']) {
      const params = getActionParamsRecord(findSelectionInput(gmailSwitchCard, widgetName)?.onChangeAction);
      expect(params.previousSpaceId).toBe(DRIVE_ID);
      expect(params.previousSelectedLogId).toBe(LOG_CONST_ID);
      expect(params.previousMessageId).toBe('msg-ambig-351');
      expect(params.previousAttachments).toBeDefined();
      expect(params.previousDriveUrl).toBe('');
    }

    // 5. Gmail Google Drive URL mode: verify InputDriveURL also carries previousSpaceId + previousSelectedLogId alongside Gmail parameters
    const driveUrl = 'https://drive.google.com/file/d/file-ambig-351/view';
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const gmailDriveUrlRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFormChange',
            previousSpaceId: DRIVE_ID,
            previousMessageId: 'msg-ambig-351',
            previousDriveUrl: driveUrl,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
            InputDriveURL: { stringInputs: { value: [driveUrl] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(gmailDriveUrlRes.statusCode).toBe(200);
    const gmailDriveUrlCard = getCard(gmailDriveUrlRes.payload, 'updateCard');
    const driveUrlInputParams = getActionParamsRecord(
      findTextInput(gmailDriveUrlCard, 'InputDriveURL')?.onChangeAction
    );
    expect(driveUrlInputParams.previousSpaceId).toBe(DRIVE_ID);
    expect(driveUrlInputParams.previousSelectedLogId).toBe(LOG_CONST_ID);
    expect(driveUrlInputParams.previousMessageId).toBe('msg-ambig-351');
    expect(driveUrlInputParams.previousDriveUrl).toBe(driveUrl);
    expect(driveUrlInputParams.previousAttachments).toBeDefined();

    expect(nock.isDone()).toBe(true);
  });

  it('preserves SelectDocumentLog across direct DocumentType switch and round-trip through non-logging DocumentType within the same DocumentSpace (Drive + Gmail)', async () => {
    // --- DRIVE ---
    // Step 1: submittal-arch -> submittal-ffe
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockDriveFileRead({
      fileId: 'file-ambig-351',
      fileName: '071200-001-A Waterproofing.pdf',
      driveId: DRIVE_ID,
      pdfBytes: flatPdfBytes,
    });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const driveStep1Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'onDocumentTypeChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(driveStep1Res.statusCode).toBe(200);
    const driveStep1Card = getCard(driveStep1Res.payload, 'updateCard');
    const driveStep1LogSection = findSection(driveStep1Card, 'Document Log')!;
    expect(
      driveStep1LogSection.widgets[0].selectionInput?.items.find((i) => i.value === LOG_CONST_ID)?.selected
    ).toBe(true);
    expect(getDecoratedTextOpenUrl(driveStep1LogSection.widgets[1].decoratedText)).toBe(CONST_FALLBACK_LINK);

    // Step 2: submittal-ffe -> communication-project (non-logging, ZERO Drive Document Log searches)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockDriveFileRead({
      fileId: 'file-ambig-351',
      fileName: '071200-001-A Waterproofing.pdf',
      driveId: DRIVE_ID,
      pdfBytes: flatPdfBytes,
      includeMedia: false,
    });
    // communication-project has dynamic contactFolders lookup under 1 Admin/Communication
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("mimeType = 'application/vnd.google-apps.folder'") &&
          q.q.includes(`'${DRIVE_ID}' in parents`)
      )
      .reply(200, { files: [] });

    const driveStep2Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'onDocumentTypeChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(driveStep2Res.statusCode).toBe(200);
    const driveStep2Card = getCard(driveStep2Res.payload, 'updateCard');
    expect(findSection(driveStep2Card, 'Document Log')).toBeUndefined();
    const driveStep2Params = getActionParamsRecord(
      findSelectionInput(driveStep2Card, getDocumentTypeWidgetName('projects'))?.onChangeAction
    );
    expect(driveStep2Params.previousSpaceId).toBe(DRIVE_ID);
    expect(driveStep2Params.previousSelectedLogId).toBe(LOG_CONST_ID);

    // Step 3: communication-project -> submittal-arch (NO SelectDocumentLog in formInputs, passing Step 2's parameters!)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockDriveFileRead({
      fileId: 'file-ambig-351',
      fileName: '071200-001-A Waterproofing.pdf',
      driveId: DRIVE_ID,
      pdfBytes: flatPdfBytes,
    });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const driveStep3Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: driveStep2Params,
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
          },
        },
      },
    });
    expect(driveStep3Res.statusCode).toBe(200);
    const driveStep3Card = getCard(driveStep3Res.payload, 'updateCard');
    const driveStep3LogSection = findSection(driveStep3Card, 'Document Log')!;
    expect(
      driveStep3LogSection.widgets[0].selectionInput?.items.find((i) => i.value === LOG_CONST_ID)?.selected
    ).toBe(true);
    expect(getDecoratedTextOpenUrl(driveStep3LogSection.widgets[1].decoratedText)).toBe(CONST_FALLBACK_LINK);

    // --- GMAIL ---
    // Step 1: submittal-arch -> submittal-ffe
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const gmailStep1Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onDocumentTypeChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
            previousMessageId: 'msg-ambig-351',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(gmailStep1Res.statusCode).toBe(200);
    const gmailStep1Card = getCard(gmailStep1Res.payload, 'updateCard');
    const gmailStep1LogSection = findSection(gmailStep1Card, 'Document Log')!;
    expect(
      gmailStep1LogSection.widgets[0].selectionInput?.items.find((i) => i.value === LOG_CONST_ID)?.selected
    ).toBe(true);
    expect(getDecoratedTextOpenUrl(gmailStep1LogSection.widgets[1].decoratedText)).toBe(CONST_FALLBACK_LINK);

    // Step 2: submittal-ffe -> communication-project (non-logging, ZERO Drive Document Log searches)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("mimeType = 'application/vnd.google-apps.folder'") &&
          q.q.includes(`'${DRIVE_ID}' in parents`)
      )
      .reply(200, { files: [] });

    const gmailStep2Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onDocumentTypeChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
            previousMessageId: 'msg-ambig-351',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(gmailStep2Res.statusCode).toBe(200);
    const gmailStep2Card = getCard(gmailStep2Res.payload, 'updateCard');
    expect(findSection(gmailStep2Card, 'Document Log')).toBeUndefined();
    const gmailStep2Params = getActionParamsRecord(
      findSelectionInput(gmailStep2Card, getDocumentTypeWidgetName('projects'))?.onChangeAction
    );
    expect(gmailStep2Params.previousSpaceId).toBe(DRIVE_ID);
    expect(gmailStep2Params.previousSelectedLogId).toBe(LOG_CONST_ID);

    // Step 3: communication-project -> submittal-arch (NO SelectDocumentLog in formInputs, passing Step 2's parameters!)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const gmailStep3Res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: gmailStep2Params,
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
          },
        },
      },
    });
    expect(gmailStep3Res.statusCode).toBe(200);
    const gmailStep3Card = getCard(gmailStep3Res.payload, 'updateCard');
    const gmailStep3LogSection = findSection(gmailStep3Card, 'Document Log')!;
    expect(
      gmailStep3LogSection.widgets[0].selectionInput?.items.find((i) => i.value === LOG_CONST_ID)?.selected
    ).toBe(true);
    expect(getDecoratedTextOpenUrl(gmailStep3LogSection.widgets[1].decoratedText)).toBe(CONST_FALLBACK_LINK);

    expect(nock.isDone()).toBe(true);
  });

  it('clears SelectDocumentLog deterministically across space change, space clear, onSpaceTypeChange, refresh, Gmail onFileSourceChange, and Gmail onEmailMessageChange', async () => {
    const driveB = 'driveB';
    const spaceBName = 'Space B';

    // 1. Drive space change (previousSpaceId: DRIVE_ID -> Space B 'driveB')
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, {
        drives: [
          { id: DRIVE_ID, name: SPACE_NAME },
          { id: driveB, name: spaceBName },
        ],
      });
    mockAmbiguousDocumentLogDiscovery({
      driveId: driveB,
      spaceName: spaceBName,
      adminFolderId: 'folder-b-admin',
      folders: [
        { id: 'folder-b-admin', name: '1 Admin' },
        { id: 'folder-b-const', name: '6 Construction' },
      ],
      candidates: [
        {
          id: 'log-b1',
          name: `${spaceBName} Document Log`,
          parents: ['folder-b-admin'],
          modifiedTime: '2026-10-19T14:30:00Z',
        },
        {
          id: LOG_CONST_ID,
          name: `${spaceBName} Document Log`,
          parents: ['folder-b-const'],
          modifiedTime: '2026-10-12T08:00:00Z',
        },
      ],
    });

    const spaceChangeRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'onFormChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceBName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(spaceChangeRes.statusCode).toBe(200);
    const spaceChangeCard = getCard(spaceChangeRes.payload, 'updateCard');
    const spaceChangeDropdown = findSelectionInput(spaceChangeCard, SELECT_DOCUMENT_LOG_KEY)!;
    expect(spaceChangeDropdown.items.find((i) => i.value === 'log-b1')?.selected).toBe(true);
    expect(spaceChangeDropdown.items.find((i) => i.value === LOG_CONST_ID)?.selected).toBe(false);
    expect(
      getActionParamsRecord(
        findSelectionInput(spaceChangeCard, getDocumentTypeWidgetName('projects'))?.onChangeAction
      ).previousSelectedLogId
    ).toBeUndefined();

    // 2. Drive space cleared to blank (previousSpaceId: DRIVE_ID -> '')
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });

    const spaceClearRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'onFormChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [''] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(spaceClearRes.statusCode).toBe(200);
    const spaceClearCard = getCard(spaceClearRes.payload, 'updateCard');
    expect(JSON.stringify(findSection(spaceClearCard, 'Document Log'))).toContain(
      'Select a <b>Document Space</b>'
    );
    expect(
      getActionParamsRecord(
        findSelectionInput(spaceClearCard, getDocumentTypeWidgetName('projects'))?.onChangeAction
      ).previousSelectedLogId
    ).toBeUndefined();
    expect(
      getActionParamsRecord(getButtonAction(findProcessButton(spaceClearCard))).previousSelectedLogId
    ).toBeUndefined();

    // 3. Drive onSpaceTypeChange (projects -> proposals)
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: 'drive-mkt-1', name: 'INC Marketing' }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name = 'Opportunities'"))
      .reply(200, { files: [{ id: 'opp-root', name: 'Opportunities' }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("'opp-root' in parents"))
      .reply(200, { files: [{ id: 'prop-space-1', name: 'Hotel Proposal' }] });

    const spaceTypeChangeRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'onSpaceTypeChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(spaceTypeChangeRes.statusCode).toBe(200);
    const spaceTypeChangeCard = getCard(spaceTypeChangeRes.payload, 'updateCard');
    expect(findSection(spaceTypeChangeCard, 'Document Log')).toBeUndefined();
    expect(
      getActionParamsRecord(
        findSelectionInput(spaceTypeChangeCard, 'SelectDocumentSpaceType')?.onChangeAction
      ).previousSelectedLogId
    ).toBeUndefined();
    expect(
      getActionParamsRecord(
        findSelectionInput(spaceTypeChangeCard, getDocumentTypeWidgetName('proposals'))?.onChangeAction
      ).previousSelectedLogId
    ).toBeUndefined();

    // 4. Drive refresh -> falls back to ranked #1 log-admin
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(2)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockDriveFileRead({
      fileId: 'file-ambig-351',
      fileName: '071200-001-A Waterproofing.pdf',
      driveId: DRIVE_ID,
      pdfBytes: flatPdfBytes,
    });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const refreshRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'refresh',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(refreshRes.statusCode).toBe(200);
    const refreshCard = getCard(refreshRes.payload, 'pushCard');
    const refreshDropdown = findSelectionInput(refreshCard, SELECT_DOCUMENT_LOG_KEY)!;
    expect(refreshDropdown.items.find((i) => i.value === LOG_ADMIN_ID)?.selected).toBe(true);
    expect(refreshDropdown.items.find((i) => i.value === LOG_CONST_ID)?.selected).toBe(false);
    expect(
      getActionParamsRecord(refreshDropdown.onChangeAction).previousSelectedLogId
    ).toBeUndefined();

    // 5. Gmail onFileSourceChange (to 'Google Drive URL' with empty URL) -> falls back to ranked #1 log-admin
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const fileSourceChangeRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onFileSourceChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
            previousMessageId: 'msg-ambig-351',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
            InputDriveURL: { stringInputs: { value: [''] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(fileSourceChangeRes.statusCode).toBe(200);
    const fileSourceChangeCard = getCard(fileSourceChangeRes.payload, 'updateCard');
    const fileSourceDropdown = findSelectionInput(fileSourceChangeCard, SELECT_DOCUMENT_LOG_KEY)!;
    expect(fileSourceDropdown.items.find((i) => i.value === LOG_ADMIN_ID)?.selected).toBe(true);
    expect(fileSourceDropdown.items.find((i) => i.value === LOG_CONST_ID)?.selected).toBe(false);
    expect(
      getActionParamsRecord(fileSourceDropdown.onChangeAction).previousSelectedLogId
    ).toBeUndefined();

    // 6. Gmail onEmailMessageChange -> falls back to ranked #1 log-admin
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({ driveId: DRIVE_ID, spaceName: SPACE_NAME });

    const emailChangeRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-1',
          threadId: 'th-multi-msg-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'onEmailMessageChange',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
            previousMessageId: 'msg-1',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-2'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
          },
        },
      },
    });
    expect(emailChangeRes.statusCode).toBe(200);
    const emailChangeCard = getCard(emailChangeRes.payload, 'updateCard');
    const emailChangeDropdown = findSelectionInput(emailChangeCard, SELECT_DOCUMENT_LOG_KEY)!;
    expect(emailChangeDropdown.items.find((i) => i.value === LOG_ADMIN_ID)?.selected).toBe(true);
    expect(emailChangeDropdown.items.find((i) => i.value === LOG_CONST_ID)?.selected).toBe(false);
    expect(
      getActionParamsRecord(emailChangeDropdown.onChangeAction).previousSelectedLogId
    ).toBeUndefined();

    expect(nock.isDone()).toBe(true);
  });

  it('submits processDocument against chosen SelectDocumentLog candidate via WorkspaceExecutionContext.selectedLogId without polluting Document.data and with single Drive search (Drive + Gmail)', async () => {
    // 1. Drive processDocument against log-const
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    const driveLogSearch = mockAmbiguousDocumentLogDiscovery({
      driveId: DRIVE_ID,
      spaceName: SPACE_NAME,
      times: 1,
      stubSheetsRead: false,
    });
    // MOVE_FILE mocks for submittal-arch: 6 Construction/Submittals
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes(`'${DRIVE_ID}' in parents`) &&
          q.q.includes("name = '6 Construction'")
      )
      .reply(200, { files: [{ id: 'folder-6-const', name: '6 Construction', parents: [DRIVE_ID] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("'folder-6-const' in parents") &&
          q.q.includes("name = 'Submittals'")
      )
      .reply(200, { files: [{ id: 'folder-submittals', name: 'Submittals', parents: ['folder-6-const'] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files/file-ambig-351')
      .query(true)
      .reply(200, {
        id: 'file-ambig-351',
        name: '071200-001-A Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['unfiled-folder'],
      });
    nock('https://www.googleapis.com')
      .patch('/drive/v3/files/file-ambig-351')
      .query(true)
      .reply(200, {
        id: 'file-ambig-351',
        name: '071200-001-A Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-submittals'],
        webViewLink: 'https://drive.google.com/file/d/file-ambig-351/view',
      });

    const driveCapturedSheets = mockSubmittalArchLogWrite(LOG_CONST_ID);

    const driveSubmitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'processDocument',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
            ...buildSubmittalArchFormInputs(),
          },
        },
      },
    });
    expect(driveSubmitRes.statusCode).toBe(200);
    expect(JSON.parse(driveSubmitRes.payload)).toEqual({
      action: { notification: { text: 'Document processed successfully' } },
    });
    expect(driveLogSearch.isDone()).toBe(true);
    expect(driveCapturedSheets).toHaveLength(1);
    const driveSheetsJson = JSON.stringify(driveCapturedSheets[0]);
    expect(driveSheetsJson).toContain('071200');
    expect(driveSheetsJson).not.toContain(SELECT_DOCUMENT_LOG_KEY);
    expect(driveSheetsJson).not.toContain(LOG_CONST_ID);
    expect(nock.isDone()).toBe(true);

    // 2. Gmail processDocument against log-const
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    const gmailLogSearch = mockAmbiguousDocumentLogDiscovery({
      driveId: DRIVE_ID,
      spaceName: SPACE_NAME,
      times: 1,
      stubSheetsRead: false,
    });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes(`'${DRIVE_ID}' in parents`) &&
          q.q.includes("name = '6 Construction'")
      )
      .reply(200, { files: [{ id: 'folder-6-const', name: '6 Construction', parents: [DRIVE_ID] }] });
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("'folder-6-const' in parents") &&
          q.q.includes("name = 'Submittals'")
      )
      .reply(200, { files: [{ id: 'folder-submittals', name: 'Submittals', parents: ['folder-6-const'] }] });
    nock('https://www.googleapis.com')
      .post('/upload/drive/v3/files')
      .query(true)
      .reply(200, {
        id: 'drive-saved-gmail-351',
        name: '071200-001-A Waterproofing.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-submittals'],
        webViewLink: 'https://drive.google.com/file/d/drive-saved-gmail-351/view',
      });

    const gmailCapturedSheets = mockSubmittalArchLogWrite(LOG_CONST_ID);

    const gmailSubmitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'processDocument',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: LOG_CONST_ID,
            previousMessageId: 'msg-ambig-351',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            SaveEmailToPdf: { stringInputs: { value: ['false'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [LOG_CONST_ID] } },
            ...buildSubmittalArchFormInputs(),
          },
        },
      },
    });
    expect(gmailSubmitRes.statusCode).toBe(200);
    expect(JSON.parse(gmailSubmitRes.payload)).toEqual({
      action: { notification: { text: 'Document processed successfully' } },
    });
    expect(gmailLogSearch.isDone()).toBe(true);
    expect(gmailCapturedSheets).toHaveLength(1);
    const gmailSheetsJson = JSON.stringify(gmailCapturedSheets[0]);
    expect(gmailSheetsJson).toContain('071200');
    expect(gmailSheetsJson).not.toContain(SELECT_DOCUMENT_LOG_KEY);
    expect(gmailSheetsJson).not.toContain(LOG_CONST_ID);
    expect(nock.isDone()).toBe(true);
  });

  it('blocks processDocument before MOVE_FILE on absent, stale, and cross-space unblurred edit SelectDocumentLog, returning updateCard error with SelectDocumentLog deleted and typed inputs preserved (Drive + Gmail)', async () => {
    // 1. Absent SelectDocumentLog (Drive): zero MOVE_FILE calls, updateCard error, live SelectDocumentLog dropdown rendered, typed title preserved
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({
      driveId: DRIVE_ID,
      spaceName: SPACE_NAME,
      times: 2, // pre-flight resolveLog + re-render queryUiContext
    });

    const absentRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: { action: 'processDocument', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            ...buildSubmittalArchFormInputs({
              [getDocumentInfoWidgetName('title', 'submittal-arch')]: 'Typed Absent Title',
            }),
          },
        },
      },
    });
    expect(absentRes.statusCode).toBe(200);
    const absentCard = getCard(absentRes.payload, 'updateCard');
    expect(JSON.stringify(absentCard)).toContain('Multiple DocumentLog spreadsheets found');
    const absentDropdown = findSelectionInput(absentCard, SELECT_DOCUMENT_LOG_KEY);
    expect(absentDropdown).toBeDefined();
    expect(absentDropdown?.items.find((i) => i.value === LOG_ADMIN_ID)?.selected).toBe(true);
    expect(
      findTextInput(absentCard, getDocumentInfoWidgetName('title', 'submittal-arch'))?.value
    ).toBe('Typed Absent Title');
    expect(nock.isDone()).toBe(true);

    // 2. Stale SelectDocumentLog ('log-deleted', Gmail): zero getAttachment/upload calls, updateCard error, 'log-deleted' absent from entire response payload, pre-selected to ranked #1 log-admin, typed title preserved
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    mockAmbiguousDocumentLogDiscovery({
      driveId: DRIVE_ID,
      spaceName: SPACE_NAME,
      times: 2,
    });

    const staleRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-ambig-351',
          threadId: 'th-ambig-351',
          accessToken: 'ya29.gmail-token',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'processDocument',
            previousSpaceId: DRIVE_ID,
            previousSelectedLogId: 'log-deleted',
            previousMessageId: 'msg-ambig-351',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-ambig-351'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
            SaveEmailToPdf: { stringInputs: { value: ['false'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: ['log-deleted'] } },
            ...buildSubmittalArchFormInputs({
              [getDocumentInfoWidgetName('title', 'submittal-arch')]: 'Typed Stale Title',
            }),
          },
        },
      },
    });
    expect(staleRes.statusCode).toBe(200);
    expect(mockGmailClient.getAttachment).not.toHaveBeenCalled();
    expect(staleRes.payload).not.toContain('log-deleted');
    const staleCard = getCard(staleRes.payload, 'updateCard');
    expect(JSON.stringify(staleCard)).toContain('Multiple DocumentLog spreadsheets found');
    const staleDropdown = findSelectionInput(staleCard, SELECT_DOCUMENT_LOG_KEY);
    expect(staleDropdown?.items.find((i) => i.value === LOG_ADMIN_ID)?.selected).toBe(true);
    expect(
      findTextInput(staleCard, getDocumentInfoWidgetName('title', 'submittal-arch'))?.value
    ).toBe('Typed Stale Title');
    expect(nock.isDone()).toBe(true);

    // 3. Cross-space unblurred space edit (Drive: previousSpaceId: 'drive-space-a', form input space name = 'Space B' -> 'drive-space-b', SelectDocumentLog: 'log-a1')
    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .times(1)
      .reply(200, {
        drives: [
          { id: 'drive-space-a', name: 'Space A' },
          { id: 'drive-space-b', name: 'Space B' },
        ],
      });
    mockAmbiguousDocumentLogDiscovery({
      driveId: 'drive-space-b',
      spaceName: 'Space B',
      times: 2,
      adminFolderId: 'folder-b-admin',
      folders: [
        { id: 'folder-b-admin', name: '1 Admin' },
        { id: 'folder-b-const', name: '6 Construction' },
      ],
      candidates: [
        {
          id: 'log-b1',
          name: 'Space B Document Log',
          parents: ['folder-b-admin'],
          modifiedTime: '2026-10-19T14:30:00Z',
        },
        {
          id: 'log-b2',
          name: 'Space B Document Log',
          parents: ['folder-b-const'],
          modifiedTime: '2026-10-12T08:00:00Z',
        },
      ],
    });

    const crossSpaceRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token' },
        drive: { selectedItems: [{ id: 'file-ambig-351', title: '071200-001-A Waterproofing.pdf' }] },
        commonEventObject: {
          parameters: {
            action: 'processDocument',
            previousSpaceId: 'drive-space-a',
            previousSelectedLogId: 'log-a1',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Space B'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-ambig-351'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: ['log-a1'] } },
            ...buildSubmittalArchFormInputs({
              [getDocumentInfoWidgetName('title', 'submittal-arch')]: 'Typed Cross-Space Title',
            }),
          },
        },
      },
    });
    expect(crossSpaceRes.statusCode).toBe(200);
    expect(crossSpaceRes.payload).not.toContain('log-a1');
    const crossSpaceCard = getCard(crossSpaceRes.payload, 'updateCard');
    expect(JSON.stringify(crossSpaceCard)).toContain('Multiple DocumentLog spreadsheets found');
    const crossSpaceDropdown = findSelectionInput(crossSpaceCard, SELECT_DOCUMENT_LOG_KEY);
    expect(crossSpaceDropdown?.items.map((i) => i.value)).toEqual(['log-b1', 'log-b2']);
    expect(crossSpaceDropdown?.items.find((i) => i.value === 'log-b1')?.selected).toBe(true);
    expect(
      findTextInput(crossSpaceCard, getDocumentInfoWidgetName('title', 'submittal-arch'))?.value
    ).toBe('Typed Cross-Space Title');
    expect(nock.isDone()).toBe(true);
  });
});

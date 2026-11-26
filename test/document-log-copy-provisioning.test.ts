import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { GoogleGmailClient } from '../src/infrastructure/gmail/gmail-client';
import type { GmailThreadDetails } from '../src/infrastructure/gmail/types';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceButton,
  GoogleWorkspaceCard,
  GoogleWorkspaceSection,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { PRIMARY_ACTION_BUTTON_COLOR } from '../src/features/schema-driven-ui/blocks/common';

const TEMPLATE_SPREADSHEET_ID = '1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I';

function mockEmptyDocumentLogSheetsRead(spreadsheetId: string, options?: { optional?: boolean }) {
  const applyOpt = <T extends nock.Interceptor>(interceptor: T): T =>
    options?.optional ? (interceptor.optionally() as T) : interceptor;

  const statusesRows = [['Status'], ['Open'], ['Closed'], ['Waiting'], ['Manager'], ['---']];
  const actionsRows = [
    ['Action', 'Name', 'Suffix', 'Order'],
    ['REC', 'Received', '', '1'],
    ['REF', 'Referred', '_REF', '2'],
    ['NR', 'Not Reviewed', '_NR', '3'],
    ['REJ', 'Rejected', '_REJ', '4'],
    ['RR', 'Revise & Resubmit', '_RR', '5'],
    ['NOC', 'No Objections As Corrected', '_NOC', '6'],
    ['NET', 'No Exceptions Taken', '_NET', '7'],
    ['---', '', '', ''],
  ];

  applyOpt(
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}`)
      .query(true)
      .times(options?.optional ? 2 : 2)
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
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-arch-actions',
        name: 'Options_Submittal_Arch_Actions',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 9, startColumnIndex: 2, endColumnIndex: 6 },
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

  applyOpt(
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
  ).reply(200, (uri) => {
    const url = new URL(uri, 'https://sheets.googleapis.com');
    const ranges = url.searchParams.getAll('ranges');
    return {
      spreadsheetId,
      valueRanges: ranges.map((r) => ({
        range: r,
        values: r.includes('A1:') ? statusesRows : actionsRows,
      })),
    };
  });
}

function findButton(card: GoogleWorkspaceCard, label: string): GoogleWorkspaceButton | undefined {
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

function findSection(card: GoogleWorkspaceCard, header: string): GoogleWorkspaceSection | undefined {
  return card.sections.find((s) => s.header === header);
}

function readDocInfoText(card: GoogleWorkspaceCard, fieldKey: string, docTypeKey: string): string | undefined {
  const dataSection = findSection(card, 'Document Data');
  const widgetName = getDocumentInfoWidgetName(fieldKey, docTypeKey);
  return dataSection?.widgets.find((w) => w.textInput?.name === widgetName)?.textInput?.value;
}

describe('Ticket #350 CQRS Integration: Idempotent User-Triggered Copy Log Provisioning (Drive & Gmail)', () => {
  let app: AppInstance;
  let mockGmailClient: Partial<GoogleGmailClient>;

  beforeEach(async () => {
    nock.disableNetConnect();

    const mockAuthVerifier: WorkspaceAuthVerifierPort = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return {
            isValid: true,
            payload: { email: 'user@inc.nyc', sub: 'user-350' },
          };
        }
        return { isValid: false, error: 'Unauthorized' };
      }),
    };

    mockGmailClient = {
      getThread: vi.fn().mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => ({
        id: threadId,
        messages: [
          {
            id: 'msg-copy-350',
            threadId,
            subject: 'Submittal 071200-001 Waterproofing',
            from: 'James McGovern <jmcgovern@pavarini.com>',
            to: 'PM <pm@inc.nyc>',
            date: 'Tue, 20 Oct 2026 14:00:00 -0400',
            labels: ['INBOX', 'Harborview Hotel'],
            plainTextBody: 'Please review waterproofing submittal.',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-350-1',
                attachmentId: 'att-350-1',
                filename: '071200-001_Waterproofing.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
              {
                partId: 'part-350-2',
                attachmentId: 'att-350-2',
                filename: 'Cover_Notes.pdf',
                mimeType: 'application/pdf',
                size: 512,
              },
            ],
          },
        ],
      })),
      getMessage: vi.fn().mockResolvedValue({
        id: 'msg-copy-350',
        messageId: 'msg-copy-350',
        inlineImages: [],
        attachments: [
          {
            partId: 'part-350-1',
            attachmentId: 'att-350-1',
            filename: '071200-001_Waterproofing.pdf',
            mimeType: 'application/pdf',
            size: 1024,
          },
          {
            partId: 'part-350-2',
            attachmentId: 'att-350-2',
            filename: 'Cover_Notes.pdf',
            mimeType: 'application/pdf',
            size: 512,
          },
        ],
      }),
      getAttachment: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
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

  it('Drive CQRS: renders Copy Log button in missing state, auto-creates "1 Admin", copies template, returns paired updateCard + toast, preserves form inputs, and unlocks Process Document', async () => {
    const driveId = 'drive-harborview-350';
    const spaceName = 'Harborview Hotel';
    const createdFolderId = 'folder-1-admin-350';
    const createdSheetId = 'sheet-created-350';
    const createdSheetName = 'Harborview Hotel Document Log';
    const createdWebViewLink = `https://docs.google.com/spreadsheets/d/${createdSheetId}/edit`;

    // Step 1: Initial render in missing state via onFormChange -> verifies filled primary-blue Copy Log button & disabled Process Document
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
      .reply(200, { files: [] });

    const missingRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token-350' },
        drive: { selectedItems: [{ id: 'file-350-1', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-350-1'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Custom Waterproofing'] } },
            [getDocumentInfoWidgetName('notes', 'submittal-arch')]: { stringInputs: { value: ['Hold for architect'] } },
          },
        },
      },
    });

    expect(missingRes.statusCode).toBe(200);
    const missingBody = JSON.parse(missingRes.payload) as GoogleWorkspaceActionResponse;
    const missingCard = missingBody.action.navigations?.[0]?.updateCard;
    expect(missingCard).toBeDefined();
    expect(missingBody.action.notification).toBeUndefined();

    const copyBtn = findButton(missingCard!, 'Copy Log');
    expect(copyBtn).toBeDefined();
    expect(copyBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    expect(
      (copyBtn?.onClick as { action?: { parameters?: Array<{ key: string; value: string }> } })?.action?.parameters
    ).toContainEqual({ key: 'action', value: 'copyDocumentLog' });
    expect(findButton(missingCard!, 'Process Document')?.disabled).toBe(true);
    expect(nock.isDone()).toBe(true);

    // Step 2: Click Copy Log -> auto-creates "1 Admin", copies template with supportsAllDrives=true, re-renders resolved card + paired toast
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.drive-token-350' },
    })
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });

    // Pre-check resolveLog finds 0 spreadsheets
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.drive-token-350' },
    })
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("name contains 'Document Log'") &&
          q.driveId === driveId
      )
      .reply(200, { files: [] });

    // ensureFolderPath checks for "1 Admin" -> 0 matches, then creates "1 Admin"
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.drive-token-350' },
    })
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes(`'${driveId}' in parents`) &&
          q.q.includes("name = '1 Admin'") &&
          q.supportsAllDrives === 'true'
      )
      .reply(200, { files: [] });

    const createFolderScope = nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.drive-token-350' },
    })
      .post('/drive/v3/files', (body: Record<string, unknown>) => {
        return (
          body.name === '1 Admin' &&
          body.mimeType === 'application/vnd.google-apps.folder' &&
          Array.isArray(body.parents) &&
          body.parents[0] === driveId
        );
      })
      .query((q) => q.supportsAllDrives === 'true')
      .reply(200, {
        id: createdFolderId,
        name: '1 Admin',
        parents: [driveId],
        mimeType: 'application/vnd.google-apps.folder',
      });

    const copyTemplateScope = nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.drive-token-350' },
    })
      .post(`/drive/v3/files/${TEMPLATE_SPREADSHEET_ID}/copy`, (body: Record<string, unknown>) => {
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

    // Post-copy card re-render runs live resolveLog and finds the newly created spreadsheet
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.drive-token-350' },
    })
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
            id: createdSheetId,
            name: createdSheetName,
            parents: [createdFolderId],
            mimeType: 'application/vnd.google-apps.spreadsheet',
            webViewLink: createdWebViewLink,
          },
        ],
      });

    mockEmptyDocumentLogSheetsRead(createdSheetId);

    const copyRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token-350' },
        drive: { selectedItems: [{ id: 'file-350-1', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'copyDocumentLog' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-350-1'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Custom Waterproofing'] } },
            [getDocumentInfoWidgetName('notes', 'submittal-arch')]: { stringInputs: { value: ['Hold for architect'] } },
          },
        },
      },
    });

    expect(copyRes.statusCode).toBe(200);
    expect(createFolderScope.isDone()).toBe(true);
    expect(copyTemplateScope.isDone()).toBe(true);

    const copyBody = JSON.parse(copyRes.payload) as GoogleWorkspaceActionResponse;
    expect(copyBody.action.notification).toEqual({
      text: `Created "${createdSheetName}" in "1 Admin".`,
    });
    const updatedCard = copyBody.action.navigations?.[0]?.updateCard;
    expect(updatedCard).toBeDefined();

    // Document Log section now shows active log with Open Log link and no Copy Log button
    const logSection = findSection(updatedCard!, 'Document Log');
    expect(logSection).toBeDefined();
    expect(logSection?.widgets[0].decoratedText?.text).toContain(createdSheetName);
    expect(
      (logSection?.widgets[0].decoratedText?.button?.onClick as { openLink?: { url?: string } })?.openLink?.url
    ).toBe(createdWebViewLink);
    expect(findButton(updatedCard!, 'Copy Log')).toBeUndefined();

    // Process Document is immediately unlocked
    const processBtn = findButton(updatedCard!, 'Process Document');
    expect(processBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    expect(processBtn?.disabled).not.toBe(true);

    // Typed form inputs and Drive file selection preserved
    expect(readDocInfoText(updatedCard!, 'section', 'submittal-arch')).toBe('071200');
    expect(readDocInfoText(updatedCard!, 'number', 'submittal-arch')).toBe('001');
    expect(readDocInfoText(updatedCard!, 'title', 'submittal-arch')).toBe('Custom Waterproofing');
    expect(readDocInfoText(updatedCard!, 'notes', 'submittal-arch')).toBe('Hold for architect');
    const fileSec = findSection(updatedCard!, 'File Selection');
    expect(
      fileSec?.widgets.find((w) => w.selectionInput?.name === 'SelectFiles')?.selectionInput?.items
    ).toEqual([{ text: '071200-001_Waterproofing.pdf', value: 'file-350-1', selected: true }]);

    expect(nock.isDone()).toBe(true);
  });

  it('Drive CQRS: double-click copyDocumentLog is idempotent (0 folder creates, 0 copies) and returns already-exists toast paired with updateCard', async () => {
    const driveId = 'drive-idemp-350';
    const spaceName = 'Harborview Hotel';
    const existingSheetId = 'sheet-existing-350';
    const existingSheetName = 'Harborview Hotel Document Log';

    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });

    // Per-request DocumentLogService memoizes resolveLog across copyLog pre-check & re-render -> 1 search, zero POST/copy calls
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("name contains 'Document Log'") &&
          q.driveId === driveId
      )
      .times(1)
      .reply(200, {
        files: [
          {
            id: existingSheetId,
            name: existingSheetName,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            webViewLink: `https://docs.google.com/spreadsheets/d/${existingSheetId}/edit`,
          },
        ],
      });

    mockEmptyDocumentLogSheetsRead(existingSheetId, { optional: true });

    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token-350' },
        drive: { selectedItems: [{ id: 'file-350-1', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'copyDocumentLog' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-350-1'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Double-Click Safe Title'] } },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    expect(body.action.notification).toEqual({
      text: `Document Log already exists: "${existingSheetName}".`,
    });
    const updatedCard = body.action.navigations?.[0]?.updateCard;
    expect(updatedCard).toBeDefined();
    expect(findButton(updatedCard!, 'Process Document')?.disabled).not.toBe(true);
    expect(readDocInfoText(updatedCard!, 'title', 'submittal-arch')).toBe('Double-Click Safe Title');
    expect(nock.isDone()).toBe(true);
  });

  it('Drive CQRS: surfaces actionable 403 Contributor / template-copy guidance via updateCard, preserves typed inputs, and keeps Process Document disabled', async () => {
    const driveId = 'drive-403-350';
    const spaceName = 'Harborview Hotel';

    nock('https://www.googleapis.com')
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });

    // Pre-check resolveLog finds 0 logs
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("name contains 'Document Log'") &&
          q.driveId === driveId
      )
      .reply(200, { files: [] });

    // "1 Admin" already exists, then template files.copy fails with HTTP 403
    nock('https://www.googleapis.com')
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes(`'${driveId}' in parents`) &&
          q.q.includes("name = '1 Admin'")
      )
      .reply(200, {
        files: [
          {
            id: 'existing-admin-folder',
            name: '1 Admin',
            parents: [driveId],
            mimeType: 'application/vnd.google-apps.folder',
          },
        ],
      });

    nock('https://www.googleapis.com')
      .post(`/drive/v3/files/${TEMPLATE_SPREADSHEET_ID}/copy`)
      .query(true)
      .reply(403, {
        error: { code: 403, message: 'The user does not have sufficient permissions for this file.' },
      });

    // Re-render reuses per-request memoized resolveLog (still 0 logs -> missing state, 0 extra Drive searches)

    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.drive-token-350' },
        drive: { selectedItems: [{ id: 'file-350-1', title: '071200-001_Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'copyDocumentLog' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-350-1'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Preserved After 403'] } },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    expect(body.action.notification).toBeUndefined();
    const updatedCard = body.action.navigations?.[0]?.updateCard;
    expect(updatedCard).toBeDefined();

    const cardJson = JSON.stringify(updatedCard);
    expect(cardJson).toContain('Contributor');
    expect(cardJson).toContain('template');
    expect(findButton(updatedCard!, 'Copy Log')).toBeDefined();
    expect(findButton(updatedCard!, 'Process Document')?.disabled).toBe(true);
    expect(readDocInfoText(updatedCard!, 'section', 'submittal-arch')).toBe('071200');
    expect(readDocInfoText(updatedCard!, 'title', 'submittal-arch')).toBe('Preserved After 403');
    expect(nock.isDone()).toBe(true);
  });

  it('Gmail CQRS: carries shared Gmail action parameters on Copy Log, provisions log using gmail.accessToken, returns paired updateCard + toast, preserves attachments & form inputs, and unlocks Process Document', async () => {
    const driveId = 'drive-gmail-350';
    const spaceName = 'Harborview Hotel';
    const createdFolderId = 'folder-gmail-admin-350';
    const createdSheetId = 'sheet-gmail-created-350';
    const createdSheetName = 'Harborview Hotel Document Log';

    // 1. Initial Gmail contextual render -> missing state with Copy Log carrying shared Gmail action parameters
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("name contains 'Document Log'") &&
          q.driveId === driveId
      )
      .reply(200, { files: [] });

    const initialGmailRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/gmail-contextual',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-copy-350',
          threadId: 'th-copy-350',
          accessToken: 'ya29.gmail-only-350',
        },
      },
    });

    expect(initialGmailRes.statusCode).toBe(200);
    const initialCard = (JSON.parse(initialGmailRes.payload) as GoogleWorkspaceActionResponse)
      .action.navigations?.[0]?.pushCard;
    expect(initialCard).toBeDefined();

    const gmailCopyBtn = findButton(initialCard!, 'Copy Log');
    expect(gmailCopyBtn).toBeDefined();
    expect(gmailCopyBtn?.color).toEqual(PRIMARY_ACTION_BUTTON_COLOR);
    const copyParams = (
      gmailCopyBtn?.onClick as { action?: { parameters?: Array<{ key: string; value: string }> } }
    )?.action?.parameters;
    expect(copyParams).toContainEqual({ key: 'action', value: 'copyDocumentLog' });
    expect(copyParams).toContainEqual({
      key: 'previousAttachments',
      value: JSON.stringify(['part-350-1', 'part-350-2']),
    });
    expect(copyParams).toContainEqual({ key: 'previousDriveUrl', value: '' });
    expect(copyParams).toContainEqual({ key: 'previousMessageId', value: 'msg-copy-350' });
    expect(findButton(initialCard!, 'Process Document')?.disabled).toBe(true);
    expect(nock.isDone()).toBe(true);

    // 2. Click Copy Log in Gmail (no userOAuthToken, only gmail.accessToken) -> creates "1 Admin" + copies template + returns paired updateCard + toast
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("name contains 'Document Log'") &&
          q.driveId === driveId
      )
      .reply(200, { files: [] });

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes(`'${driveId}' in parents`) &&
          q.q.includes("name = '1 Admin'")
      )
      .reply(200, { files: [] });

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
      .post('/drive/v3/files')
      .query((q) => q.supportsAllDrives === 'true')
      .reply(200, {
        id: createdFolderId,
        name: '1 Admin',
        parents: [driveId],
        mimeType: 'application/vnd.google-apps.folder',
      });

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
      .post(`/drive/v3/files/${TEMPLATE_SPREADSHEET_ID}/copy`)
      .query((q) => q.supportsAllDrives === 'true')
      .reply(200, {
        id: createdSheetId,
        name: createdSheetName,
        parents: [createdFolderId],
        mimeType: 'application/vnd.google-apps.spreadsheet',
        webViewLink: `https://docs.google.com/spreadsheets/d/${createdSheetId}/edit`,
      });

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-350' },
    })
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
            id: createdSheetId,
            name: createdSheetName,
            parents: [createdFolderId],
            mimeType: 'application/vnd.google-apps.spreadsheet',
            webViewLink: `https://docs.google.com/spreadsheets/d/${createdSheetId}/edit`,
          },
        ],
      });

    const gmailCopyRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-copy-350',
          threadId: 'th-copy-350',
          accessToken: 'ya29.gmail-only-350',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'copyDocumentLog',
            previousAttachments: JSON.stringify(['part-350-1']),
            previousDriveUrl: '',
            previousMessageId: 'msg-copy-350',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-copy-350'] } },
            SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            SelectAttachments: { stringInputs: { value: ['part-350-1'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: {
              stringInputs: { value: ['Gmail Custom Submittal'] },
            },
          },
        },
      },
    });

    expect(gmailCopyRes.statusCode).toBe(200);
    const gmailCopyBody = JSON.parse(gmailCopyRes.payload) as GoogleWorkspaceActionResponse;
    expect(gmailCopyBody.action.notification).toEqual({
      text: `Created "${createdSheetName}" in "1 Admin".`,
    });
    const gmailUpdatedCard = gmailCopyBody.action.navigations?.[0]?.updateCard;
    expect(gmailUpdatedCard).toBeDefined();
    expect(findButton(gmailUpdatedCard!, 'Process Document')?.disabled).not.toBe(true);
    expect(findButton(gmailUpdatedCard!, 'Copy Log')).toBeUndefined();
    expect(readDocInfoText(gmailUpdatedCard!, 'title', 'submittal-arch')).toBe('Gmail Custom Submittal');

    // Gmail partial attachment selection preserved (part-350-1 checked, part-350-2 unchecked)
    const fileSec = findSection(gmailUpdatedCard!, 'File Selection');
    const attItems = fileSec?.widgets.find((w) => w.selectionInput?.name === 'SelectAttachments')
      ?.selectionInput?.items;
    expect(attItems).toEqual([
      { text: '071200-001_Waterproofing.pdf', value: 'part-350-1', selected: true },
      { text: 'Cover_Notes.pdf', value: 'part-350-2', selected: false },
    ]);
    expect(nock.isDone()).toBe(true);
  });

  it('Gmail CQRS: preserves Google Drive URL mode on copyDocumentLog and recovers cleanly on 403 folder-creation error keeping Process Document disabled', async () => {
    const driveId = 'drive-gmail-403-350';
    const spaceName = 'Harborview Hotel';
    const driveUrl = 'https://drive.google.com/file/d/drive-url-file-350/view';

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-403' },
    })
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: driveId, name: spaceName }] });

    // Pre-check resolveLog finds 0 logs
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-403' },
    })
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes("name contains 'Document Log'") &&
          q.driveId === driveId
      )
      .reply(200, { files: [] });

    // "1 Admin" search -> 0 matches, then POST /drive/v3/files (folder create) fails with HTTP 403
    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-403' },
    })
      .get('/drive/v3/files')
      .query(
        (q) =>
          typeof q.q === 'string' &&
          q.q.includes(`'${driveId}' in parents`) &&
          q.q.includes("name = '1 Admin'")
      )
      .reply(200, { files: [] });

    nock('https://www.googleapis.com', {
      reqheaders: { authorization: 'Bearer ya29.gmail-only-403' },
    })
      .post('/drive/v3/files')
      .query(true)
      .reply(403, { error: { code: 403, message: 'Insufficient permissions to create folder in Shared Drive' } });

    // Post-error re-render reuses per-request memoized resolveLog (still 0 logs)

    const res = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt-token' },
      payload: {
        hostApp: 'GMAIL',
        gmail: {
          messageId: 'msg-copy-350',
          threadId: 'th-copy-350',
          accessToken: 'ya29.gmail-only-403',
        },
        commonEventObject: {
          hostApp: 'GMAIL',
          parameters: {
            action: 'copyDocumentLog',
            previousAttachments: JSON.stringify(['part-350-2']),
            previousDriveUrl: driveUrl,
            previousMessageId: 'msg-copy-350',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [spaceName] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectEmailMessage: { stringInputs: { value: ['msg-copy-350'] } },
            SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
            InputDriveURL: { stringInputs: { value: [driveUrl] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: {
              stringInputs: { value: ['Drive URL Submittal'] },
            },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
    expect(body.action.notification).toBeUndefined();
    const updatedCard = body.action.navigations?.[0]?.updateCard;
    expect(updatedCard).toBeDefined();

    const cardJson = JSON.stringify(updatedCard);
    expect(cardJson).toContain('Contributor');
    expect(cardJson).toContain('template');
    expect(findButton(updatedCard!, 'Process Document')?.disabled).toBe(true);
    expect(readDocInfoText(updatedCard!, 'title', 'submittal-arch')).toBe('Drive URL Submittal');

    // Google Drive URL mode and InputDriveURL preserved; Copy Log button carries previousAttachments forward
    const fileSec = findSection(updatedCard!, 'File Selection');
    expect(
      fileSec?.widgets.find((w) => w.textInput?.name === 'InputDriveURL')?.textInput?.value
    ).toBe(driveUrl);
    const copyBtnParams = (
      findButton(updatedCard!, 'Copy Log')?.onClick as {
        action?: { parameters?: Array<{ key: string; value: string }> };
      }
    )?.action?.parameters;
    expect(copyBtnParams).toContainEqual({
      key: 'previousAttachments',
      value: JSON.stringify(['part-350-2']),
    });
    expect(copyBtnParams).toContainEqual({ key: 'previousDriveUrl', value: driveUrl });
    expect(nock.isDone()).toBe(true);
  });
});

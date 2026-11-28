import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { Value } from '@sinclair/typebox/value';
import { PDFDocument } from 'pdf-lib';
import { GoogleDriveClient } from '../src/infrastructure/drive/drive-client';
import type { GmailThreadDetails } from '../src/infrastructure/gmail/types';
import {
  GoogleWorkspaceActionResponseSchema,
  type GoogleWorkspaceActionResponse,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import {
  setupWorkspaceGmailIntegrationSuite,
  mockDocumentLogSearch,
  getCachedCoverSheetPdfBytes,
  getCachedFlatPdfBytes,
  CONFIG_ARCH_NAMED_RANGES,
  CONFIG_FFE_NAMED_RANGES,
  buildSubmittalArchOptionBatchGetReply,
} from './utils/workspace-gmail-test-helper';

describe('Workspace Gmail Pass 2 Pre-Population & Cover-Sheet Integration', () => {
  const ctx = setupWorkspaceGmailIntegrationSuite();

  describe('Ticket #303: Pass 2 Gmail field pre-population (communication-project & communication-proposal)', () => {
    beforeEach(() => {
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-pass2-e2e') {
          return {
            id: 'th-pass2-e2e',
            messages: [
              {
                id: 'msg-pass2-incoming',
                threadId: 'th-pass2-e2e',
                subject: 'Re: Fwd: Site Logistics Update',
                from: 'Vendor Partner <vendor@partner.com>',
                date: 'Mon, 19 Oct 2026 14:30:00 +0000',
                labels: ['INBOX'],
                plainTextBody: 'Please find attached site notes.',
                inlineImages: [],
                attachments: [],
              },
              {
                id: 'msg-pass2-outgoing',
                threadId: 'th-pass2-e2e',
                subject: 'Fwd: Project Proposal Overview',
                from: 'Project Manager <pm@inc.nyc>',
                date: 'Tue, 20 Oct 2026 09:15:00 -04:00',
                labels: ['SENT', 'INBOX'],
                plainTextBody: 'Here is the proposal details.',
                inlineImages: [],
                attachments: [],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });
    });

    it('pre-populates date, direction ("IN"), and description (prefix stripped) on incoming communication-project card', async () => {
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-pass2-incoming',
            threadId: 'th-pass2-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      const dateWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      )?.textInput;
      expect(dateWidget?.value).toBe('261019');

      const descWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
      )?.textInput;
      expect(descWidget?.value).toBe('Site Logistics Update');

      const directionWidget = docInfoSec?.widgets.find(
        (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
      )?.selectionInput;
      const selectedDir = directionWidget?.items?.find((item) => item.selected);
      expect(selectedDir?.value).toBe('IN');
    });

    it('pre-populates direction as "OT" for outgoing email (SENT label / inc.nyc sender) and strips prefixes', async () => {
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-pass2-outgoing',
            threadId: 'th-pass2-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      const dateWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      )?.textInput;
      expect(dateWidget?.value).toBe('261020');

      const descWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
      )?.textInput;
      expect(descWidget?.value).toBe('Project Proposal Overview');

      const directionWidget = docInfoSec?.widgets.find(
        (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
      )?.selectionInput;
      const selectedDir = directionWidget?.items?.find((item) => item.selected);
      expect(selectedDir?.value).toBe('OT');
    });

    it('pre-populates date, direction, and description when switching to communication-proposal', async () => {
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'onSpaceTypeChange',
            },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
            },
          },
          gmail: {
            messageId: 'msg-pass2-incoming',
            threadId: 'th-pass2-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.updateCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      const dateWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
      )?.textInput;
      expect(dateWidget?.value).toBe('261019');

      const descWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-proposal')
      )?.textInput;
      expect(descWidget?.value).toBe('Site Logistics Update');

      const directionWidget = docInfoSec?.widgets.find(
        (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-proposal')
      )?.selectionInput;
      const selectedDir = directionWidget?.items?.find((item) => item.selected);
      expect(selectedDir?.value).toBe('IN');
    });
  });

  describe('Ticket #304: 3-tier LookupField resolution, single listFolders execution, and counterparty contact pre-population', () => {
    beforeEach(() => {
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-pass2-ticket-304') {
          return {
            id: 'th-pass2-ticket-304',
            messages: [
              {
                id: 'msg-304-outgoing-matched',
                threadId: 'th-pass2-ticket-304',
                subject: 'Project Logistics & Schedule Update',
                from: 'Project Manager <pm@inc.nyc>',
                to: 'colleague@inc.nyc, "McGovern, James (Pavarini)" <jmcgovern@pavarini.com>',
                date: 'Tue, 20 Oct 2026 14:00:00 -04:00',
                labels: ['SENT', 'INBOX', 'Active Projects'],
                plainTextBody: 'Please find the schedule attached.',
                inlineImages: [],
                attachments: [],
              },
              {
                id: 'msg-304-outgoing-unmatched',
                threadId: 'th-pass2-ticket-304',
                subject: 'Unregistered Vendor Email',
                from: 'Project Manager <pm@inc.nyc>',
                to: 'colleague@inc.nyc, Unregistered Person <unregistered@somewhere.com>',
                date: 'Tue, 20 Oct 2026 15:00:00 -04:00',
                labels: ['SENT', 'INBOX', 'Active Projects'],
                plainTextBody: 'Hello world.',
                inlineImages: [],
                attachments: [],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });
    });

    it('filters internal colleagues from email.to, resolves external counterparty contact, executes listFolders at most once per (spaceId, sourceKey), and emits zero duplicate status banners', async () => {
      // Step 1: list folders in space root
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'space-projects-1' in parents`))
        .reply(200, { files: [{ id: 'admin-id', name: '1 Admin' }] });

      // Step 2: list folders in 1 Admin
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'admin-id' in parents`))
        .reply(200, { files: [{ id: 'comm-id', name: 'Communication' }] });

      // Step 3: list folders in Communication
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'comm-id' in parents`))
        .reply(200, { files: [{ id: 'pavarini-id', name: 'Pavarini' }] });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-304-outgoing-matched',
            threadId: 'th-pass2-ticket-304',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      const contactWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      )?.textInput;
      expect(contactWidget?.value).toBe('Pavarini');

      const directionWidget = docInfoSec?.widgets.find(
        (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
      )?.selectionInput;
      const selectedDir = directionWidget?.items?.find((item) => item.selected);
      expect(selectedDir?.value).toBe('OT');

      // Verify single-execution: each nock interceptor was called exactly ONCE across SourceParser and SchemaDrivenUi
      expect(nock.isDone()).toBe(true);

      // Verify zero duplicate status banners
      const allTextParagraphs = card?.sections.flatMap((s) =>
        s.widgets.map((w) => w.textParagraph?.text).filter(Boolean)
      ) ?? [];
      const statusBanners = allTextParagraphs.filter((t) => t?.includes('Status:'));
      const uniqueStatusBanners = new Set(statusBanners);
      expect(statusBanners.length).toBe(uniqueStatusBanners.size);
    });

    it('leaves allowUserInput LookupField blank when no canonical option or alias matches', async () => {
      // Step 1: list folders in space root
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'space-projects-1' in parents`))
        .reply(200, { files: [{ id: 'admin-id', name: '1 Admin' }] });

      // Step 2: list folders in 1 Admin
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'admin-id' in parents`))
        .reply(200, { files: [{ id: 'comm-id', name: 'Communication' }] });

      // Step 3: list folders in Communication
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes(`'comm-id' in parents`))
        .reply(200, { files: [{ id: 'pavarini-id', name: 'Pavarini' }] });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-304-outgoing-unmatched',
            threadId: 'th-pass2-ticket-304',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      const contactWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
      )?.textInput;
      expect(contactWidget?.value ?? '').toBe('');
      expect(nock.isDone()).toBe(true);
    });
  });

  describe('Ticket #305: End-to-end Gmail Workspace Add-on pre-population and Document submission for Submittal Arch & FF&E', () => {
    let coverSheetPdfBytes: Uint8Array;
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

    beforeEach(async () => {
      vi.stubEnv('SUBMITTAL_COVER_SHEET_TEMPLATE_ID', 'test-cover-sheet-tpl');
      coverSheetPdfBytes = await getCachedCoverSheetPdfBytes();
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-pass2-ticket-305-arch') {
          return {
            id: 'th-pass2-ticket-305-arch',
            messages: [
              {
                id: 'msg-305-arch-1',
                threadId: 'th-pass2-ticket-305-arch',
                subject: 'Submittal 071200-001-A Waterproofing Specs',
                from: 'James McGovern <jmcgovern@pavarini.com>',
                to: 'Architect <pm@inc.nyc>',
                date: 'Tue, 20 Oct 2026 14:00:00 -04:00',
                labels: ['INBOX', 'Active Projects'],
                plainTextBody: 'Please find the waterproofing submittal attached for review.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-arch-1',
                    attachmentId: 'att-arch-1',
                    filename: '071200-001-A Waterproofing Specs.pdf',
                    mimeType: 'application/pdf',
                    size: 2048,
                  },
                ],
              },
            ],
          };
        }
        if (threadId === 'th-pass2-ticket-305-ffe') {
          return {
            id: 'th-pass2-ticket-305-ffe',
            messages: [
              {
                id: 'msg-305-ffe-1',
                threadId: 'th-pass2-ticket-305-ffe',
                subject: 'CG104-A Berman Falk King Bed Submittal',
                from: 'Berman Rep <rep@bermanfalk.com>',
                to: 'Designer <designer@inc.nyc>, Benjamin West <procurement@benjaminwest.com>',
                date: 'Wed, 21 Oct 2026 10:00:00 -04:00',
                labels: ['INBOX', 'Active Projects'],
                plainTextBody: 'Attached is the CG104 King Bed submittal cut sheet.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-ffe-1',
                    attachmentId: 'att-ffe-1',
                    filename: 'CG104-A Berman Falk Cut Sheet.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      vi.spyOn(ctx.mockGmailClient, 'getMessage').mockImplementation(async (messageId: string) => {
        if (messageId === 'msg-305-arch-1') {
          return {
            id: 'msg-305-arch-1',
            messageId: 'msg-305-arch-1',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-arch-1',
                attachmentId: 'att-arch-1',
                filename: '071200-001-A Waterproofing Specs.pdf',
                mimeType: 'application/pdf',
                size: 2048,
              },
            ],
          };
        }
        if (messageId === 'msg-305-ffe-1') {
          return {
            id: 'msg-305-ffe-1',
            messageId: 'msg-305-ffe-1',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-ffe-1',
                attachmentId: 'att-ffe-1',
                filename: 'CG104-A Berman Falk Cut Sheet.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
            ],
          };
        }
        return { id: messageId, messageId, inlineImages: [], attachments: [] };
      });
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('renders Submittal Arch card with pre-populated compound attachment fields, contact alias, action: REC, and submits document successfully', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-305-arch-1',
            threadId: 'th-pass2-ticket-305-arch',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      const sectionWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
      )?.textInput;
      expect(sectionWidget?.value).toBe('071200');

      const numberWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
      )?.textInput;
      expect(numberWidget?.value).toBe('001');

      const revisionWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
      )?.textInput;
      expect(revisionWidget?.value).toBe('A');

      const titleWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch')
      )?.textInput;
      expect(titleWidget?.value).toBe('Waterproofing Specs');

      const dateWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
      )?.textInput;
      expect(dateWidget?.value).toBe('261020');

      const contactWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch')
      )?.textInput;
      expect(contactWidget?.value).toBe('PMG');

      const actionWidget = docInfoSec?.widgets.find(
        (w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
      )?.selectionInput;
      const selectedAction = actionWidget?.items?.find((i) => i.selected);
      expect(selectedAction?.value).toBe('REC');

      // Now submit processDocument
      const attachmentBytes = new Uint8Array([1, 2, 3, 4]);
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '6 Construction'"))
        .times(2)
        .reply(200, {
          files: [{ id: 'const-folder-id', name: '6 Construction', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('const-folder-id') && q.q.includes("name = 'Submittals'"))
        .times(2)
        .reply(200, {
          files: [{ id: 'submittals-folder-id', name: 'Submittals', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('submittals-folder-id') && q.q.includes("name = 'Closed'"))
        .reply(200, {
          files: [{ id: 'submittals-closed-id', name: 'Closed', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('submittals-closed-id') && q.q.includes("name = '07 Thermal and Moisture Protection'"))
        .reply(200, {
          files: [{ id: 'submittals-csi-07-id', name: '07 Thermal and Moisture Protection', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-submittal-arch',
          name: '071200-001-A Waterproofing Specs - 261020 PMG.pdf',
          mimeType: 'application/pdf',
          parents: ['submittals-csi-07-id'],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-submittal-arch/view',
        });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files/drive-saved-submittal-arch/copy')
        .query(true)
        .reply(200, (_uri, body) => {
          const reqBody = body as { name?: string; parents?: string[] };
          return {
            id: 'drive-saved-submittal-arch-copy',
            name: reqBody.name ?? '_071200-001-A Waterproofing Specs - 261020 PMG.pdf',
            mimeType: 'application/pdf',
            parents: reqBody.parents ?? ['submittals-folder-id'],
            webViewLink: 'https://drive.google.com/file/d/drive-saved-submittal-arch-copy/view',
          };
        });
      mockInsertCoverSheetNock({
        copyFileId: 'drive-saved-submittal-arch-copy',
        copyFileName: '_071200-001-A Waterproofing Specs - 261020 PMG.pdf',
        copyParentId: 'submittals-folder-id',
        pdfBytes: coverSheetPdfBytes,
      });

      // WRITE_LOG: Drive discovery + Sheets read/batchUpdate
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query(
          (q) =>
            q.driveId === 'shared-drive-proj-root' &&
            typeof q.q === 'string' &&
            q.q.includes("name contains 'Document Log'")
        )
        .reply(200, {
          files: [
            {
              id: 'doc-log-proj-1',
              name: 'Active Projects Document Log',
              mimeType: 'application/vnd.google-apps.spreadsheet',
              parents: ['admin-folder-id'],
            },
          ],
        });

      nock('https://sheets.googleapis.com')
        .get('/v4/spreadsheets/doc-log-proj-1')
        .query(true)
        .times(2)
        .reply(200, {
          spreadsheetId: 'doc-log-proj-1',
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
                endRowIndex: 25,
                startColumnIndex: 0,
                endColumnIndex: 10,
              },
            },
            ...CONFIG_ARCH_NAMED_RANGES,
          ],
        });

      nock('https://sheets.googleapis.com')
        .get('/v4/spreadsheets/doc-log-proj-1/values:batchGet')
        .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
        .reply(200, (uri) => buildSubmittalArchOptionBatchGetReply(uri));

      nock('https://sheets.googleapis.com')
        .get(/\/v4\/spreadsheets\/doc-log-proj-1\/values\/.*/)
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
            [],
            ['<--->'],
            [],
            ['<--->'],
          ],
        });

      nock('https://sheets.googleapis.com')
        .get('/v4/spreadsheets/doc-log-proj-1/values:batchGet')
        .query((q) => q.valueRenderOption === 'FORMULA')
        .reply(200, {
          valueRanges: [{ values: [[]] }],
        });

      let capturedBatchUpdate: Record<string, unknown> | undefined;
      nock('https://sheets.googleapis.com')
        .post('/v4/spreadsheets/doc-log-proj-1:batchUpdate', (body) => {
          capturedBatchUpdate = body as Record<string, unknown>;
          return true;
        })
        .reply(200, {});

      const submitRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-305-arch-1',
            threadId: 'th-pass2-ticket-305-arch',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'processDocument' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-arch-1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['false'] } },
              [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
              [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
              [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['A'] } },
              [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing Specs'] } },
              [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['261020'] } },
              [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
              [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
              [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            },
          },
        },
      });

      expect(submitRes.statusCode).toBe(200);
      const submitBody = JSON.parse(submitRes.payload) as GoogleWorkspaceActionResponse;
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, submitBody)).toBe(true);
      expect(submitBody.action?.notification).toBeUndefined();
      expect(submitBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Submittal Arch Filed');
      expect(capturedBatchUpdate).toBeDefined();
      expect(JSON.stringify(capturedBatchUpdate)).toContain(
        '=HYPERLINK(\\"https://drive.google.com/file/d/drive-saved-submittal-arch/view\\", \\"Link\\")'
      );
      expect(nock.isDone()).toBe(true);
    });

    it('renders Submittal FF&E card with pre-populated specTag, auto-derived specTitle, vendor alias, action: REC, and submits document successfully', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-305-ffe-1',
            threadId: 'th-pass2-ticket-305-ffe',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      const specTagWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe')
      )?.textInput;
      expect(specTagWidget?.value).toBe('CG104');

      const specTitleWidget = docInfoSec?.widgets.find(
        (w) => w.decoratedText?.topLabel === 'Spec Title'
      )?.decoratedText;
      expect(specTitleWidget).toEqual({
        topLabel: 'Spec Title',
        text: 'BED - KING',
        wrapText: true,
      }); // auto-derived locked LinkedField!
      expect(
        docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
        )
      ).toBeUndefined();

      const revisionWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe')
      )?.textInput;
      expect(revisionWidget?.value).toBe('A');

      const vendorWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('vendor', 'submittal-ffe')
      )?.textInput;
      expect(vendorWidget?.value).toBe('BM');

      const dateWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-ffe')
      )?.textInput;
      expect(dateWidget?.value).toBe('261021');

      const actionWidget = docInfoSec?.widgets.find(
        (w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-ffe')
      )?.selectionInput;
      const selectedAction = actionWidget?.items?.find((i) => i.selected);
      expect(selectedAction?.value).toBe('REC');

      // Now submit processDocument for submittal-ffe
      const attachmentBytes = new Uint8Array([5, 6, 7, 8]);
      ctx.mockGmailClient.getAttachment = vi.fn().mockResolvedValue(attachmentBytes);

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('shared-drive-proj-root') && q.q.includes("name = '3 FFE'"))
        .times(2)
        .reply(200, {
          files: [{ id: 'ffe-folder-id', name: '3 FFE', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('ffe-folder-id') && q.q.includes("name = '05 Submittals'"))
        .times(2)
        .reply(200, {
          files: [{ id: 'ffe-submittals-id', name: '05 Submittals', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('ffe-submittals-id') && q.q.includes("name = 'Closed'"))
        .reply(200, {
          files: [{ id: 'ffe-closed-id', name: 'Closed', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('ffe-closed-id') && q.q.includes("name = 'CG'"))
        .reply(200, {
          files: [{ id: 'ffe-cg-id', name: 'CG', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query((q) => typeof q.q === 'string' && q.q.includes('ffe-cg-id') && q.q.includes("name = 'CG104'"))
        .reply(200, {
          files: [{ id: 'ffe-cg104-id', name: 'CG104', mimeType: 'application/vnd.google-apps.folder' }],
        });

      nock('https://www.googleapis.com')
        .post('/upload/drive/v3/files')
        .query(true)
        .reply(200, {
          id: 'drive-saved-submittal-ffe',
          name: 'CG104-A Berman Falk - 261021 INC.pdf',
          mimeType: 'application/pdf',
          parents: ['ffe-cg104-id'],
          webViewLink: 'https://drive.google.com/file/d/drive-saved-submittal-ffe/view',
        });

      nock('https://www.googleapis.com')
        .post('/drive/v3/files/drive-saved-submittal-ffe/copy')
        .query(true)
        .reply(200, (_uri, body) => {
          const reqBody = body as { name?: string; parents?: string[] };
          return {
            id: 'drive-saved-submittal-ffe-copy',
            name: reqBody.name ?? '_CG104-A Berman Falk - 261021 INC.pdf',
            mimeType: 'application/pdf',
            parents: reqBody.parents ?? ['ffe-submittals-id'],
            webViewLink: 'https://drive.google.com/file/d/drive-saved-submittal-ffe-copy/view',
          };
        });
      mockInsertCoverSheetNock({
        copyFileId: 'drive-saved-submittal-ffe-copy',
        copyFileName: '_CG104-A Berman Falk - 261021 INC.pdf',
        copyParentId: 'ffe-submittals-id',
        pdfBytes: coverSheetPdfBytes,
      });

      // WRITE_LOG: Drive discovery + Sheets read/FORMULA check + batchUpdate (protecting Spec Title)
      nock('https://www.googleapis.com')
        .get('/drive/v3/files')
        .query(
          (q) =>
            q.driveId === 'shared-drive-proj-root' &&
            typeof q.q === 'string' &&
            q.q.includes("name contains 'Document Log'")
        )
        .reply(200, {
          files: [
            {
              id: 'doc-log-proj-1',
              name: 'Active Projects Document Log',
              mimeType: 'application/vnd.google-apps.spreadsheet',
              parents: ['admin-folder-id'],
            },
          ],
        });

      nock('https://sheets.googleapis.com')
        .get('/v4/spreadsheets/doc-log-proj-1')
        .query(true)
        .times(2)
        .reply(200, {
          spreadsheetId: 'doc-log-proj-1',
          sheets: [
            { properties: { sheetId: 102, title: 'Submittal FF&E' } },
            { properties: { sheetId: 104, title: '_Config Submittal FF&E' } },
          ],
          namedRanges: [
            {
              namedRangeId: 'nr-ffe',
              name: 'Log_Submittal_FFE',
              range: {
                sheetId: 102,
                startRowIndex: 2,
                endRowIndex: 21,
                startColumnIndex: 0,
                endColumnIndex: 11,
              },
            },
            ...CONFIG_FFE_NAMED_RANGES,
          ],
        });

      nock('https://sheets.googleapis.com')
        .get('/v4/spreadsheets/doc-log-proj-1/values:batchGet')
        .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
        .reply(200, (uri) => buildSubmittalArchOptionBatchGetReply(uri));

      nock('https://sheets.googleapis.com')
        .get(/\/v4\/spreadsheets\/doc-log-proj-1\/values\/.*/)
        .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
        .reply(200, {
          values: [
            [
              'Status',
              'Spec Tag',
              'Related Tag',
              'Revision',
              'Spec Title',
              'Vendor',
              'Date',
              'Contact',
              'Action',
              'Notes',
              'Calc Link',
            ],
            ['Formula Row', '', '', '', ''],
            ['<--->'],
            [],
            ['<--->'],
          ],
        });

      nock('https://sheets.googleapis.com')
        .get('/v4/spreadsheets/doc-log-proj-1/values:batchGet')
        .query((q) => q.valueRenderOption === 'FORMULA')
        .reply(200, {
          valueRanges: [
            {
              values: [
                [
                  'Formula Row',
                  '',
                  '',
                  '',
                  '=ARRAYFORMULA(IF(B6:B="","",VLOOKUP(B6:B,Options_Submittal_FFE_Specs,2,FALSE)))',
                ],
              ],
            },
          ],
        });

      let capturedBatchUpdate: Record<string, unknown> | undefined;
      nock('https://sheets.googleapis.com')
        .post('/v4/spreadsheets/doc-log-proj-1:batchUpdate', (body) => {
          capturedBatchUpdate = body as Record<string, unknown>;
          return true;
        })
        .reply(200, {});

      const submitRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-305-ffe-1',
            threadId: 'th-pass2-ticket-305-ffe',
            accessToken: 'ya29.live-token',
          },
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'processDocument' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
              SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
              SelectAttachments: { stringInputs: { value: ['part-ffe-1'] } },
              SaveEmailToPdf: { stringInputs: { value: ['false'] } },
              [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: ['CG104'] } },
              [getDocumentInfoWidgetName('specTitle', 'submittal-ffe')]: { stringInputs: { value: ['BED - KING'] } },
              [getDocumentInfoWidgetName('revision', 'submittal-ffe')]: { stringInputs: { value: ['A'] } },
              [getDocumentInfoWidgetName('vendor', 'submittal-ffe')]: { stringInputs: { value: ['BM'] } },
              [getDocumentInfoWidgetName('date', 'submittal-ffe')]: { stringInputs: { value: ['261021'] } },
              [getDocumentInfoWidgetName('contact', 'submittal-ffe')]: { stringInputs: { value: ['INC'] } },
              [getDocumentInfoWidgetName('action', 'submittal-ffe')]: { stringInputs: { value: ['REC'] } },
              [getDocumentInfoWidgetName('status', 'submittal-ffe')]: { stringInputs: { value: ['Open'] } },
            },
          },
        },
      });

      expect(submitRes.statusCode).toBe(200);
      const submitBody = JSON.parse(submitRes.payload) as GoogleWorkspaceActionResponse;
      expect(Value.Check(GoogleWorkspaceActionResponseSchema, submitBody)).toBe(true);
      expect(submitBody.action?.notification).toBeUndefined();
      expect(submitBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe('Submittal FF&E Filed');
      expect(capturedBatchUpdate).toBeDefined();
      const batchRequests = (capturedBatchUpdate as { requests: Array<{ updateCells?: { range?: { startColumnIndex?: number; endColumnIndex?: number } } }> }).requests;
      expect(batchRequests.map((r) => [r.updateCells?.range?.startColumnIndex, r.updateCells?.range?.endColumnIndex])).toEqual([
        [0, 4],
        [5, 11],
      ]);
      expect(JSON.stringify(capturedBatchUpdate)).toContain(
        '=HYPERLINK(\\"https://drive.google.com/file/d/drive-saved-submittal-ffe/view\\", \\"Link\\")'
      );
      expect(nock.isDone()).toBe(true);
    });

    it('does not fall back to email.from ("INC") for contact on outgoing submittal-arch emails to unregistered external recipients (Spec #6)', async () => {
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-spec6-outgoing',
        messages: [
          {
            id: 'msg-spec6-1',
            threadId: 'th-spec6-outgoing',
            subject: '071200-001 Waterproofing Submittal',
            from: 'INC PM <pm@inc.nyc>',
            to: 'colleague@inc.nyc, Stranger <stranger@unknown-vendor.com>',
            date: 'Wed, 21 Oct 2026 10:00:00 GMT',
            labels: ['SENT'],
            inlineImages: [],
            attachments: [
              {
                partId: 'part-arch-1',
                attachmentId: 'att-arch-1',
                filename: '071200-001-A_Waterproofing.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
            ],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-spec6-1',
            threadId: 'th-spec6-outgoing',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');
      const contactWidget = docInfoSec?.widgets.find(
        (w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch')
      )?.textInput;
      expect(contactWidget?.value ?? '').toBe('');
    });

    it('binds specTag and revision to CG104-A_CutSheet.pdf across [Berman_Cover.pdf, CG104-A_CutSheet.pdf] and resolves vendor BM via real submittal-ffe.json', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-iter2-ffe-multi-att',
        messages: [
          {
            id: 'msg-iter2-ffe-1',
            threadId: 'th-iter2-ffe-multi-att',
            subject: 'Submittal Package',
            from: 'Berman Rep <rep@bermanfalk.com>',
            to: 'Designer <designer@inc.nyc>',
            date: 'Wed, 21 Oct 2026 10:00:00 -04:00',
            labels: ['INBOX', 'Active Projects'],
            plainTextBody: 'Please find the cut sheet attached.',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-cover',
                attachmentId: 'att-cover',
                filename: 'Berman_Cover.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
              {
                partId: 'part-cutsheet',
                attachmentId: 'att-cutsheet',
                filename: 'CG104-A_CutSheet.pdf',
                mimeType: 'application/pdf',
                size: 2048,
              },
            ],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-iter2-ffe-1',
            threadId: 'th-iter2-ffe-multi-att',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe'))?.textInput?.value
      ).toBe('CG104');
      expect(
        docInfoSec?.widgets.find((w) => w.decoratedText?.topLabel === 'Spec Title')?.decoratedText
      ).toEqual({
        topLabel: 'Spec Title',
        text: 'BED - KING',
        wrapText: true,
      });
      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe'))
      ).toBeUndefined();
      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe'))?.textInput?.value
      ).toBe('A');
      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('vendor', 'submittal-ffe'))?.textInput?.value
      ).toBe('BM');
    });

    it('ignores PO12345 prefix and extracts CG104-A from subject "PO12345 - CG104-A" against real submittal-ffe.json', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-iter2-ffe-po',
        messages: [
          {
            id: 'msg-iter2-ffe-po',
            threadId: 'th-iter2-ffe-po',
            subject: 'PO12345 - CG104-A',
            from: 'Berman Rep <rep@bermanfalk.com>',
            to: 'Designer <designer@inc.nyc>',
            date: 'Wed, 21 Oct 2026 10:00:00 -04:00',
            labels: ['INBOX', 'Active Projects'],
            plainTextBody: 'Attached.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-iter2-ffe-po',
            threadId: 'th-iter2-ffe-po',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe'))?.textInput?.value
      ).toBe('CG104');
      expect(
        docInfoSec?.widgets.find((w) => w.decoratedText?.topLabel === 'Spec Title')?.decoratedText
      ).toEqual({
        topLabel: 'Spec Title',
        text: 'BED - KING',
        wrapText: true,
      });
      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe'))
      ).toBeUndefined();
      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe'))?.textInput?.value
      ).toBe('A');
    });

    it('ignores prefixed token "XCG104-Z" and resolves specTag "CG104" and revision "A" from "XCG104-Z - CG104-A" against real submittal-ffe.json', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-iter3-ffe-xcg',
        messages: [
          {
            id: 'msg-iter3-ffe-xcg',
            threadId: 'th-iter3-ffe-xcg',
            subject: 'XCG104-Z - CG104-A',
            from: 'Berman Rep <rep@bermanfalk.com>',
            to: 'Designer <designer@inc.nyc>',
            date: 'Wed, 21 Oct 2026 10:00:00 -04:00',
            labels: ['INBOX', 'Active Projects'],
            plainTextBody: 'Attached.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-iter3-ffe-xcg',
            threadId: 'th-iter3-ffe-xcg',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.pushCard;
      const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');

      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe'))?.textInput?.value
      ).toBe('CG104');
      expect(
        docInfoSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe'))?.textInput?.value
      ).toBe('A');
    });
  });

  describe('Ticket #307: Gmail Google Drive URL fallback vs Email Attachments skip for source: "drive"', () => {
    it('prefers gmail email.date in Google Drive URL mode and falls back to drive.modifiedTime when email.date is absent', async () => {
      const driveGetFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-comm-1',
        name: 'Meeting_Minutes.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-comm-1'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-03-16T02:30:00Z', // 260315 in America/New_York
      });
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValue({
        id: 'th-drive-url-307',
        messages: [
          {
            id: 'msg-with-date',
            threadId: 'th-drive-url-307',
            subject: 'Re: Active Projects - Weekly Sync',
            from: 'Alice <alice@example.com>',
            date: 'Mon, 19 Oct 2026 10:00:00 -0400',
            plainTextBody: 'See link.',
            inlineImages: [],
            attachments: [],
          },
          {
            id: 'msg-no-date',
            threadId: 'th-drive-url-307',
            subject: 'Re: Active Projects - Follow-up Sync',
            from: 'Alice <alice@example.com>',
            plainTextBody: 'See link.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      // 1. email.date present -> gmail wins (261019)
      const res1 = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: ['https://drive.google.com/file/d/drive-url-comm-1/view'] } },
            },
          },
          gmail: {
            messageId: 'msg-with-date',
            threadId: 'th-drive-url-307',
            accessToken: 'ya29.live-token',
          },
        },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.payload) as GoogleWorkspaceActionResponse;
      const docSec1 = body1.action?.navigations?.[0]?.updateCard?.sections.find((s) => s.header === 'Document Data');
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project'))?.textInput?.value
      ).toBe('261019');

      // 2. email.date absent -> drive fills blank date (260315) while gmail fills description
      driveGetFileSpy.mockClear();
      const res2 = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: { stringInputs: { value: ['https://drive.google.com/file/d/drive-url-comm-1/view'] } },
            },
          },
          gmail: {
            messageId: 'msg-no-date',
            threadId: 'th-drive-url-307',
            accessToken: 'ya29.live-token',
          },
        },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.payload) as GoogleWorkspaceActionResponse;
      const docSec2 = body2.action?.navigations?.[0]?.updateCard?.sections.find((s) => s.header === 'Document Data');
      expect(
        docSec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project'))?.textInput?.value
      ).toBe('260315');
      expect(
        docSec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project'))?.textInput?.value
      ).toBe('Active Projects - Follow-up Sync');
    });

    it('skips source: "drive" extractors completely in Gmail Email Attachments mode', async () => {
      const driveGetFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile');

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-att-skip-307',
        messages: [
          {
            id: 'msg-att-skip-307',
            threadId: 'th-att-skip-307',
            subject: 'Active Projects - No Date Email',
            from: 'Alice <alice@example.com>',
            plainTextBody: 'Attached.',
            inlineImages: [],
            attachments: [{ partId: '1', attachmentId: 'att-part-1', filename: 'Notes.pdf', mimeType: 'application/pdf', size: 100 }],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-att-skip-307',
            threadId: 'th-att-skip-307',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(driveGetFileSpy).not.toHaveBeenCalled();
    });

    it('memoizes target-item 403 error across Pass 1 + Pass 2 in Google Drive URL mode, still populates gmail fields, and emits only one Drive warning banner', async () => {
      const err403 = new Error('Forbidden') as Error & { statusCode: number };
      err403.statusCode = 403;
      const driveGetFileSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'getFile')
        .mockRejectedValue(err403);

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-drive-url-403',
        messages: [
          {
            id: 'msg-drive-url-403',
            threadId: 'th-drive-url-403',
            subject: 'Re: Active Projects - Restricted Link Discussion',
            from: 'Alice <alice@example.com>',
            plainTextBody: 'Please see the restricted file.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/forbidden-drive-url-1/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-drive-url-403',
            threadId: 'th-drive-url-403',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(driveGetFileSpy).toHaveBeenCalledTimes(1);

      const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const card = body.action?.navigations?.[0]?.updateCard;
      const cardJson = JSON.stringify(card);

      expect(cardJson).toContain(
        'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.'
      );
      expect(cardJson).not.toContain(
        'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.'
      );

      const docSec = card?.sections.find((s) => s.header === 'Document Data');
      expect(
        docSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
        )?.textInput?.value
      ).toBe('Active Projects - Restricted Link Discussion');
    });
  });

  describe('Ticket #310: Flexible Submittal Arch Gmail Email Attachments & Google Drive URL pre-population', () => {
    it('pre-populates flexible attachment fields in Email Attachments mode, skips Drive API, avoids splicing unrelated subject v2, and preserves .Inc/.Ltd in subject', async () => {
      const driveGetFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile');

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => {
        if (threadId === 'th-arch-310-att') {
          return {
            id: 'th-arch-310-att',
            messages: [
              {
                id: 'msg-arch-310-att',
                threadId: 'th-arch-310-att',
                subject: 'Re: Submittal Package v2 - 071200-001 Waterproofing by Acme.Inc',
                from: 'James McGovern <jmcgovern@pavarini.com>',
                to: 'Architect <pm@inc.nyc>',
                date: 'Tue, 17 Nov 2026 14:00:00 -0500',
                labels: ['INBOX', 'Active Projects'],
                plainTextBody: 'Attached is the waterproofing submittal.',
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
          };
        }
        return {
          id: 'th-arch-310-subj',
          messages: [
            {
              id: 'msg-arch-310-subj',
              threadId: 'th-arch-310-subj',
              subject: 'Re: 071200-001 Waterproofing by Acme.Inc',
              from: 'James McGovern <jmcgovern@pavarini.com>',
              to: 'Architect <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 14:00:00 -0500',
              labels: ['INBOX', 'Active Projects'],
              plainTextBody: 'Please review.',
              inlineImages: [],
              attachments: [],
            },
          ],
        };
      });

      // 1. Attachment without revision + unrelated "v2" in subject -> revision stays blank, Drive API never called
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const res1 = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-arch-310-att',
            threadId: 'th-arch-310-att',
            accessToken: 'ya29.live-token',
          },
        },
      });
      expect(res1.statusCode).toBe(200);
      expect(driveGetFileSpy).not.toHaveBeenCalled();

      const card1 = (JSON.parse(res1.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.pushCard;
      const docSec1 = card1?.sections.find((s) => s.header === 'Document Data');
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch'))?.textInput?.value
      ).toBe('071200');
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch'))?.textInput?.value
      ).toBe('001');
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch'))?.textInput?.value
      ).toBeUndefined();
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch'))?.textInput?.value
      ).toBe('Waterproofing');
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch'))?.textInput?.value
      ).toBe('PMG');

      // 2. Subject ending in .Inc does NOT get truncated as a file extension
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const res2 = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-arch-310-subj',
            threadId: 'th-arch-310-subj',
            accessToken: 'ya29.live-token',
          },
        },
      });
      expect(res2.statusCode).toBe(200);
      const card2 = (JSON.parse(res2.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.pushCard;
      const docSec2 = card2?.sections.find((s) => s.header === 'Document Data');
      expect(
        docSec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch'))?.textInput?.value
      ).toBe('Waterproofing by Acme.Inc');
    });

    it('extracts submittal-arch attachmentName titles cleanly without double-stripping .Inc/.Ltd/.2 while stripping trailing dates', async () => {
      const attachmentCases = [
        {
          threadId: 'th-arch-310-date-att',
          messageId: 'msg-arch-310-date-att',
          filename: '071200-001_Waterproofing_2026-11-15.pdf',
          expectedTitle: 'Waterproofing',
        },
        {
          threadId: 'th-arch-310-inc-att',
          messageId: 'msg-arch-310-inc-att',
          filename: '071200-001_Waterproofing_by_Acme.Inc.pdf',
          expectedTitle: 'Waterproofing by Acme.Inc',
        },
        {
          threadId: 'th-arch-310-ltd-att',
          messageId: 'msg-arch-310-ltd-att',
          filename: '071200-001_Waterproofing_Supply.Ltd.pdf',
          expectedTitle: 'Waterproofing Supply.Ltd',
        },
        {
          threadId: 'th-arch-310-spec-att',
          messageId: 'msg-arch-310-spec-att',
          filename: '071200-001_Spec_v1.2.pdf',
          expectedTitle: 'Spec v1.2',
        },
      ] as const;

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => {
        const matched = attachmentCases.find((c) => c.threadId === threadId);
        if (!matched) {
          throw new Error(`Unexpected threadId: ${threadId}`);
        }
        return {
          id: matched.threadId,
          messages: [
            {
              id: matched.messageId,
              threadId: matched.threadId,
              subject: 'Submittal Package',
              from: 'James McGovern <jmcgovern@pavarini.com>',
              to: 'Architect <pm@inc.nyc>',
              date: 'Tue, 17 Nov 2026 14:00:00 -0500',
              labels: ['INBOX', 'Active Projects'],
              plainTextBody: 'Attached.',
              inlineImages: [],
              attachments: [
                {
                  partId: 'part-1',
                  attachmentId: 'att-1',
                  filename: matched.filename,
                  mimeType: 'application/pdf',
                  size: 1024,
                },
              ],
            },
          ],
        };
      });

      for (const c of attachmentCases) {
        mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: c.messageId,
              threadId: c.threadId,
              accessToken: 'ya29.live-token',
            },
          },
        });
        expect(res.statusCode).toBe(200);
        const card = (JSON.parse(res.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.pushCard;
        const docSec = card?.sections.find((s) => s.header === 'Document Data');
        expect(
          docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch'))
            ?.textInput?.value,
          c.filename
        ).toBe(c.expectedTitle);
      }
    });

    it('runs gmail before drive in Google Drive URL mode for submittal-arch, letting gmail win first and drive fill remaining blank fields', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const flatPdfBytes = await getCachedFlatPdfBytes();
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(flatPdfBytes);
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-arch-310',
        name: '07 12 00 - 1_v1_Waterproofing_Drive_Title.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-drive-url-arch-310',
        messages: [
          {
            id: 'msg-drive-url-arch-310',
            threadId: 'th-drive-url-arch-310',
            subject: '071200-001 Waterproofing by Acme.Inc',
            from: 'James McGovern <jmcgovern@pavarini.com>',
            to: 'Architect <pm@inc.nyc>',
            labels: ['INBOX', 'Active Projects'],
            plainTextBody: 'See Google Drive link.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/drive-url-arch-310/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-drive-url-arch-310',
            threadId: 'th-drive-url-arch-310',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = (JSON.parse(res.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const docSec = card?.sections.find((s) => s.header === 'Document Data');

      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch'))?.textInput?.value
      ).toBe('071200');
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch'))?.textInput?.value
      ).toBe('001');
      // Gmail wins title (preserving .Inc), while Drive fills blank revision ('0' from v1) and date ('261118')
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch'))?.textInput?.value
      ).toBe('Waterproofing by Acme.Inc');
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch'))?.textInput?.value
      ).toBe('0');
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch'))?.textInput?.value
      ).toBe('261118');
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch'))?.textInput?.value
      ).toBe('PMG');
    });
  });

  describe('Ticket #311: Flexible Submittal FF&E Gmail Email Attachments & Google Drive URL pre-population', () => {
    it('pre-populates flexible FF&E attachment fields in Email Attachments mode (CG-104_v2_Fil_Doux.pdf, LT 159A_R0.pdf), skips Drive API, and guards lowercase prose', async () => {
      const driveGetFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile');

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => {
        if (threadId === 'th-ffe-311-att') {
          return {
            id: 'th-ffe-311-att',
            messages: [
              {
                id: 'msg-ffe-311-att',
                threadId: 'th-ffe-311-att',
                subject: 'King Bed Cut Sheet',
                from: 'Rep <rep@fildoux.com>',
                to: 'Designer <designer@inc.nyc>',
                date: 'Tue, 17 Nov 2026 14:00:00 -0500',
                labels: ['INBOX', 'Active Projects'],
                plainTextBody: 'Attached is the revised cut sheet.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-1',
                    attachmentId: 'att-1',
                    filename: 'CG-104_v2_Fil_Doux.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        if (threadId === 'th-ffe-311-lt') {
          return {
            id: 'th-ffe-311-lt',
            messages: [
              {
                id: 'msg-ffe-311-lt',
                threadId: 'th-ffe-311-lt',
                subject: 'Re: Corridor Sconce Submittal',
                from: 'Lighting <sales@ashleylighting.com>',
                to: 'Designer <designer@inc.nyc>',
                date: 'Tue, 17 Nov 2026 14:00:00 -0500',
                labels: ['INBOX', 'Active Projects'],
                plainTextBody: 'See attached.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-1',
                    attachmentId: 'att-1',
                    filename: 'LT 159A_R0.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return {
          id: 'th-ffe-311-neg',
          messages: [
            {
              id: 'msg-ffe-311-neg',
              threadId: 'th-ffe-311-neg',
              subject: 'Schedule Update',
              from: 'Alice <alice@example.com>',
              to: 'Designer <designer@inc.nyc>',
              date: 'Tue, 17 Nov 2026 14:00:00 -0500',
              labels: ['INBOX', 'Active Projects'],
              plainTextBody: 'Delivery in 100 days and installation at 120V panel.',
              inlineImages: [],
              attachments: [],
            },
          ],
        };
      });

      // 1. CG-104_v2_Fil_Doux.pdf -> specTag CG104, specTitle BED - KING, revision 1, vendor FDT, Drive API never called
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const res1 = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-ffe-311-att',
            threadId: 'th-ffe-311-att',
            accessToken: 'ya29.live-token',
          },
        },
      });
      expect(res1.statusCode).toBe(200);
      expect(driveGetFileSpy).not.toHaveBeenCalled();

      const card1 = (JSON.parse(res1.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.pushCard;
      const docSec1 = card1?.sections.find((s) => s.header === 'Document Data');
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe'))?.textInput?.value
      ).toBe('CG104');
      expect(
        docSec1?.widgets.find((w) => w.decoratedText?.topLabel === 'Spec Title')?.decoratedText
      ).toEqual({
        topLabel: 'Spec Title',
        text: 'BED - KING',
        wrapText: true,
      });
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe'))
      ).toBeUndefined();
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe'))?.textInput?.value
      ).toBe('1');
      expect(
        docSec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('vendor', 'submittal-ffe'))?.textInput?.value
      ).toBe('FDT');

      // 2. LT 159A_R0.pdf -> specTag LT159A, specTitle SCONCE - CORRIDOR, revision 0, vendor AL
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const res2 = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-ffe-311-lt',
            threadId: 'th-ffe-311-lt',
            accessToken: 'ya29.live-token',
          },
        },
      });
      expect(res2.statusCode).toBe(200);
      const card2 = (JSON.parse(res2.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.pushCard;
      const docSec2 = card2?.sections.find((s) => s.header === 'Document Data');
      expect(
        docSec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe'))?.textInput?.value
      ).toBe('LT159A');
      expect(
        docSec2?.widgets.find((w) => w.decoratedText?.topLabel === 'Spec Title')?.decoratedText
      ).toEqual({
        topLabel: 'Spec Title',
        text: 'SCONCE - CORRIDOR',
        wrapText: true,
      });
      expect(
        docSec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe'))
      ).toBeUndefined();
      expect(
        docSec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe'))?.textInput?.value
      ).toBe('0');
      expect(
        docSec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('vendor', 'submittal-ffe'))?.textInput?.value
      ).toBe('AL');

      // 3. Negative lowercase prose ("in 100 days" / "at 120V panel") -> does NOT route to submittal-ffe
      const res3 = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-ffe-311-neg',
            threadId: 'th-ffe-311-neg',
            accessToken: 'ya29.live-token',
          },
        },
      });
      expect(res3.statusCode).toBe(200);
      const card3 = (JSON.parse(res3.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.pushCard;
      const docTypeSec3 = card3?.sections.find((s) => s.header === 'Document Type');
      const selectedDocType3 = docTypeSec3?.widgets
        .find((w) => w.selectionInput?.name === getDocumentTypeWidgetName('projects'))
        ?.selectionInput?.items.find((i) => i.selected)?.value;
      expect(selectedDocType3).toBe('communication-project');
    });

    it('runs gmail before drive in Google Drive URL mode for submittal-ffe, letting gmail win first and drive fill remaining blank fields', async () => {
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const flatPdfBytes = await getCachedFlatPdfBytes();
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(flatPdfBytes);
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-ffe-311',
        name: 'CG-104_v2_Fil_Doux.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValueOnce({
        id: 'th-drive-url-ffe-311',
        messages: [
          {
            id: 'msg-drive-url-ffe-311',
            threadId: 'th-drive-url-ffe-311',
            subject: 'Please review attached link',
            from: 'Benjamin West <procurement@benjaminwest.com>',
            to: 'Designer <designer@inc.nyc>',
            labels: ['INBOX', 'Active Projects'],
            plainTextBody: 'See Google Drive link.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/drive-url-ffe-311/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-drive-url-ffe-311',
            threadId: 'th-drive-url-ffe-311',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = (JSON.parse(res.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const docSec = card?.sections.find((s) => s.header === 'Document Data');

      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTag', 'submittal-ffe'))?.textInput?.value
      ).toBe('CG104');
      expect(
        docSec?.widgets.find((w) => w.decoratedText?.topLabel === 'Spec Title')?.decoratedText
      ).toEqual({
        topLabel: 'Spec Title',
        text: 'BED - KING',
        wrapText: true,
      });
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe'))
      ).toBeUndefined();
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-ffe'))?.textInput?.value
      ).toBe('1');
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('vendor', 'submittal-ffe'))?.textInput?.value
      ).toBe('FDT');
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-ffe'))?.textInput?.value
      ).toBe('261118');
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-ffe'))?.textInput?.value
      ).toBe('BW');
      expect(JSON.stringify(card)).not.toContain('Could not read Google Drive file metadata');
    });
  });

  describe('Ticket #315: Submittal Arch PDF AcroForm pre-population in Gmail Google Drive URL vs Email Attachments mode', () => {
    it('populates action from stamped Drive PDF in Google Drive URL mode for @inc.nyc sender while skipping form extraction in Email Attachments mode', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([600, 400]);
      const form = doc.getForm();
      const radio = form.createRadioGroup('Submittal Response');
      radio.addOptionToPage('No Exceptions Taken', doc.getPage(0), { x: 50, y: 300, width: 12, height: 12 });
      radio.addOptionToPage('No Objections As Corrected', doc.getPage(0), { x: 50, y: 280, width: 12, height: 12 });
      radio.select('No Objections As Corrected');
      const stampedPdfBytes = await doc.save();

      const getFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-arch-315',
        name: '071200-001_Waterproofing_Stamped.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      const downloadMediaSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'downloadFileMedia')
        .mockResolvedValue(stampedPdfBytes);
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => ({
        id: threadId,
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            subject: '071200-001 Waterproofing Review',
            from: 'Reviewer <pm@inc.nyc>',
            to: 'James McGovern <jmcgovern@pavarini.com>',
            labels: ['INBOX', 'SENT', 'Active Projects'],
            plainTextBody: 'See reviewed submittal.',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-arch-315',
                attachmentId: 'att-arch-315',
                filename: '071200-001_Waterproofing.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
            ],
          },
        ],
      }));

      // 1. Google Drive URL mode -> form extractor runs and extracts action: NOC
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const urlRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/drive-url-arch-315/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-drive-url-315',
            threadId: 'th-drive-url-315',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(urlRes.statusCode).toBe(200);
      const urlCard = (JSON.parse(urlRes.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const urlDocSec = urlCard?.sections.find((s) => s.header === 'Document Data');
      const selectedAction = urlDocSec?.widgets
        .find((w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch'))
        ?.selectionInput?.items.find((i) => i.selected)?.value;
      expect(selectedAction).toBe('NOC');
      expect(
        urlDocSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('title', 'submittal-arch'))
          ?.textInput?.value
      ).toBe('Waterproofing Review');
      expect(
        urlDocSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('contact', 'submittal-arch'))
          ?.textInput?.value
      ).toBe('PMG');
      expect(
        urlDocSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch'))
          ?.textInput?.value
      ).toBe('261118');
      expect(getFileSpy).toHaveBeenCalled();
      expect(downloadMediaSpy).toHaveBeenCalledTimes(1);

      // 2. Email Attachments mode -> skips Drive & form extraction completely
      getFileSpy.mockClear();
      downloadMediaSpy.mockClear();
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });

      const attRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          gmail: {
            messageId: 'msg-th-att-315',
            threadId: 'th-att-315',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(attRes.statusCode).toBe(200);
      const attCard = (JSON.parse(attRes.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.pushCard;
      const attDocSec = attCard?.sections.find((s) => s.header === 'Document Data');
      const attAction = attDocSec?.widgets
        .find((w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch'))
        ?.selectionInput?.items.find((i) => i.selected)?.value;
      expect(attAction).toBe('REC');
      expect(getFileSpy).not.toHaveBeenCalled();
      expect(downloadMediaSpy).not.toHaveBeenCalled();
    });
  });

  describe('Ticket #316: Submittal Arch Date pre-population vs email.date precedence in Gmail Google Drive URL mode', () => {
    it('lets email.date win ahead of form Date when email.date exists, and uses form Date ahead of drive.modifiedTime when email.date is absent', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([600, 400]);
      const form = doc.getForm();
      const radio = form.createRadioGroup('Submittal Response');
      radio.addOptionToPage('No Objections As Corrected', doc.getPage(0), { x: 50, y: 300, width: 12, height: 12 });
      radio.select('No Objections As Corrected');
      const dateField = form.createTextField('Date');
      dateField.addToPage(doc.getPage(0), { x: 200, y: 300, width: 120, height: 20 });
      dateField.setText('2023-09-13');
      const stampedPdfBytes = await doc.save();

      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-arch-316',
        name: '071200-001_Waterproofing_Stamped.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(stampedPdfBytes);
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      let emailDate: string | undefined = 'Tue, 17 Nov 2026 10:00:00 -0500';
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => ({
        id: threadId,
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            subject: '071200-001 Waterproofing Review',
            from: 'Reviewer <pm@inc.nyc>',
            to: 'James McGovern <jmcgovern@pavarini.com>',
            ...(emailDate !== undefined ? { date: emailDate } : {}),
            labels: ['INBOX', 'SENT', 'Active Projects'],
            plainTextBody: 'See reviewed submittal.',
            inlineImages: [],
            attachments: [],
          },
        ],
      }));

      // 1. email.date present -> email.date wins ('261117') while form still populates action ('NOC')
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const withEmailDateRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/drive-url-arch-316/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-316-1',
            threadId: 'th-316-1',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(withEmailDateRes.statusCode).toBe(200);
      const card1 = (JSON.parse(withEmailDateRes.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const sec1 = card1?.sections.find((s) => s.header === 'Document Data');
      expect(
        sec1?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch'))?.textInput?.value
      ).toBe('261117');
      expect(
        sec1?.widgets
          .find((w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch'))
          ?.selectionInput?.items.find((i) => i.selected)?.value
      ).toBe('NOC');

      // 2. email.date absent -> form Date ('230913') wins ahead of drive.modifiedTime ('261118')
      emailDate = undefined;
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const withoutEmailDateRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/drive-url-arch-316/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-316-2',
            threadId: 'th-316-2',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(withoutEmailDateRes.statusCode).toBe(200);
      const card2 = (JSON.parse(withoutEmailDateRes.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const sec2 = card2?.sections.find((s) => s.header === 'Document Data');
      expect(
        sec2?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch'))?.textInput?.value
      ).toBe('230913');
    });
  });

  describe('Ticket #317: Submittal Arch Submittal No multi-token cursor advancement in Gmail Google Drive URL mode', () => {
    it('populates contact/date/section/number from outgoing @inc.nyc email, advances form cursor to populate revision and action, and fills title from drive', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 400]);
      const form = doc.getForm();
      const subNoField = form.createTextField('Submittal No');
      subNoField.addToPage(page, { x: 50, y: 340, width: 180, height: 20 });
      subNoField.setText('081100-002-Rev. B');
      const radio = form.createRadioGroup('Submittal Response');
      radio.addOptionToPage('No Objections As Corrected', page, { x: 50, y: 300, width: 12, height: 12 });
      radio.select('No Objections As Corrected');
      const dateField = form.createTextField('Date');
      dateField.addToPage(page, { x: 200, y: 300, width: 120, height: 20 });
      dateField.setText('2026-11-21');
      const stampedPdfBytes = await doc.save();

      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-arch-317',
        name: '071200-001_Waterproofing_Stamped.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(stampedPdfBytes);
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => ({
        id: threadId,
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            subject: '071200-001',
            date: 'Tue, 17 Nov 2026 10:00:00 -0500',
            from: 'Reviewer <pm@inc.nyc>',
            to: 'James McGovern <jmcgovern@pavarini.com>',
            labels: ['INBOX', 'SENT', 'Active Projects'],
            plainTextBody: 'See reviewed submittal.',
            inlineImages: [],
            attachments: [],
          },
        ],
      }));

      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/drive-url-arch-317/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-317',
            threadId: 'th-317',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = (JSON.parse(res.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const docSec = card?.sections.find((s) => s.header === 'Document Data');
      const getText = (fieldKey: string) =>
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch'))
          ?.textInput?.value;

      expect(getText('contact')).toBe('PMG');
      expect(getText('date')).toBe('261117');
      expect(getText('section')).toBe('071200');
      expect(getText('number')).toBe('001');
      expect(getText('revision')).toBe('B');
      expect(getText('title')).toBe('Waterproofing Stamped');
      expect(
        docSec?.widgets
          .find((w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch'))
          ?.selectionInput?.items.find((i) => i.selected)?.value
      ).toBe('NOC');
    });
  });

  describe('Ticket #318: Submittal FF&E Submittal No multi-token cursor advancement and cover-sheet pre-population in Gmail Google Drive URL mode', () => {
    it('populates contact/date/specTag/specTitle from outgoing @inc.nyc email, advances form cursor to populate revision and action, and fills vendor from drive', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 400]);
      const form = doc.getForm();
      const subNoField = form.createTextField('Submittal No');
      subNoField.addToPage(page, { x: 50, y: 340, width: 180, height: 20 });
      subNoField.setText('LT 159A - B');
      const radio = form.createRadioGroup('Submittal Response');
      radio.addOptionToPage('Revise and Resubmit', page, { x: 50, y: 300, width: 12, height: 12 });
      radio.select('Revise and Resubmit');
      const dateField = form.createTextField('Date');
      dateField.addToPage(page, { x: 200, y: 300, width: 120, height: 20 });
      dateField.setText('5/8/26');
      const stampedPdfBytes = await doc.save();

      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-ffe-318',
        name: 'CG104_Berman_Falk_Stamped.pdf',
        mimeType: 'application/pdf',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(stampedPdfBytes);
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => ({
        id: threadId,
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            subject: 'CG104 Submittal Review',
            date: 'Tue, 17 Nov 2026 10:00:00 -0500',
            from: 'Designer <designer@inc.nyc>',
            to: 'Benjamin West <procurement@benjaminwest.com>',
            labels: ['INBOX', 'SENT', 'Active Projects'],
            plainTextBody: 'See stamped FF&E cover sheet.',
            inlineImages: [],
            attachments: [],
          },
        ],
      }));

      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://drive.google.com/file/d/drive-url-ffe-318/view'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-318',
            threadId: 'th-318',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const card = (JSON.parse(res.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      expect(JSON.stringify(card)).not.toContain('Could not read Google Drive file metadata');
      const docSec = card?.sections.find((s) => s.header === 'Document Data');
      const getText = (fieldKey: string) =>
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe'))
          ?.textInput?.value;

      expect(getText('contact')).toBe('BW');
      expect(getText('date')).toBe('261117');
      expect(getText('specTag')).toBe('CG104');
      expect(
        docSec?.widgets.find((w) => w.decoratedText?.topLabel === 'Spec Title')?.decoratedText
      ).toEqual({
        topLabel: 'Spec Title',
        text: 'BED - KING',
        wrapText: true,
      });
      expect(
        docSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe'))
      ).toBeUndefined();
      expect(getText('revision')).toBe('B');
      expect(getText('vendor')).toBe('BM');
      expect(
        docSec?.widgets
          .find((w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-ffe'))
          ?.selectionInput?.items.find((i) => i.selected)?.value
      ).toBe('RR');
    });
  });

  describe('Ticket #321: Submittal Arch Google Doc N×2 pre-population in Gmail Google Drive URL vs Email Attachments mode', () => {
    beforeEach(() => {
      nock.disableNetConnect();
    });

    afterEach(() => {
      nock.enableNetConnect();
    });

    it('authenticates via gmail.accessToken in Google Drive URL mode to extract N×2 Submittal No while making zero Docs calls in Email Attachments mode', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-gdoc-321',
        name: 'Waterproofing_Cover_Doc',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string) => ({
        id: threadId,
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            subject: '071200-001 Waterproofing Submittal',
            date: 'Tue, 17 Nov 2026 10:00:00 -0500',
            from: 'Reviewer <pm@inc.nyc>',
            to: 'James McGovern <jmcgovern@pavarini.com>',
            labels: ['INBOX', 'SENT', 'Active Projects'],
            plainTextBody: 'See linked Google Doc.',
            inlineImages: [],
            attachments: [
              {
                partId: 'part-gdoc-321',
                attachmentId: 'att-gdoc-321',
                filename: '071200-001_Attachment.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              },
            ],
          },
        ],
      }));

      const docsScope = nock('https://docs.googleapis.com', {
        reqheaders: { authorization: 'Bearer ya29.gmail-only-cred' },
      })
        .get('/v1/documents/drive-url-gdoc-321')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(200, {
          documentId: 'drive-url-gdoc-321',
          body: null,
          tabs: [
            {
              documentTab: {
                body: {
                  content: [
                    {
                      table: {
                        rows: 1,
                        columns: 2,
                        tableRows: [
                          {
                            tableCells: [
                              { content: [{ paragraph: { elements: [{ textRun: { content: 'Submittal No.\n' } }] } }] },
                              { content: [{ paragraph: { elements: [{ textRun: { content: '071200-001-2\n' } }] } }] },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          ],
        });

      // 1. Google Drive URL mode -> gmail populates contact/date/section/number; form advances to revision "2"
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const urlRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://docs.google.com/document/d/drive-url-gdoc-321/edit'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-drive-url-321',
            threadId: 'th-drive-url-321',
            accessToken: 'ya29.gmail-only-cred',
          },
        },
      });

      expect(urlRes.statusCode).toBe(200);
      const urlCard = (JSON.parse(urlRes.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const urlDocSec = urlCard?.sections.find((s) => s.header === 'Document Data');
      const getText = (fieldKey: string) =>
        urlDocSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch'))
          ?.textInput?.value;

      expect(getText('contact')).toBe('PMG');
      expect(getText('date')).toBe('261117');
      expect(getText('section')).toBe('071200');
      expect(getText('number')).toBe('001');
      expect(getText('revision')).toBe('2');
      expect(getText('title')).toBe('Waterproofing Submittal');
      expect(docsScope.isDone()).toBe(true);

      // 2. Email Attachments mode -> makes zero docs.googleapis.com calls (enforced by nock.disableNetConnect)
      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const attRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          gmail: {
            messageId: 'msg-th-att-321',
            threadId: 'th-att-321',
            accessToken: 'ya29.gmail-only-cred',
          },
        },
      });

      expect(attRes.statusCode).toBe(200);
    });
  });

  describe('Ticket #323: Full stamped Google Doc cover-sheet gmail -> form -> drive pipeline in Gmail Google Drive URL mode via gmail.accessToken fallback', () => {
    const RESPONSE_LABELS = [
      'NO EXCEPTIONS TAKEN',
      'NO OBJECTIONS AS CORRECTED',
      'REVISE AND RESUBMIT',
      'REJECTED',
      'NOT REVIEWED',
    ] as const;

    beforeEach(() => {
      nock.disableNetConnect();
    });

    afterEach(() => {
      nock.enableNetConnect();
    });

    function buildStampedCoverSheetDoc(options: {
      documentId: string;
      submittalNo: string;
      checkedIndex: number;
      remarks: string;
      reviewerName: string;
      dateElementOrText: Record<string, unknown>;
    }) {
      const cell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
        content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
        ...(style ? { tableCellStyle: style } : {}),
      });

      return {
        documentId: options.documentId,
        body: null,
        tabs: [
          {
            documentTab: {
              dropdownDefinitions: {
                'kix.cb': {
                  dropdownDefinitionId: 'kix.cb',
                  dropdownDefinitionProperties: {
                    title: 'Checkbox',
                    options: [
                      { optionId: 'opt.off', displayValue: '☐' },
                      { optionId: 'opt.on', displayValue: '☑' },
                    ],
                  },
                },
              },
              body: {
                content: [
                  { sectionBreak: {} },
                  {
                    table: {
                      rows: 1,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            cell('Submittal No.\n', { columnSpan: 1, rowSpan: 1 }),
                            cell(`${options.submittalNo}\n`, { columnSpan: 1, rowSpan: 1 }),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '––––\n' } }] } },
                  { paragraph: { elements: [{ textRun: { content: 'Submittal Response\n' } }] } },
                  {
                    table: {
                      rows: 6,
                      columns: 3,
                      tableRows: [
                        ...RESPONSE_LABELS.map((label, idx) => {
                          const isChecked = options.checkedIndex === idx;
                          return {
                            tableCells: [
                              {
                                tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                content: [
                                  {
                                    paragraph: {
                                      elements: [
                                        {
                                          dropdown: {
                                            dropdownId: `kix.dd.${idx}`,
                                            dropdownProperties: {
                                              dropdownDefinitionId: 'kix.cb',
                                              selectedOptionId: isChecked ? 'opt.on' : 'opt.off',
                                              displayValue: isChecked ? '☑' : '☐',
                                            },
                                          },
                                        },
                                      ],
                                    },
                                  },
                                ],
                              },
                              cell(`${label}\n`, { columnSpan: 1, rowSpan: 1 }),
                              cell(idx === 0 || idx === 2 ? 'Legend\n' : '\n', idx === 0 || idx === 2 ? { rowSpan: 2 } : undefined),
                            ],
                          };
                        }),
                        {
                          tableCells: [
                            cell('Disclaimer banner.\n', { columnSpan: 3, rowSpan: 1 }),
                            cell('\n'),
                            cell('\n'),
                          ],
                        },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 2,
                      columns: 1,
                      tableRows: [
                        { tableCells: [cell('REMARKS\n', { columnSpan: 1, rowSpan: 1 })] },
                        { tableCells: [cell(`${options.remarks}\n`, { columnSpan: 1, rowSpan: 1 })] },
                      ],
                    },
                  },
                  { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  {
                    table: {
                      rows: 2,
                      columns: 2,
                      tableRows: [
                        {
                          tableCells: [
                            {
                              tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                              content: [
                                {
                                  paragraph: {
                                    elements: [{ person: { personProperties: { name: options.reviewerName } } }],
                                  },
                                },
                              ],
                            },
                            {
                              tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                              content: [{ paragraph: { elements: [options.dateElementOrText] } }],
                            },
                          ],
                        },
                        {
                          tableCells: [
                            cell('Reviewed By\n', { columnSpan: 1, rowSpan: 1 }),
                            cell('Date\n', { columnSpan: 1, rowSpan: 1 }),
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      };
    }

    it('executes gmail -> form -> drive for Submittal Arch and Submittal FF&E Google Doc cover sheets using gmail.accessToken without userOAuthToken', async () => {
      vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
        drives: [{ id: 'space-projects-1', name: 'Active Projects' }],
      });

      // 1. Submittal Arch cover sheet
      const getFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
        id: 'drive-url-gdoc-arch-323',
        name: '071200-001_Waterproofing_Stamped',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      const getThreadSpy = vi.spyOn(ctx.mockGmailClient, 'getThread').mockResolvedValue({
        id: 'th-arch-323',
        messages: [
          {
            id: 'msg-th-arch-323',
            threadId: 'th-arch-323',
            subject: '071200-001',
            date: 'Tue, 17 Nov 2026 10:00:00 -0500',
            from: 'Reviewer <pm@inc.nyc>',
            to: 'James McGovern <jmcgovern@pavarini.com>',
            labels: ['INBOX', 'SENT', 'Active Projects'],
            plainTextBody: 'See reviewed Google Doc cover sheet.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      const archDocsScope = nock('https://docs.googleapis.com', {
        reqheaders: { authorization: 'Bearer ya29.gmail-only-cred-323' },
      })
        .get('/v1/documents/drive-url-gdoc-arch-323')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(
          200,
          buildStampedCoverSheetDoc({
            documentId: 'drive-url-gdoc-arch-323',
            submittalNo: '081100-002-Rev. B',
            checkedIndex: 1,
            remarks: 'See shop drawing markups.',
            reviewerName: 'Jane Architect',
            dateElementOrText: {
              dateElement: {
                dateElementProperties: {
                  timestamp: '2026-11-21T00:00:00Z',
                  timeZoneId: 'UTC',
                },
              },
            },
          })
        );

      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const archRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://docs.google.com/document/d/drive-url-gdoc-arch-323/edit'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-arch-323',
            threadId: 'th-arch-323',
            accessToken: 'ya29.gmail-only-cred-323',
          },
        },
      });

      expect(archRes.statusCode).toBe(200);
      const archCard = (JSON.parse(archRes.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const archSec = archCard?.sections.find((s) => s.header === 'Document Data');
      const getArchText = (fieldKey: string) =>
        archSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch'))
          ?.textInput?.value;

      expect(getArchText('contact')).toBe('PMG');
      expect(getArchText('date')).toBe('261117');
      expect(getArchText('section')).toBe('071200');
      expect(getArchText('number')).toBe('001');
      expect(getArchText('revision')).toBe('B');
      expect(getArchText('title')).toBe('Waterproofing Stamped');
      expect(
        archSec?.widgets
          .find((w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch'))
          ?.selectionInput?.items.find((i) => i.selected)?.value
      ).toBe('NOC');
      expect(archDocsScope.isDone()).toBe(true);

      // 2. Submittal FF&E cover sheet
      getFileSpy.mockResolvedValue({
        id: 'drive-url-gdoc-ffe-323',
        name: 'CG104_Berman_Falk_Stamped',
        mimeType: 'application/vnd.google-apps.document',
        parents: ['folder-unfiled'],
        driveId: 'space-projects-1',
        modifiedTime: '2026-11-18T15:00:00Z',
      });
      getThreadSpy.mockResolvedValue({
        id: 'th-ffe-323',
        messages: [
          {
            id: 'msg-th-ffe-323',
            threadId: 'th-ffe-323',
            subject: 'CG104 Submittal Review',
            date: 'Tue, 17 Nov 2026 10:00:00 -0500',
            from: 'Designer <designer@inc.nyc>',
            to: 'Benjamin West <procurement@benjaminwest.com>',
            labels: ['INBOX', 'SENT', 'Active Projects'],
            plainTextBody: 'See stamped FF&E Google Doc cover sheet.',
            inlineImages: [],
            attachments: [],
          },
        ],
      });

      const ffeDocsScope = nock('https://docs.googleapis.com', {
        reqheaders: { authorization: 'Bearer ya29.gmail-only-cred-323' },
      })
        .get('/v1/documents/drive-url-gdoc-ffe-323')
        .query({
          includeTabsContent: 'true',
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        })
        .reply(
          200,
          buildStampedCoverSheetDoc({
            documentId: 'drive-url-gdoc-ffe-323',
            submittalNo: 'LT 159A - B',
            checkedIndex: 2,
            remarks: 'Match veneer sample.',
            reviewerName: 'Jane Designer',
            dateElementOrText: { textRun: { content: '5/8/26\n' } },
          })
        );

      mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
      const ffeRes = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: { action: 'onFormChange', previousDriveUrl: '' },
            formInputs: {
              SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
              InputDriveURL: {
                stringInputs: { value: ['https://docs.google.com/document/d/drive-url-gdoc-ffe-323/edit'] },
              },
            },
          },
          gmail: {
            messageId: 'msg-th-ffe-323',
            threadId: 'th-ffe-323',
            accessToken: 'ya29.gmail-only-cred-323',
          },
        },
      });

      expect(ffeRes.statusCode).toBe(200);
      const ffeCard = (JSON.parse(ffeRes.payload) as GoogleWorkspaceActionResponse).action?.navigations?.[0]?.updateCard;
      const ffeSec = ffeCard?.sections.find((s) => s.header === 'Document Data');
      const getFfeText = (fieldKey: string) =>
        ffeSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe'))
          ?.textInput?.value;

      expect(getFfeText('contact')).toBe('BW');
      expect(getFfeText('date')).toBe('261117');
      expect(getFfeText('specTag')).toBe('CG104');
      expect(
        ffeSec?.widgets.find((w) => w.decoratedText?.topLabel === 'Spec Title')?.decoratedText
      ).toEqual({
        topLabel: 'Spec Title',
        text: 'BED - KING',
        wrapText: true,
      });
      expect(
        ffeSec?.widgets.find((w) => w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe'))
      ).toBeUndefined();
      expect(getFfeText('revision')).toBe('B');
      expect(getFfeText('vendor')).toBe('BM');
      expect(
        ffeSec?.widgets
          .find((w) => w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-ffe'))
          ?.selectionInput?.items.find((i) => i.selected)?.value
      ).toBe('RR');
      expect(ffeDocsScope.isDone()).toBe(true);
    });
  });
});

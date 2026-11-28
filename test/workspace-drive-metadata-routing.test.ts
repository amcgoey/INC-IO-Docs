import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import type { AppInstance } from '../src/app/server';
import type { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { mockAllowedDocumentTypes } from './utils/manifest-test-helper';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { GoogleDriveClient, GoogleDriveApiError } from '../src/infrastructure/drive/drive-client';
import {
  createDriveIntegrationContext,
  getCachedFlatPdfBuffer,
  mockDocumentLogSearch,
} from './utils/workspace-drive-test-helper';

describe('Workspace-to-Drive E2E: Metadata Routing, Date Extraction & SelectFiles Filtering', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    vi.useRealTimers();
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  describe('read-only manifest routes', () => {
    let app: AppInstance;

    beforeAll(async () => {
      ({ app } = await createDriveIntegrationContext());
    });

    describe('Ticket #307: Pass 2 Drive timestamp date pre-population on Communications in workspace timeZone', () => {
      it('pre-populates communication-project date in yyMMdd from evening UTC-Z modifiedTime in America/New_York, leaving description/contact blank and direction IN', async () => {
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-comm-evening')
          .query(true)
          .reply(200, {
            id: 'file-comm-evening',
            name: 'Client_Meeting_Notes.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-comm'],
            driveId: 'projects-shared-drive-001',
            // 2026-03-16 02:30Z = 2026-03-15 22:30 EDT in America/New_York
            modifiedTime: '2026-03-16T02:30:00Z',
            createdTime: '2026-03-10T12:00:00Z',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-comm')
          .query(true)
          .reply(200, {
            id: 'folder-comm',
            name: '1 Admin/Communication',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
          });

        const response = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'file-comm-evening', title: 'Client_Meeting_Notes.pdf' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const card = body.action.navigations[0].pushCard;
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');

        const dateWidget = docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
        );
        expect(dateWidget?.textInput?.value).toBe('260315');

        const descWidget = docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
        );
        expect(descWidget?.textInput?.value ?? '').toBe('');

        const contactWidget = docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('contact', 'communication-project')
        );
        expect(contactWidget?.textInput?.value ?? '').toBe('');

        const dirWidget = docDataSec.widgets.find(
          (w: { selectionInput?: { name: string } }) =>
            w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
        );
        expect(
          dirWidget?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
        ).toBe('IN');
      });

      it('pre-populates communication-proposal date from Drive shortcut target createdTime across DST fall-back boundary', async () => {
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/shortcut-prop')
          .query(true)
          .reply(200, {
            id: 'shortcut-prop',
            name: 'Proposal Shortcut',
            mimeType: 'application/vnd.google-apps.shortcut',
            shortcutDetails: {
              targetId: 'target-prop-file',
              targetMimeType: 'application/pdf',
            },
            parents: ['root'],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/target-prop-file')
          .query(true)
          .reply(200, {
            id: 'target-prop-file',
            name: 'Proposal_Notes.pdf',
            mimeType: 'application/pdf',
            parents: ['proposal-space-folder'],
            driveId: 'drive-marketing-1',
            // 2026-11-02 04:30Z = 2026-11-01 23:30 EST in America/New_York
            createdTime: '2026-11-02T04:30:00Z',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'drive-marketing-1', name: 'INC Marketing' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/proposal-space-folder')
          .query(true)
          .reply(200, {
            id: 'proposal-space-folder',
            name: 'Client Proposals',
            parents: ['opp-folder'],
            driveId: 'drive-marketing-1',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/opp-folder')
          .query(true)
          .reply(200, {
            id: 'opp-folder',
            name: 'Opportunities',
            parents: ['drive-marketing-1'],
            driveId: 'drive-marketing-1',
          });

        const response = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'shortcut-prop', title: 'Proposal Shortcut' }],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.payload);
        const card = body.action.navigations[0].pushCard;
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const dateWidget = docDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
        );
        expect(dateWidget?.textInput?.value).toBe('261101');
      });
    });

    describe('Ticket #308: Explicit filename yymmdd date extraction ([today - 12 months, today]) and Google Workspace stem handling', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      it('pre-populates communication-project and communication-proposal date from INC yyMMdd and delimited filename dates within [today - 12 months, today] ahead of modifiedTime', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));

        // Case 1: communication-project with INC yyMMdd filename
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-comm-yymmdd')
          .query(true)
          .reply(200, {
            id: 'file-comm-yymmdd',
            name: '261115_Client_Meeting_Notes.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-comm-308'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T14:00:00Z',
            createdTime: '2026-11-10T12:00:00Z',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-comm-308')
          .query(true)
          .reply(200, {
            id: 'folder-comm-308',
            name: '1 Admin/Communication',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
          });

        const projResp = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'file-comm-yymmdd', title: '261115_Client_Meeting_Notes.pdf' }],
            },
          },
        });

        expect(projResp.statusCode).toBe(200);
        const projBody = JSON.parse(projResp.payload);
        const projCard = projBody.action.navigations[0].pushCard;
        const projDocDataSec = projCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const projDateWidget = projDocDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
        );
        expect(projDateWidget?.textInput?.value).toBe('261115');

        // Case 2: communication-proposal with delimited YYYY-MM-DD filename
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-prop-delimited')
          .query(true)
          .reply(200, {
            id: 'file-prop-delimited',
            name: 'Proposal_Notes_2026-11-12.pdf',
            mimeType: 'application/pdf',
            parents: ['proposal-space-folder-308'],
            driveId: 'drive-marketing-1',
            modifiedTime: '2026-11-18T14:00:00Z',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'drive-marketing-1', name: 'INC Marketing' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/proposal-space-folder-308')
          .query(true)
          .reply(200, {
            id: 'proposal-space-folder-308',
            name: 'Client Proposals',
            parents: ['opp-folder-308'],
            driveId: 'drive-marketing-1',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/opp-folder-308')
          .query(true)
          .reply(200, {
            id: 'opp-folder-308',
            name: 'Opportunities',
            parents: ['drive-marketing-1'],
            driveId: 'drive-marketing-1',
          });

        const propResp = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'file-prop-delimited', title: 'Proposal_Notes_2026-11-12.pdf' }],
            },
          },
        });

        expect(propResp.statusCode).toBe(200);
        const propBody = JSON.parse(propResp.payload);
        const propCard = propBody.action.navigations[0].pushCard;
        const propDocDataSec = propCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const propDateWidget = propDocDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
        );
        expect(propDateWidget?.textInput?.value).toBe('261112');

        // Case 3: late-December yyMMdd filename in early January
        vi.setSystemTime(new Date('2026-01-05T15:00:00Z'));

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-comm-jan-dec')
          .query(true)
          .reply(200, {
            id: 'file-comm-jan-dec',
            name: '251228_Year_End_Notes.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-comm-308'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-01-05T14:00:00Z',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-comm-308')
          .query(true)
          .reply(200, {
            id: 'folder-comm-308',
            name: '1 Admin/Communication',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
          });

        const janResp = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'file-comm-jan-dec', title: '251228_Year_End_Notes.pdf' }],
            },
          },
        });

        expect(janResp.statusCode).toBe(200);
        const janBody = JSON.parse(janResp.payload);
        const janCard = janBody.action.navigations[0].pushCard;
        const janDocDataSec = janCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const janDateWidget = janDocDataSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
        );
        expect(janDateWidget?.textInput?.value).toBe('251228');
      });

      it('falls back to modifiedTime when filename has rejected date (> today, < today - 12 months, 260519-001, 260230) or extensionless Google Workspace doc (07.12.00, Spec_v1.2)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));

        for (const testCase of [
          { id: 'file-future-308', name: '261125_Future_Notes.pdf', mimeType: 'application/pdf' },
          { id: 'file-stale-308', name: '251110_Stale_Notes.pdf', mimeType: 'application/pdf' },
          { id: 'file-div26-308', name: '260519-001_Lighting_Submittal.pdf', mimeType: 'application/pdf' },
          { id: 'file-invalid-308', name: '260230_Invalid_Calendar.pdf', mimeType: 'application/pdf' },
          { id: 'file-gdoc-csi-308', name: '07.12.00', mimeType: 'application/vnd.google-apps.document' },
          { id: 'file-gdoc-spec-308', name: 'Spec_v1.2', mimeType: 'application/vnd.google-apps.document' },
        ]) {
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${testCase.id}`)
            .query(true)
            .reply(200, {
              id: testCase.id,
              name: testCase.name,
              mimeType: testCase.mimeType,
              parents: ['folder-comm-308'],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T14:00:00Z',
            });

          nock('https://www.googleapis.com')
            .get('/drive/v3/drives')
            .query(true)
            .reply(200, {
              drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
            });

          nock('https://www.googleapis.com')
            .get('/drive/v3/files/folder-comm-308')
            .query(true)
            .reply(200, {
              id: 'folder-comm-308',
              name: '1 Admin/Communication',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
            });

          const resp = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: {
                selectedItems: [{ id: testCase.id, title: testCase.name }],
              },
            },
          });

          expect(resp.statusCode).toBe(200);
          const body = JSON.parse(resp.payload);
          const card = body.action.navigations[0].pushCard;
          const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
          const dateWidget = docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
          );
          expect(dateWidget?.textInput?.value, testCase.name).toBe('261118');
        }
      });
    });

    describe('Ticket #310: Flexible Submittal Arch routing and Drive pre-population', () => {
      it('binds multi-file selection [Cover_Notes.pdf, 07 12 00 - 1_v1_Waterproofing.pdf] to the submittal file and populates section, number, 0-based revision, title, date, action, and status', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
        const flatPdfBuffer = await getCachedFlatPdfBuffer();

        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-cover-310')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'file-cover-310',
            name: 'Cover_Notes.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-unfiled-310'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-01T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-cover-310')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-unfiled-310')
          .query(true)
          .reply(200, {
            id: 'folder-unfiled-310',
            name: 'Unfiled',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-submittal-310')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'file-submittal-310',
            name: '07 12 00 - 1_v1_Waterproofing.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-unfiled-310'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-submittal-310')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        const response = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'file-cover-310', title: 'Cover_Notes.pdf' },
                { id: 'file-submittal-310', title: '07 12 00 - 1_v1_Waterproofing.pdf' },
              ],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const card = JSON.parse(response.payload).action.navigations[0].pushCard;
        const cardJson = JSON.stringify(card);
        expect(cardJson).toContain('submittal-arch');

        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getTextVal = (field: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
          )?.textInput?.value;
        const getSelVal = (field: string) =>
          docDataSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

        expect(getTextVal('section')).toBe('071200');
        expect(getTextVal('number')).toBe('001');
        expect(getTextVal('revision')).toBe('0');
        expect(getTextVal('title')).toBe('Waterproofing');
        expect(getTextVal('date')).toBe('261118');
        expect(getSelVal('action')).toBe('REC');
        expect(getSelVal('status')).toBe('Open');
        expect(cardJson).not.toContain('Could not read Google Drive file metadata');
        expect(nock.isDone()).toBe(true);
      });

      it('extracts varied contractor submittal formats, strips trailing stamps, protects R-19/120V/v1.2, and does not route ISO-date files to submittal-arch', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
        const flatPdfBuffer = await getCachedFlatPdfBuffer();

        const submittalCases = [
          {
            id: 'arch-case-1',
            name: '07.12.00_Submittal_002_Rev1_Waterproofing_2026-11-15.pdf',
            section: '071200',
            number: '002',
            revision: '1',
            title: 'Waterproofing',
            date: '261115',
          },
          {
            id: 'arch-case-2',
            name: 'Section 07-12-00 Submittal #12 - Fluid Applied Waterproofing.pdf',
            section: '071200',
            number: '012',
            revision: undefined,
            title: 'Fluid Applied Waterproofing',
            date: '261118',
          },
          {
            id: 'arch-case-3',
            name: '071200-001-A Fluid Applied Waterproofing - 261115 PMG_NET.pdf',
            section: '071200',
            number: '001',
            revision: 'A',
            title: 'Fluid Applied Waterproofing',
            date: '261115',
          },
          {
            id: 'arch-case-4',
            name: '071200-001-R R-19 Insulation.pdf',
            section: '071200',
            number: '001',
            revision: 'R',
            title: 'R-19 Insulation',
            date: '261118',
          },
          {
            id: 'arch-case-5',
            name: '071200-001_v1.2_120V_Review.pdf',
            section: '071200',
            number: '001',
            revision: undefined,
            title: 'v1.2 120V Review',
            date: '261118',
          },
        ];

        for (const tc of submittalCases) {
          mockDocumentLogSearch();
          nock('https://www.googleapis.com')
            .get('/drive/v3/drives')
            .query(true)
            .reply(200, {
              drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt !== 'media')
            .reply(200, {
              id: tc.id,
              name: tc.name,
              mimeType: 'application/pdf',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt === 'media')
            .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: tc.id, title: tc.name }] },
            },
          });
          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          expect(JSON.stringify(card), tc.name).toContain('submittal-arch');
          const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
          const getTextVal = (field: string) =>
            docDataSec.widgets.find(
              (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
            )?.textInput?.value;

          expect(getTextVal('section'), tc.name).toBe(tc.section);
          expect(getTextVal('number'), tc.name).toBe(tc.number);
          expect(getTextVal('revision'), tc.name).toBe(tc.revision);
          expect(getTextVal('title'), tc.name).toBe(tc.title);
          expect(getTextVal('date'), tc.name).toBe(tc.date);
        }

        // ISO date filename must NOT route to submittal-arch
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/iso-date-only')
          .query(true)
          .reply(200, {
            id: 'iso-date-only',
            name: '2026-11-15_Meeting_Notes.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });

        const isoRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'iso-date-only', title: '2026-11-15_Meeting_Notes.pdf' }] },
          },
        });
        expect(isoRes.statusCode).toBe(200);
        const isoCard = JSON.parse(isoRes.payload).action.navigations[0].pushCard;
        const docTypeSec = isoCard.sections.find((s: { header?: string }) => s.header === 'Document Type');
        const selectedDocType = docTypeSec.widgets
          .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(selectedDocType).toBe('communication-project');
        const isoDocDataSec = isoCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          isoDocDataSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
          )?.textInput?.value
        ).toBe('261115');
      });
    });

    describe('Ticket #311: Flexible Submittal FF&E routing and Drive pre-population', () => {
      it('binds multi-file selection [Berman_Cover.pdf, CG-104_v2_Fil_Doux.pdf] to item 2 and populates specTag, LinkedField specTitle, 0-based revision, vendor, date, action, and status', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
        const flatPdfBuffer = await getCachedFlatPdfBuffer();

        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-cover-311')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'file-cover-311',
            name: 'Berman_Cover.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-unfiled-311'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-01T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-cover-311')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-unfiled-311')
          .query(true)
          .reply(200, {
            id: 'folder-unfiled-311',
            name: 'Unfiled',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-submittal-311')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'file-submittal-311',
            name: 'CG-104_v2_Fil_Doux.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-unfiled-311'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-submittal-311')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        const response = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'file-cover-311', title: 'Berman_Cover.pdf' },
                { id: 'file-submittal-311', title: 'CG-104_v2_Fil_Doux.pdf' },
              ],
            },
          },
        });

        expect(response.statusCode).toBe(200);
        const card = JSON.parse(response.payload).action.navigations[0].pushCard;
        const docTypeSec = card.sections.find((s: { header?: string }) => s.header === 'Document Type');
        const selectedDocType = docTypeSec.widgets
          .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(selectedDocType).toBe('submittal-ffe');

        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getTextVal = (field: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-ffe')
          )?.textInput?.value;
        const getSelVal = (field: string) =>
          docDataSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(field, 'submittal-ffe')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

        expect(getTextVal('specTag')).toBe('CG104');
        const specTitleDecorated = docDataSec.widgets.find(
          (w: { decoratedText?: { topLabel?: string; text?: string; wrapText?: boolean } }) =>
            w.decoratedText?.topLabel === 'Spec Title'
        )?.decoratedText;
        expect(specTitleDecorated).toEqual({
          topLabel: 'Spec Title',
          text: 'BED - KING',
          wrapText: true,
        });
        expect(
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
          )
        ).toBeUndefined();
        expect(getTextVal('revision')).toBe('1');
        expect(getTextVal('vendor')).toBe('FDT');
        expect(getTextVal('date')).toBe('261118');
        expect(getSelVal('action')).toBe('REC');
        expect(getSelVal('status')).toBe('Open');
        expect(JSON.stringify(card)).not.toContain('Could not read Google Drive file metadata');
        expect(nock.isDone()).toBe(true);
      });

      it('extracts varied FF&E formats (CG104-A_Berman_Falk, LT 159A_R0, Light_Annex without rev) and rejects lowercase prose ("in 100 days at 120V panel")', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-11-20T15:00:00Z'));
        const flatPdfBuffer = await getCachedFlatPdfBuffer();

        const ffeCases = [
          {
            id: 'ffe-case-1',
            name: 'CG104-A_Berman_Falk.pdf',
            specTag: 'CG104',
            specTitle: 'BED - KING',
            revision: 'A',
            vendor: 'BM',
            date: '261118',
          },
          {
            id: 'ffe-case-2',
            name: 'LT 159A_R0.pdf',
            specTag: 'LT159A',
            specTitle: 'SCONCE - CORRIDOR',
            revision: '0',
            vendor: undefined,
            date: '261118',
          },
          {
            id: 'ffe-case-3',
            name: 'CG-104_Light_Annex_2026-11-15.pdf',
            specTag: 'CG104',
            specTitle: 'BED - KING',
            revision: undefined,
            vendor: 'LA',
            date: '261115',
          },
        ];

        for (const tc of ffeCases) {
          mockDocumentLogSearch();
          nock('https://www.googleapis.com')
            .get('/drive/v3/drives')
            .query(true)
            .reply(200, {
              drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt !== 'media')
            .reply(200, {
              id: tc.id,
              name: tc.name,
              mimeType: 'application/pdf',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt === 'media')
            .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: tc.id, title: tc.name }] },
            },
          });
          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          const docTypeSec = card.sections.find((s: { header?: string }) => s.header === 'Document Type');
          const selectedDocType = docTypeSec.widgets
            .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
          expect(selectedDocType, tc.name).toBe('submittal-ffe');

          const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
          const getTextVal = (field: string) =>
            docDataSec.widgets.find(
              (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-ffe')
            )?.textInput?.value;

          expect(getTextVal('specTag'), tc.name).toBe(tc.specTag);
          const specTitleDecorated = docDataSec.widgets.find(
            (w: { decoratedText?: { topLabel?: string; text?: string; wrapText?: boolean } }) =>
              w.decoratedText?.topLabel === 'Spec Title'
          )?.decoratedText;
          expect(specTitleDecorated, tc.name).toEqual({
            topLabel: 'Spec Title',
            text: tc.specTitle,
            wrapText: true,
          });
          expect(
            docDataSec.widgets.find(
              (w: { textInput?: { name: string } }) =>
                w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
            ),
            tc.name
          ).toBeUndefined();
          expect(getTextVal('revision'), tc.name).toBe(tc.revision);
          expect(getTextVal('vendor'), tc.name).toBe(tc.vendor);
          expect(getTextVal('date'), tc.name).toBe(tc.date);
          expect(JSON.stringify(card), tc.name).not.toContain('Could not read Google Drive file metadata');
        }
        expect(nock.isDone()).toBe(true);

        // Lowercase prose ("in 100 days", "at 120V panel") must NOT route to submittal-ffe
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/ffe-prose-neg')
          .query(true)
          .reply(200, {
            id: 'ffe-prose-neg',
            name: 'Work in 100 days at 120V panel.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });

        const negRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'ffe-prose-neg', title: 'Work in 100 days at 120V panel.pdf' }] },
          },
        });
        expect(negRes.statusCode).toBe(200);
        const negCard = JSON.parse(negRes.payload).action.navigations[0].pushCard;
        const negDocTypeSec = negCard.sections.find((s: { header?: string }) => s.header === 'Document Type');
        const negSelectedDocType = negDocTypeSec.widgets
          .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(negSelectedDocType).toBe('communication-project');
      });
    });

    describe('Initial-load SelectFiles preservation across Pass 1 routing mutations', () => {
      it('keeps SelectFiles checked on initial Shared Drive load when Pass 1 infers projects + space, and extracts Submittal Arch fields on follow-up onDocumentTypeChange', async () => {
        const flatPdfBuffer = await getCachedFlatPdfBuffer();

        function mockDriveHierarchy() {
          nock('https://www.googleapis.com')
            .get('/drive/v3/drives')
            .query(true)
            .reply(200, {
              drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
            });

          nock('https://www.googleapis.com')
            .get('/drive/v3/files/file-initial-submittal-1')
            .query((q) => q.alt !== 'media')
            .reply(200, {
              id: 'file-initial-submittal-1',
              name: '07 12 00 - 1_v1_Waterproofing.pdf',
              mimeType: 'application/pdf',
              parents: ['folder-comm-initial-1'],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });

          nock('https://www.googleapis.com')
            .get('/drive/v3/files/folder-comm-initial-1')
            .query(true)
            .reply(200, {
              id: 'folder-comm-initial-1',
              name: 'Communication',
              parents: ['folder-admin-initial-1'],
              driveId: 'projects-shared-drive-001',
              mimeType: 'application/vnd.google-apps.folder',
            });

          nock('https://www.googleapis.com')
            .get('/drive/v3/files/folder-admin-initial-1')
            .query(true)
            .reply(200, {
              id: 'folder-admin-initial-1',
              name: '1 Admin',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              mimeType: 'application/vnd.google-apps.folder',
            });
        }

        // Step 1 mocks: Pass 1 infers projects + Projects Shared Drive 001 + communication-project from 1 Admin/Communication hierarchy
        mockDriveHierarchy();

        const step1Res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'file-initial-submittal-1', title: '07 12 00 - 1_v1_Waterproofing.pdf' },
              ],
            },
          },
        });

        expect(step1Res.statusCode).toBe(200);
        const pushCard = JSON.parse(step1Res.payload).action.navigations[0].pushCard;
        const docTypeSec1 = pushCard.sections.find((s: { header?: string }) => s.header === 'Document Type');
        expect(
          docTypeSec1.widgets
            .find((w: { selectionInput?: { name?: string } }) => w.selectionInput?.name === 'SelectDocumentSpaceType')
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
        ).toBe('projects');
        expect(
          docTypeSec1.widgets.find(
            (w: { textInput?: { name?: string } }) => w.textInput?.name === getDocumentSpaceWidgetName('projects')
          )?.textInput?.value
        ).toBe('Projects Shared Drive 001');
        expect(
          docTypeSec1.widgets
            .find(
              (w: { selectionInput?: { name?: string } }) =>
                w.selectionInput?.name === getDocumentTypeWidgetName('projects')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
        ).toBe('communication-project');

        const fileSelSec1 = pushCard.sections.find((s: { header?: string }) => s.header === 'File Selection');
        const selectFiles1 = fileSelSec1.widgets.find(
          (w: { selectionInput?: { name?: string } }) => w.selectionInput?.name === 'SelectFiles'
        )?.selectionInput;
        expect(selectFiles1?.items).toEqual([
          { text: '07 12 00 - 1_v1_Waterproofing.pdf', value: 'file-initial-submittal-1', selected: true },
        ]);

        // Step 2 mocks: Follow-up onDocumentTypeChange to submittal-arch runs Pass 2 (form ?alt=media + drive hierarchy/metadata)
        mockDocumentLogSearch();
        mockDriveHierarchy();

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/file-initial-submittal-1')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        const checkedIds = selectFiles1.items
          .filter((i: { selected?: boolean }) => i.selected)
          .map((i: { value: string }) => i.value);

        const step2Res = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'file-initial-submittal-1', title: '07 12 00 - 1_v1_Waterproofing.pdf' },
              ],
            },
            commonEventObject: {
              parameters: { action: 'onDocumentTypeChange' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: {
                  stringInputs: { value: ['Projects Shared Drive 001'] },
                },
                [getDocumentTypeWidgetName('projects')]: {
                  stringInputs: { value: ['submittal-arch'] },
                },
                SelectFiles: { stringInputs: { value: checkedIds } },
              },
            },
          },
        });

        expect(step2Res.statusCode).toBe(200);
        const updateCard = JSON.parse(step2Res.payload).action.navigations[0].updateCard;
        const fileSelSec2 = updateCard.sections.find((s: { header?: string }) => s.header === 'File Selection');
        const selectFiles2 = fileSelSec2.widgets.find(
          (w: { selectionInput?: { name?: string } }) => w.selectionInput?.name === 'SelectFiles'
        )?.selectionInput;
        expect(selectFiles2?.items).toEqual([
          { text: '07 12 00 - 1_v1_Waterproofing.pdf', value: 'file-initial-submittal-1', selected: true },
        ]);

        const docDataSec2 = updateCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getTextVal = (field: string) =>
          docDataSec2.widgets.find(
            (w: { textInput?: { name?: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName(field, 'submittal-arch')
          )?.textInput?.value;

        expect(getTextVal('section')).toBe('071200');
        expect(getTextVal('number')).toBe('001');
        expect(getTextVal('revision')).toBe('0');
        expect(getTextVal('title')).toBe('Waterproofing');
        expect(getTextVal('date')).toBe('261118');
        expect(nock.isDone()).toBe(true);
      });
    });
  });

  describe('Ticket #309: End-to-end SelectFiles filtering, type-switch edit preservation & single-banner Drive error degradation', () => {
    let app: AppInstance;
    let manifestProvider: AppManifestProvider;

    beforeEach(async () => {
      ({ app, manifestProvider } = await createDriveIntegrationContext());
    });

    it('silently retains partial ancestors on parent-folder 403 with zero warning banners and still populates date from file metadata', async () => {
      nock('https://www.googleapis.com')
        .get('/drive/v3/files/file-restricted-parent')
        .query(true)
        .reply(200, {
          id: 'file-restricted-parent',
          name: 'Restricted_Parent_Notes.pdf',
          mimeType: 'application/pdf',
          parents: ['forbidden-parent'],
          driveId: 'projects-shared-drive-001',
          // 2026-03-16 02:30Z -> 260315 in America/New_York
          modifiedTime: '2026-03-16T02:30:00Z',
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/drives')
        .query(true)
        .reply(200, {
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });

      nock('https://www.googleapis.com')
        .get('/drive/v3/files/forbidden-parent')
        .query(true)
        .reply(403, { error: { code: 403, message: 'Forbidden' } });

      const response = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-restricted-parent', title: 'Restricted_Parent_Notes.pdf' }],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const card = body.action.navigations[0].pushCard;
      const cardJson = JSON.stringify(card);

      expect(cardJson).not.toContain('Could not inspect Google Drive folder hierarchy');
      expect(cardJson).not.toContain('Could not read Google Drive file metadata');

      const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
      const dateWidget = docDataSec.widgets.find(
        (w: { textInput?: { name: string } }) =>
          w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-project')
      );
      expect(dateWidget?.textInput?.value).toBe('260315');
    });

    it('suppresses Pass 2 Drive metadata notice on initial load when Drive fails (503) and memoizes getFile per request, while surfacing Pass 2 notice standalone on manual onDocumentTypeChange', async () => {
      mockAllowedDocumentTypes(manifestProvider, 'projects', ['communication-project', 'communication-proposal']);
      const getFileSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'getFile')
        .mockRejectedValue(new GoogleDriveApiError('Service Unavailable', { statusCode: 503 }));

      // 1. Initial load -> Pass 1 + Pass 2 share memoized rejected promise (1 getFile call) & emit only 1 banner
      const initialRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/drive-items-selected',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-503', title: 'Outage.pdf' }],
          },
        },
      });

      expect(initialRes.statusCode).toBe(200);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      const initialJson = JSON.stringify(JSON.parse(initialRes.payload).action.navigations[0].pushCard);
      expect(initialJson).toContain(
        'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.'
      );
      expect(initialJson).not.toContain(
        'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.'
      );

      // 2. Manual onDocumentTypeChange -> Pass 1 does not run, Pass 2 notice surfaces standalone
      getFileSpy.mockClear();
      const switchRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [{ id: 'file-503', title: 'Outage.pdf' }],
          },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['communication-proposal'] },
              },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Active Projects'] },
              },
              SelectFiles: { stringInputs: { value: ['file-503'] } },
            },
          },
        },
      });

      expect(switchRes.statusCode).toBe(200);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      const switchJson = JSON.stringify(JSON.parse(switchRes.payload).action.navigations[0].updateCard);
      expect(switchJson).not.toContain('Could not inspect Google Drive folder hierarchy');
      expect(switchJson).toContain(
        'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.'
      );
    });

    it('filters checked SelectFiles items on manual type switches (treating omitted SelectFiles as []), preserves active-type edits, and evaluates defaults', async () => {
      mockAllowedDocumentTypes(manifestProvider, 'projects', ['communication-project', 'communication-proposal']);
      const getFileSpy = vi
        .spyOn(GoogleDriveClient.prototype, 'getFile')
        .mockImplementation(async (fileId: string) => ({
          id: fileId,
          name: `${fileId}.pdf`,
          mimeType: 'application/pdf',
          parents: [],
          modifiedTime: fileId === 'file-checked' ? '2026-10-22T14:00:00Z' : '2026-10-10T14:00:00Z',
        }));

      // 1. Partial SelectFiles on onDocumentTypeChange -> fetches only file-checked, preserves user edit, defaults direction IN
      const partialRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-unchecked', title: 'Unchecked.pdf' },
              { id: 'file-checked', title: 'Checked.pdf' },
            ],
          },
          commonEventObject: {
            parameters: { action: 'onDocumentTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: {
                stringInputs: { value: ['communication-proposal'] },
              },
              [getDocumentSpaceWidgetName('projects')]: {
                stringInputs: { value: ['Active Projects'] },
              },
              SelectFiles: { stringInputs: { value: ['file-checked'] } },
              [getDocumentInfoWidgetName('description', 'communication-proposal')]: {
                stringInputs: { value: ['Custom User Note'] },
              },
            },
          },
        },
      });

      expect(partialRes.statusCode).toBe(200);
      expect(getFileSpy).toHaveBeenCalledTimes(1);
      expect(getFileSpy).toHaveBeenCalledWith('file-checked');

      const partialCard = JSON.parse(partialRes.payload).action.navigations[0].updateCard;
      const partialDocSec = partialCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
      expect(
        partialDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('date', 'communication-proposal')
        )?.textInput?.value
      ).toBe('261022');
      expect(
        partialDocSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-proposal')
        )?.textInput?.value
      ).toBe('Custom User Note');
      expect(
        partialDocSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-proposal')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value
      ).toBe('IN');

      // 2. All checkboxes unchecked (SelectFiles omitted) on onSpaceTypeChange -> 0 Drive API calls, items stay unselected
      getFileSpy.mockClear();
      const allUncheckedRes = await app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
          drive: {
            selectedItems: [
              { id: 'file-unchecked', title: 'Unchecked.pdf' },
              { id: 'file-checked', title: 'Checked.pdf' },
            ],
          },
          commonEventObject: {
            parameters: { action: 'onSpaceTypeChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            },
          },
        },
      });

      expect(allUncheckedRes.statusCode).toBe(200);
      expect(getFileSpy).not.toHaveBeenCalled();

      const uncheckedCard = JSON.parse(allUncheckedRes.payload).action.navigations[0].updateCard;
      const fileSelSec = uncheckedCard.sections.find((s: { header?: string }) => s.header === 'File Selection');
      const selectFilesWidget = fileSelSec.widgets.find(
        (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectFiles'
      );
      expect(selectFilesWidget?.selectionInput?.items.every((i: { selected?: boolean }) => i.selected === false)).toBe(
        true
      );
    });
  });
});

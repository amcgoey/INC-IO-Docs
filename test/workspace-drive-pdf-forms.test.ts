import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { AppInstance } from '../src/app/server';
import type { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { mockAllowedDocumentTypes } from './utils/manifest-test-helper';
import {
  createDriveIntegrationContext,
  getCachedFlatPdfBuffer,
  mockDocumentLogSearch,
} from './utils/workspace-drive-test-helper';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { GoogleDriveClient, GoogleDriveApiError } from '../src/infrastructure/drive/drive-client';
import { PdfProcessor } from '../src/infrastructure/pdf/pdf-processor';
import { PdfEncryptionError } from '../src/infrastructure/pdf/errors';
import {
  PDF_FORM_ENCRYPTED_ERROR_MESSAGE,
  DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE,
  DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
  formatAmbiguousFormFieldMessage,
} from '../src/features/source-parser/domain';
import { DriveFormExtractorAdapter } from '../src/features/source-parser/adapters/drive-form-extractor.adapter';

async function createCoverPdfBuffer(options: {
  submittalNo?: string | undefined;
  selectedAction?: string | undefined;
  dateText?: string | undefined;
  reviewedBy?: string | undefined;
  freeTextRemark?: string | undefined;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();

  if (options.submittalNo !== undefined) {
    const subNoField = form.createTextField('Submittal No');
    subNoField.addToPage(page, { x: 50, y: 340, width: 180, height: 20 });
    subNoField.setText(options.submittalNo);
  }

  const radio = form.createRadioGroup('Submittal Response');
  for (const [idx, label] of [
    'No Exceptions Taken',
    'No Objections As Corrected',
    'Revise and Resubmit',
    'Rejected',
    'Not Reviewed',
  ].entries()) {
    radio.addOptionToPage(label, page, {
      x: 50,
      y: 300 - idx * 20,
      width: 12,
      height: 12,
    });
  }
  if (options.selectedAction !== undefined) {
    radio.select(options.selectedAction);
  }

  if (options.dateText !== undefined) {
    const dateField = form.createTextField('Date');
    dateField.addToPage(page, { x: 200, y: 300, width: 120, height: 20 });
    dateField.setText(options.dateText);
  }

  if (options.reviewedBy !== undefined) {
    const revBy = form.createTextField('Reviewed By');
    revBy.addToPage(page, { x: 200, y: 260, width: 140, height: 20 });
    revBy.setText(options.reviewedBy);
  }

  if (options.freeTextRemark !== undefined) {
    const freeTextAnnot = doc.context.obj({
      Type: PDFName.of('Annot'),
      Subtype: PDFName.of('FreeText'),
      Rect: [20, 20, 200, 60],
      Contents: PDFString.of(options.freeTextRemark),
    });
    const annotRef = doc.context.register(freeTextAnnot);
    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
  }

  return Buffer.from(await doc.save());
}

const stampedArchPdfCache = new Map<string, Promise<Buffer>>();
const archPdfWithDateCache = new Map<string, Promise<Buffer>>();
const fullArchCoverPdfCache = new Map<string, Promise<Buffer>>();
const fullFfeCoverPdfCache = new Map<string, Promise<Buffer>>();

function buildStampedArchPdfBuffer(selectedOption?: string): Promise<Buffer> {
  const key = selectedOption ?? '__none__';
  let cached = stampedArchPdfCache.get(key);
  if (!cached) {
    cached = createCoverPdfBuffer({ selectedAction: selectedOption });
    stampedArchPdfCache.set(key, cached);
  }
  return cached;
}

function buildArchPdfWithDate(options: {
  dateText?: string | undefined;
  selectedAction?: string | undefined;
}): Promise<Buffer> {
  const key = JSON.stringify(options);
  let cached = archPdfWithDateCache.get(key);
  if (!cached) {
    cached = createCoverPdfBuffer(options);
    archPdfWithDateCache.set(key, cached);
  }
  return cached;
}

function buildFullArchCoverPdf(options: {
  submittalNo?: string;
  selectedAction?: string;
  dateText?: string;
  reviewedBy?: string;
  includeFreeTextRemark?: boolean;
}): Promise<Buffer> {
  const key = JSON.stringify(options);
  let cached = fullArchCoverPdfCache.get(key);
  if (!cached) {
    cached = createCoverPdfBuffer({
      ...options,
      ...(options.includeFreeTextRemark
        ? { freeTextRemark: 'REMARK: Verify flashing detail' }
        : {}),
    });
    fullArchCoverPdfCache.set(key, cached);
  }
  return cached;
}

function buildFullFfeCoverPdf(options: {
  submittalNo?: string;
  selectedAction?: string;
  dateText?: string;
  reviewedBy?: string;
  includeFreeTextRemark?: boolean;
}): Promise<Buffer> {
  const key = JSON.stringify(options);
  let cached = fullFfeCoverPdfCache.get(key);
  if (!cached) {
    cached = createCoverPdfBuffer({
      ...options,
      ...(options.includeFreeTextRemark
        ? { freeTextRemark: 'REMARK: Verify upholstery COM' }
        : {}),
    });
    fullFfeCoverPdfCache.set(key, cached);
  }
  return cached;
}

describe('Workspace-to-Drive E2E: PDF AcroForm Pre-Population & Degradation', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  describe('Read-only AcroForm pre-population suite', () => {
    let app: AppInstance;

    beforeAll(async () => {
      ({ app } = await createDriveIntegrationContext());
    });

    describe('Ticket #315: Submittal Arch PDF AcroForm pre-population via source: "form"', () => {
      it('pre-populates action (NET, NOC, RR via valueMap, REJ, NR) and leaves REC when unchecked using single metadata + single alt=media download', async () => {
        const cases = [
          { id: 'arch-315-net', label: 'No Exceptions Taken', expectedAction: 'NET' },
          { id: 'arch-315-noc', label: 'No Objections As Corrected', expectedAction: 'NOC' },
          { id: 'arch-315-rr', label: 'Revise and Resubmit', expectedAction: 'RR' },
          { id: 'arch-315-rej', label: 'Rejected', expectedAction: 'REJ' },
          { id: 'arch-315-nr', label: 'Not Reviewed', expectedAction: 'NR' },
          { id: 'arch-315-blank', label: undefined, expectedAction: 'REC' },
        ];

        for (const tc of cases) {
          const pdfBuffer = await buildStampedArchPdfBuffer(tc.label);

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
              name: '071200-001_Waterproofing.pdf',
              mimeType: 'application/pdf',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt === 'media')
            .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: tc.id, title: '071200-001_Waterproofing.pdf' }] },
            },
          });

          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          const cardJson = JSON.stringify(card);
          expect(cardJson).not.toContain('Could not read Google Drive file metadata');

          const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
          const selectedAction = docDataSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
          expect(selectedAction, String(tc.label)).toBe(tc.expectedAction);
          expect(nock.isDone()).toBe(true);
        }
      });

      it('resolves Drive shortcut to stamped Submittal Arch PDF and skips flat 0-widget drawing in [Flat_Drawing.pdf, Stamped_Cover.pdf]', async () => {
        const flatPdfBuffer = await getCachedFlatPdfBuffer();
        const stampedPdfBuffer = await buildStampedArchPdfBuffer('Revise and Resubmit');

        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/flat-315')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'flat-315',
            name: '071200-001_Waterproofing.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/flat-315')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBuffer, { 'content-type': 'application/pdf' });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/shortcut-stamped-315')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'shortcut-stamped-315',
            name: 'Shortcut to Cover.pdf',
            mimeType: 'application/vnd.google-apps.shortcut',
            parents: ['root'],
            shortcutDetails: {
              targetId: 'target-stamped-315',
              targetMimeType: 'application/pdf',
            },
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/target-stamped-315')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'target-stamped-315',
            name: 'Stamped_Cover.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/target-stamped-315')
          .query((q) => q.alt === 'media')
          .reply(200, stampedPdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'flat-315', title: '071200-001_Waterproofing.pdf' },
                { id: 'shortcut-stamped-315', title: 'Shortcut to Cover.pdf' },
              ],
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const cardJson = JSON.stringify(card);
        expect(cardJson).not.toContain('Could not read Google Drive file metadata');

        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const selectedAction = docDataSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(selectedAction).toBe('RR');
        expect(nock.isDone()).toBe(true);
      });
    });

    describe('Ticket #316: Stamped Submittal Arch Date pre-population via formDate (format: "date")', () => {
      it('pre-populates date from stamped Date widget in varied human/ISO formats ahead of drive.modifiedTime and falls back to drive.modifiedTime for "DATE"', async () => {
        const cases = [
          { id: 'arch-316-iso', rawDate: '2026-11-21', expectedDate: '261121' },
          { id: 'arch-316-us2', rawDate: '5/8/26', expectedDate: '260508' },
          { id: 'arch-316-sept', rawDate: 'Sept 8, 2026', expectedDate: '260908' },
          { id: 'arch-316-ord', rawDate: 'May 8th, 2026', expectedDate: '260508' },
          { id: 'arch-316-dmy', rawDate: '8 May 2026', expectedDate: '260508' },
          { id: 'arch-316-arch', rawDate: '2023-09-13', expectedDate: '230913' },
          { id: 'arch-316-yymmdd', rawDate: '261121', expectedDate: '261121' },
          { id: 'arch-316-placeholder', rawDate: 'DATE', expectedDate: '261118' },
        ];

        for (const tc of cases) {
          const pdfBuffer = await buildArchPdfWithDate({
            dateText: tc.rawDate,
            selectedAction: tc.rawDate === 'DATE' ? undefined : 'No Exceptions Taken',
          });

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
              name: '071200-001_Waterproofing.pdf',
              mimeType: 'application/pdf',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt === 'media')
            .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: tc.id, title: '071200-001_Waterproofing.pdf' }] },
            },
          });

          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
          const dateValue = docDataSec.widgets
            .find(
              (w: { textInput?: { name: string } }) =>
                w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
            )
            ?.textInput?.value;
          expect(dateValue, tc.rawDate).toBe(tc.expectedDate);
          expect(nock.isDone()).toBe(true);
        }
      });

      it('falls through [Unfillable_DATE.pdf, Stamped_Cover.pdf] when first PDF has placeholder "DATE"', async () => {
        const unfillableBuffer = await buildArchPdfWithDate({ dateText: 'DATE' });
        const stampedBuffer = await buildArchPdfWithDate({
          dateText: 'Sept 8, 2026',
          selectedAction: 'Revise and Resubmit',
        });

        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/unfillable-316')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'unfillable-316',
            name: '071200-001_Waterproofing.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/unfillable-316')
          .query((q) => q.alt === 'media')
          .reply(200, unfillableBuffer, { 'content-type': 'application/pdf' });

        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-316')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'stamped-316',
            name: 'Stamped_Cover.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-316')
          .query((q) => q.alt === 'media')
          .reply(200, stampedBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'unfillable-316', title: '071200-001_Waterproofing.pdf' },
                { id: 'stamped-316', title: 'Stamped_Cover.pdf' },
              ],
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const dateValue = docDataSec.widgets
          .find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
          )
          ?.textInput?.value;
        const selectedAction = docDataSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(dateValue).toBe('260908');
        expect(selectedAction).toBe('RR');
        expect(nock.isDone()).toBe(true);
      });
    });

    describe('Ticket #318: Submittal FF&E PDF AcroForm pre-population and LinkedField derivation via source: "form"', () => {
      it('pre-populates specTag, LinkedField specTitle, revision, action, and date from stamped Submittal FF&E PDF while filling vendor from drive, defaulting status Open, and leaving contact blank', async () => {
        const pdfBuffer = await buildFullFfeCoverPdf({
          submittalNo: 'CG-104 - A',
          selectedAction: 'Revise and Resubmit',
          dateText: '5/8/26',
          reviewedBy: 'Jane Designer',
          includeFreeTextRemark: true,
        });

        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-3ffe-318')
          .query(true)
          .reply(200, {
            id: 'folder-3ffe-318',
            name: '3 FFE',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-ffe-318')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'stamped-ffe-318',
            name: 'Berman_Falk.pdf',
            mimeType: 'application/pdf',
            parents: ['folder-3ffe-318'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-ffe-318')
          .query((q) => q.alt === 'media')
          .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'stamped-ffe-318', title: 'Berman_Falk.pdf' }],
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const cardJson = JSON.stringify(card);
        expect(cardJson).not.toContain('Could not read Google Drive file metadata');

        const docTypeSec = card.sections.find((s: { header?: string }) => s.header === 'Document Type');
        const selectedDocType = docTypeSec.widgets
          .find((w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentType_projects')
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(selectedDocType).toBe('submittal-ffe');

        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getTextVal = (fieldKey: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
          )?.textInput?.value;
        const getSelVal = (fieldKey: string) =>
          docDataSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
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
        expect(getTextVal('revision')).toBe('A');
        expect(getSelVal('action')).toBe('RR');
        expect(getTextVal('date')).toBe('260508');
        expect(getTextVal('vendor')).toBe('BM');
        expect(getSelVal('status')).toBe('Open');
        expect(getTextVal('contact')).toBeUndefined();
        expect(nock.isDone()).toBe(true);
      });

      it('extracts CG104 without revision, CG104_A, CG 104 - A, NOC label, and leaves unlisted specTag XX999 - A blank across UiView renders', async () => {
        const cases = [
          {
            id: 'ffe-form-case-1',
            submittalNo: 'CG104',
            selectedAction: 'No Objections As Corrected',
            expectedSpecTag: 'CG104',
            expectedSpecTitle: 'BED - KING',
            expectedRevision: undefined,
            expectedAction: 'NOC',
          },
          {
            id: 'ffe-form-case-2',
            submittalNo: 'CG104_A',
            selectedAction: 'No Exceptions Taken',
            expectedSpecTag: 'CG104',
            expectedSpecTitle: 'BED - KING',
            expectedRevision: 'A',
            expectedAction: 'NET',
          },
          {
            id: 'ffe-form-case-3',
            submittalNo: 'CG 104 - A',
            selectedAction: 'Revise and Resubmit',
            expectedSpecTag: 'CG104',
            expectedSpecTitle: 'BED - KING',
            expectedRevision: 'A',
            expectedAction: 'RR',
          },
          {
            id: 'ffe-form-case-4',
            submittalNo: 'XX999 - A',
            selectedAction: 'No Objections As Corrected',
            expectedSpecTag: undefined,
            expectedSpecTitle: undefined,
            expectedRevision: undefined,
            expectedAction: 'NOC',
          },
        ];

        for (const tc of cases) {
          const pdfBuffer = await buildFullFfeCoverPdf({
            submittalNo: tc.submittalNo,
            selectedAction: tc.selectedAction,
            dateText: '2026-11-21',
          });

          mockDocumentLogSearch();
          nock('https://www.googleapis.com')
            .get('/drive/v3/drives')
            .query(true)
            .reply(200, {
              drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/folder-${tc.id}`)
            .query(true)
            .reply(200, {
              id: `folder-${tc.id}`,
              name: '3 FFE',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              mimeType: 'application/vnd.google-apps.folder',
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt !== 'media')
            .reply(200, {
              id: tc.id,
              name: 'Stamped_Submittal.pdf',
              mimeType: 'application/pdf',
              parents: [`folder-${tc.id}`],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt === 'media')
            .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: tc.id, title: 'Stamped_Submittal.pdf' }] },
            },
          });
          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
          const getTextVal = (fieldKey: string) =>
            docDataSec.widgets.find(
              (w: { textInput?: { name: string } }) => w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
            )?.textInput?.value;
          const getSelVal = (fieldKey: string) =>
            docDataSec.widgets
              .find(
                (w: { selectionInput?: { name: string } }) =>
                  w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
              )
              ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

          expect(getTextVal('specTag'), tc.id).toBe(tc.expectedSpecTag);
          const specTitleDecorated = docDataSec.widgets.find(
            (w: { decoratedText?: { topLabel?: string; text?: string; wrapText?: boolean } }) =>
              w.decoratedText?.topLabel === 'Spec Title'
          )?.decoratedText;
          const specTitleTextInput = docDataSec.widgets.find(
            (w: { textInput?: { name: string; value?: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
          );
          if (tc.expectedSpecTitle !== undefined) {
            expect(specTitleDecorated, tc.id).toEqual({
              topLabel: 'Spec Title',
              text: tc.expectedSpecTitle,
              wrapText: true,
            });
            expect(specTitleTextInput, tc.id).toBeUndefined();
          } else {
            expect(specTitleDecorated, tc.id).toBeUndefined();
            expect(specTitleTextInput?.textInput?.value, tc.id).toBeUndefined();
          }
          expect(getTextVal('revision'), tc.id).toBe(tc.expectedRevision);
          expect(getSelVal('action'), tc.id).toBe(tc.expectedAction);
          expect(getTextVal('date'), tc.id).toBe('261121');
        }
        expect(nock.isDone()).toBe(true);
      });
    });
  });

  describe('Isolated AcroForm pre-population & degradation suite (manifest overrides & spies)', () => {
    let app: AppInstance;
    let manifestProvider: AppManifestProvider;

    beforeEach(async () => {
      ({ app, manifestProvider } = await createDriveIntegrationContext());
    });

    describe('Ticket #317: Multi-token Submittal No decomposition and full Submittal Arch pre-population', () => {
      it('pre-populates section, number, revision, action, and date from stamped Submittal Arch PDF (including 4-digit external numbers) while filling title from drive.fileNameStem, defaulting status Open, and leaving contact blank', async () => {
        const pdfBuffer = await buildFullArchCoverPdf({
          submittalNo: '07 12 00 - 001 - Rev. B',
          selectedAction: 'Revise and Resubmit',
          dateText: 'May 8th, 2026',
          reviewedBy: 'Alice Architect',
          includeFreeTextRemark: true,
        });

        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/arch-317-full')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'arch-317-full',
            name: '071200-001_Waterproofing_Review.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/arch-317-full')
          .query((q) => q.alt === 'media')
          .reply(200, pdfBuffer, { 'content-type': 'application/pdf' });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'arch-317-full', title: '071200-001_Waterproofing_Review.pdf' }],
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');

        const getText = (fieldKey: string) =>
          docDataSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
          )?.textInput?.value;
        const getSelected = (fieldKey: string) =>
          docDataSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

        expect(getSelected('status')).toBe('Open');
        expect(getText('section')).toBe('071200');
        expect(getText('number')).toBe('001');
        expect(getText('revision')).toBe('B');
        expect(getText('title')).toBe('Waterproofing Review');
        expect(getText('date')).toBe('260508');
        expect(getText('contact')).toBeUndefined();
        expect(getSelected('action')).toBe('RR');
        expect(nock.isDone()).toBe(true);

        // 4-digit external submittal sequence number in Submittal No
        const fourDigitBuffer = await buildFullArchCoverPdf({
          submittalNo: '071200-1042-B',
          selectedAction: 'No Exceptions Taken',
          dateText: '2026-11-21',
        });
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/arch-317-1042')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'arch-317-1042',
            name: '071200-001_Stamped_Cover.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/arch-317-1042')
          .query((q) => q.alt === 'media')
          .reply(200, fourDigitBuffer, { 'content-type': 'application/pdf' });

        const res1042 = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'arch-317-1042', title: '071200-001_Stamped_Cover.pdf' }],
            },
          },
        });
        expect(res1042.statusCode).toBe(200);
        const card1042 = JSON.parse(res1042.payload).action.navigations[0].pushCard;
        const docSec1042 = card1042.sections.find(
          (s: { header?: string }) => s.header === 'Document Data'
        );
        expect(
          docSec1042.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe('1042');
        expect(
          docSec1042.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
          )?.textInput?.value
        ).toBe('B');
        expect(nock.isDone()).toBe(true);
      });

      it('preserves user edits on manual onDocumentTypeChange and onSpaceTypeChange while advancing multi-token cursor to fill remaining blank fields', async () => {
        const allowedSpy = mockAllowedDocumentTypes(manifestProvider, 'projects', [
          'communication-project',
          'submittal-arch',
        ]);
        const pdfBuffer = await buildFullArchCoverPdf({
          submittalNo: '081100-002-C',
          selectedAction: 'No Exceptions Taken',
          dateText: '2026-11-21',
        });

        vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
          id: 'arch-317-switch',
          name: '071200-001_Metal_Doors.pdf',
          mimeType: 'application/pdf',
          parents: ['space-projects-1'],
          driveId: 'space-projects-1',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
        vi.spyOn(GoogleDriveClient.prototype, 'downloadFileMedia').mockResolvedValue(pdfBuffer);

        // 1. onDocumentTypeChange to submittal-arch with user-edited section and number
        mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
        const typeSwitchRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'arch-317-switch', title: '071200-001_Metal_Doors.pdf' }],
            },
            commonEventObject: {
              parameters: { action: 'onDocumentTypeChange' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentTypeWidgetName('projects')]: {
                  stringInputs: { value: ['submittal-arch'] },
                },
                [getDocumentSpaceWidgetName('projects')]: {
                  stringInputs: { value: ['Active Projects'] },
                },
                SelectFiles: { stringInputs: { value: ['arch-317-switch'] } },
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

        expect(typeSwitchRes.statusCode).toBe(200);
        const switchCard = JSON.parse(typeSwitchRes.payload).action.navigations[0].updateCard;
        const switchDocSec = switchCard.sections.find(
          (s: { header?: string }) => s.header === 'Document Data'
        );
        const getSwitchText = (fieldKey: string) =>
          switchDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
          )?.textInput?.value;
        const getSwitchSelected = (fieldKey: string) =>
          switchDocSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

        expect(getSwitchText('section')).toBe('071200');
        expect(getSwitchText('number')).toBe('001');
        expect(getSwitchText('revision')).toBe('C');
        expect(getSwitchText('date')).toBe('261121');
        expect(getSwitchText('title')).toBe('Metal Doors');
        expect(getSwitchSelected('action')).toBe('NET');

        // 2. onSpaceTypeChange targeting projects (with submittal-arch resolved as space default) preserves user edits and re-evaluates reactive UiView
        allowedSpy.mockRestore();
        mockAllowedDocumentTypes(manifestProvider, 'projects', ['submittal-arch']);
        mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
        const spaceSwitchRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'arch-317-switch', title: '071200-001_Metal_Doors.pdf' }],
            },
            commonEventObject: {
              parameters: { action: 'onSpaceTypeChange' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: {
                  stringInputs: { value: ['Active Projects'] },
                },
                SelectFiles: { stringInputs: { value: ['arch-317-switch'] } },
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

        expect(spaceSwitchRes.statusCode).toBe(200);
        const spaceCard = JSON.parse(spaceSwitchRes.payload).action.navigations[0].updateCard;
        const spaceDocSec = spaceCard.sections.find(
          (s: { header?: string }) => s.header === 'Document Data'
        );
        expect(
          spaceDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
          )?.textInput?.value
        ).toBe('C');
        expect(
          spaceDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
      });
    });

    describe('Ticket #319: Pass 2 form error degradation & multi-selection resilience (UiView)', () => {
      it('renders PDF_FORM_ENCRYPTED_ERROR_MESSAGE and DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE in UiView while still populating Drive filename/date fields', async () => {
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/enc-arch-319')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'enc-arch-319',
            name: '071200-001_Encrypted_Cover.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/enc-arch-319')
          .query((q) => q.alt === 'media')
          .reply(200, Buffer.from('%PDF-1.4-encrypted'), { 'content-type': 'application/pdf' });

        const extractSpy = vi
          .spyOn(PdfProcessor.prototype, 'extractFormData')
          .mockRejectedValueOnce(new PdfEncryptionError());

        const encRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'enc-arch-319', title: '071200-001_Encrypted_Cover.pdf' }] },
          },
        });
        extractSpy.mockRestore();

        expect(encRes.statusCode).toBe(200);
        const encCard = JSON.parse(encRes.payload).action.navigations[0].pushCard;
        const encCardJson = JSON.stringify(encCard);
        expect(encCardJson).toContain(PDF_FORM_ENCRYPTED_ERROR_MESSAGE);
        const encDocSec = encCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          encDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
        expect(
          encDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe('001');
        expect(nock.isDone()).toBe(true);

        // Corrupted PDF -> real PdfProcessor throws PdfCorruptedError on malformed bytes
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/corrupt-arch-319')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'corrupt-arch-319',
            name: '071200-002_Corrupted_Cover.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/corrupt-arch-319')
          .query((q) => q.alt === 'media')
          .reply(200, Buffer.from('not-a-valid-pdf'), { 'content-type': 'application/pdf' });

        const corruptRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'corrupt-arch-319', title: '071200-002_Corrupted_Cover.pdf' }] },
          },
        });

        expect(corruptRes.statusCode).toBe(200);
        const corruptCard = JSON.parse(corruptRes.payload).action.navigations[0].pushCard;
        const corruptCardJson = JSON.stringify(corruptCard);
        expect(corruptCardJson).toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
        const corruptDocSec = corruptCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          corruptDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
        expect(
          corruptDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe('002');
        expect(nock.isDone()).toBe(true);
      });

      it('recovers from [Forbidden.pdf, Stamped_Cover.pdf] in source: "form" on onDocumentTypeChange and surfaces generalized Pass 2 Drive notice on downloadFileMedia 503', async () => {
        mockAllowedDocumentTypes(manifestProvider, 'projects', ['communication-project', 'submittal-arch']);
        const stampedPdfBuffer = await buildStampedArchPdfBuffer('Revise and Resubmit');

        // 1. [Forbidden.pdf, Stamped_Cover.pdf] on onDocumentTypeChange -> form populates action RR + generalized notice
        mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root', name: 'Active Projects Document Log' });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/forbidden-319')
          .query((q) => q.alt !== 'media')
          .reply(403, { error: { code: 403, message: 'Forbidden' } });
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-319')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'stamped-319',
            name: '071200-003_Stamped_Cover.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-319')
          .query((q) => q.alt === 'media')
          .reply(200, stampedPdfBuffer, { 'content-type': 'application/pdf' });

        const multiRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'forbidden-319', title: 'Forbidden.pdf' },
                { id: 'stamped-319', title: '071200-003_Stamped_Cover.pdf' },
              ],
            },
            commonEventObject: {
              parameters: { action: 'onDocumentTypeChange' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentTypeWidgetName('projects')]: {
                  stringInputs: { value: ['submittal-arch'] },
                },
                [getDocumentSpaceWidgetName('projects')]: {
                  stringInputs: { value: ['Active Projects'] },
                },
                SelectFiles: { stringInputs: { value: ['forbidden-319', 'stamped-319'] } },
              },
            },
          },
        });

        expect(multiRes.statusCode).toBe(200);
        const multiCard = JSON.parse(multiRes.payload).action.navigations[0].updateCard;
        const multiCardJson = JSON.stringify(multiCard);
        expect(multiCardJson).toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
        const multiDocSec = multiCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const selectedAction = multiDocSec.widgets
          .find(
            (w: { selectionInput?: { name: string } }) =>
              w.selectionInput?.name === getDocumentInfoWidgetName('action', 'submittal-arch')
          )
          ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;
        expect(selectedAction).toBe('RR');
        expect(nock.isDone()).toBe(true);

        // 2. Drive 503 on downloadFileMedia during initial load (Pass 1 succeeds -> Pass 2 generalized notice appears once)
        mockDocumentLogSearch();
        const getFileSpy = vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
          id: 'media-503-319',
          name: '071200-004_Outage_Cover.pdf',
          mimeType: 'application/pdf',
          parents: ['projects-shared-drive-001'],
          driveId: 'projects-shared-drive-001',
          modifiedTime: '2026-11-18T15:00:00Z',
        });
        const listDrivesSpy = vi.spyOn(GoogleDriveClient.prototype, 'listSharedDrives').mockResolvedValue({
          drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
        });
        const downloadSpy = vi
          .spyOn(GoogleDriveClient.prototype, 'downloadFileMedia')
          .mockRejectedValue(new GoogleDriveApiError('Service Unavailable', { statusCode: 503 }));

        const mediaOutageRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'media-503-319', title: '071200-004_Outage_Cover.pdf' }] },
          },
        });
        getFileSpy.mockRestore();
        listDrivesSpy.mockRestore();
        downloadSpy.mockRestore();

        expect(mediaOutageRes.statusCode).toBe(200);
        const outageCard = JSON.parse(mediaOutageRes.payload).action.navigations[0].pushCard;
        const outageCardJson = JSON.stringify(outageCard);
        expect(outageCardJson).toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
        const outageDocSec = outageCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          outageDocSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
      });

      it('renders formatAmbiguousFormFieldMessage in UiView for ambiguous form widgets while still populating Drive metadata fields', async () => {
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/ambig-gdoc-319')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'ambig-gdoc-319',
            name: '071200-005_Ambiguous_Cover',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });

        const extractFormSpy = vi
          .spyOn(DriveFormExtractorAdapter.prototype, 'extractFormFields')
          .mockResolvedValueOnce({
            status: 'ok',
            widgetCount: 2,
            fields: {},
            ambiguousFields: ['Submittal Response'],
          });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [{ id: 'ambig-gdoc-319', title: '071200-005_Ambiguous_Cover' }],
            },
          },
        });
        extractFormSpy.mockRestore();

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        expect(card.sections[0]?.widgets?.[0]?.textParagraph?.text).toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );
        const docSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          docSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
        expect(nock.isDone()).toBe(true);
      });
    });
  });
});

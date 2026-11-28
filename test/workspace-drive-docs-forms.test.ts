import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
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
import {
  DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE,
  DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
  formatAmbiguousFormFieldMessage,
} from '../src/features/source-parser/domain';
import { DRIVE_ROUTING_FALLBACK_NOTICE } from '../src/features/ui-process-manager/domain';

describe('Workspace-to-Drive E2E: Google Docs Form Pre-Population & Degradation', () => {
  beforeEach(() => {
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  describe('Read-only Google Docs pre-population & degradation suite', () => {
    let app: AppInstance;

    beforeAll(async () => {
      ({ app } = await createDriveIntegrationContext());
    });

    describe('Ticket #321: Google Docs N×2 Key/Value pre-population, shortcuts, multi-item fallback, and non-blocking degradation', () => {
      function buildNx2GoogleDocPayload(documentId: string, submittalNoText?: string) {
        return {
          documentId,
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
                              {
                                content: [
                                  {
                                    paragraph: {
                                      elements: [{ textRun: { content: `${submittalNoText ?? ''}\n` } }],
                                    },
                                  },
                                ],
                              },
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

      function buildProseGoogleDocPayload(documentId: string, bodyText = 'Plain meeting notes without form tables.\n') {
        return {
          documentId,
          body: null,
          tabs: [
            {
              documentTab: {
                body: {
                  content: [
                    { paragraph: { elements: [{ textRun: { content: bodyText } }] } },
                  ],
                },
              },
            },
          ],
        };
      }

      it('pre-populates full and partial Submittal No from N×2 table on Submittal Arch Google Doc cover sheets via nock', async () => {
        const cases = [
          {
            id: 'gdoc-arch-full',
            fileName: '071200-001_Waterproofing_Cover_Sheet',
            subNo: '071200-001-1',
            section: '071200',
            number: '001',
            revision: '1',
            title: 'Waterproofing Cover Sheet',
          },
          {
            id: 'gdoc-arch-no-rev',
            fileName: '071200-001_Waterproofing_Cover_Sheet',
            subNo: '071200-001',
            section: '071200',
            number: '001',
            revision: undefined,
            title: 'Waterproofing Cover Sheet',
          },
          {
            id: 'gdoc-arch-4digit',
            fileName: '071200-001_Waterproofing_Cover_Sheet',
            subNo: '071200-1042',
            section: '071200',
            number: '1042',
            revision: undefined,
            title: undefined,
          },
          {
            id: 'gdoc-arch-csi',
            fileName: 'Waterproofing_Cover_Sheet',
            subNo: '07 12 00',
            section: '071200',
            number: undefined,
            revision: undefined,
            title: undefined,
          },
          {
            id: 'gdoc-arch-num-rev',
            fileName: 'Waterproofing_Cover_Sheet',
            subNo: '42 Rev B',
            section: undefined,
            number: '042',
            revision: 'B',
            title: undefined,
          },
          {
            id: 'gdoc-arch-rev-only',
            fileName: 'Waterproofing_Cover_Sheet',
            subNo: 'R1',
            section: undefined,
            number: undefined,
            revision: '1',
            title: undefined,
          },
        ];

        for (const tc of cases) {
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
              name: '6 Construction',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              mimeType: 'application/vnd.google-apps.folder',
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${tc.id}`)
            .query((q) => q.alt !== 'media')
            .reply(200, {
              id: tc.id,
              name: tc.fileName,
              mimeType: 'application/vnd.google-apps.document',
              parents: [`folder-${tc.id}`],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });
          nock('https://docs.googleapis.com', {
            reqheaders: { authorization: 'Bearer ya29.valid-oauth-token' },
          })
            .get(`/v1/documents/${tc.id}`)
            .query({
              includeTabsContent: 'true',
              suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
            })
            .reply(200, buildNx2GoogleDocPayload(tc.id, tc.subNo));

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: tc.id, title: tc.fileName }] },
            },
          });

          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          expect(JSON.stringify(card)).not.toContain('Could not read Google Drive file metadata');

          const docDataSec = card.sections.find((s: { header?: string }) => s.header === 'Document Data');
          const getText = (fieldKey: string) =>
            docDataSec.widgets.find(
              (w: { textInput?: { name: string } }) =>
                w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
            )?.textInput?.value;
          const getSel = (fieldKey: string) =>
            docDataSec.widgets
              .find(
                (w: { selectionInput?: { name: string } }) =>
                  w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-arch')
              )
              ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

          expect(getText('section'), tc.id).toBe(tc.section);
          expect(getText('number'), tc.id).toBe(tc.number);
          expect(getText('revision'), tc.id).toBe(tc.revision);
          expect(getText('title'), tc.id).toBe(tc.title);
          expect(getText('date'), tc.id).toBe('261118');
          expect(getSel('status'), tc.id).toBe('Open');
          expect(getSel('action'), tc.id).toBe('REC');
        }
        expect(nock.isDone()).toBe(true);
      });

      it('pre-populates specTag, derived LinkedField specTitle, and revision on Submittal FF&E Google Doc cover sheet and handles 0-widget prose doc silently', async () => {
        // 1. Submittal FF&E cover sheet with CG104-A
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-ffe-321')
          .query(true)
          .reply(200, {
            id: 'folder-ffe-321',
            name: '3 FFE',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/gdoc-ffe-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'gdoc-ffe-321',
            name: 'Berman_Falk',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['folder-ffe-321'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/gdoc-ffe-321')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, buildNx2GoogleDocPayload('gdoc-ffe-321', 'CG104-A'));

        const ffeRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'gdoc-ffe-321', title: 'Berman_Falk' }] },
          },
        });

        expect(ffeRes.statusCode).toBe(200);
        const ffeCard = JSON.parse(ffeRes.payload).action.navigations[0].pushCard;
        const ffeSec = ffeCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        const getFfeText = (fieldKey: string) =>
          ffeSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
          )?.textInput?.value;
        const getFfeSel = (fieldKey: string) =>
          ffeSec.widgets
            .find(
              (w: { selectionInput?: { name: string } }) =>
                w.selectionInput?.name === getDocumentInfoWidgetName(fieldKey, 'submittal-ffe')
            )
            ?.selectionInput?.items.find((i: { selected?: boolean }) => i.selected)?.value;

        expect(getFfeText('specTag')).toBe('CG104');
        const specTitleDecorated = ffeSec.widgets.find(
          (w: { decoratedText?: { topLabel?: string; text?: string; wrapText?: boolean } }) =>
            w.decoratedText?.topLabel === 'Spec Title'
        )?.decoratedText;
        expect(specTitleDecorated).toEqual({
          topLabel: 'Spec Title',
          text: 'BED - KING',
          wrapText: true,
        });
        expect(
          ffeSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
          )
        ).toBeUndefined();
        expect(getFfeText('revision')).toBe('A');
        expect(getFfeText('vendor')).toBe('BM');
        expect(getFfeText('date')).toBe('261118');
        expect(getFfeSel('status')).toBe('Open');
        expect(getFfeSel('action')).toBe('REC');

        // 2. Plain 0-widget prose Google Doc silently falls through to drive rules with zero error banners
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/gdoc-prose-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'gdoc-prose-321',
            name: '071200-003_Prose_Narrative',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/gdoc-prose-321')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, buildProseGoogleDocPayload('gdoc-prose-321'));

        const proseRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'gdoc-prose-321', title: '071200-003_Prose_Narrative' }] },
          },
        });

        expect(proseRes.statusCode).toBe(200);
        const proseCard = JSON.parse(proseRes.payload).action.navigations[0].pushCard;
        expect(JSON.stringify(proseCard)).not.toContain('Could not read Google Drive file metadata');
        expect(JSON.stringify(proseCard)).not.toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
        const proseSec = proseCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          proseSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
        expect(
          proseSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe('003');
        expect(nock.isDone()).toBe(true);
      });

      it('resolves Drive shortcut to Google Doc and skips 0-widget candidates in multi-item selection', async () => {
        // 1. Shortcut pointing to a Google Doc cover sheet
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/shortcut-gdoc-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'shortcut-gdoc-321',
            name: 'Shortcut to Cover',
            mimeType: 'application/vnd.google-apps.shortcut',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            shortcutDetails: {
              targetId: 'target-gdoc-321',
              targetMimeType: 'application/vnd.google-apps.document',
            },
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/target-gdoc-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'target-gdoc-321',
            name: 'Submittal_Cover_Doc',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['folder-target-arch-321'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-target-arch-321')
          .query(true)
          .reply(200, {
            id: 'folder-target-arch-321',
            name: '6 Construction',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/target-gdoc-321')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, buildNx2GoogleDocPayload('target-gdoc-321', '092900-007-2'));

        const shortcutRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'shortcut-gdoc-321', title: 'Shortcut to Cover' }] },
          },
        });
        expect(shortcutRes.statusCode).toBe(200);
        const shortcutCard = JSON.parse(shortcutRes.payload).action.navigations[0].pushCard;
        const shortcutSec = shortcutCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          shortcutSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('092900');
        expect(
          shortcutSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe('007');
        expect(
          shortcutSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
          )?.textInput?.value
        ).toBe('2');

        // 2. Multi-item [Flat_Drawing.pdf, Stamped_Cover_Doc] skips 0-widget PDF and binds to Stamped_Cover_Doc
        const flatPdfBytes = await getCachedFlatPdfBuffer();
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/flat-pdf-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'flat-pdf-321',
            name: '071200-001_Flat_Drawing.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/flat-pdf-321')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBytes, { 'content-type': 'application/pdf' });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-gdoc-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'stamped-gdoc-321',
            name: 'Stamped_Cover_Doc',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/stamped-gdoc-321')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, buildNx2GoogleDocPayload('stamped-gdoc-321', '081100-012-A'));

        const multiRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'flat-pdf-321', title: '071200-001_Flat_Drawing.pdf' },
                { id: 'stamped-gdoc-321', title: 'Stamped_Cover_Doc' },
              ],
            },
          },
        });
        expect(multiRes.statusCode).toBe(200);
        const multiCard = JSON.parse(multiRes.payload).action.navigations[0].pushCard;
        const multiSec = multiCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          multiSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('081100');
        expect(
          multiSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe('012');
        expect(
          multiSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('revision', 'submittal-arch')
          )?.textInput?.value
        ).toBe('A');
        expect(nock.isDone()).toBe(true);
      });

      it('degrades non-blockingly on Docs 403/503 transport failure and malformed 200 payload', async () => {
        // 1. Docs 403 -> single deduplicated DRIVE_METADATA_EXTRACT_ERROR_MESSAGE + Drive fallback still populates
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/gdoc-403-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'gdoc-403-321',
            name: '071200-004_Restricted_Cover',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/gdoc-403-321')
          .query(true)
          .reply(403, { error: { code: 403, message: 'Forbidden' } });

        const errRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'gdoc-403-321', title: '071200-004_Restricted_Cover' }] },
          },
        });
        expect(errRes.statusCode).toBe(200);
        const errCard = JSON.parse(errRes.payload).action.navigations[0].pushCard;
        const errCardJson = JSON.stringify(errCard);
        expect(errCardJson.split(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE).length - 1).toBe(1);
        const errSec = errCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          errSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');

        // 2. Malformed 200 payload -> DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE + Drive fallback still populates
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/gdoc-corrupt-321')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'gdoc-corrupt-321',
            name: '071200-005_Corrupt_Cover',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/gdoc-corrupt-321')
          .query(true)
          .reply(200, { documentId: 'gdoc-corrupt-321' });

        const corruptRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: 'gdoc-corrupt-321', title: '071200-005_Corrupt_Cover' }] },
          },
        });
        expect(corruptRes.statusCode).toBe(200);
        const corruptCard = JSON.parse(corruptRes.payload).action.navigations[0].pushCard;
        expect(JSON.stringify(corruptCard)).toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
        const corruptSec = corruptCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(corruptSec.widgets.find(
          (w: { textInput?: { name: string } }) =>
            w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
        )?.textInput?.value).toBe('071200');
        expect(nock.isDone()).toBe(true);
      });
    });

    describe('Ticket #324: GoogleDocsClient resiliency & non-blocking source_error / corrupted degradation', () => {
      it('renders DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE on malformed 200 Docs payload while Drive metadata still populates', async () => {
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/gdoc-corrupt-324')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'gdoc-corrupt-324',
            name: '071200-008_Corrupt_Cover',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/gdoc-corrupt-324')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, { documentId: 'gdoc-corrupt-324', body: { content: null } });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-cred' },
            drive: { selectedItems: [{ id: 'gdoc-corrupt-324', title: '071200-008_Corrupt_Cover' }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const pushCard = JSON.parse(res.payload).action.navigations[0].pushCard;
        const cardJson = JSON.stringify(pushCard);
        expect(cardJson).toContain(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
        expect(cardJson).not.toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);

        const docSec = pushCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
        expect(
          docSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
          )?.textInput?.value
        ).toBe('071200');
        expect(
          docSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
          )?.textInput?.value
        ).toBe('008');
        expect(
          docSec.widgets.find(
            (w: { textInput?: { name: string } }) =>
              w.textInput?.name === getDocumentInfoWidgetName('date', 'submittal-arch')
          )?.textInput?.value
        ).toBe('261118');
        expect(nock.isDone()).toBe(true);
      });

      it('renders at most one deduplicated DRIVE_METADATA_EXTRACT_ERROR_MESSAGE on permanent docs.googleapis.com 403 and 503 failures', async () => {
        for (const failure of [
          {
            id: 'gdoc-403-324',
            name: '071200-009_Forbidden_Cover',
            expectedNumber: '009',
            status: 403,
            body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'forbidden' }] } },
          },
          {
            id: 'gdoc-503-324',
            name: '071200-010_Unavailable_Cover',
            expectedNumber: '010',
            status: 503,
            body: { error: { code: 503, message: 'Service Unavailable' } },
          },
        ]) {
          mockDocumentLogSearch();
          nock('https://www.googleapis.com')
            .get('/drive/v3/drives')
            .query(true)
            .reply(200, {
              drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
            });
          nock('https://www.googleapis.com')
            .get(`/drive/v3/files/${failure.id}`)
            .query((q) => q.alt !== 'media')
            .reply(200, {
              id: failure.id,
              name: failure.name,
              mimeType: 'application/vnd.google-apps.document',
              parents: ['projects-shared-drive-001'],
              driveId: 'projects-shared-drive-001',
              modifiedTime: '2026-11-18T15:00:00Z',
            });
          nock('https://docs.googleapis.com')
            .get(`/v1/documents/${failure.id}`)
            .query({
              includeTabsContent: 'true',
              suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
            })
            .reply(failure.status, failure.body);

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-cred' },
              drive: { selectedItems: [{ id: failure.id, title: failure.name }] },
            },
          });

          expect(res.statusCode).toBe(200);
          const pushCard = JSON.parse(res.payload).action.navigations[0].pushCard;
          const cardJson = JSON.stringify(pushCard);
          expect(cardJson.split(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE).length - 1).toBe(1);

          const docSec = pushCard.sections.find((s: { header?: string }) => s.header === 'Document Data');
          expect(
            docSec.widgets.find(
              (w: { textInput?: { name: string } }) =>
                w.textInput?.name === getDocumentInfoWidgetName('section', 'submittal-arch')
            )?.textInput?.value
          ).toBe('071200');
          expect(
            docSec.widgets.find(
              (w: { textInput?: { name: string } }) =>
                w.textInput?.name === getDocumentInfoWidgetName('number', 'submittal-arch')
            )?.textInput?.value
          ).toBe(failure.expectedNumber);
          expect(nock.isDone()).toBe(true);
        }
      });

      it('suppresses Pass 2 source_error notice when Pass 1 already emitted DRIVE_ROUTING_FALLBACK_NOTICE and leaves manual card entry unblocked', async () => {
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/gdoc-pass1-503-324')
          .query((q) => q.alt !== 'media')
          .reply(503, { error: { code: 503, message: 'Service Unavailable' } });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-cred' },
            drive: { selectedItems: [{ id: 'gdoc-pass1-503-324', title: '071200-011_Unavailable' }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const pushCard = JSON.parse(res.payload).action.navigations[0].pushCard;
        const cardJson = JSON.stringify(pushCard);

        expect(cardJson.split(DRIVE_ROUTING_FALLBACK_NOTICE).length - 1).toBe(1);
        expect(cardJson).not.toContain(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
        expect(cardJson).toContain('communication-project');
        expect(cardJson).toContain('Active Projects');
        expect(pushCard.sections.some((s: { header?: string }) => s.header === 'Document Data')).toBe(true);
        expect(nock.isDone()).toBe(true);
      });
    });

    describe('Ticket #323: Full 5-pattern live Google Docs cover-sheet pre-population, DateElement/typed dates, and multi-item memoization', () => {
      const RESPONSE_LABELS = [
        'NO EXCEPTIONS TAKEN',
        'NO OBJECTIONS AS CORRECTED',
        'REVISE AND RESUBMIT',
        'REJECTED',
        'NOT REVIEWED',
      ] as const;

      function buildFullCoverSheetDoc(options: {
        documentId: string;
        submittalNo?: string;
        checkedIndex?: number;
        remarks?: string;
        reviewerName?: string;
        dateCellElements?: Array<Record<string, unknown>>;
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
                    { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                    {
                      table: {
                        rows: 1,
                        columns: 2,
                        tableRows: [
                          {
                            tableCells: [
                              cell('Submittal No.\n', { columnSpan: 1, rowSpan: 1 }),
                              cell(`${options.submittalNo ?? ''}\n`, { columnSpan: 1, rowSpan: 1 }),
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
                            const col2 =
                              idx === 0
                                ? cell('NET/NOC Legend\n', { rowSpan: 2 })
                                : idx === 2
                                  ? cell('RR/REJ Legend\n', { rowSpan: 2 })
                                  : cell('\n');
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
                                col2,
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
                          { tableCells: [cell(`${options.remarks ?? ''}\n`, { columnSpan: 1, rowSpan: 1 })] },
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
                              options.reviewerName
                                ? {
                                    tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                    content: [
                                      {
                                        paragraph: {
                                          elements: [
                                            { person: { personProperties: { name: options.reviewerName } } },
                                          ],
                                        },
                                      },
                                    ],
                                  }
                                : cell('\n', { columnSpan: 1, rowSpan: 1 }),
                              {
                                tableCellStyle: { columnSpan: 1, rowSpan: 1 },
                                content: [
                                  {
                                    paragraph: {
                                      elements: options.dateCellElements ?? [{ textRun: { content: '\uE907\n' } }],
                                    },
                                  },
                                ],
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
                    { paragraph: { elements: [{ textRun: { content: '\n' } }] } },
                  ],
                },
              },
            },
          ],
        };
      }

      function mockDriveAndDocsForCoverSheet(options: {
        docId: string;
        fileName: string;
        folderName: '6 Construction' | '3 FFE';
        modifiedTime?: string;
        docPayload: Record<string, unknown>;
      }) {
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/folder-${options.docId}`)
          .query(true)
          .reply(200, {
            id: `folder-${options.docId}`,
            name: options.folderName,
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${options.docId}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: options.docId,
            name: options.fileName,
            mimeType: 'application/vnd.google-apps.document',
            parents: [`folder-${options.docId}`],
            driveId: 'projects-shared-drive-001',
            modifiedTime: options.modifiedTime ?? '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com', {
          reqheaders: { authorization: 'Bearer ya29.valid-oauth-token' },
        })
          .get(`/v1/documents/${options.docId}`)
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, options.docPayload);
      }

      const readText = (
        card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
        fieldKey: string,
        docTypeKey: string
      ) => {
        const docSec = card.sections.find((s) => s.header === 'Document Data');
        const widget = docSec?.widgets.find(
          (w) =>
            (w.textInput as { name?: string } | undefined)?.name ===
            getDocumentInfoWidgetName(fieldKey, docTypeKey)
        ) as { textInput?: { value?: string } } | undefined;
        return widget?.textInput?.value;
      };

      const readSelected = (
        card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
        fieldKey: string,
        docTypeKey: string
      ) => {
        const docSec = card.sections.find((s) => s.header === 'Document Data');
        const widget = docSec?.widgets.find(
          (w) =>
            (w.selectionInput as { name?: string } | undefined)?.name ===
            getDocumentInfoWidgetName(fieldKey, docTypeKey)
        ) as { selectionInput?: { items: Array<{ value: string; selected?: boolean }> } } | undefined;
        return widget?.selectionInput?.items.find((i) => i.selected)?.value;
      };

      it('pre-populates stamped Submittal Arch cover sheet (DateElement, Submittal No, NOC action, title from drive, REMARKS/Reviewed By unmapped, single documents.get call)', async () => {
        const docId = 'gdoc-323-stamped-arch';
        mockDriveAndDocsForCoverSheet({
          docId,
          fileName: '071200-001_Waterproofing_Cover_Sheet',
          folderName: '6 Construction',
          modifiedTime: '2026-11-18T15:00:00Z',
          docPayload: buildFullCoverSheetDoc({
            documentId: docId,
            submittalNo: '071200-001-1',
            checkedIndex: 1,
            remarks: 'Confirm membrane overlap at parapet.',
            reviewerName: 'Jane Architect',
            dateCellElements: [
              {
                dateElement: {
                  dateElementProperties: {
                    timestamp: '2026-11-21T00:00:00Z',
                    timeZoneId: 'UTC',
                  },
                },
              },
            ],
          }),
        });

        const res = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing_Cover_Sheet' }] },
          },
        });

        expect(res.statusCode).toBe(200);
        const card = JSON.parse(res.payload).action.navigations[0].pushCard;
        expect(readText(card, 'section', 'submittal-arch')).toBe('071200');
        expect(readText(card, 'number', 'submittal-arch')).toBe('001');
        expect(readText(card, 'revision', 'submittal-arch')).toBe('1');
        expect(readSelected(card, 'action', 'submittal-arch')).toBe('NOC');
        expect(readText(card, 'date', 'submittal-arch')).toBe('261121');
        expect(readText(card, 'title', 'submittal-arch')).toBe('Waterproofing Cover Sheet');
        expect(readSelected(card, 'status', 'submittal-arch')).toBe('Open');
        expect(readText(card, 'notes', 'submittal-arch') ?? '').toBe('');
        expect(nock.isDone()).toBe(true);
      });

      it('pre-populates stamped Submittal FF&E cover sheet across typed date formats and preserves action: REC + drive.modifiedTime on unreviewed template', async () => {
        const ffeDateCases = [
          { rawDate: '5/8/26', expectedYymmdd: '260508' },
          { rawDate: '11/21/2026', expectedYymmdd: '261121' },
          { rawDate: 'Sept 8, 2026', expectedYymmdd: '260908' },
          { rawDate: '2026-11-21', expectedYymmdd: '261121' },
        ];

        for (const [idx, tc] of ffeDateCases.entries()) {
          const docId = `gdoc-323-stamped-ffe-${idx}`;
          mockDriveAndDocsForCoverSheet({
            docId,
            fileName: 'Berman_Falk',
            folderName: '3 FFE',
            modifiedTime: '2026-11-18T15:00:00Z',
            docPayload: buildFullCoverSheetDoc({
              documentId: docId,
              submittalNo: 'CG104-A',
              checkedIndex: 2,
              remarks: 'Submit walnut finish sample.',
              reviewerName: 'Sam Designer',
              dateCellElements: [{ textRun: { content: `${tc.rawDate}\n` } }],
            }),
          });

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: docId, title: 'Berman_Falk' }] },
            },
          });

          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          expect(readText(card, 'specTag', 'submittal-ffe'), tc.rawDate).toBe('CG104');
          const cardDocSec = (card as { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> }).sections.find(
            (s) => s.header === 'Document Data'
          );
          expect(
            cardDocSec?.widgets.find(
              (w) => (w.decoratedText as { topLabel?: string } | undefined)?.topLabel === 'Spec Title'
            )?.decoratedText,
            tc.rawDate
          ).toEqual({ topLabel: 'Spec Title', text: 'BED - KING', wrapText: true });
          expect(
            cardDocSec?.widgets.find(
              (w) =>
                (w.textInput as { name?: string } | undefined)?.name ===
                getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
            ),
            tc.rawDate
          ).toBeUndefined();
          expect(readText(card, 'revision', 'submittal-ffe'), tc.rawDate).toBe('A');
          expect(readSelected(card, 'action', 'submittal-ffe'), tc.rawDate).toBe('RR');
          expect(readText(card, 'date', 'submittal-ffe'), tc.rawDate).toBe(tc.expectedYymmdd);
          expect(readText(card, 'vendor', 'submittal-ffe'), tc.rawDate).toBe('BM');
        }

        // Unreviewed template (0 checked ☐ + \uE907 Date Placeholder) keeps action: "REC" and falls through date to drive.modifiedTime
        const unreviewedId = 'gdoc-323-unreviewed-ffe';
        mockDriveAndDocsForCoverSheet({
          docId: unreviewedId,
          fileName: 'Berman_Falk',
          folderName: '3 FFE',
          modifiedTime: '2026-11-18T15:00:00Z',
          docPayload: buildFullCoverSheetDoc({
            documentId: unreviewedId,
            submittalNo: 'CG104-A',
          }),
        });

        const unreviewedRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: unreviewedId, title: 'Berman_Falk' }] },
          },
        });

        expect(unreviewedRes.statusCode).toBe(200);
        const unreviewedCard = JSON.parse(unreviewedRes.payload).action.navigations[0].pushCard;
        expect(readSelected(unreviewedCard, 'action', 'submittal-ffe')).toBe('REC');
        expect(readText(unreviewedCard, 'date', 'submittal-ffe')).toBe('261118');
        expect(readText(unreviewedCard, 'specTag', 'submittal-ffe')).toBe('CG104');
        const unreviewedDocSec = (unreviewedCard as { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> }).sections.find(
          (s) => s.header === 'Document Data'
        );
        expect(
          unreviewedDocSec?.widgets.find(
            (w) => (w.decoratedText as { topLabel?: string } | undefined)?.topLabel === 'Spec Title'
          )?.decoratedText
        ).toEqual({ topLabel: 'Spec Title', text: 'BED - KING', wrapText: true });
        expect(
          unreviewedDocSec?.widgets.find(
            (w) =>
              (w.textInput as { name?: string } | undefined)?.name ===
              getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
          )
        ).toBeUndefined();
        expect(readText(unreviewedCard, 'vendor', 'submittal-ffe')).toBe('BM');
        expect(nock.isDone()).toBe(true);
      });

      it('skips 0-widget candidates in [Plain_Narrative_Doc, Stamped_Cover_Doc] and [Flat_Drawing.pdf, Stamped_Cover_Doc] with per-mimeType:id memoization', async () => {
        // 1. [Plain_Narrative_Doc, Stamped_Cover_Doc]
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/plain-narrative-323')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'plain-narrative-323',
            name: 'Plain_Narrative_Doc',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/plain-narrative-323')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(200, {
            documentId: 'plain-narrative-323',
            body: null,
            tabs: [
              {
                documentTab: {
                  body: {
                    content: [{ paragraph: { elements: [{ textRun: { content: 'Narrative only.\n' } }] } }],
                  },
                },
              },
            ],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-cover-doc-323a')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'stamped-cover-doc-323a',
            name: 'Stamped_Cover_Doc',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['folder-const-323a'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/folder-const-323a')
          .query(true)
          .reply(200, {
            id: 'folder-const-323a',
            name: '6 Construction',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/stamped-cover-doc-323a')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(
            200,
            buildFullCoverSheetDoc({
              documentId: 'stamped-cover-doc-323a',
              submittalNo: '071200-004-2',
              checkedIndex: 1,
              dateCellElements: [{ textRun: { content: '2026-11-21\n' } }],
            })
          );

        const docPairRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'plain-narrative-323', title: 'Plain_Narrative_Doc' },
                { id: 'stamped-cover-doc-323a', title: 'Stamped_Cover_Doc' },
              ],
            },
          },
        });
        expect(docPairRes.statusCode).toBe(200);
        const docPairCard = JSON.parse(docPairRes.payload).action.navigations[0].pushCard;
        expect(readText(docPairCard, 'section', 'submittal-arch')).toBe('071200');
        expect(readText(docPairCard, 'number', 'submittal-arch')).toBe('004');
        expect(readText(docPairCard, 'revision', 'submittal-arch')).toBe('2');
        expect(readSelected(docPairCard, 'action', 'submittal-arch')).toBe('NOC');
        expect(readText(docPairCard, 'date', 'submittal-arch')).toBe('261121');

        // 2. [Flat_Drawing.pdf, Stamped_Cover_Doc]
        const flatPdfBytes = await getCachedFlatPdfBuffer();
        mockDocumentLogSearch();
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/flat-drawing-323')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'flat-drawing-323',
            name: '071200-001_Flat_Drawing.pdf',
            mimeType: 'application/pdf',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/flat-drawing-323')
          .query((q) => q.alt === 'media')
          .reply(200, flatPdfBytes, { 'content-type': 'application/pdf' });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/stamped-cover-doc-323b')
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: 'stamped-cover-doc-323b',
            name: 'Stamped_Cover_Doc',
            mimeType: 'application/vnd.google-apps.document',
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        nock('https://docs.googleapis.com')
          .get('/v1/documents/stamped-cover-doc-323b')
          .query({
            includeTabsContent: 'true',
            suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
          })
          .reply(
            200,
            buildFullCoverSheetDoc({
              documentId: 'stamped-cover-doc-323b',
              submittalNo: '081100-012-A',
              checkedIndex: 0,
              dateCellElements: [
                {
                  dateElement: {
                    dateElementProperties: {
                      timestamp: '2026-11-22T02:00:00Z',
                      timeZoneId: 'America/New_York',
                    },
                  },
                },
              ],
            })
          );

        const mixedPairRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: {
              selectedItems: [
                { id: 'flat-drawing-323', title: '071200-001_Flat_Drawing.pdf' },
                { id: 'stamped-cover-doc-323b', title: 'Stamped_Cover_Doc' },
              ],
            },
          },
        });
        expect(mixedPairRes.statusCode).toBe(200);
        const mixedPairCard = JSON.parse(mixedPairRes.payload).action.navigations[0].pushCard;
        expect(readText(mixedPairCard, 'section', 'submittal-arch')).toBe('081100');
        expect(readText(mixedPairCard, 'number', 'submittal-arch')).toBe('012');
        expect(readText(mixedPairCard, 'revision', 'submittal-arch')).toBe('A');
        expect(readSelected(mixedPairCard, 'action', 'submittal-arch')).toBe('NET');
        expect(readText(mixedPairCard, 'date', 'submittal-arch')).toBe('261121');
        expect(nock.isDone()).toBe(true);
      });
    });
  });

  describe('Isolated Google Docs suite (manifest overrides)', () => {
    let app: AppInstance;
    let manifestProvider: AppManifestProvider;

    beforeEach(async () => {
      ({ app, manifestProvider } = await createDriveIntegrationContext());
    });

    describe('Ticket #322: Google Docs Submittal Response checkbox table pre-population, 0-checked REC preservation, cross-tab ambiguity & warning suppression', () => {
      const RESPONSE_LABELS = [
        'NO EXCEPTIONS TAKEN',
        'NO OBJECTIONS AS CORRECTED',
        'REVISE AND RESUBMIT',
        'REJECTED',
        'NOT REVIEWED',
      ] as const;

      function buildSubmittalTab(options: {
        submittalNo?: string;
        checkedIndices?: number[];
        omitDisplayValue?: boolean;
        date?: string;
      }) {
        const checked = new Set(options.checkedIndices ?? []);
        const cell = (text: string, style?: { columnSpan?: number; rowSpan?: number }) => ({
          content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }],
          ...(style ? { tableCellStyle: style } : {}),
        });

        return {
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
                          cell('Submittal No.\n'),
                          cell(`${options.submittalNo ?? ''}\n`),
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
                        const isChecked = checked.has(idx);
                        const col2Cell =
                          idx === 0
                            ? cell('NET/NOC\n', { rowSpan: 2 })
                            : idx === 1
                              ? cell('\n')
                              : idx === 2
                                ? cell('RR/REJ\n', { rowSpan: 2 })
                                : cell('\n');
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
                                            displayValue: options.omitDisplayValue
                                              ? null
                                              : isChecked
                                                ? '☑'
                                                : '☐',
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              ],
                            },
                            cell(`${label}\n`, { columnSpan: 1, rowSpan: 1 }),
                            col2Cell,
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
                ...(options.date !== undefined
                  ? [
                      {
                        table: {
                          rows: 2,
                          columns: 2,
                          tableRows: [
                            {
                              tableCells: [cell('\n'), cell(`${options.date}\n`)],
                            },
                            {
                              tableCells: [cell('Reviewed By\n'), cell('Date\n')],
                            },
                          ],
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        };
      }

      function mockDriveAndDocsForSubmittal(options: {
        docId: string;
        fileName: string;
        folderName: '6 Construction' | '3 FFE';
        tabs: Array<ReturnType<typeof buildSubmittalTab>>;
        mockDocs?: boolean;
        mockLog?: boolean;
      }) {
        if (options.mockLog !== false) {
          mockDocumentLogSearch();
        }
        nock('https://www.googleapis.com')
          .get('/drive/v3/drives')
          .query(true)
          .reply(200, {
            drives: [{ id: 'projects-shared-drive-001', name: 'Projects Shared Drive 001' }],
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/folder-${options.docId}`)
          .query(true)
          .reply(200, {
            id: `folder-${options.docId}`,
            name: options.folderName,
            parents: ['projects-shared-drive-001'],
            driveId: 'projects-shared-drive-001',
            mimeType: 'application/vnd.google-apps.folder',
          });
        nock('https://www.googleapis.com')
          .get(`/drive/v3/files/${options.docId}`)
          .query((q) => q.alt !== 'media')
          .reply(200, {
            id: options.docId,
            name: options.fileName,
            mimeType: 'application/vnd.google-apps.document',
            parents: [`folder-${options.docId}`],
            driveId: 'projects-shared-drive-001',
            modifiedTime: '2026-11-18T15:00:00Z',
          });
        if (options.mockDocs !== false) {
          nock('https://docs.googleapis.com', {
            reqheaders: { authorization: 'Bearer ya29.valid-oauth-token' },
          })
            .get(`/v1/documents/${options.docId}`)
            .query({
              includeTabsContent: 'true',
              suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
            })
            .reply(200, {
              documentId: options.docId,
              body: null,
              tabs: options.tabs,
            });
        }
      }

      const readSelectedValue = (
        card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
        fieldKey: string,
        docTypeKey: string
      ) => {
        const docSec = card.sections.find((s) => s.header === 'Document Data');
        const widget = docSec?.widgets.find(
          (w) =>
            (w.selectionInput as { name?: string } | undefined)?.name ===
            getDocumentInfoWidgetName(fieldKey, docTypeKey)
        ) as { selectionInput?: { items: Array<{ value: string; selected?: boolean }> } } | undefined;
        return widget?.selectionInput?.items.find((i) => i.selected)?.value;
      };

      const readTextValue = (
        card: { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> },
        fieldKey: string,
        docTypeKey: string
      ) => {
        const docSec = card.sections.find((s) => s.header === 'Document Data');
        const widget = docSec?.widgets.find(
          (w) =>
            (w.textInput as { name?: string } | undefined)?.name ===
            getDocumentInfoWidgetName(fieldKey, docTypeKey)
        ) as { textInput?: { value?: string } } | undefined;
        return widget?.textInput?.value;
      };

      const readStatusText = (
        card: { sections: Array<{ widgets?: Array<{ textParagraph?: { text?: string } }> }> }
      ) =>
        card.sections
          .flatMap((s) => s.widgets ?? [])
          .map((w) => w.textParagraph?.text ?? '')
          .join('\n');

      it('pre-populates all 5 Submittal Response actions (NET, NOC, RR via valueMap, REJ, NR) across Submittal Arch and Submittal FF&E and preserves action: REC when 0-checked', async () => {
        const actionCases = [
          { checkedIndices: [], expectedAction: 'REC' },
          { checkedIndices: [0], expectedAction: 'NET' },
          { checkedIndices: [1], expectedAction: 'NOC' },
          { checkedIndices: [2], expectedAction: 'RR' },
          { checkedIndices: [3], expectedAction: 'REJ' },
          { checkedIndices: [4], expectedAction: 'NR' },
        ];

        for (const [idx, tc] of actionCases.entries()) {
          // Submittal Arch
          const archId = `gdoc-322-arch-${idx}`;
          mockDriveAndDocsForSubmittal({
            docId: archId,
            fileName: '071200-001_Waterproofing',
            folderName: '6 Construction',
            tabs: [
              buildSubmittalTab({
                submittalNo: '071200-001-1',
                checkedIndices: tc.checkedIndices,
                omitDisplayValue: idx % 2 === 1,
              }),
            ],
          });

          const archRes = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: archId, title: '071200-001_Waterproofing' }] },
            },
          });
          expect(archRes.statusCode).toBe(200);
          const archCard = JSON.parse(archRes.payload).action.navigations[0].pushCard;
          expect(readSelectedValue(archCard, 'action', 'submittal-arch'), archId).toBe(tc.expectedAction);
          expect(readTextValue(archCard, 'section', 'submittal-arch'), archId).toBe('071200');
          expect(readTextValue(archCard, 'number', 'submittal-arch'), archId).toBe('001');
          expect(readTextValue(archCard, 'revision', 'submittal-arch'), archId).toBe('1');
          expect(readStatusText(archCard)).not.toContain(
            formatAmbiguousFormFieldMessage('Submittal Response')
          );

          // Submittal FF&E
          const ffeId = `gdoc-322-ffe-${idx}`;
          mockDriveAndDocsForSubmittal({
            docId: ffeId,
            fileName: 'Berman_Falk',
            folderName: '3 FFE',
            tabs: [
              buildSubmittalTab({
                submittalNo: 'CG104-A',
                checkedIndices: tc.checkedIndices,
                omitDisplayValue: idx % 2 === 0,
              }),
            ],
          });

          const ffeRes = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: ffeId, title: 'Berman_Falk' }] },
            },
          });
          expect(ffeRes.statusCode).toBe(200);
          const ffeCard = JSON.parse(ffeRes.payload).action.navigations[0].pushCard;
          expect(readSelectedValue(ffeCard, 'action', 'submittal-ffe'), ffeId).toBe(tc.expectedAction);
          expect(readTextValue(ffeCard, 'specTag', 'submittal-ffe'), ffeId).toBe('CG104');
          const ffeDocSec = (ffeCard as { sections: Array<{ header?: string; widgets: Array<Record<string, unknown>> }> }).sections.find(
            (s) => s.header === 'Document Data'
          );
          expect(
            ffeDocSec?.widgets.find(
              (w) => (w.decoratedText as { topLabel?: string } | undefined)?.topLabel === 'Spec Title'
            )?.decoratedText,
            ffeId
          ).toEqual({ topLabel: 'Spec Title', text: 'BED - KING', wrapText: true });
          expect(
            ffeDocSec?.widgets.find(
              (w) =>
                (w.textInput as { name?: string } | undefined)?.name ===
                getDocumentInfoWidgetName('specTitle', 'submittal-ffe')
            ),
            ffeId
          ).toBeUndefined();
          expect(readTextValue(ffeCard, 'revision', 'submittal-ffe'), ffeId).toBe('A');
          expect(readStatusText(ffeCard)).not.toContain(
            formatAmbiguousFormFieldMessage('Submittal Response')
          );
        }

        expect(nock.isDone()).toBe(true);
      });

      it('renders formatAmbiguousFormFieldMessage for 2+ checked rows and cross-tab conflicts while still pre-populating Submittal No and Date', async () => {
        const ambiguousCases = [
          {
            id: 'gdoc-322-multi',
            tabs: [
              buildSubmittalTab({
                submittalNo: '071200-001-2',
                checkedIndices: [0, 3],
                date: '2026-11-21',
              }),
            ],
          },
          {
            id: 'gdoc-322-conflict-tabs',
            tabs: [
              buildSubmittalTab({
                submittalNo: '071200-001-2',
                checkedIndices: [0],
                date: '2026-11-21',
              }),
              buildSubmittalTab({ checkedIndices: [3] }),
            ],
          },
          {
            id: 'gdoc-322-one-then-multi',
            tabs: [
              buildSubmittalTab({
                submittalNo: '071200-001-2',
                checkedIndices: [0],
                date: '2026-11-21',
              }),
              buildSubmittalTab({ checkedIndices: [1, 2] }),
            ],
          },
          {
            id: 'gdoc-322-multi-then-one',
            tabs: [
              buildSubmittalTab({
                submittalNo: '071200-001-2',
                checkedIndices: [1, 2],
                date: '2026-11-21',
              }),
              buildSubmittalTab({ checkedIndices: [0] }),
            ],
          },
        ];

        for (const tc of ambiguousCases) {
          mockDriveAndDocsForSubmittal({
            docId: tc.id,
            fileName: 'Waterproofing_Stamped',
            folderName: '6 Construction',
            tabs: tc.tabs,
          });

          const res = await app.server.inject({
            method: 'POST',
            url: '/workspace/drive-items-selected',
            headers: { authorization: 'Bearer valid-jwt-token' },
            payload: {
              authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
              drive: { selectedItems: [{ id: tc.id, title: 'Waterproofing_Stamped' }] },
            },
          });
          expect(res.statusCode).toBe(200);
          const card = JSON.parse(res.payload).action.navigations[0].pushCard;
          expect(readStatusText(card), tc.id).toContain(
            formatAmbiguousFormFieldMessage('Submittal Response')
          );
          expect(readSelectedValue(card, 'action', 'submittal-arch'), tc.id).toBe('REC');
          expect(readTextValue(card, 'section', 'submittal-arch'), tc.id).toBe('071200');
          expect(readTextValue(card, 'number', 'submittal-arch'), tc.id).toBe('001');
          expect(readTextValue(card, 'revision', 'submittal-arch'), tc.id).toBe('2');
          expect(readTextValue(card, 'date', 'submittal-arch'), tc.id).toBe('261121');
        }

        expect(nock.isDone()).toBe(true);
      });

      it('suppresses Submittal Response ambiguity warning when existingData.action is already populated (manual edit or round-trip revisit) while surfacing on initial load and fresh cross-type switch', async () => {
        mockAllowedDocumentTypes(manifestProvider, 'projects', [
          'communication-project',
          'submittal-arch',
          'submittal-ffe',
        ]);

        const docId = 'gdoc-322-switch-ambig';
        const ambigTabs = [
          buildSubmittalTab({ submittalNo: '071200-001-1', checkedIndices: [0, 3] }),
        ];

        // 1. Initial load -> warning surfaces
        mockDriveAndDocsForSubmittal({
          docId,
          fileName: '071200-001_Waterproofing',
          folderName: '6 Construction',
          tabs: ambigTabs,
        });

        const initialRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/drive-items-selected',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
          },
        });
        expect(initialRes.statusCode).toBe(200);
        const initialCard = JSON.parse(initialRes.payload).action.navigations[0].pushCard;
        expect(readStatusText(initialCard)).toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );

        // 2. Round-trip revisit (Submittal Arch -> Communication - Project -> Submittal Arch) where submittal-arch action='REC' is in formInputs -> suppressed
        mockDriveAndDocsForSubmittal({
          docId,
          fileName: '071200-001_Waterproofing',
          folderName: '6 Construction',
          tabs: ambigTabs,
          mockDocs: false,
          mockLog: false,
        });
        const toCommRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
            commonEventObject: {
              parameters: { action: 'onDocumentTypeChange' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: {
                  stringInputs: { value: ['Projects Shared Drive 001'] },
                },
                [getDocumentTypeWidgetName('projects')]: {
                  stringInputs: { value: ['communication-project'] },
                },
                SelectFiles: { stringInputs: { value: [docId] } },
                [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                  stringInputs: { value: ['REC'] },
                },
              },
            },
          },
        });
        expect(toCommRes.statusCode).toBe(200);
        const toCommCard = JSON.parse(toCommRes.payload).action.navigations[0].updateCard;
        expect(readStatusText(toCommCard)).not.toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );

        mockDriveAndDocsForSubmittal({
          docId,
          fileName: '071200-001_Waterproofing',
          folderName: '6 Construction',
          tabs: ambigTabs,
        });

        const revisitRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
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
                SelectFiles: { stringInputs: { value: [docId] } },
                [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                  stringInputs: { value: ['REC'] },
                },
              },
            },
          },
        });
        expect(revisitRes.statusCode).toBe(200);
        const revisitCard = JSON.parse(revisitRes.payload).action.navigations[0].updateCard;
        expect(readStatusText(revisitCard)).not.toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );

        // 3. Manual edit (user chose action='NET' on submittal-arch) -> suppressed and preserves 'NET'
        mockDriveAndDocsForSubmittal({
          docId,
          fileName: '071200-001_Waterproofing',
          folderName: '6 Construction',
          tabs: ambigTabs,
        });

        const manualEditRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: docId, title: '071200-001_Waterproofing' }] },
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
                SelectFiles: { stringInputs: { value: [docId] } },
                [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                  stringInputs: { value: ['NET'] },
                },
              },
            },
          },
        });
        expect(manualEditRes.statusCode).toBe(200);
        const manualEditCard = JSON.parse(manualEditRes.payload).action.navigations[0].updateCard;
        expect(readStatusText(manualEditCard)).not.toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );
        expect(readSelectedValue(manualEditCard, 'action', 'submittal-arch')).toBe('NET');

        // 4. Fresh cross-type switch (Submittal Arch -> Submittal FF&E, where submittal-ffe has no existingData.action) -> warning surfaces!
        mockDriveAndDocsForSubmittal({
          docId,
          fileName: 'Berman_Falk',
          folderName: '6 Construction',
          tabs: [buildSubmittalTab({ submittalNo: 'CG104-A', checkedIndices: [0, 3] })],
        });

        const crossSwitchRes = await app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            authorizationEventObject: { userOAuthToken: 'ya29.valid-oauth-token' },
            drive: { selectedItems: [{ id: docId, title: 'Berman_Falk' }] },
            commonEventObject: {
              parameters: { action: 'onDocumentTypeChange' },
              formInputs: {
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: {
                  stringInputs: { value: ['Projects Shared Drive 001'] },
                },
                [getDocumentTypeWidgetName('projects')]: {
                  stringInputs: { value: ['submittal-ffe'] },
                },
                SelectFiles: { stringInputs: { value: [docId] } },
                // Previous submittal-arch inputs present, none for submittal-ffe
                [getDocumentInfoWidgetName('action', 'submittal-arch')]: {
                  stringInputs: { value: ['REC'] },
                },
              },
            },
          },
        });
        expect(crossSwitchRes.statusCode).toBe(200);
        const crossSwitchCard = JSON.parse(crossSwitchRes.payload).action.navigations[0].updateCard;
        expect(readStatusText(crossSwitchCard)).toContain(
          formatAmbiguousFormFieldMessage('Submittal Response')
        );
        expect(readTextValue(crossSwitchCard, 'specTag', 'submittal-ffe')).toBe('CG104');
        expect(readSelectedValue(crossSwitchCard, 'action', 'submittal-ffe')).toBe('REC');

        expect(nock.isDone()).toBe(true);
      });
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { UiViewModel } from '../domain';
import type { DocumentTypeDisplayNameResolverPort, UiViewAdapterContext } from '../ports';
import { HandlebarsAdapter } from '../../../infrastructure/template-engine/handlebars-adapter';
import {
  DocumentSuccessCardAdapter,
  DOCUMENT_SUCCESS_CARD_VIEW_ID,
} from './document-success-card.adapter';

function assertValidUiView(view: unknown): void {
  const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
  TypeSystemPolicy.ExactOptionalPropertyTypes = true;
  try {
    expect(Value.Check(UiViewModel, view)).toBe(true);
  } finally {
    TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
  }
}

describe('DocumentSuccessCardAdapter (#382)', () => {
  it('declares granular adapter options to avoid remote OptionsFetcher and UiContextQuery calls', () => {
    const adapter = new DocumentSuccessCardAdapter();
    expect(adapter.viewId).toBe(DOCUMENT_SUCCESS_CARD_VIEW_ID);
    expect(adapter.viewId).toBe('document-success-card');
    expect(adapter.requiresDocumentSchema).toBe(false);
    expect(adapter.requiresUiSchema).toBe('optional');
    expect(adapter.contextKeys).toEqual([]);
  });

  it('renders <DocumentType> Filed header, subtitle, Filed via <workflowName>, deduplicated Created & Filed, and Start Over', async () => {
    const displayNameResolver: DocumentTypeDisplayNameResolverPort = {
      getDisplayName: vi.fn().mockResolvedValue('Submittal Arch'),
    };
    const adapter = new DocumentSuccessCardAdapter(displayNameResolver);

    const ctx: UiViewAdapterContext = {
      viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
      documentTypeKey: 'submittal-arch',
      executionOutcome: {
        success: true,
        workflowName: 'SubmittalReceived',
        completedStepCount: 3,
        spaceName: 'Harborview Tower',
        documentData: { title: 'Waterproofing' },
        stepResults: [
          {
            stepId: 'moveOriginal',
            activityType: 'MOVE_FILE',
            files: [
              {
                id: 'file-1',
                name: '071200-001-0.pdf',
                parentId: 'folder-closed',
                parentName: '07 Thermal & Moisture',
                uri: 'https://drive.google.com/file/d/file-1/view',
              },
            ],
          },
          {
            stepId: 'duplicateForReview',
            activityType: 'DUPLICATE_FILE',
            files: [
              {
                id: 'file-2',
                name: '_071200-001-0.pdf',
                parentId: 'folder-submittals',
                parentName: 'Submittals',
                uri: 'https://drive.google.com/file/d/file-2/view',
              },
            ],
          },
          {
            stepId: 'insertCoverSheet',
            activityType: 'INSERT_PAGES',
            files: [
              {
                // Same ID modified in-place: deduplicates cleanly
                id: 'file-2',
                name: '_071200-001-0.pdf',
                parentId: 'folder-submittals',
                parentName: 'Submittals',
                uri: 'https://drive.google.com/file/d/file-2/view',
              },
            ],
          },
          {
            stepId: 'writeLog',
            activityType: 'WRITE_LOG',
            files: [
              {
                id: 'sheet-should-be-excluded',
                name: 'Harborview Document Log',
                uri: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
              },
            ],
          },
        ],
        notices: [],
        errors: [],
      },
    };

    const view = await adapter.composeView(ctx);
    assertValidUiView(view);

    expect(view.id).toBe('document-success-card');
    expect(view.header).toEqual({
      title: 'Submittal Arch Filed',
      subtitle: 'Harborview Tower',
    });

    // Workflow banner
    expect(view.sections[0].widgets[0].textParagraph?.text).toBe('Filed via <b>SubmittalReceived</b>');

    // Created & Filed (deduplicated by FileLocator.id and excluding WRITE_LOG)
    const filesSection = view.sections.find((s) => s.header === 'Created & Filed');
    expect(filesSection).toBeDefined();
    expect(filesSection?.widgets).toHaveLength(2);
    expect(filesSection?.widgets[0].decoratedText).toEqual({
      text: '071200-001-0.pdf',
      wrapText: true,
      bottomLabel: '07 Thermal & Moisture',
      button: {
        text: 'Open',
        onClick: {
          openLink: {
            url: 'https://drive.google.com/file/d/file-1/view',
            openAs: 'FULL_SIZE',
          },
        },
      },
    });
    expect(filesSection?.widgets[1].decoratedText?.text).toBe('_071200-001-0.pdf');

    // Start Over button at bottom
    const lastSection = view.sections[view.sections.length - 1];
    expect(lastSection.widgets[0].buttonList?.buttons).toEqual([
      {
        text: 'Start Over',
        onClick: {
          action: 'startOver',
        },
      },
    ]);
  });

  it('omits blank subtitle, falls back blank workflowName to "Filed.", omits Open button on blank uri, and HTML-escapes dynamic strings', async () => {
    const adapter = new DocumentSuccessCardAdapter();

    const view = await adapter.composeView({
      viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
      documentTypeKey: 'custom-doc',
      executionOutcome: {
        success: true,
        workflowName: '   ',
        completedStepCount: 1,
        spaceName: '   ',
        documentData: {},
        stepResults: [
          {
            activityType: 'MOVE_FILE',
            files: [
              {
                id: 'f-no-uri',
                name: 'Spec <A & B>.pdf',
                parentName: 'Folder <1>',
                uri: '   ',
              },
            ],
          },
        ],
        notices: ['Warning: <script>alert(1)</script> & fallback'],
        errors: [],
      },
    });

    assertValidUiView(view);
    expect(view.header).toEqual({ title: 'custom-doc Filed (with Warnings)' });
    expect('subtitle' in (view.header ?? {})).toBe(false);

    expect(view.sections[0].widgets[0].textParagraph?.text).toBe('Filed.');
    expect(view.sections[0].widgets[1].textParagraph?.text).toContain(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; fallback'
    );

    const filesSection = view.sections.find((s) => s.header === 'Created & Filed');
    expect(filesSection?.widgets[0].decoratedText).toEqual({
      text: 'Spec &lt;A &amp; B&gt;.pdf',
      wrapText: true,
      bottomLabel: 'Folder <1>',
    });
    expect('button' in (filesSection?.widgets[0].decoratedText ?? {})).toBe(false);
  });

  it('omits Created & Filed section when zero non-log files were produced', async () => {
    const adapter = new DocumentSuccessCardAdapter();

    const view = await adapter.composeView({
      viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
      executionOutcome: {
        success: true,
        completedStepCount: 0,
        spaceName: 'Project 1',
        documentData: {},
        stepResults: [],
        notices: [],
        errors: [],
      },
    });

    assertValidUiView(view);
    expect(view.header).toEqual({ title: 'Document Filed', subtitle: 'Project 1' });
    expect(view.sections.find((s) => s.header === 'Created & Filed')).toBeUndefined();
    expect(view.sections).toHaveLength(2); // Banner + Start Over
  });

  describe('fallback Summary row and Open Log button (#383)', () => {
    it('renders Summary section with HTML-escaped <b>sheetName</b> • Row N and trailing Open Log (FULL_SIZE) button before Created & Filed', async () => {
      const adapter = new DocumentSuccessCardAdapter();

      const view = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalSent',
          completedStepCount: 2,
          spaceName: 'Harborview Tower',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveOriginal',
              activityType: 'MOVE_FILE',
              files: [
                {
                  id: 'file-1',
                  name: 'Submittal.pdf',
                  uri: 'https://drive.google.com/file/d/file-1/view',
                },
              ],
            },
            {
              stepId: 'writeLog',
              activityType: 'WRITE_LOG',
              files: [
                {
                  id: 'sheet-ignored',
                  name: 'Ignored Log File',
                  uri: 'https://docs.google.com/spreadsheets/d/log-1/edit',
                },
              ],
            },
          ],
          notices: [],
          logWrite: {
            sheetName: 'Submittal <Arch & FF&E>',
            sheetId: 0,
            rowNumber: 12,
            action: 'inserted',
            uri: 'https://docs.google.com/spreadsheets/d/log-1/edit#gid=0&range=12:12',
          },
          errors: [],
        },
      });

      assertValidUiView(view);
      expect(view.sections.map((s) => s.header)).toEqual([
        undefined,
        'Summary',
        'Created & Filed',
        undefined,
      ]);

      const summarySection = view.sections[1];
      expect(summarySection.widgets).toEqual([
        {
          decoratedText: {
            text: '<b>Submittal &lt;Arch &amp; FF&amp;E&gt;</b> • Row 12',
            wrapText: true,
            button: {
              text: 'Open Log',
              onClick: {
                openLink: {
                  url: 'https://docs.google.com/spreadsheets/d/log-1/edit#gid=0&range=12:12',
                  openAs: 'FULL_SIZE',
                },
              },
            },
          },
        },
      ]);

      const filesSection = view.sections[2];
      expect(filesSection.widgets).toHaveLength(1);
      expect(filesSection.widgets[0].decoratedText?.text).toBe('Submittal.pdf');
    });

    it('renders "Document Log Entry" when sheet metadata is absent and omits Open Log button on blank or missing uri', async () => {
      const adapter = new DocumentSuccessCardAdapter();

      const missingMetaWithUriView = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          completedStepCount: 1,
          spaceName: 'Project 1',
          documentData: {},
          stepResults: [],
          notices: [],
          logWrite: {
            sheetName: '   ',
            uri: 'https://docs.google.com/spreadsheets/d/log-fallback/edit',
          },
          errors: [],
        },
      });

      assertValidUiView(missingMetaWithUriView);
      const summaryWithUri = missingMetaWithUriView.sections.find((s) => s.header === 'Summary');
      expect(summaryWithUri?.widgets).toEqual([
        {
          decoratedText: {
            text: 'Document Log Entry',
            wrapText: true,
            button: {
              text: 'Open Log',
              onClick: {
                openLink: {
                  url: 'https://docs.google.com/spreadsheets/d/log-fallback/edit',
                  openAs: 'FULL_SIZE',
                },
              },
            },
          },
        },
      ]);

      const blankUriView = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          completedStepCount: 1,
          spaceName: 'Project 1',
          documentData: {},
          stepResults: [],
          notices: [],
          logWrite: {
            sheetName: 'Submittal Arch',
            rowNumber: 6,
            uri: '   ',
          },
          errors: [],
        },
      });

      assertValidUiView(blankUriView);
      const summaryWithoutUri = blankUriView.sections.find((s) => s.header === 'Summary');
      expect(summaryWithoutUri?.widgets).toEqual([
        {
          decoratedText: {
            text: '<b>Submittal Arch</b> • Row 6',
            wrapText: true,
          },
        },
      ]);
      expect('button' in (summaryWithoutUri?.widgets[0].decoratedText ?? {})).toBe(false);
    });
  });

  describe('Folders section, placeholder exclusion, and moved user folders (#384)', () => {
    it('renders Folders directly below Summary and above Created & Filed deduplicated strictly by parentId and omits Open button when parentUri is blank', async () => {
      const adapter = new DocumentSuccessCardAdapter();

      const view = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalReceived',
          completedStepCount: 4,
          spaceName: 'Harborview Tower',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveOriginal',
              activityType: 'MOVE_FILE',
              files: [
                {
                  id: 'orig-1',
                  name: '071200-001-0.pdf',
                  parentId: 'folder-closed',
                  parentName: '07 Thermal & Moisture',
                  parentUri: 'https://drive.google.com/drive/folders/folder-closed',
                  uri: 'https://drive.google.com/file/d/orig-1/view',
                },
              ],
            },
            {
              stepId: 'duplicateForReview',
              activityType: 'DUPLICATE_FILE',
              files: [
                {
                  id: 'dup-1',
                  name: '_071200-001-0.pdf',
                  parentId: 'folder-submittals',
                  parentName: 'Submittals <Review>',
                  parentUri: '   ',
                  uri: 'https://drive.google.com/file/d/dup-1/view',
                },
              ],
            },
            {
              stepId: 'insertCoverSheet',
              activityType: 'INSERT_PAGES',
              files: [
                {
                  id: 'sibling-1',
                  name: '_071200-001-0 Transmittal.pdf',
                  parentId: 'folder-submittals',
                  parentName: 'Submittals <Review>',
                  parentUri: '',
                  uri: 'https://drive.google.com/file/d/sibling-1/view',
                },
              ],
            },
            {
              stepId: 'writeLog',
              activityType: 'WRITE_LOG',
              files: [
                {
                  id: 'log-1',
                  name: 'Document Log',
                  parentId: 'folder-admin-should-not-appear',
                  parentName: '1 Admin',
                  parentUri: 'https://drive.google.com/drive/folders/folder-admin-should-not-appear',
                },
              ],
            },
          ],
          notices: [],
          logWrite: {
            sheetName: 'Submittal Arch',
            sheetId: 0,
            rowNumber: 5,
            action: 'inserted',
            uri: 'https://docs.google.com/spreadsheets/d/log-1/edit#gid=0&range=5:5',
          },
          errors: [],
        },
      });

      assertValidUiView(view);

      const headers = view.sections.map((s) => s.header);
      const summaryIdx = headers.indexOf('Summary');
      const foldersIdx = headers.indexOf('Folders');
      const filesIdx = headers.indexOf('Created & Filed');
      expect(summaryIdx).toBe(1);
      expect(foldersIdx).toBe(2); // Directly below Summary
      expect(filesIdx).toBe(3); // Directly above Created & Filed

      const foldersSection = view.sections[foldersIdx];
      expect(foldersSection?.widgets).toHaveLength(2);
      expect(foldersSection?.widgets[0]?.decoratedText).toEqual({
        text: '07 Thermal &amp; Moisture',
        wrapText: true,
        button: {
          text: 'Open',
          onClick: {
            openLink: {
              url: 'https://drive.google.com/drive/folders/folder-closed',
              openAs: 'FULL_SIZE',
            },
          },
        },
      });
      // Blank parentUri omits Open button and deduplicates folder-submittals across duplicate + sibling
      expect(foldersSection?.widgets[1]?.decoratedText).toEqual({
        text: 'Submittals &lt;Review&gt;',
        wrapText: true,
      });
      expect('button' in (foldersSection?.widgets[1]?.decoratedText ?? {})).toBe(false);
    });

    it('excludes folder-only placeholder (id === parentId) from Created & Filed while rendering it in Folders', async () => {
      const adapter = new DocumentSuccessCardAdapter();

      const view = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'communication-project',
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 1,
          spaceName: 'Harborview Tower',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveFiles',
              activityType: 'MOVE_FILE',
              files: [
                {
                  id: 'comm-folder-99',
                  name: '261126 OT - No Attachments',
                  parentId: 'comm-folder-99',
                  parentName: '261126 OT - No Attachments',
                  parentUri: 'https://drive.google.com/drive/folders/comm-folder-99',
                  mimeType: 'application/vnd.google-apps.folder',
                  uri: 'https://drive.google.com/drive/folders/comm-folder-99',
                },
              ],
            },
          ],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(view);
      const foldersSection = view.sections.find((s) => s.header === 'Folders');
      expect(foldersSection?.widgets).toHaveLength(1);
      expect(foldersSection?.widgets[0]?.decoratedText).toEqual({
        text: '261126 OT - No Attachments',
        wrapText: true,
        button: {
          text: 'Open',
          onClick: {
            openLink: {
              url: 'https://drive.google.com/drive/folders/comm-folder-99',
              openAs: 'FULL_SIZE',
            },
          },
        },
      });
      expect(view.sections.find((s) => s.header === 'Created & Filed')).toBeUndefined();
    });

    it('keeps moved user Drive folders (id !== parentId) in Created & Filed with parentName bottomLabel while also surfacing destination folder in Folders', async () => {
      const adapter = new DocumentSuccessCardAdapter();

      const view = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'communication-project',
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 1,
          spaceName: 'Harborview Tower',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveFiles',
              activityType: 'MOVE_FILE',
              files: [
                {
                  id: 'user-folder-1',
                  name: 'Vendor Package',
                  parentId: 'comm-dest-folder-1',
                  parentName: '261126 IN - Vendor Package',
                  parentUri: 'https://drive.google.com/drive/folders/comm-dest-folder-1',
                  mimeType: 'application/vnd.google-apps.folder',
                  uri: 'https://drive.google.com/drive/folders/user-folder-1',
                },
              ],
            },
          ],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(view);
      const foldersSection = view.sections.find((s) => s.header === 'Folders');
      expect(foldersSection?.widgets).toHaveLength(1);
      expect(foldersSection?.widgets[0]?.decoratedText?.text).toBe('261126 IN - Vendor Package');

      const filesSection = view.sections.find((s) => s.header === 'Created & Filed');
      expect(filesSection?.widgets).toHaveLength(1);
      expect(filesSection?.widgets[0]?.decoratedText).toEqual({
        text: 'Vendor Package',
        wrapText: true,
        bottomLabel: '261126 IN - Vendor Package',
        button: {
          text: 'Open',
          onClick: {
            openLink: {
              url: 'https://drive.google.com/drive/folders/user-folder-1',
              openAs: 'FULL_SIZE',
            },
          },
        },
      });
    });
  });

  describe('declarative successView summary & artifacts (#385)', () => {
    const parser = new HandlebarsAdapter();

    it('evaluates summary via TemplateParserPort, attaches Open Log when logWrite.uri is present, HTML-escapes values while preserving <b> tags, maps objects to "", normalizes newlines, and falls back blank text to "—"', async () => {
      const displayNameResolver: DocumentTypeDisplayNameResolverPort = {
        getDisplayName: vi.fn().mockResolvedValue('Submittal Arch'),
      };
      const adapter = new DocumentSuccessCardAdapter(displayNameResolver, parser);

      const view = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        uiSchema: {
          successView: {
            summary: {
              topLabel: '{{section}}-{{number}}-{{revision}} • {{status.key}}',
              text: '<b>{{action.name}}</b> • {{date}} ({{contact.key}})',
              bottomLabel: '{{title}}',
            },
          },
        },
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalReceived',
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: {
            section: '071200',
            number: '001',
            revision: '0',
            status: { key: 'Open' },
            action: { name: 'Approved <As Noted> & Filed' },
            date: '260920',
            contact: { key: { nestedObj: true } },
            title: 'Line 1\r\nLine 2\n<Raw Title & Co>',
          },
          stepResults: [],
          notices: [],
          logWrite: {
            sheetName: 'Submittal Arch',
            sheetId: 0,
            rowNumber: 5,
            action: 'inserted',
            uri: 'https://docs.google.com/spreadsheets/d/log-1/edit#gid=0&range=5:5',
          },
          errors: [],
        },
      });

      assertValidUiView(view);
      const summarySection = view.sections.find((s) => s.header === 'Summary');
      expect(summarySection).toBeDefined();
      expect(summarySection?.widgets).toHaveLength(1);
      expect(summarySection?.widgets[0].decoratedText).toEqual({
        topLabel: '071200-001-0 • Open',
        text: '<b>Approved &lt;As Noted&gt; &amp; Filed</b> • 260920 ()',
        wrapText: true,
        bottomLabel: 'Line 1 Line 2 <Raw Title & Co>',
        button: {
          text: 'Open Log',
          onClick: {
            openLink: {
              url: 'https://docs.google.com/spreadsheets/d/log-1/edit#gid=0&range=5:5',
              openAs: 'FULL_SIZE',
            },
          },
        },
      });

      // Blank summary.text (even inside <b></b>) falls back to '—' and blank topLabel/bottomLabel are omitted
      const blankView = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        uiSchema: {
          successView: {
            summary: {
              topLabel: '{{missingField}}',
              text: '<b>{{title}}</b>',
              bottomLabel: '   ',
            },
          },
        },
        executionOutcome: {
          success: true,
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: { title: { invalidObject: 1 } },
          stepResults: [],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(blankView);
      const blankSummary = blankView.sections.find((s) => s.header === 'Summary');
      expect(blankSummary?.widgets[0].decoratedText).toEqual({
        text: '—',
        wrapText: true,
      });
    });

    it('orders Created & Filed primary-actionable first, applies workflow-aware labels, suppresses duplicate in-place Review Copy, and uses fallbackLabel on step notices', async () => {
      const adapter = new DocumentSuccessCardAdapter(undefined, parser);
      const submittalArtifacts = [
        {
          stepId: 'insertCoverSheet',
          label: 'Review Copy (with Cover Sheet)',
          fallbackLabel: 'Transmittal Cover Sheet',
        },
        {
          stepId: 'duplicateForReview',
          label: 'Review Copy',
        },
        {
          stepId: 'moveOriginal',
          label: 'Filed Original',
          whenWorkflow: {
            SubmittalReceived: 'Archived Original',
            SubmittalSent: 'Filed Submittal',
          },
        },
      ];

      // Case 1: In-place cover sheet grafting (same id for duplicateForReview & insertCoverSheet)
      const inPlaceView = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        uiSchema: { successView: { artifacts: submittalArtifacts } },
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalReceived',
          completedStepCount: 3,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveOriginal',
              activityType: 'MOVE_FILE',
              files: [{ id: 'orig-1', name: 'Orig.pdf', uri: 'https://drive.google.com/file/d/orig-1/view' }],
            },
            {
              stepId: 'duplicateForReview',
              activityType: 'DUPLICATE_FILE',
              files: [{ id: 'rev-1', name: '_Review.pdf', uri: 'https://drive.google.com/file/d/rev-1/view' }],
            },
            {
              stepId: 'insertCoverSheet',
              activityType: 'INSERT_PAGES',
              files: [{ id: 'rev-1', name: '_Review.pdf', uri: 'https://drive.google.com/file/d/rev-1/view' }],
            },
            {
              stepId: 'unconfiguredStep',
              activityType: 'CUSTOM_STEP',
              files: [{ id: 'extra-1', name: 'Extra.pdf' }],
            },
          ],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(inPlaceView);
      const inPlaceFiles = inPlaceView.sections.find((s) => s.header === 'Created & Filed');
      expect(inPlaceFiles?.widgets.map((w) => [w.decoratedText?.topLabel, w.decoratedText?.text])).toEqual([
        ['Review Copy (with Cover Sheet)', '_Review.pdf'],
        ['Archived Original', 'Orig.pdf'],
        [undefined, 'Extra.pdf'],
      ]);

      // Case 2: createSiblingPdf fallback (insertCoverSheet emits notices & distinct sibling ID)
      const siblingView = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        uiSchema: { successView: { artifacts: submittalArtifacts } },
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalReceived',
          completedStepCount: 3,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveOriginal',
              activityType: 'MOVE_FILE',
              files: [{ id: 'orig-1', name: 'Orig.pdf' }],
            },
            {
              stepId: 'duplicateForReview',
              activityType: 'DUPLICATE_FILE',
              files: [{ id: 'rev-1', name: '_Review.pdf' }],
            },
            {
              stepId: 'insertCoverSheet',
              activityType: 'INSERT_PAGES',
              files: [{ id: 'sib-1', name: '_Review Transmittal.pdf' }],
              notices: ['Encrypted PDF; created sibling cover sheet.'],
            },
          ],
          notices: ['Encrypted PDF; created sibling cover sheet.'],
          errors: [],
        },
      });

      assertValidUiView(siblingView);
      const siblingFiles = siblingView.sections.find((s) => s.header === 'Created & Filed');
      expect(siblingFiles?.widgets.map((w) => [w.decoratedText?.topLabel, w.decoratedText?.text])).toEqual([
        ['Transmittal Cover Sheet', '_Review Transmittal.pdf'],
        ['Review Copy', '_Review.pdf'],
        ['Archived Original', 'Orig.pdf'],
      ]);

      // Case 3: SubmittalSent workflow uses whenWorkflow['SubmittalSent']
      const sentView = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        uiSchema: { successView: { artifacts: submittalArtifacts } },
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalSent',
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveOriginal',
              activityType: 'MOVE_FILE',
              files: [{ id: 'orig-1', name: 'Sent.pdf' }],
            },
          ],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(sentView);
      const sentFiles = sentView.sections.find((s) => s.header === 'Created & Filed');
      expect(sentFiles?.widgets.map((w) => [w.decoratedText?.topLabel, w.decoratedText?.text])).toEqual([
        ['Filed Submittal', 'Sent.pdf'],
      ]);
    });
  });

  describe('status-aware headers and partial-failure + warnings banners (#386)', () => {
    it('renders "<DocumentType> Filed (with Warnings)" header and amber Warnings banner when notices are present', async () => {
      const displayNameResolver: DocumentTypeDisplayNameResolverPort = {
        getDisplayName: vi.fn().mockResolvedValue('Submittal Arch'),
      };
      const adapter = new DocumentSuccessCardAdapter(displayNameResolver);

      const view = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-arch',
        executionOutcome: {
          success: true,
          workflowName: 'SubmittalReceived',
          completedStepCount: 3,
          spaceName: 'Harborview Tower',
          documentData: {},
          stepResults: [],
          notices: ['Fallback <sibling> & notice'],
          errors: [],
        },
      });

      assertValidUiView(view);
      expect(view.header).toEqual({
        title: 'Submittal Arch Filed (with Warnings)',
        subtitle: 'Harborview Tower',
      });
      expect(view.sections[0]?.widgets).toEqual([
        {
          textParagraph: {
            text: 'Filed via <b>SubmittalReceived</b>',
          },
        },
        {
          textParagraph: {
            text: '<font color="#b06000"><b>Warnings:</b></font> Fallback &lt;sibling&gt; &amp; notice',
          },
        },
      ]);
    });

    it('renders "<DocumentType> — Partial Failure" header, red partial-failure banner with HTML-escaped failedStepId/errors/completedStepCount, and combined amber Warnings banner', async () => {
      const displayNameResolver: DocumentTypeDisplayNameResolverPort = {
        getDisplayName: vi.fn().mockResolvedValue('Submittal FF&E'),
      };
      const adapter = new DocumentSuccessCardAdapter(displayNameResolver);

      const combinedView = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'submittal-ffe',
        executionOutcome: {
          success: false,
          workflowName: 'SubmittalReceived',
          completedStepCount: 2,
          failedStepId: 'insertCover<Sheet>&1',
          spaceName: 'Harborview Tower',
          documentData: {},
          stepResults: [
            {
              stepId: 'moveOriginal',
              activityType: 'MOVE_FILE',
              files: [
                {
                  id: 'orig-1',
                  name: 'Submittal.pdf',
                  parentId: 'folder-1',
                  parentName: 'Closed',
                  parentUri: 'https://drive.google.com/drive/folders/folder-1',
                  uri: 'https://drive.google.com/file/d/orig-1/view',
                },
              ],
            },
          ],
          notices: ['Warning <one> & two'],
          errors: ['PDF graft <failed> & aborted'],
        },
      });

      assertValidUiView(combinedView);
      expect(combinedView.header).toEqual({
        title: 'Submittal FF&E \u2014 Partial Failure',
        subtitle: 'Harborview Tower',
      });
      expect(combinedView.sections[0]?.widgets).toHaveLength(2);
      const failureText = combinedView.sections[0]?.widgets[0]?.textParagraph?.text ?? '';
      expect(failureText).toContain('<font color="#c5221f">');
      expect(failureText).toContain('insertCover&lt;Sheet&gt;&amp;1');
      expect(failureText).toContain('PDF graft &lt;failed&gt; &amp; aborted');
      expect(failureText).toContain('2');
      expect(failureText).not.toContain('<Sheet>');
      expect(failureText).not.toContain('<failed>');

      const warningsText = combinedView.sections[0]?.widgets[1]?.textParagraph?.text ?? '';
      expect(warningsText).toBe(
        '<font color="#b06000"><b>Warnings:</b></font> Warning &lt;one&gt; &amp; two'
      );

      // Step 1 batch partial failure with completedStepCount: 0 and missing failedStepId/errors
      const fallbackAdapter = new DocumentSuccessCardAdapter();
      const step1FallbackView = await fallbackAdapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        documentTypeKey: 'communication-project',
        executionOutcome: {
          success: false,
          completedStepCount: 0,
          spaceName: '',
          documentData: {},
          stepResults: [],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(step1FallbackView);
      expect(step1FallbackView.header).toEqual({
        title: 'communication-project \u2014 Partial Failure',
      });
      expect(step1FallbackView.sections[0]?.widgets).toHaveLength(1);
      const fallbackBanner = step1FallbackView.sections[0]?.widgets[0]?.textParagraph?.text ?? '';
      expect(fallbackBanner).toContain('<font color="#c5221f">');
      expect(fallbackBanner).toContain('0');
    });
  });

  describe('collapsible Created & Filed and dynamic 100-widget budget (#386)', () => {
    function makeFiles(count: number, options?: { distinctFolders?: boolean; folderUri?: string | undefined }) {
      return Array.from({ length: count }, (_, idx) => {
        const n = idx + 1;
        const folderId = options?.distinctFolders ? `folder-${n}` : 'folder-main';
        const folderName = options?.distinctFolders ? `Folder ${n}` : 'Communications';
        return {
          id: `file-${n}`,
          name: `Doc_${n}.pdf`,
          parentId: folderId,
          parentName: folderName,
          ...(options && 'folderUri' in options
            ? options.folderUri !== undefined
              ? { parentUri: options.folderUri }
              : {}
            : { parentUri: `https://drive.google.com/drive/folders/${folderId}` }),
          uri: `https://drive.google.com/file/d/file-${n}/view`,
        };
      });
    }

    function countTotalWidgets(view: { sections: Array<{ widgets: unknown[] }> }): number {
      return view.sections.reduce((sum, s) => sum + s.widgets.length, 0);
    }

    it('enables collapsible: true and uncollapsibleWidgetsCount: 5 strictly when more than 5 items exist, and omits hard 20-row cap up to budget', async () => {
      const adapter = new DocumentSuccessCardAdapter();

      // Exactly 5 items: NOT collapsible
      const view5 = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [{ activityType: 'MOVE_FILE', files: makeFiles(5) }],
          notices: [],
          errors: [],
        },
      });
      assertValidUiView(view5);
      const files5 = view5.sections.find((s) => s.header === 'Created & Filed');
      expect(files5?.widgets).toHaveLength(5);
      expect('collapsible' in (files5 ?? {})).toBe(false);
      expect('uncollapsibleWidgetsCount' in (files5 ?? {})).toBe(false);

      // 6 items: collapsible with uncollapsibleWidgetsCount: 5
      const view6 = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [{ activityType: 'MOVE_FILE', files: makeFiles(6) }],
          notices: [],
          errors: [],
        },
      });
      assertValidUiView(view6);
      const files6 = view6.sections.find((s) => s.header === 'Created & Filed');
      expect(files6?.widgets).toHaveLength(6);
      expect(files6?.collapsible).toBe(true);
      expect(files6?.uncollapsibleWidgetsCount).toBe(5);

      // 50 items: no hard 20-row cap, all 50 rendered with no overflow notice
      const view50 = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [{ activityType: 'MOVE_FILE', files: makeFiles(50) }],
          notices: [],
          errors: [],
        },
      });
      assertValidUiView(view50);
      const files50 = view50.sections.find((s) => s.header === 'Created & Filed');
      expect(files50?.widgets).toHaveLength(50);
      expect(files50?.collapsible).toBe(true);
      expect(files50?.uncollapsibleWidgetsCount).toBe(5);
      expect(countTotalWidgets(view50)).toBe(53); // 1 banner + 1 folder + 50 files + 1 Start Over
    });

    it('caps total widgets strictly <= 100 with dynamic budgeting and permanently visible overflow notice outside collapsed tail (with and without Open Folder button)', async () => {
      const adapter = new DocumentSuccessCardAdapter();

      // 120 files + 1 folder (with uri) + 2 banners (status + warnings) + Summary + Start Over
      // fixedWidgets = 2 (banners) + 1 (summary) + 1 (Start Over) = 4
      // remaining = 96 -> reserve 1 overflow notice -> itemBudget = 95 -> 1 folder + 94 files = 95 -> total = 100
      const overflowWithUri = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 2,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [{ activityType: 'MOVE_FILE', files: makeFiles(120) }],
          notices: ['Large batch warning'],
          logWrite: {
            sheetName: 'Comm Log',
            rowNumber: 9,
            uri: 'https://docs.google.com/spreadsheets/d/log-1/edit#gid=0&range=9:9',
          },
          errors: [],
        },
      });

      assertValidUiView(overflowWithUri);
      expect(countTotalWidgets(overflowWithUri)).toBe(100);

      const filesSection = overflowWithUri.sections.find((s) => s.header === 'Created & Filed');
      expect(filesSection?.widgets).toHaveLength(94);
      expect(filesSection?.collapsible).toBe(true);
      expect(filesSection?.uncollapsibleWidgetsCount).toBe(5);

      const filesSectionIdx = overflowWithUri.sections.indexOf(filesSection!);
      const overflowSection = overflowWithUri.sections[filesSectionIdx + 1];
      expect(overflowSection).toBeDefined();
      expect('collapsible' in (overflowSection ?? {})).toBe(false);
      expect(overflowSection?.widgets).toHaveLength(1);
      expect(overflowSection?.widgets[0]?.decoratedText).toEqual({
        text: 'Showing 94 of 120 filed items',
        wrapText: true,
        button: {
          text: 'Open Folder',
          onClick: {
            openLink: {
              url: 'https://drive.google.com/drive/folders/folder-main',
              openAs: 'FULL_SIZE',
            },
          },
        },
      });

      // Overflow without folders[0]?.uri omits Open Folder button
      const overflowNoFolderUri = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [
            { activityType: 'MOVE_FILE', files: makeFiles(120, { folderUri: '   ' }) },
          ],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(overflowNoFolderUri);
      expect(countTotalWidgets(overflowNoFolderUri)).toBe(100);
      const noUriFilesIdx = overflowNoFolderUri.sections.findIndex(
        (s) => s.header === 'Created & Filed'
      );
      const noUriOverflow = overflowNoFolderUri.sections[noUriFilesIdx + 1]?.widgets[0]?.decoratedText;
      expect(noUriOverflow?.text).toContain('120');
      expect('button' in (noUriOverflow ?? {})).toBe(false);

      // Combined overflow across many distinct folders (80) and many files (80)
      const combinedOverflow = await adapter.composeView({
        viewId: DOCUMENT_SUCCESS_CARD_VIEW_ID,
        executionOutcome: {
          success: true,
          workflowName: 'FileCommProject',
          completedStepCount: 1,
          spaceName: 'Harborview',
          documentData: {},
          stepResults: [
            { activityType: 'MOVE_FILE', files: makeFiles(80, { distinctFolders: true }) },
          ],
          notices: [],
          errors: [],
        },
      });

      assertValidUiView(combinedOverflow);
      expect(countTotalWidgets(combinedOverflow)).toBe(100);
      const combinedFolders = combinedOverflow.sections.find((s) => s.header === 'Folders');
      const combinedFiles = combinedOverflow.sections.find((s) => s.header === 'Created & Filed');
      expect((combinedFolders?.widgets.length ?? 0)).toBeGreaterThan(0);
      expect((combinedFiles?.widgets.length ?? 0)).toBeGreaterThan(0);
      expect(combinedFiles?.collapsible).toBe(true);
      expect(combinedFiles?.uncollapsibleWidgetsCount).toBe(5);
    });
  });
});

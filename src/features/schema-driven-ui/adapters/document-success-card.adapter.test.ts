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
    expect(view.header).toEqual({ title: 'custom-doc Filed' });
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
});

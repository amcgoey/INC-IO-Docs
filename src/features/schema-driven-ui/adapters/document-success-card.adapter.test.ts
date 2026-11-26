import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import { UiViewModel } from '../domain';
import type { DocumentTypeDisplayNameResolverPort, UiViewAdapterContext } from '../ports';
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
});

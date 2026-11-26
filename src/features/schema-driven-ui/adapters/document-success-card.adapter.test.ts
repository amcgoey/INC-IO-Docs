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
});

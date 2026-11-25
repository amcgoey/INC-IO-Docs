import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewColorSchema, UiViewSectionSchema } from '../domain';
import type { DocumentLogPanelContext, DocumentLogPanelEntry } from '../ports';
import { PRIMARY_ACTION_BUTTON_COLOR, escapeCardHtml } from './common';
import { buildDocumentLogSection } from './document-log';

describe('escapeCardHtml', () => {
  it('escapes &, <, >, ", and \' while preserving =', () => {
    const raw = 'A & B "Tower" <1> = \'Main\'';
    expect(escapeCardHtml(raw)).toBe('A &amp; B &quot;Tower&quot; &lt;1&gt; = &#39;Main&#39;');
    expect(escapeCardHtml('a=b')).toBe('a=b');
    expect(escapeCardHtml('a=b')).not.toContain('&#x3D;');
    expect(escapeCardHtml('')).toBe('');
  });
});

describe('Document Log Block', () => {
  it('exports a valid PRIMARY_ACTION_BUTTON_COLOR', () => {
    expect(Value.Check(UiViewColorSchema, PRIMARY_ACTION_BUTTON_COLOR)).toBe(true);
  });

  it('returns undefined when context is undefined or maxWidgets <= 0', () => {
    expect(buildDocumentLogSection(undefined)).toBeUndefined();

    const resolvedContext: DocumentLogPanelContext = {
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      activeCandidate: {
        name: 'Harborview Hotel Document Log',
        url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
      },
    };

    expect(buildDocumentLogSection(resolvedContext, { maxWidgets: 0 })).toBeUndefined();
    expect(buildDocumentLogSection(resolvedContext, { maxWidgets: -1 })).toBeUndefined();
  });

  it('renders guidance textParagraph for status: missing_space', () => {
    const context: DocumentLogPanelContext = {
      status: 'missing_space',
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section?.header).toBe('Document Log');
    expect(section?.widgets.length).toBeGreaterThanOrEqual(1);
    const paragraph = section?.widgets.find((w) => w.textParagraph !== undefined)?.textParagraph;
    expect(paragraph).toBeDefined();
    expect(paragraph?.text.trim().length).toBeGreaterThan(0);
  });

  it('renders HTML-escaped decoratedText and unescaped plain labels for 2-widget status: missing', () => {
    const trickySpace = 'A & B "Tower" <1> = \'Main\'';
    const trickyFolder = '1 Admin & Ops <Root> = \'Log\'';
    const trickyFile = 'Log "2026" & <Draft> = \'v1\'';

    const context: DocumentLogPanelContext = {
      status: 'missing',
      spaceName: trickySpace,
      targetFolderPath: trickyFolder,
      targetFileName: trickyFile,
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section?.header).toBe('Document Log');
    expect(section?.widgets).toHaveLength(2);
    expect(section?.widgets.some((w) => w.textParagraph !== undefined)).toBe(false);

    const decorated = section?.widgets[0].decoratedText;
    expect(decorated).toBeDefined();
    expect(decorated?.topLabel).toBe(`No Document Log in ${trickySpace}`);
    expect(decorated?.topLabel).not.toContain('&amp;');
    expect(decorated?.topLabel).not.toContain('&#x3D;');

    expect(decorated?.text).toBe(
      `Create <b>${escapeCardHtml(trickyFile)}</b> in <b>${escapeCardHtml(trickySpace)}</b>`
    );
    expect(decorated?.text).not.toContain(trickyFile);
    expect(decorated?.text).not.toContain(trickySpace);

    expect(decorated?.bottomLabel).toBe(`Folder: ${trickyFolder}`);
    expect(decorated?.bottomLabel).not.toContain('&amp;');
    expect(decorated?.bottomLabel).not.toContain('&#x3D;');

    const fallbackSection = buildDocumentLogSection({ status: 'missing' });
    expect(fallbackSection).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, fallbackSection)).toBe(true);
    expect(fallbackSection?.widgets).toHaveLength(2);
    const fallbackDecorated = fallbackSection?.widgets[0].decoratedText;
    expect(fallbackDecorated).toBeDefined();
    expect(fallbackDecorated?.topLabel).toBe('No Document Log found');
    expect(fallbackDecorated?.text).toBe('Create <b>Document Log</b>');
    expect('bottomLabel' in fallbackDecorated!).toBe(false);
  });

  it('renders primary-blue Copy Log buttonList for status: missing and forwards actionParameters only when non-empty', () => {
    const context: DocumentLogPanelContext = {
      status: 'missing',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      targetFileName: 'Harborview Hotel Document Log',
    };

    const defaultSection = buildDocumentLogSection(context);
    expect(defaultSection).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, defaultSection)).toBe(true);
    expect(defaultSection?.widgets).toHaveLength(2);
    expect(defaultSection?.widgets[0].decoratedText).toBeDefined();
    expect(defaultSection?.widgets[1]).toEqual({
      buttonList: {
        buttons: [
          {
            text: 'Copy Log',
            color: PRIMARY_ACTION_BUTTON_COLOR,
            onClick: {
              action: 'copyDocumentLog',
            },
          },
        ],
      },
    });
    expect('parameters' in (defaultSection?.widgets[1].buttonList?.buttons[0].onClick ?? {})).toBe(
      false
    );

    const emptyParamsSection = buildDocumentLogSection(context, { actionParameters: {} });
    expect(emptyParamsSection).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, emptyParamsSection)).toBe(true);
    expect(emptyParamsSection?.widgets).toHaveLength(2);
    expect(emptyParamsSection?.widgets[0].decoratedText).toBeDefined();
    expect(emptyParamsSection?.widgets[1]).toEqual({
      buttonList: {
        buttons: [
          {
            text: 'Copy Log',
            color: PRIMARY_ACTION_BUTTON_COLOR,
            onClick: {
              action: 'copyDocumentLog',
            },
          },
        ],
      },
    });
    expect(
      'parameters' in (emptyParamsSection?.widgets[1].buttonList?.buttons[0].onClick ?? {})
    ).toBe(false);

    const actionParameters = {
      previousAttachments: '["att-1"]',
      previousDriveUrl: 'https://drive.google.com/file/d/123/view',
    };
    const withParamsSection = buildDocumentLogSection(context, { actionParameters });
    expect(withParamsSection).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, withParamsSection)).toBe(true);
    expect(withParamsSection?.widgets).toHaveLength(2);
    expect(withParamsSection?.widgets[0].decoratedText).toBeDefined();
    expect(withParamsSection?.widgets[1]).toEqual({
      buttonList: {
        buttons: [
          {
            text: 'Copy Log',
            color: PRIMARY_ACTION_BUTTON_COLOR,
            onClick: {
              action: 'copyDocumentLog',
              parameters: actionParameters,
            },
          },
        ],
      },
    });
  });

  it('renders non-blocking HTML-escaped textParagraph for status: discovery_error', () => {
    const rawError = 'Drive API <500> & "Quota" = \'Exceeded\'';
    const context: DocumentLogPanelContext = {
      status: 'discovery_error',
      discoveryErrorMessage: rawError,
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section?.header).toBe('Document Log');

    const paragraph = section?.widgets.find((w) => w.textParagraph !== undefined)?.textParagraph;
    expect(paragraph).toBeDefined();
    expect(paragraph?.text).toContain(escapeCardHtml(rawError));
    expect(paragraph?.text).not.toContain('<500>');

    const fallbackSection = buildDocumentLogSection({ status: 'discovery_error' });
    expect(fallbackSection).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, fallbackSection)).toBe(true);
    const fallbackParagraph = fallbackSection?.widgets.find(
      (w) => w.textParagraph !== undefined
    )?.textParagraph;
    expect(fallbackParagraph?.text).toContain('Unable to check for a Document Log right now.');
    expect(fallbackParagraph?.text).not.toContain('Google Drive');
  });

  it('renders single active-log decoratedText bar with Open Log link for status: resolved', () => {
    const activeName = 'A & B "Log" <2026> = \'Active\'';
    const spaceName = 'Space & Co <1> = \'Main\'';
    const folderPath = '1 Admin & Logs <Dir> = \'Sub\'';
    const activeUrl = 'https://docs.google.com/spreadsheets/d/log-1/edit';

    const context: DocumentLogPanelContext = {
      status: 'resolved',
      spaceName,
      targetFolderPath: folderPath,
      activeCandidate: {
        name: activeName,
        url: activeUrl,
      },
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section?.header).toBe('Document Log');
    expect(section?.widgets).toHaveLength(1);

    const decorated = section?.widgets[0].decoratedText;
    expect(decorated).toBeDefined();
    expect(decorated?.text).toContain(escapeCardHtml(activeName));
    expect(decorated?.text).not.toContain(activeName);
    expect(decorated?.topLabel).toContain(spaceName);
    expect(decorated?.topLabel).not.toContain('&amp;');
    expect(decorated?.bottomLabel).toBeUndefined();
    expect('bottomLabel' in decorated!).toBe(false);
    expect(decorated?.button).toEqual({
      text: 'Open Log',
      onClick: {
        openLink: {
          url: activeUrl,
          openAs: 'FULL_SIZE',
        },
      },
    });

    const emptyEntriesSection = buildDocumentLogSection({
      ...context,
      readStatus: 'ready',
      idGroup: '071200-001',
      entries: [],
    });
    expect(emptyEntriesSection).toBeDefined();
    const emptyEntriesDecorated = emptyEntriesSection?.widgets[0].decoratedText;
    expect(emptyEntriesDecorated?.bottomLabel).toBe('No prior entries for 071200-001');
    expect(emptyEntriesDecorated?.bottomLabel).not.toContain('Folder:');
  });

  it('renders SelectDocumentLog DROPDOWN followed by only 1 active-log decoratedText bar with Open Log for status: ambiguous and honors maxWidgets clamp', () => {
    const activeName = 'Log & <1> = \'B\'';
    const spaceName = 'Harbor & <Bay> Hotel';
    const activeUrl = 'https://docs.google.com/spreadsheets/d/log-b/edit';
    const candidateOptions = [
      { text: 'Log A (1 Admin · 2026-10-19)', value: 'log-a', selected: false },
      { text: 'Log B (6 Construction · 2026-10-12)', value: 'log-b', selected: true },
      { text: 'Log C (2026-10-01)', value: 'log-c', selected: false },
    ];

    const context: DocumentLogPanelContext = {
      status: 'ambiguous',
      spaceName,
      targetFolderPath: '1 Admin',
      candidateOptions,
      activeCandidate: {
        name: activeName,
        url: activeUrl,
      },
    };

    const actionParams = {
      previousSpaceId: 'space-harbor',
      previousSelectedLogId: 'log-b',
    };
    const section = buildDocumentLogSection(context, {
      actionParameters: actionParams,
    });

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section?.header).toBe('Document Log');
    expect(section?.widgets).toHaveLength(2);

    // Widget 0: SelectDocumentLog dropdown
    expect(section?.widgets[0].selectionInput).toEqual({
      name: 'SelectDocumentLog',
      label: 'Document Log (3 found)',
      type: 'DROPDOWN',
      items: candidateOptions,
      onChangeAction: {
        action: 'onFormChange',
        parameters: actionParams,
      },
    });

    // Widget 1: ONLY 1 active-log decoratedText bar with Open Log
    const decoratedWidgets = section?.widgets.filter((w) => w.decoratedText !== undefined) ?? [];
    expect(decoratedWidgets).toHaveLength(1);
    const decorated = section?.widgets[1].decoratedText;
    expect(decorated).toBeDefined();
    expect(decorated?.topLabel).toBe(`Active Document Log · ${spaceName}`);
    expect(decorated?.topLabel).not.toContain('&amp;');
    expect(decorated?.text).toContain(escapeCardHtml(activeName));
    expect(decorated?.text).not.toContain(activeName);
    expect(decorated?.wrapText).toBe(true);
    expect(decorated?.button).toEqual({
      text: 'Open Log',
      onClick: {
        openLink: {
          url: activeUrl,
          openAs: 'FULL_SIZE',
        },
      },
    });

    // Omits parameters on onChangeAction when onChangeActionParameters is omitted or empty
    const sectionNoParams = buildDocumentLogSection(context);
    expect(sectionNoParams?.widgets[0].selectionInput?.onChangeAction).toEqual({
      action: 'onFormChange',
    });
    const sectionEmptyParams = buildDocumentLogSection(context, {
      actionParameters: {},
    });
    expect(sectionEmptyParams?.widgets[0].selectionInput?.onChangeAction).toEqual({
      action: 'onFormChange',
    });

    // Honors maxWidgets clamp
    const clamped = buildDocumentLogSection(context, { maxWidgets: 1 });
    expect(clamped).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, clamped)).toBe(true);
    expect(clamped?.widgets).toHaveLength(1);
  });

  const makeHistoryEntries = (count: number): DocumentLogPanelEntry[] =>
    Array.from({ length: count }, (_, idx) => ({
      topLabel: `Submission ${count - idx}`,
      text: `<b>Revise &amp; Resubmit</b> 2602${String(idx + 1).padStart(2, '0')} (ARC)`,
      bottomLabel: `Row ${idx + 1}`,
      fileUri: `https://drive.google.com/file/d/entry-${idx + 1}/view`,
      valid: true,
    }));

  it('renders HTML-escaped missing field guidance for readStatus: idle_incomplete_id and omits collapsible properties', () => {
    const context: DocumentLogPanelContext = {
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      activeCandidate: {
        name: 'Harborview Hotel Document Log',
        url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
      },
      readStatus: 'idle_incomplete_id',
      missingIdFields: ['Section & <1>', 'Number'],
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect('collapsible' in section!).toBe(false);
    expect('uncollapsibleWidgetsCount' in section!).toBe(false);
    expect(section?.widgets).toHaveLength(2);

    const guidance = section?.widgets[1].textParagraph;
    expect(guidance).toBeDefined();
    expect(guidance?.text).toContain(escapeCardHtml('Section & <1>'));
    expect(guidance?.text).toContain('Number');
    expect(guidance?.text).not.toContain('Section & <1>');
  });

  it('renders non-blocking HTML-escaped error and idGroup for readStatus: read_error and omits collapsible properties', () => {
    const rawError = 'Sheet <Read> & "Timeout" = \'504\'';
    const rawIdGroup = '071200 & <001>';
    const context: DocumentLogPanelContext = {
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      activeCandidate: {
        name: 'Harborview Hotel Document Log',
        url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
      },
      readStatus: 'read_error',
      idGroup: rawIdGroup,
      readErrorMessage: rawError,
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect('collapsible' in section!).toBe(false);
    expect('uncollapsibleWidgetsCount' in section!).toBe(false);
    expect(section?.widgets).toHaveLength(2);

    const paragraph = section?.widgets[1].textParagraph;
    expect(paragraph).toBeDefined();
    expect(paragraph?.text).toContain(escapeCardHtml(rawError));
    expect(paragraph?.text).not.toContain('<Read>');
    expect(paragraph?.text).toContain(escapeCardHtml(rawIdGroup));
    expect(paragraph?.text).not.toContain(rawIdGroup);
  });

  it('renders empty-history guidance with HTML-escaped idGroup for readStatus: ready with entries: [] and omits collapsible properties', () => {
    const rawIdGroup = '071200 & <001>';
    const context: DocumentLogPanelContext = {
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      activeCandidate: {
        name: 'Harborview Hotel Document Log',
        url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
      },
      readStatus: 'ready',
      idGroup: rawIdGroup,
      entries: [],
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect('collapsible' in section!).toBe(false);
    expect('uncollapsibleWidgetsCount' in section!).toBe(false);
    expect(section?.widgets).toHaveLength(2);

    const paragraph = section?.widgets[1].textParagraph;
    expect(paragraph).toBeDefined();
    expect(paragraph?.text).toContain(escapeCardHtml(rawIdGroup));
    expect(paragraph?.text).not.toContain(rawIdGroup);
  });

  it('renders newest-first history rows for resolved + readStatus: ready preserving pre-escaped text, plain labels, optional Open link, and collapsible: true / uncollapsibleWidgetsCount: 1', () => {
    const firstFileUri = 'https://drive.google.com/file/d/sub-2/view';
    const context: DocumentLogPanelContext = {
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      activeCandidate: {
        name: 'Harborview Hotel Document Log',
        url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
      },
      readStatus: 'ready',
      idGroup: '071200-001',
      entries: [
        {
          topLabel: 'Rev 2 · A & B <C>',
          text: '<b>Revise &amp; Resubmit</b> 260212 (ARC)',
          bottomLabel: 'Note: "Check" = \'OK\'',
          fileUri: firstFileUri,
          valid: true,
        },
        {
          text: '<b>Approved</b> 260110 (ENG)',
          valid: true,
        },
      ],
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section?.collapsible).toBe(true);
    expect(section?.uncollapsibleWidgetsCount).toBe(1);
    expect(section?.widgets).toHaveLength(3);

    const row0 = section?.widgets[1].decoratedText;
    expect(row0).toEqual({
      topLabel: 'Rev 2 · A & B <C>',
      text: '<b>Revise &amp; Resubmit</b> 260212 (ARC)',
      wrapText: true,
      bottomLabel: 'Note: "Check" = \'OK\'',
      button: {
        text: 'Open',
        onClick: {
          openLink: {
            url: firstFileUri,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });

    const row1 = section?.widgets[2].decoratedText;
    expect(row1).toEqual({
      text: '<b>Approved</b> 260110 (ENG)',
      wrapText: true,
    });
    expect('topLabel' in row1!).toBe(false);
    expect('bottomLabel' in row1!).toBe(false);
    expect('button' in row1!).toBe(false);
  });

  it('renders partial_hydration warning banner and adjusts collapsible/uncollapsibleWidgetsCount for resolved and ambiguous', () => {
    const rawWarning = 'Row 3 & <4> "bad" = \'skip\'';
    const escapedWarning = escapeCardHtml(rawWarning);
    expect(escapedWarning).not.toContain('&#x3D;');

    const candidateOptions = [
      { text: 'Log A (1 Admin)', value: 'log-a', selected: true },
      { text: 'Log B (6 Construction)', value: 'log-b', selected: false },
    ];
    const activeCandidate = {
      name: 'Log A',
      url: 'https://docs.google.com/spreadsheets/d/log-a/edit',
    };
    const oneEntry = makeHistoryEntries(1);

    // 1. resolved + partial_hydration + >= 1 entries -> uncollapsibleWidgetsCount: 2 (active bar + warning banner)
    const resolvedPartial = buildDocumentLogSection({
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      activeCandidate,
      readStatus: 'partial_hydration',
      idGroup: '071200-001',
      warningMessages: [rawWarning],
      entries: oneEntry,
    });
    expect(resolvedPartial).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, resolvedPartial)).toBe(true);
    expect(resolvedPartial?.collapsible).toBe(true);
    expect(resolvedPartial?.uncollapsibleWidgetsCount).toBe(2);
    expect(resolvedPartial?.widgets).toHaveLength(3);
    expect(resolvedPartial?.widgets[1].textParagraph?.text).toContain(escapedWarning);
    expect(resolvedPartial?.widgets[1].textParagraph?.text).not.toContain(rawWarning);
    expect(resolvedPartial?.widgets[1].textParagraph?.text).not.toContain('&#x3D;');

    // 2. ambiguous + partial_hydration + >= 1 entries -> uncollapsibleWidgetsCount: 3 (SelectDocumentLog + active bar + warning banner)
    const ambiguousPartial = buildDocumentLogSection({
      status: 'ambiguous',
      spaceName: 'Harborview Hotel',
      candidateOptions,
      activeCandidate,
      readStatus: 'partial_hydration',
      idGroup: '071200-001',
      warningMessages: [rawWarning],
      entries: oneEntry,
    });
    expect(ambiguousPartial).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, ambiguousPartial)).toBe(true);
    expect(ambiguousPartial?.collapsible).toBe(true);
    expect(ambiguousPartial?.uncollapsibleWidgetsCount).toBe(3);
    expect(ambiguousPartial?.widgets).toHaveLength(4);
    expect(ambiguousPartial?.widgets[2].textParagraph?.text).toContain(escapedWarning);
    expect(ambiguousPartial?.widgets[2].textParagraph?.text).not.toContain('&#x3D;');

    // 3. ambiguous + ready + >= 1 entries (no warning) -> uncollapsibleWidgetsCount: 2
    const ambiguousReady = buildDocumentLogSection({
      status: 'ambiguous',
      spaceName: 'Harborview Hotel',
      candidateOptions,
      activeCandidate,
      readStatus: 'ready',
      idGroup: '071200-001',
      entries: oneEntry,
    });
    expect(ambiguousReady).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, ambiguousReady)).toBe(true);
    expect(ambiguousReady?.collapsible).toBe(true);
    expect(ambiguousReady?.uncollapsibleWidgetsCount).toBe(2);
    expect(ambiguousReady?.widgets).toHaveLength(3);

    // 4. partial_hydration + entries: [] -> omits collapsible and uncollapsibleWidgetsCount
    const partialEmpty = buildDocumentLogSection({
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      activeCandidate,
      readStatus: 'partial_hydration',
      idGroup: '071200-001',
      warningMessages: [rawWarning],
      entries: [],
    });
    expect(partialEmpty).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, partialEmpty)).toBe(true);
    expect('collapsible' in partialEmpty!).toBe(false);
    expect('uncollapsibleWidgetsCount' in partialEmpty!).toBe(false);
    expect(partialEmpty?.widgets.some((w) => w.textParagraph?.text.includes(escapedWarning))).toBe(
      true
    );
  });

  it('enforces hard 100-widget cap guard and overflow-first math boundaries in buildDocumentLogSection', () => {
    const activeUrl = 'https://docs.google.com/spreadsheets/d/log-1/edit';
    const baseContext: Omit<DocumentLogPanelContext, 'entries'> = {
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      activeCandidate: {
        name: 'Harborview Hotel Document Log',
        url: activeUrl,
      },
      readStatus: 'ready',
      idGroup: '071200-001',
    };

    // Case 1: maxWidgets = 21, 20 entries -> 20 history rows, NO overflow notice, widgets.length === 21
    const exactFit = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(20) },
      { maxWidgets: 21 }
    );
    expect(exactFit).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, exactFit)).toBe(true);
    expect(exactFit?.widgets).toHaveLength(21);
    expect(exactFit?.collapsible).toBe(true);
    expect(exactFit?.uncollapsibleWidgetsCount).toBe(1);
    expect(
      exactFit?.widgets.some((w) => w.decoratedText?.text.startsWith('Showing '))
    ).toBe(false);

    // Case 2: maxWidgets = 21, 21 entries -> 19 history rows + 1 overflow notice ('Showing 19 of 21 entries'), widgets.length === 21
    const overflowAt21 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(21) },
      { maxWidgets: 21 }
    );
    expect(overflowAt21).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, overflowAt21)).toBe(true);
    expect(overflowAt21?.widgets).toHaveLength(21);
    expect(overflowAt21?.collapsible).toBe(true);
    expect(overflowAt21?.uncollapsibleWidgetsCount).toBe(1);
    expect(overflowAt21?.widgets[20].decoratedText).toEqual({
      text: 'Showing 19 of 21 entries',
      wrapText: true,
      button: {
        text: 'Open Log',
        onClick: {
          openLink: {
            url: activeUrl,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });

    // Case 3: maxWidgets = 30, 25 entries -> enforces 20-row history cap + 1 overflow notice ('Showing 20 of 25 entries'), widgets.length === 22
    const cappedAt20 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(25) },
      { maxWidgets: 30 }
    );
    expect(cappedAt20).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, cappedAt20)).toBe(true);
    expect(cappedAt20?.widgets).toHaveLength(22);
    expect(cappedAt20?.collapsible).toBe(true);
    expect(cappedAt20?.uncollapsibleWidgetsCount).toBe(1);
    expect(cappedAt20?.widgets[21].decoratedText?.text).toBe('Showing 20 of 25 entries');

    // Case 4: maxWidgets = 2, 5 entries -> 0 history rows + 1 overflow notice ('Showing 0 of 5 entries'), widgets.length === 2, omits collapsible/uncollapsibleWidgetsCount
    const budgetOne = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(5) },
      { maxWidgets: 2 }
    );
    expect(budgetOne).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, budgetOne)).toBe(true);
    expect(budgetOne?.widgets).toHaveLength(2);
    expect(budgetOne?.widgets[1].decoratedText).toEqual({
      text: 'Showing 0 of 5 entries',
      wrapText: true,
      button: {
        text: 'Open Log',
        onClick: {
          openLink: {
            url: activeUrl,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });
    expect('collapsible' in budgetOne!).toBe(false);
    expect('uncollapsibleWidgetsCount' in budgetOne!).toBe(false);

    // Case 5: maxWidgets = 1, 5 entries -> 0 history rows and NO overflow notice (no negative .slice), widgets.length === 1, omits collapsible/uncollapsibleWidgetsCount
    const budgetZero = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(5) },
      { maxWidgets: 1 }
    );
    expect(budgetZero).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, budgetZero)).toBe(true);
    expect(budgetZero?.widgets).toHaveLength(1);
    expect(
      budgetZero?.widgets.some((w) => w.decoratedText?.text.startsWith('Showing '))
    ).toBe(false);
    expect('collapsible' in budgetZero!).toBe(false);
    expect('uncollapsibleWidgetsCount' in budgetZero!).toBe(false);

    // Case 6: fractional and NaN maxWidgets are normalized safely via floor (never emitting fractional counts)
    const fractionalBudget = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(5) },
      { maxWidgets: 2.5 }
    );
    expect(fractionalBudget).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, fractionalBudget)).toBe(true);
    expect(fractionalBudget?.widgets).toHaveLength(2);
    expect(fractionalBudget?.widgets[1].decoratedText?.text).toBe('Showing 0 of 5 entries');
    expect('collapsible' in fractionalBudget!).toBe(false);
    expect('uncollapsibleWidgetsCount' in fractionalBudget!).toBe(false);

    expect(
      buildDocumentLogSection({ ...baseContext, entries: makeHistoryEntries(5) }, { maxWidgets: 0.5 })
    ).toBeUndefined();
    expect(
      buildDocumentLogSection({ ...baseContext, entries: makeHistoryEntries(5) }, { maxWidgets: Number.NaN })
    ).toBeUndefined();
  });

  it('returns undefined for maxWidgets <= 0 (0 and -5) across all DocumentLogPanelContext statuses', () => {
    const activeCandidate = {
      name: 'Harborview Hotel Document Log',
      url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
    };
    const contexts: DocumentLogPanelContext[] = [
      { status: 'missing_space' },
      { status: 'discovery_error', discoveryErrorMessage: 'Drive timeout' },
      {
        status: 'missing',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        targetFileName: 'Harborview Hotel Document Log',
      },
      {
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        activeCandidate,
        readStatus: 'ready',
        idGroup: '071200-001',
        entries: makeHistoryEntries(3),
      },
      {
        status: 'ambiguous',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        candidateOptions: [
          { text: 'Log A (1 Admin)', value: 'log-a', selected: true },
          { text: 'Log B (6 Construction)', value: 'log-b', selected: false },
        ],
        activeCandidate,
        readStatus: 'partial_hydration',
        idGroup: '071200-001',
        warningMessages: ['Skipped invalid row 2'],
        entries: makeHistoryEntries(3),
      },
    ];

    for (const ctx of contexts) {
      expect(buildDocumentLogSection(ctx, { maxWidgets: 0 })).toBeUndefined();
      expect(buildDocumentLogSection(ctx, { maxWidgets: -5 })).toBeUndefined();
    }
  });

  it('enforces additional resolved + ready boundaries, omitted maxWidgets cap, exact-fit 1-entry budget, and newest-first slicing order', () => {
    const activeUrl = 'https://docs.google.com/spreadsheets/d/log-1/edit';
    const baseContext: Omit<DocumentLogPanelContext, 'entries'> = {
      status: 'resolved',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      activeCandidate: {
        name: 'Harborview Hotel Document Log',
        url: activeUrl,
      },
      readStatus: 'ready',
      idGroup: '071200-001',
    };

    // maxWidgets = 22 (rawBudget = 21) with 21 entries -> 20 newest rows + 1 overflow notice, length 22
    const atCap22 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(21) },
      { maxWidgets: 22 }
    );
    expect(atCap22).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, atCap22)).toBe(true);
    expect(atCap22?.widgets).toHaveLength(22);
    expect(atCap22?.collapsible).toBe(true);
    expect(atCap22?.uncollapsibleWidgetsCount).toBe(1);
    expect(atCap22?.widgets[1].decoratedText?.topLabel).toBe('Submission 21');
    expect(atCap22?.widgets[20].decoratedText?.topLabel).toBe('Submission 2');
    expect(atCap22?.widgets[21].decoratedText).toEqual({
      text: 'Showing 20 of 21 entries',
      wrapText: true,
      button: {
        text: 'Open Log',
        onClick: {
          openLink: {
            url: activeUrl,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });

    // maxWidgets omitted (undefined) with 25 entries -> 20 newest rows + 1 overflow notice, length 22
    const omittedMax25 = buildDocumentLogSection({
      ...baseContext,
      entries: makeHistoryEntries(25),
    });
    expect(omittedMax25).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, omittedMax25)).toBe(true);
    expect(omittedMax25?.widgets).toHaveLength(22);
    expect(omittedMax25?.collapsible).toBe(true);
    expect(omittedMax25?.uncollapsibleWidgetsCount).toBe(1);
    expect(omittedMax25?.widgets[1].decoratedText?.topLabel).toBe('Submission 25');
    expect(omittedMax25?.widgets[20].decoratedText?.topLabel).toBe('Submission 6');
    expect(omittedMax25?.widgets[21].decoratedText).toEqual({
      text: 'Showing 20 of 25 entries',
      wrapText: true,
      button: {
        text: 'Open Log',
        onClick: {
          openLink: {
            url: activeUrl,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });

    // maxWidgets = 2 (rawBudget = 1) with 1 entry -> 1 row + NO overflow notice, length 2
    const exactFitOne = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(1) },
      { maxWidgets: 2 }
    );
    expect(exactFitOne).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, exactFitOne)).toBe(true);
    expect(exactFitOne?.widgets).toHaveLength(2);
    expect(exactFitOne?.collapsible).toBe(true);
    expect(exactFitOne?.uncollapsibleWidgetsCount).toBe(1);
    expect(exactFitOne?.widgets[1].decoratedText?.topLabel).toBe('Submission 1');
    expect(
      exactFitOne?.widgets.some((w) => w.decoratedText?.text.startsWith('Showing '))
    ).toBe(false);

    // Newest-first ordering preserved when slicing maxWidgets = 21 with 21 entries -> 19 rows (Submission 21..Submission 3) + overflow notice
    const slicedAt21 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(21) },
      { maxWidgets: 21 }
    );
    expect(slicedAt21).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, slicedAt21)).toBe(true);
    expect(slicedAt21?.widgets).toHaveLength(21);
    expect(slicedAt21?.widgets[1].decoratedText?.topLabel).toBe('Submission 21');
    expect(slicedAt21?.widgets[19].decoratedText?.topLabel).toBe('Submission 3');
    expect(slicedAt21?.widgets[20].decoratedText?.text).toBe('Showing 19 of 21 entries');
  });

  it('enforces ambiguous + partial_hydration (logFixedWidgets = 3) overflow-first budget and clamping boundaries', () => {
    const activeUrl = 'https://docs.google.com/spreadsheets/d/log-a/edit';
    const baseContext: Omit<DocumentLogPanelContext, 'entries'> = {
      status: 'ambiguous',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      candidateOptions: [
        { text: 'Log A (1 Admin)', value: 'log-a', selected: true },
        { text: 'Log B (6 Construction)', value: 'log-b', selected: false },
      ],
      activeCandidate: {
        name: 'Log A',
        url: activeUrl,
      },
      readStatus: 'partial_hydration',
      idGroup: '071200-001',
      warningMessages: ['Skipped invalid row 4'],
    };

    // maxWidgets = 23 (rawBudget = 20) with 21 entries -> 19 rows + 1 overflow notice, length 23, uncollapsibleWidgetsCount: 3
    const budget20With21 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(21) },
      { maxWidgets: 23 }
    );
    expect(budget20With21).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, budget20With21)).toBe(true);
    expect(budget20With21?.widgets).toHaveLength(23);
    expect(budget20With21?.collapsible).toBe(true);
    expect(budget20With21?.uncollapsibleWidgetsCount).toBe(3);
    expect(budget20With21?.widgets[3].decoratedText?.topLabel).toBe('Submission 21');
    expect(budget20With21?.widgets[21].decoratedText?.topLabel).toBe('Submission 3');
    expect(budget20With21?.widgets[22].decoratedText).toEqual({
      text: 'Showing 19 of 21 entries',
      wrapText: true,
      button: {
        text: 'Open Log',
        onClick: {
          openLink: {
            url: activeUrl,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });

    // maxWidgets = 30 (ample budget) with 25 entries -> 20 rows + 1 overflow notice, length 24, uncollapsibleWidgetsCount: 3
    const ampleWith25 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(25) },
      { maxWidgets: 30 }
    );
    expect(ampleWith25).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, ampleWith25)).toBe(true);
    expect(ampleWith25?.widgets).toHaveLength(24);
    expect(ampleWith25?.collapsible).toBe(true);
    expect(ampleWith25?.uncollapsibleWidgetsCount).toBe(3);
    expect(ampleWith25?.widgets[3].decoratedText?.topLabel).toBe('Submission 25');
    expect(ampleWith25?.widgets[22].decoratedText?.topLabel).toBe('Submission 6');
    expect(ampleWith25?.widgets[23].decoratedText).toEqual({
      text: 'Showing 20 of 25 entries',
      wrapText: true,
      button: {
        text: 'Open Log',
        onClick: {
          openLink: {
            url: activeUrl,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });

    // maxWidgets = 4 (rawBudget = 1) with 5 entries -> 0 rows + 1 overflow notice, length 4, omits collapsible props
    const budgetOneWith5 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(5) },
      { maxWidgets: 4 }
    );
    expect(budgetOneWith5).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, budgetOneWith5)).toBe(true);
    expect(budgetOneWith5?.widgets).toHaveLength(4);
    expect('collapsible' in budgetOneWith5!).toBe(false);
    expect('uncollapsibleWidgetsCount' in budgetOneWith5!).toBe(false);
    expect(budgetOneWith5?.widgets[3].decoratedText).toEqual({
      text: 'Showing 0 of 5 entries',
      wrapText: true,
      button: {
        text: 'Open Log',
        onClick: {
          openLink: {
            url: activeUrl,
            openAs: 'FULL_SIZE',
          },
        },
      },
    });

    // maxWidgets = 3 (rawBudget = 0) with 5 entries -> 0 rows, NO overflow notice, length 3, omits collapsible props
    const budgetZeroWith5 = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(5) },
      { maxWidgets: 3 }
    );
    expect(budgetZeroWith5).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, budgetZeroWith5)).toBe(true);
    expect(budgetZeroWith5?.widgets).toHaveLength(3);
    expect('collapsible' in budgetZeroWith5!).toBe(false);
    expect('uncollapsibleWidgetsCount' in budgetZeroWith5!).toBe(false);
    expect(
      budgetZeroWith5?.widgets.some((w) => w.decoratedText?.text.startsWith('Showing '))
    ).toBe(false);

    // maxWidgets = 2 and maxWidgets = 1 (< logFixedWidgets = 3) with 5 entries -> clamped cleanly to 2 and 1 widgets
    const clampedToTwo = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(5) },
      { maxWidgets: 2 }
    );
    expect(clampedToTwo).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, clampedToTwo)).toBe(true);
    expect(clampedToTwo?.widgets).toHaveLength(2);
    expect('collapsible' in clampedToTwo!).toBe(false);
    expect('uncollapsibleWidgetsCount' in clampedToTwo!).toBe(false);

    const clampedToOne = buildDocumentLogSection(
      { ...baseContext, entries: makeHistoryEntries(5) },
      { maxWidgets: 1 }
    );
    expect(clampedToOne).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, clampedToOne)).toBe(true);
    expect(clampedToOne?.widgets).toHaveLength(1);
    expect('collapsible' in clampedToOne!).toBe(false);
    expect('uncollapsibleWidgetsCount' in clampedToOne!).toBe(false);
  });

  it('clamps non-history multi-widget states strictly to maxWidgets < fixed widget count while remaining schema-valid', () => {
    const missingContext: DocumentLogPanelContext = {
      status: 'missing',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      targetFileName: 'Harborview Hotel Document Log',
    };

    const missingClamped2 = buildDocumentLogSection(missingContext, { maxWidgets: 2 });
    expect(missingClamped2).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, missingClamped2)).toBe(true);
    expect(missingClamped2?.widgets).toHaveLength(2);
    expect(missingClamped2?.widgets[0].decoratedText).toBeDefined();
    expect(missingClamped2?.widgets[1].buttonList?.buttons[0].text).toBe('Copy Log');
    expect('collapsible' in missingClamped2!).toBe(false);
    expect('uncollapsibleWidgetsCount' in missingClamped2!).toBe(false);

    const missingClamped1 = buildDocumentLogSection(missingContext, { maxWidgets: 1 });
    expect(missingClamped1).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, missingClamped1)).toBe(true);
    expect(missingClamped1?.widgets).toHaveLength(1);
    expect(missingClamped1?.widgets[0].decoratedText?.text).toBe(
      'Create <b>Harborview Hotel Document Log</b> in <b>Harborview Hotel</b>'
    );
    expect('collapsible' in missingClamped1!).toBe(false);
    expect('uncollapsibleWidgetsCount' in missingClamped1!).toBe(false);

    const activeCandidate = {
      name: 'Harborview Hotel Document Log',
      url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
    };

    const nonHistoryResolvedContexts: DocumentLogPanelContext[] = [
      {
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        activeCandidate,
        readStatus: 'idle_incomplete_id',
        missingIdFields: ['Section', 'Number'],
      },
      {
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        activeCandidate,
        readStatus: 'read_error',
        idGroup: '071200-001',
        readErrorMessage: 'Timeout',
      },
      {
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        activeCandidate,
        readStatus: 'ready',
        idGroup: '071200-001',
        entries: [],
      },
    ];

    for (const ctx of nonHistoryResolvedContexts) {
      const clamped = buildDocumentLogSection(ctx, { maxWidgets: 1 });
      expect(clamped).toBeDefined();
      expect(Value.Check(UiViewSectionSchema, clamped)).toBe(true);
      expect(clamped?.widgets).toHaveLength(1);
      expect('collapsible' in clamped!).toBe(false);
      expect('uncollapsibleWidgetsCount' in clamped!).toBe(false);
    }
  });
});

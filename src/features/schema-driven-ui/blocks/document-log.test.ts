import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewColorSchema, UiViewSectionSchema } from '../domain';
import type { DocumentLogPanelContext } from '../ports';
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

  it('renders HTML-escaped textParagraph/decoratedText and unescaped plain labels for status: missing', () => {
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

    const paragraph = section?.widgets.find((w) => w.textParagraph !== undefined)?.textParagraph;
    expect(paragraph).toBeDefined();
    expect(paragraph?.text).toContain(escapeCardHtml(trickySpace));
    expect(paragraph?.text).not.toContain(trickySpace);

    const decorated = section?.widgets.find((w) => w.decoratedText !== undefined)?.decoratedText;
    expect(decorated).toBeDefined();
    expect(decorated?.text).toContain(escapeCardHtml(trickyFile));
    expect(decorated?.text).not.toContain(trickyFile);

    expect(decorated?.topLabel).toContain(trickySpace);
    expect(decorated?.topLabel).not.toContain('&amp;');
    expect(decorated?.topLabel).not.toContain('&#x3D;');

    expect(decorated?.bottomLabel).toContain(trickyFolder);
    expect(decorated?.bottomLabel).not.toContain('&amp;');
    expect(decorated?.bottomLabel).not.toContain('&#x3D;');
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
    expect(decorated?.bottomLabel).toContain(folderPath);
    expect(decorated?.bottomLabel).not.toContain('&amp;');
    expect(decorated?.button).toEqual({
      text: 'Open Log',
      onClick: {
        openLink: {
          url: activeUrl,
          openAs: 'FULL_SIZE',
        },
      },
    });
  });

  it('renders warning textParagraph and Open Log decoratedText for status: ambiguous and honors maxWidgets clamp', () => {
    const activeName = 'Log & <1> = \'A\'';
    const activeUrl = 'https://docs.google.com/spreadsheets/d/log-a/edit';

    const context: DocumentLogPanelContext = {
      status: 'ambiguous',
      spaceName: 'Harborview Hotel',
      targetFolderPath: '1 Admin',
      candidateOptions: [
        { text: 'Log A', value: 'log-a', selected: true },
        { text: 'Log B', value: 'log-b', selected: false },
      ],
      activeCandidate: {
        name: activeName,
        url: activeUrl,
      },
    };

    const section = buildDocumentLogSection(context);

    expect(section).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    expect(section?.header).toBe('Document Log');

    const paragraph = section?.widgets.find((w) => w.textParagraph !== undefined)?.textParagraph;
    expect(paragraph).toBeDefined();
    expect(paragraph?.text.trim().length).toBeGreaterThan(0);

    const decorated = section?.widgets.find((w) => w.decoratedText !== undefined)?.decoratedText;
    expect(decorated).toBeDefined();
    expect(decorated?.text).toContain(escapeCardHtml(activeName));
    expect(decorated?.button).toEqual({
      text: 'Open Log',
      onClick: {
        openLink: {
          url: activeUrl,
          openAs: 'FULL_SIZE',
        },
      },
    });

    const clamped = buildDocumentLogSection(context, { maxWidgets: 1 });
    expect(clamped).toBeDefined();
    expect(Value.Check(UiViewSectionSchema, clamped)).toBe(true);
    expect(clamped?.widgets).toHaveLength(1);
  });
});
